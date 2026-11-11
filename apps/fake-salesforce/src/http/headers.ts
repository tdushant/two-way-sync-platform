import { IDEMPOTENCY_KEY_HEADER, parseOperationId } from '@sync/contracts';
import { requestError } from './salesforce-request.error';
import { unwrap } from './unwrap';

export function operationId(
  value: string | string[] | undefined,
  correlationId: string,
): string | null {
  const header = oneHeader(value, correlationId);
  if (header === undefined) {
    return null;
  }
  return unwrap(parseOperationId(header, correlationId));
}

/** Working assumption: local editors send X-Changed-By. Absent stays null on the change log. */
export function changedBy(
  value: string | string[] | undefined,
  correlationId: string,
): string | null {
  const header = oneHeader(value, correlationId);
  if (header === undefined) {
    return null;
  }
  if (header.trim().length === 0 || header !== header.trim()) {
    throw requestError(correlationId, 400, 'X-Changed-By must be a non-empty string');
  }
  return header;
}

export function oneHeader(
  value: string | string[] | undefined,
  correlationId: string,
): string | undefined {
  if (Array.isArray(value)) {
    throw requestError(correlationId, 400, 'Header must be a single value');
  }
  return value;
}

export { IDEMPOTENCY_KEY_HEADER };
