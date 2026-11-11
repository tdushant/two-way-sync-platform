import { apiError, type ApiError } from '@sync/contracts';

export class SalesforceRequestError extends Error {
  readonly failure: ApiError;

  constructor(failure: ApiError) {
    super(failure.message);
    this.name = 'SalesforceRequestError';
    this.failure = failure;
  }
}

export function requestError(
  correlationId: string,
  statusCode: number,
  message: string,
): SalesforceRequestError {
  return new SalesforceRequestError(
    apiError(correlationId, statusCode, 'validation_failed', message),
  );
}
