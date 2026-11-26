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

async function startApp(t: TestContext, accessCode?: string) {
  const server = createApp({ getModel: () => model, version: 'v1.0.0', accessCode }).listen(0, '127.0.0.1');
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
  const result = events.at(-1);
  assert.equal(result?.type, 'report');
  assert.equal(result.report.requirements[0]?.originalId, 'FR-1');
  assert.equal(result.report.readiness.testing, 'ready');
  assert.equal(result.file.name, 'alerts-report.pdf');
  assert.equal(result.file.contentType, 'application/pdf');
  assert.equal(Buffer.from(result.file.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
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
