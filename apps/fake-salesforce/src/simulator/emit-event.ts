import { apiError, isUtcTimestamp, isUuid, type ObjectType } from '@sync/contracts';
import { SalesforceRequestError } from '../http/salesforce-request.error';

const EMIT_KEYS = [
  'objectType',
  'recordId',
  'occurredAt',
  'changedFields',
  'changedBy',
  'recordVersion',
  'originOperationId',
] as const;

const ACCOUNT_FIELDS = ['name', 'status', 'ownerId'] as const;
const CONTACT_FIELDS = ['accountId', 'fullName', 'email', 'phone', 'city', 'ownerId'] as const;

export interface EmitEvent {
  objectType: ObjectType;
  recordId: string;
  occurredAt: string;
  changedFields: Record<string, string | null>;
  changedBy: string;
  recordVersion?: number;
  originOperationId: string | null;
}

export function parseEmitEvent(input: unknown, correlationId: string): EmitEvent {
  if (!isRecord(input)) {
    throw failure(correlationId, 400, 'validation_failed', 'Body must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!EMIT_KEYS.includes(key as (typeof EMIT_KEYS)[number])) {
      throw failure(correlationId, 400, 'unknown_field', `Unknown field ${key}`);
    }
  }
  if (input.objectType !== 'Account' && input.objectType !== 'Contact') {
    throw failure(correlationId, 400, 'validation_failed', 'objectType must be Account or Contact');
  }
  if (typeof input.recordId !== 'string' || input.recordId.length === 0) {
    throw failure(correlationId, 400, 'validation_failed', 'recordId is required');
  }
  if (!isUtcTimestamp(input.occurredAt)) {
    throw failure(
      correlationId,
      400,
      'validation_failed',
      'occurredAt must be an ISO 8601 UTC timestamp',
    );
  }
  if (
    typeof input.changedBy !== 'string' ||
    input.changedBy !== input.changedBy.trim() ||
    input.changedBy.length === 0
  ) {
    throw failure(correlationId, 400, 'validation_failed', 'changedBy must be a non-empty string');
  }
  const allowed = input.objectType === 'Account' ? ACCOUNT_FIELDS : CONTACT_FIELDS;
  const changedFields = parseFields(input.changedFields, allowed, correlationId);
  let recordVersion: number | undefined;
  if (Object.hasOwn(input, 'recordVersion')) {
    if (!isWholeNumber(input.recordVersion) || input.recordVersion < 0) {
      throw failure(
        correlationId,
        400,
        'validation_failed',
        'recordVersion must be an integer >= 0',
      );
    }
    recordVersion = input.recordVersion;
  }
  let originOperationId: string | null = null;
  if (Object.hasOwn(input, 'originOperationId') && input.originOperationId !== null) {
    if (!isUuid(input.originOperationId)) {
      throw failure(correlationId, 400, 'validation_failed', 'originOperationId must be a UUID');
    }
    originOperationId = input.originOperationId;
  }
  return {
    objectType: input.objectType,
    recordId: input.recordId,
    occurredAt: input.occurredAt,
    changedFields,
    changedBy: input.changedBy,
    ...(recordVersion === undefined ? {} : { recordVersion }),
    originOperationId,
  };
}

function parseFields(
  value: unknown,
  allowed: readonly string[],
  correlationId: string,
): Record<string, string | null> {
  if (!isRecord(value)) {
    throw failure(correlationId, 400, 'validation_failed', 'changedFields must be an object');
  }
  const fields: Record<string, string | null> = {};
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw failure(correlationId, 400, 'unknown_field', `Unknown field ${key}`);
    }
    const field = value[key];
    if (field !== null && (typeof field !== 'string' || field.length === 0)) {
      throw failure(correlationId, 400, 'validation_failed', `${key} must be a string or null`);
    }
    if ((key === 'name' || key === 'accountId') && field === null) {
      throw failure(correlationId, 400, 'validation_failed', `${key} cannot be cleared`);
    }
    fields[key] = field;
  }
  if (Object.keys(fields).length === 0) {
    throw failure(correlationId, 400, 'validation_failed', 'changedFields must include a field');
  }
  return fields;
}

function failure(
  correlationId: string,
  statusCode: number,
  code: 'validation_failed' | 'unknown_field',
  message: string,
): SalesforceRequestError {
  return new SalesforceRequestError(apiError(correlationId, statusCode, code, message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
