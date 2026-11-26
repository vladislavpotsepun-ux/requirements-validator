import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { limits, loadDocument } from '../review/document.js';
import { ReviewError } from '../review/errors.js';
import { analyzeDocument } from '../review/pipeline.js';
import { renderReportFile } from '../review/report-file.js';
import type { ReviewEvent, ReviewModel, WebErrorCode, WebInfo } from '../review/types.js';

interface AppOptions {
  version: string;
  getModel: () => ReviewModel;
  accessCode?: string;
}

export function createApp({ version, getModel, accessCode }: AppOptions) {
  const app = express();
  let reviewing = false;
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  app.get('/api/info', (_request, response) => {
    const info: WebInfo = { configured: false, requiresAccessCode: Boolean(accessCode), maxBytes: limits.bytes };
    try {
      const { model, provider } = getModel();
      Object.assign(info, { configured: true, model, provider });
    } catch (error) {
      if (!(error instanceof ReviewError) || error.code !== 'MODEL_CONFIG') {
        throw error;
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

  app.post(
    '/api/review',
    authorize,
    express.raw({ type: 'application/octet-stream', limit: limits.bytes, inflate: false }),
    async (request, response) => {
      const name = decodeHeader(request.get('X-Document-Name'));
      const bytes: unknown = request.body;
      if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(name) || !Buffer.isBuffer(bytes) || !bytes.length) {
        response.status(400).json({ code: 'INVALID_DOCUMENT' });
        return;
      }
      if (reviewing) {
        response.status(409).json({ code: 'BUSY' });
        return;
      }
      const model = getModel();
      reviewing = true;
      const controller = new AbortController();
      const send = (event: ReviewEvent) => {
        if (!response.destroyed) {
          response.write(JSON.stringify(event) + '\n');
        }
      };
      response.once('close', () => controller.abort());
      response.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 12_000).unref();
      try {
        const document = await loadDocument(name, bytes);
        const report = await analyzeDocument(document, model, {
          version,
          signal: controller.signal,
          onProgress: (progress) => send({ type: 'progress', ...progress }),
        });
        const file = await renderReportFile(report);
        send({
          type: 'report', report,
          file: { name: file.name, contentType: file.contentType, base64: file.bytes.toString('base64') },
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          send({ type: 'error', code: publicError(error) });
        }
      } finally {
        reviewing = false;
        clearInterval(heartbeat);
        if (!response.destroyed) {
          response.end();
        }
      }
    },
  );
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
