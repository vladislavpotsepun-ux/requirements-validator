import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadDocument } from '../src/review/document.js';
import { createApp } from '../src/server/app.js';
import type { ReviewEvent, ReviewModel } from '../src/review/types.js';
import { textPdf } from './fixtures.js';

const model: ReviewModel = {
  model: 'test-model', provider: 'Local',
  async generate({ phase }) {
    if (phase === 'extract') {
      return {
        requirements: [{
          candidateId: 'B0002.1',
          summary: 'Уведомление за минуту', kind: 'nonfunctional',
        }],
      };
    }
    if (phase === 'individual') {
      return { reviews: [{ id: 'REQ-001', feasibility: 'feasible', testReadiness: 'ready', findings: [] }] };
    }
    return { findings: [] };
  },
};

async function startApp(t: TestContext, accessCode?: string, customModel: ReviewModel = model) {
  const server = createApp({ getModel: () => customModel, version: 'v1.0.0', accessCode }).listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readEvents(response: Response): Promise<ReviewEvent[]> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/x-ndjson/u);
  return (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
}

test('serves progress and the default PDF download for a Markdown upload', async (t) => {
  const address = await startApp(t, 'example');
  assert.deepEqual(await (await fetch(`${address}/api/info`)).json(), {
    configured: true, provider: 'Local', model: 'test-model', requiresAccessCode: true, maxBytes: 10 * 1024 * 1024,
  });
  const body = '# Alerts\n\nFR-1. Send an alert within one minute.';
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'alerts.md' };
  const denied = await fetch(`${address}/api/review`, { method: 'POST', headers, body });
  assert.equal(denied.status, 401);

  const response = await fetch(`${address}/api/review`, {
    method: 'POST', headers: { ...headers, 'X-Review-Access-Code': 'example' }, body,
  });
  const events = await readEvents(response);
  assert.deepEqual(events.filter((event) => event.type === 'progress').map((event) => event.phase), [
    'extract', 'individual', 'set',
  ]);
  const started = events.find((event) => event.type === 'started');
  assert.equal(started?.type, 'started');
  assert.match(started.jobId, /^[a-f0-9]{32}$/u);
  const result = events.at(-1);
  assert.equal(result?.type, 'report');
  assert.equal(result.report.requirements[0]?.originalId, 'FR-1');
  assert.equal(result.report.readiness.testing, 'ready');
  assert.equal(result.file.name, 'alerts-report.pdf');
  assert.equal(result.file.contentType, 'application/pdf');
  assert.equal(Buffer.from(result.file.base64, 'base64').subarray(0, 5).toString(), '%PDF-');

  // Reconnecting after completion enforces authorization and replays the report.
  const deniedReconnect = await fetch(`${address}/api/review/${started.jobId}`);
  assert.equal(deniedReconnect.status, 401);
  const reconnected = await fetch(`${address}/api/review/${started.jobId}`, {
    headers: { 'X-Review-Access-Code': 'example' },
  });
  const replayEvents = await readEvents(reconnected);
  assert.equal(replayEvents.at(-1)?.type, 'report');
});

test('serves a readable PDF report for a PDF upload', async (t) => {
  const address = await startApp(t);
  const document = textPdf([[['Alerts', 45, 780], ['FR-1. Send an alert within one minute.', 45, 740]]]);
  const response = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'alerts.pdf' },
    body: Uint8Array.from(document),
  });
  const result = (await readEvents(response)).at(-1);

  assert.equal(result?.type, 'report');
  assert.equal(result.file.name, 'alerts-report.pdf');
  assert.equal(result.file.contentType, 'application/pdf');
  const bytes = Buffer.from(result.file.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const exported = await loadDocument(result.file.name, bytes);
  assert.ok(exported.blocks.some(({ text }) => text.includes('Уведомление за минуту')));
  assert.ok(exported.blocks.some(({ text }) => text.includes('Итог и порядок исправлений')));
});

test('keeps a review running across client disconnect and allows reconnecting to finish', async (t) => {
  let releaseIndividual!: () => void;
  const individualGate = new Promise<void>((resolve) => {
    releaseIndividual = resolve;
  });
  const slowModel: ReviewModel = {
    model: 'test-model',
    provider: 'Local',
    async generate(request) {
      if (request.phase === 'individual') {
        await individualGate;
      }
      return model.generate(request);
    },
  };
  const address = await startApp(t, undefined, slowModel);
  const disconnect = new AbortController();
  const initial = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'alerts.md' },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
    signal: disconnect.signal,
  });
  const reader = initial.body!.pipeThrough(new TextDecoderStream()).getReader();
  let jobId = '';
  let seenIndividual = false;
  let buffer = '';
  while (!seenIndividual) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const lines = (buffer + value).split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ReviewEvent;
      if (event.type === 'started') jobId = event.jobId;
      if (event.type === 'progress' && event.phase === 'individual') seenIndividual = true;
    }
  }
  assert.match(jobId, /^[a-f0-9]{32}$/u);
  // Simulate page reload disconnecting the original HTTP stream.
  disconnect.abort();
  await reader.cancel().catch(() => undefined);

  // Reconnect from a fresh request, verify current progress is replayed, then release the job.
  const reconnectedPromise = fetch(`${address}/api/review/${jobId}`);
  const reconnected = await reconnectedPromise;
  releaseIndividual();
  const events = await readEvents(reconnected);
  assert.ok(events.some((event) => event.type === 'progress' && event.phase === 'individual'));
  assert.equal(events.at(-1)?.type, 'report');
});

test('cancels an active review explicitly via the cancel endpoint and frees the server', async (t) => {
  let modelAborted = false;
  const hangingModel: ReviewModel = {
    model: 'test-model',
    provider: 'Local',
    async generate({ phase, signal }) {
      if (phase === 'extract') {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            modelAborted = true;
            reject(signal.reason ?? new Error('Aborted'));
          }, { once: true });
        });
      }
      return model.generate({ phase, instructions: '', data: {}, schema: {} });
    },
  };
  const address = await startApp(t, 'secret-code', hangingModel);
  const auth = { 'X-Review-Access-Code': 'secret-code' };
  const initial = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'alerts.md', ...auth },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
  });
  const reader = initial.body!.pipeThrough(new TextDecoderStream()).getReader();
  let jobId = '';
  let buffer = '';
  while (!jobId) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const lines = (buffer + value).split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ReviewEvent;
      if (event.type === 'started') jobId = event.jobId;
    }
  }

  // Unauthorized cancel must be rejected.
  const deniedCancel = await fetch(`${address}/api/review/${jobId}/cancel`, { method: 'POST' });
  assert.equal(deniedCancel.status, 401);

  // Authorized cancel aborts the model and sends a cancelled event.
  const cancelRes = await fetch(`${address}/api/review/${jobId}/cancel`, { method: 'POST', headers: auth });
  assert.equal(cancelRes.status, 200);
  const remaining = [buffer];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    remaining.push(value);
  }
  const events = remaining.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReviewEvent);
  assert.equal(events.at(-1)?.type, 'cancelled');
  assert.equal(modelAborted, true);
});

test('advertises available providers and lets the client swap providers safely via header', async (t) => {
  const seen: (string | undefined)[] = [];
  const server = createApp({
    version: 'v1.0.0',
    getModel: (provider) => {
      seen.push(provider);
      return provider === 'local'
        ? { ...model, provider: 'Local', model: 'qwen3.5:9b' }
        : { ...model, provider: 'Gemini', model: 'gemini-4-hydrogen' };
    },
    getAvailableProviders: async () => [
      { id: 'gemini', provider: 'Gemini', model: 'gemini-4-hydrogen' },
      { id: 'local', provider: 'Local', model: 'qwen3.5:9b' },
    ],
  }).listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const info = await (await fetch(`${address}/api/info`)).json();
  assert.deepEqual(info.providers.map((item: { id: string }) => item.id), ['gemini', 'local']);

  const invalid = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Document-Name': 'alerts.md',
      'X-Review-Provider': 'http://evil.invalid',
    },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
  });
  assert.equal(invalid.status, 400);

  const localRun = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Document-Name': 'alerts.md',
      'X-Review-Provider': 'local',
    },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
  });
  const result = (await readEvents(localRun)).at(-1);
  assert.equal(result?.type, 'report');
  assert.equal(result.report.run.provider, 'Local');
  assert.equal(result.report.run.model, 'qwen3.5:9b');
  assert.ok(seen.includes('local'));
});

test('validates X-Review-Mode header and supports fintech mode with sourceBlocks', async (t) => {
  const server = createApp({
    version: 'v1.0.0',
    getModel: () => model,
    defaultMode: 'standard',
  }).listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const info = await (await fetch(`${address}/api/info`)).json();
  assert.equal(info.defaultMode, 'standard');

  const invalid = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Document-Name': 'alerts.md',
      'X-Review-Mode': 'unknown-mode',
    },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
  });
  assert.equal(invalid.status, 400);

  const fintechRun = await fetch(`${address}/api/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Document-Name': 'alerts.md',
      'X-Review-Mode': 'fintech',
    },
    body: '# Alerts\n\nFR-1. Send an alert within one minute.',
  });
  const result = (await readEvents(fintechRun)).at(-1);
  assert.equal(result?.type, 'report');
  assert.equal(result.report.run.mode, 'fintech');
  assert.ok((result.report.sourceBlocks?.length ?? 0) >= 2);
});

