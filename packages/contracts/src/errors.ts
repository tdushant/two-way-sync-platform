import { ERROR_CODES, type ErrorCode } from './enums';
import { assertCorrelationId, isUuid } from './ids';

export interface ApiError {
  correlationId: string;
  statusCode: number;
  code: ErrorCode;
  message: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export function apiError(
  correlationId: string,
  statusCode: number,
  code: ErrorCode,
  message: string,
): ApiError {
  assertCorrelationId(correlationId);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    throw new Error('API error statusCode must be an integer from 400 through 599');
  }
  if (!ERROR_CODES.includes(code)) {
    throw new Error('Unknown API error code');
  }
  if (message.trim().length === 0) {
    throw new Error('API error message is required');
  }
  return { correlationId, statusCode, code, message };
}

export function parseApiError(input: unknown): ContractResult<ApiError> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return rejected('Body must be a JSON object');
  }
  const body = input as Record<string, unknown>;
  const allowed = ['correlationId', 'statusCode', 'code', 'message'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return rejected(`Unknown field ${key}`);
    }
  }
  if (!isUuid(body.correlationId)) {
    return rejected('correlationId must be a UUID');
  }
  if (
    !Number.isInteger(body.statusCode) ||
    (body.statusCode as number) < 400 ||
    (body.statusCode as number) > 599
  ) {
    return rejected('statusCode must be an integer from 400 through 599');
  }
  if (typeof body.code !== 'string' || !ERROR_CODES.includes(body.code as ErrorCode)) {
    return rejected('code is not a known error code');
  }
  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    return rejected('message must be a non-empty string');
  }
  return {
    ok: true,
    value: {
      correlationId: body.correlationId,
      statusCode: body.statusCode as number,
      code: body.code as ErrorCode,
      message: body.message,
    },
  };
}

function rejected(message: string): ContractResult<ApiError> {
  return {
    ok: false,
    error: {
      correlationId: '00000000-0000-4000-8000-000000000000',
      statusCode: 400,
      code: 'validation_failed',
      message,
    },
  };
}
