export type ReviewErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_DOCUMENT'
  | 'LIMIT_EXCEEDED'
  | 'NO_TEXT'
  | 'NO_REQUIREMENTS'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_CONFIG'
  | 'MODEL_CONTEXT'
  | 'MODEL_LIMIT'
  | 'MODEL_UNAVAILABLE'
  | 'BUSY';

export class ReviewError extends Error {
  constructor(
    public readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
