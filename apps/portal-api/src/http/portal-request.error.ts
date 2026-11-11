import { apiError, type ApiError } from '@sync/contracts';

export class PortalRequestError extends Error {
  readonly failure: ApiError;

  constructor(failure: ApiError) {
    super(failure.message);
    this.name = 'PortalRequestError';
    this.failure = failure;
  }
}

export function requestError(
  correlationId: string,
  statusCode: number,
  message: string,
): PortalRequestError {
  return new PortalRequestError(apiError(correlationId, statusCode, 'validation_failed', message));
}
