import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { limits, loadDocument } from '../review/document.js';
import { ReviewError } from '../review/errors.js';
import { analyzeDocument } from '../review/pipeline.js';
import { renderReportFile } from '../review/report-file.js';
import type {
  DownloadableReport, ProviderId, ProviderOption, ReviewEvent, ReviewMode, ReviewModel, ReviewProgress, ReviewReport,
  WebErrorCode, WebInfo,
} from '../review/types.js';

interface AppOptions {
  version: string;
  getModel: (provider?: ProviderId) => ReviewModel;
  getAvailableProviders?: () => Promise<ProviderOption[]>;
  accessCode?: string;
  defaultMode?: ReviewMode;
}

interface ReviewSubscriber {
  send: (event: ReviewEvent) => void;
  close: () => void;
}

interface ReviewJob {
  id: string;
  documentName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: ReviewProgress;
  result?: { report: ReviewReport; file: DownloadableReport };
  errorCode?: WebErrorCode;
  controller: AbortController;
  subscribers: Set<ReviewSubscriber>;
}

const jobRetentionMs = 30 * 60_000;
const validJobId = /^[a-f0-9]{32}$/u;
const allowedProviders = new Set<ProviderId>(['gemini', 'local', 'codex']);
const allowedModes = new Set<ReviewMode>(['standard', 'fintech']);

export function createApp({ version, getModel, getAvailableProviders, accessCode, defaultMode }: AppOptions) {
  const app = express();
  let currentJob: ReviewJob | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  app.get('/api/info', async (_request, response) => {
    const info: WebInfo = { configured: false, requiresAccessCode: Boolean(accessCode), maxBytes: limits.bytes };
    const providers = getAvailableProviders ? await getAvailableProviders() : undefined;
    if (providers) {
      info.providers = providers;
    }
    if (defaultMode) {
      info.defaultMode = defaultMode;
    }
    try {
      const { model, provider } = getModel();
      Object.assign(info, { configured: true, model, provider });
    } catch (error) {
      if (!(error instanceof ReviewError) || error.code !== 'MODEL_CONFIG') {
        throw error;
      }
      const fallback = providers?.[0];
      if (fallback) {
        Object.assign(info, { configured: true, model: fallback.model, provider: fallback.provider });
      }
    }
    response.set('Cache-Control', 'no-store').json(info);
  });

  const authorize: RequestHandler = (request, response, next) => {
    if (accessCode && !codeMatches(request.get('X-Review-Access-Code'), accessCode)) {
      response.status(401).json({ code: 'ACCESS_DENIED' });
      return;
    }
    next();
  };

  function scheduleCleanup(job: ReviewJob) {
    if (currentJob !== job) {
      return;
    }
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (currentJob === job && job.status !== 'running') {
        currentJob = undefined;
      }
    }, jobRetentionMs).unref();
  }

  function broadcast(job: ReviewJob, event: ReviewEvent, finish = false) {
    for (const subscriber of [...job.subscribers]) {
      subscriber.send(event);
      if (finish) {
        subscriber.close();
      }
    }
  }

  function attachStream(job: ReviewJob, response: Response) {
    response.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const write = (event: ReviewEvent) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(JSON.stringify(event) + '\n');
      }
    };
    write({ type: 'started', jobId: job.id, documentName: job.documentName });
    if (job.status === 'completed' && job.result) {
      write({ type: 'report', report: job.result.report, file: job.result.file });
      response.end();
      return;
    }
    if (job.status === 'cancelled') {
      write({ type: 'cancelled' });
      response.end();
      return;
    }
    if (job.status === 'failed') {
      write({ type: 'error', code: job.errorCode ?? 'INTERNAL_ERROR' });
      response.end();
      return;
    }
    if (job.progress) {
      write({ type: 'progress', ...job.progress });
    }
    const heartbeat = setInterval(() => write({ type: 'heartbeat' }), 12_000).unref();
    const subscriber: ReviewSubscriber = {
      send: write,
      close: () => {
        clearInterval(heartbeat);
        job.subscribers.delete(subscriber);
        if (!response.destroyed && !response.writableEnded) {
          response.end();
        }
      },
    };
    job.subscribers.add(subscriber);
    response.once('close', () => {
      clearInterval(heartbeat);
      job.subscribers.delete(subscriber);
    });
  }

  app.post(
    '/api/review',
    authorize,
    express.raw({ type: 'application/octet-stream', limit: limits.bytes, inflate: false }),
    (request, response) => {
      const name = decodeHeader(request.get('X-Document-Name'));
      const bytes: unknown = request.body;
      if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(name) || !Buffer.isBuffer(bytes) || !bytes.length) {
        response.status(400).json({ code: 'INVALID_DOCUMENT' });
        return;
      }
      const rawProvider = request.get('X-Review-Provider')?.trim().toLowerCase();
      if (rawProvider && !allowedProviders.has(rawProvider as ProviderId)) {
        response.status(400).json({ code: 'MODEL_CONFIG' });
        return;
      }
      const rawMode = request.get('X-Review-Mode')?.trim().toLowerCase();
      if (rawMode && !allowedModes.has(rawMode as ReviewMode)) {
        response.status(400).json({ code: 'INVALID_DOCUMENT' });
        return;
      }
      const mode: ReviewMode = (rawMode as ReviewMode | undefined) ?? defaultMode ?? 'standard';
      if (currentJob?.status === 'running') {
        response.status(409).json({ code: 'BUSY' });
        return;
      }
      const model = getModel(rawProvider as ProviderId | undefined);
      clearTimeout(cleanupTimer);
      const job: ReviewJob = {
        id: randomBytes(16).toString('hex'),
        documentName: name,
        status: 'running',
        controller: new AbortController(),
        subscribers: new Set(),
      };
      currentJob = job;
      attachStream(job, response);

      void (async () => {
        try {
          const document = await loadDocument(name, bytes);
          job.controller.signal.throwIfAborted();
          const report = await analyzeDocument(document, model, {
            version,
            mode,
            signal: job.controller.signal,
            onProgress: (progress) => {
              job.progress = progress;
              broadcast(job, { type: 'progress', ...progress });
            },
          });
          job.controller.signal.throwIfAborted();
          const file = await renderReportFile(report);
          job.controller.signal.throwIfAborted();
          const downloadable: DownloadableReport = {
            name: file.name,
            contentType: file.contentType,
            base64: file.bytes.toString('base64'),
          };
          job.status = 'completed';
          job.result = { report, file: downloadable };
          broadcast(job, { type: 'report', report, file: downloadable }, true);
        } catch (error) {
          if (job.status === 'cancelled' || job.controller.signal.aborted) {
            if (job.status !== 'cancelled') {
              job.status = 'cancelled';
              broadcast(job, { type: 'cancelled' }, true);
            }
          } else {
            const code = publicError(error);
            job.status = 'failed';
            job.errorCode = code;
            broadcast(job, { type: 'error', code }, true);
          }
        } finally {
          scheduleCleanup(job);
        }
      })();
    },
  );

  app.get('/api/review/:jobId', authorize, (request, response) => {
    const jobId = String(request.params.jobId ?? '');
    if (!validJobId.test(jobId) || currentJob?.id !== jobId) {
      response.status(404).json({ code: 'JOB_NOT_FOUND' });
      return;
    }
    attachStream(currentJob, response);
  });

  app.post('/api/review/:jobId/cancel', authorize, (request, response) => {
    const jobId = String(request.params.jobId ?? '');
    if (!validJobId.test(jobId) || currentJob?.id !== jobId) {
      response.status(404).json({ code: 'JOB_NOT_FOUND' });
      return;
    }
    if (currentJob.status === 'running') {
      currentJob.status = 'cancelled';
      currentJob.controller.abort();
      broadcast(currentJob, { type: 'cancelled' }, true);
      scheduleCleanup(currentJob);
    }
    response.set('Cache-Control', 'no-store').json({ cancelled: true });
  });

  app.use('/api', (_request, response) => response.status(404).json({ code: 'INTERNAL_ERROR' }));
  app.use(handleApiError);
  return app;
}

function decodeHeader(value: string | undefined): string | undefined {
  try {
    return value && decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function codeMatches(value: string | undefined, expected: string) {
  const supplied = decodeHeader(value);
  if (supplied === undefined) {
    return false;
  }
  const hash = (text: string) => createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}

const handleApiError: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error?.type === 'entity.too.large') {
    response.status(413).json({ code: 'LIMIT_EXCEEDED' });
    return;
  }
  if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
    response.status(error.status).json({ code: 'INVALID_DOCUMENT' });
    return;
  }
  const code = publicError(error);
  response.status(code === 'MODEL_CONFIG' ? 503 : 500).json({ code });
};

function publicError(error: unknown): WebErrorCode {
  if (error instanceof ReviewError) {
    console.error(`Review request failed (${error.code}).`);
    return error.code;
  }
  console.error('Review request failed (INTERNAL_ERROR).');
  return 'INTERNAL_ERROR';
}
