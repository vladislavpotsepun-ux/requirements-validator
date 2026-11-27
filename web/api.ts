import type { ProviderId, ReviewEvent, ReviewMode, WebErrorCode, WebInfo } from '../src/review/types.js';

type CompletedReview = Extract<ReviewEvent, { type: 'report' }>;
type Progress = Extract<ReviewEvent, { type: 'progress' }>;
type Started = Extract<ReviewEvent, { type: 'started' }>;

export interface ReviewStreamHandlers {
  onStarted?: (started: Started) => void;
  onProgress: (progress: Progress) => void;
}

export class WebReviewError extends Error {
  constructor(public readonly code: WebErrorCode) {
    super(code);
  }
}

export class ReviewCancelledError extends Error {
  constructor() {
    super('Review cancelled');
    this.name = 'ReviewCancelledError';
  }
}

export async function fetchInfo(signal: AbortSignal): Promise<WebInfo> {
  const response = await fetch('/api/info', { signal });
  if (!response.ok) {
    throw new WebReviewError('INTERNAL_ERROR');
  }
  return response.json();
}

function authHeaders(accessCode: string): Record<string, string> {
  return accessCode.trim()
    ? { 'X-Review-Access-Code': encodeURIComponent(accessCode.trim()) }
    : {};
}

async function consumeReviewStream(
  response: Response,
  handlers: ReviewStreamHandlers,
): Promise<CompletedReview> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: WebErrorCode } | null;
    throw new WebReviewError(body?.code ?? 'INTERNAL_ERROR');
  }
  if (!response.body) {
    throw new WebReviewError('INTERNAL_ERROR');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  const handleLine = (line: string): CompletedReview | undefined => {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }
    const event = JSON.parse(trimmed) as ReviewEvent;
    if (event.type === 'started') {
      handlers.onStarted?.(event);
    } else if (event.type === 'progress') {
      handlers.onProgress(event);
    } else if (event.type === 'cancelled') {
      throw new ReviewCancelledError();
    } else if (event.type === 'error') {
      throw new WebReviewError(event.code);
    } else if (event.type === 'report') {
      return event;
    }
    return undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const finalReport = handleLine(pending);
        if (finalReport) {
          return finalReport;
        }
        break;
      }
      const lines = (pending + value).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const report = handleLine(line);
        if (report) {
          return report;
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new WebReviewError('MODEL_UNAVAILABLE');
}

export async function submitReview(
  file: File,
  accessCode: string,
  signal: AbortSignal,
  handlers: ReviewStreamHandlers,
  provider?: ProviderId,
  mode?: ReviewMode,
): Promise<CompletedReview> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Document-Name': encodeURIComponent(file.name),
    ...(provider ? { 'X-Review-Provider': provider } : {}),
    ...(mode ? { 'X-Review-Mode': mode } : {}),
    ...authHeaders(accessCode),
  };
  const response = await fetch('/api/review', { method: 'POST', headers, body: file, signal });
  return consumeReviewStream(response, handlers);
}

export async function reconnectReview(
  jobId: string,
  accessCode: string,
  signal: AbortSignal,
  handlers: ReviewStreamHandlers,
): Promise<CompletedReview> {
  const response = await fetch(`/api/review/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: authHeaders(accessCode),
    signal,
  });
  return consumeReviewStream(response, handlers);
}

export async function cancelReview(jobId: string, accessCode: string): Promise<void> {
  const response = await fetch(`/api/review/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(accessCode),
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => null) as { code?: WebErrorCode } | null;
    throw new WebReviewError(body?.code ?? 'INTERNAL_ERROR');
  }
}
