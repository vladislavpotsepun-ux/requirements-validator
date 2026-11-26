import type { ReviewEvent, WebErrorCode, WebInfo } from '../src/review/types.js';

type CompletedReview = Extract<ReviewEvent, { type: 'report' }>;
type Progress = Extract<ReviewEvent, { type: 'progress' }>;

export class WebReviewError extends Error {
  constructor(public readonly code: WebErrorCode) {
    super(code);
  }
}

export async function fetchInfo(signal: AbortSignal): Promise<WebInfo> {
  const response = await fetch('/api/info', { signal });
  if (!response.ok) {
    throw new WebReviewError('INTERNAL_ERROR');
  }
  return response.json();
}

export async function submitReview(
  file: File,
  accessCode: string,
  signal: AbortSignal,
  onProgress: (progress: Progress) => void,
): Promise<CompletedReview> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Document-Name': encodeURIComponent(file.name),
  };
  if (accessCode) {
    headers['X-Review-Access-Code'] = encodeURIComponent(accessCode.trim());
  }
  const response = await fetch('/api/review', { method: 'POST', headers, body: file, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: WebErrorCode } | null;
    throw new WebReviewError(body?.code ?? 'INTERNAL_ERROR');
  }
  if (!response.body) {
    throw new WebReviewError('INTERNAL_ERROR');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const lines = (pending + value).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line) as ReviewEvent;
        if (event.type === 'progress') {
          onProgress(event);
        } else if (event.type === 'error') {
          throw new WebReviewError(event.code);
        } else if (event.type === 'report') {
          return event;
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new WebReviewError('MODEL_UNAVAILABLE');
}
