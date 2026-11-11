import { EVENT_TYPES, OBJECT_TYPES, isOneOf, type EventType, type ObjectType } from './enums';
import { apiError, type ContractResult } from './errors';
import { isSafeInteger, isUtcTimestamp, isUuid } from './ids';
import { parseAccountPatch } from './customers';
import { parseSfContactPatch } from './salesforce';
import { isPlainObject } from './validate';

const WEBHOOK_KEYS = [
  'eventId',
  'objectType',
  'recordId',
  'eventType',
  'changedFields',
  'changedBy',
  'values',
  'occurredAt',
  'recordVersion',
  'originOperationId',
  'changeSequence',
] as const;

export interface CanonicalWebhook {
  eventId: string;
  objectType: ObjectType;
  recordId: string;
  eventType: EventType;
  changedFields: Record<string, string | null>;
  changedBy?: string;
  occurredAt: string;
  recordVersion?: number;
  originOperationId?: string | null;
  changeSequence?: number;
}

export function parseWebhook(
  input: unknown,
  correlationId: string,
): ContractResult<CanonicalWebhook> {
  if (!isPlainObject(input)) {
    return fail(correlationId, 'Body must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!WEBHOOK_KEYS.includes(key as (typeof WEBHOOK_KEYS)[number])) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'unknown_field', `Unknown field ${key}`),
      };
    }
  }
  if (typeof input.eventId !== 'string' || input.eventId.length === 0) {
    return fail(correlationId, 'eventId is required');
  }
  if (!isOneOf(OBJECT_TYPES, input.objectType)) {
    return fail(correlationId, 'objectType must be Account or Contact');
  }
  if (typeof input.recordId !== 'string' || input.recordId.length === 0) {
    return fail(correlationId, 'recordId is required');
  }
  if (!isOneOf(EVENT_TYPES, input.eventType)) {
    return fail(correlationId, 'eventType must be created or updated');
  }
  if (!isUtcTimestamp(input.occurredAt)) {
    return fail(correlationId, 'occurredAt must be an ISO 8601 UTC timestamp');
  }
  const fields = normalizeFields(input, input.objectType, correlationId);
  if (!fields.ok) {
    return fields;
  }
  const event: CanonicalWebhook = {
    eventId: input.eventId,
    objectType: input.objectType,
    recordId: input.recordId,
    eventType: input.eventType,
    changedFields: fields.value,
    occurredAt: input.occurredAt,
  };
  if (!Array.isArray(input.changedFields) && !Object.hasOwn(input, 'changedBy')) {
    return fail(correlationId, 'changedBy is required when changedFields is an object');
  }
  if (Object.hasOwn(input, 'changedBy')) {
    if (typeof input.changedBy !== 'string' || input.changedBy.length === 0) {
      return fail(correlationId, 'changedBy must be a non-empty string');
    }
    event.changedBy = input.changedBy;
  }
  if (Object.hasOwn(input, 'recordVersion')) {
    if (!isSafeInteger(input.recordVersion) || input.recordVersion < 0) {
      return fail(correlationId, 'recordVersion must be an integer >= 0');
    }
    event.recordVersion = input.recordVersion;
  }
  if (Object.hasOwn(input, 'originOperationId')) {
    if (input.originOperationId !== null && !isUuid(input.originOperationId)) {
      return fail(correlationId, 'originOperationId must be a UUID or null');
    }
    event.originOperationId = input.originOperationId as string | null;
  }
  if (Object.hasOwn(input, 'changeSequence')) {
    if (!isSafeInteger(input.changeSequence) || input.changeSequence < 0) {
      return fail(correlationId, 'changeSequence must be an integer >= 0');
    }
    event.changeSequence = input.changeSequence;
  }
  return { ok: true, value: event };
}

function normalizeFields(
  input: Record<string, unknown>,
  objectType: ObjectType,
  correlationId: string,
): ContractResult<Record<string, string | null>> {
  const changedFields = input.changedFields;
  if (isPlainObject(changedFields)) {
    const map = readFieldMap(changedFields, correlationId);
    if (!map.ok) {
      return map;
    }
    if (Object.hasOwn(input, 'values')) {
      if (!isPlainObject(input.values)) {
        return fail(correlationId, 'values must be an object');
      }
      const values = readFieldMap(input.values, correlationId);
      if (!values.ok) {
        return values;
      }
      if (!sameMap(map.value, values.value)) {
        return fail(correlationId, 'changedFields and values disagree');
      }
    }
    return checkAllowList(map.value, objectType, correlationId);
  }
  if (Array.isArray(changedFields)) {
    if (!changedFields.every((name) => typeof name === 'string' && name.length > 0)) {
      return fail(correlationId, 'changedFields names must be non-empty strings');
    }
    if (new Set(changedFields).size !== changedFields.length) {
      return fail(correlationId, 'changedFields names must be unique');
    }
    if (!isPlainObject(input.values)) {
      return fail(correlationId, 'values is required when changedFields is an array');
    }
    const values = readFieldMap(input.values, correlationId);
    if (!values.ok) {
      return values;
    }
    const names = Object.keys(values.value);
    if (
      names.length !== changedFields.length ||
      changedFields.some((name) => !Object.hasOwn(values.value, name))
    ) {
      return fail(correlationId, 'changedFields and values must name the same fields');
    }
    return checkAllowList(values.value, objectType, correlationId);
  }
  return fail(correlationId, 'changedFields must be an object or an array of field names');
}

function readFieldMap(
  input: Record<string, unknown>,
  correlationId: string,
): ContractResult<Record<string, string | null>> {
  const map: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && (typeof value !== 'string' || value.length === 0)) {
      return fail(correlationId, `${key} must be a non-empty string or null`);
    }
    map[key] = value as string | null;
  }
  return { ok: true, value: map };
}

function checkAllowList(
  fields: Record<string, string | null>,
  objectType: ObjectType,
  correlationId: string,
): ContractResult<Record<string, string | null>> {
  const parsed =
    objectType === 'Account'
      ? parseAccountPatch(fields, correlationId)
      : parseSfContactPatch(fields, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: fields };
}

function sameMap(
  left: Record<string, string | null>,
  right: Record<string, string | null>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function fail(correlationId: string, message: string): ContractResult<never> {
  return { ok: false, error: apiError(correlationId, 400, 'validation_failed', message) };
}
