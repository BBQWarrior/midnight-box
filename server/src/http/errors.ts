import type { ApiError } from '@shared/types';

export type ErrorCode = ApiError['error']['code'];

/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function apiError(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}
