import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  FIELD_DECISIONS,
  FIELD_SOURCES,
  OUTBOX_STATUSES,
  PORTAL_ENTITY_TYPES,
  isOneOf,
  type FieldDecision,
  type FieldSource,
  type OutboxStatus,
  type PortalEntityType,
} from './enums';
import { apiError, type ContractResult } from './errors';
import { IsUtcTimestamp, isUuid } from './ids';
import { isPlainObject, parseDto } from './validate';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export interface SyncHealth {
  outboxPending: number;
  outboxOldestAgeSeconds: number;
  reconciliationLagSeconds: number;
  deadLetterTotal: number;
  checkpointCursor: string | null;
  workerObserved: boolean;
}

export interface HistoryEntry {
  id: string;
  entityType: PortalEntityType;
  entityId: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  source: FieldSource;
  actorId: string | null;
  eventId: string | null;
  operationId: string | null;
  sourceChangedAt: string | null;
  appliedAt: string;
  decision: FieldDecision;
}

const SYNC_HEALTH_FIELDS = [
  'outboxPending',
  'outboxOldestAgeSeconds',
  'reconciliationLagSeconds',
  'deadLetterTotal',
  'checkpointCursor',
  'workerObserved',
] as const;

const HISTORY_FIELDS = [
  'id',
  'entityType',
  'entityId',
  'fieldName',
  'oldValue',
  'newValue',
  'source',
  'actorId',
  'eventId',
  'operationId',
  'sourceChangedAt',
  'appliedAt',
  'decision',
] as const;

class SyncHealthDto {
  @IsInt()
  @Min(0)
  outboxPending!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  outboxOldestAgeSeconds!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  reconciliationLagSeconds!: number;

  @IsInt()
  @Min(0)
  deadLetterTotal!: number;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  checkpointCursor!: string | null;

  @IsBoolean()
  workerObserved!: boolean;
}

class HistoryDto {
  @IsUUID('all')
  id!: string;

  @IsIn(PORTAL_ENTITY_TYPES)
  entityType!: PortalEntityType;

  @IsUUID('all')
  entityId!: string;

  @IsString()
  @MinLength(1)
  fieldName!: string;

  @ValidateBy({
    name: 'isJsonValue',
    validator: {
      validate: (value: unknown) => isJsonValue(value),
      defaultMessage: () => 'must be JSON',
    },
  })
  oldValue!: unknown;

  @ValidateBy({
    name: 'isJsonValue',
    validator: {
      validate: (value: unknown) => isJsonValue(value),
      defaultMessage: () => 'must be JSON',
    },
  })
  newValue!: unknown;

  @IsIn(FIELD_SOURCES)
  source!: FieldSource;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  actorId!: string | null;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  eventId!: string | null;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsUUID('all')
  operationId!: string | null;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsUtcTimestamp()
  sourceChangedAt!: string | null;

  @IsUtcTimestamp()
  appliedAt!: string;

  @IsIn(FIELD_DECISIONS)
  decision!: FieldDecision;
}

export function parseSyncHealth(input: unknown, correlationId: string): ContractResult<SyncHealth> {
  const parsed = parseDto(SyncHealthDto, input, SYNC_HEALTH_FIELDS, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  for (const key of SYNC_HEALTH_FIELDS) {
    if (!Object.hasOwn(parsed.value as object, key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', `${key} is required`),
      };
    }
  }
  return parsed as ContractResult<SyncHealth>;
}

export function parseHistoryEntry(
  input: unknown,
  correlationId: string,
): ContractResult<HistoryEntry> {
  const parsed = parseDto(HistoryDto, input, HISTORY_FIELDS, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  for (const key of HISTORY_FIELDS) {
    if (!Object.hasOwn(parsed.value as object, key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', `${key} is required`),
      };
    }
  }
  const entry = parsed.value as HistoryEntry;
  if (!isJsonValue(entry.oldValue) || !isJsonValue(entry.newValue)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'history values must be JSON'),
    };
  }
  return { ok: true, value: entry };
}

export function parseOutboxStatus(
  value: unknown,
  correlationId: string,
): ContractResult<OutboxStatus | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isOneOf(OUTBOX_STATUSES, value)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'status must be an outbox status'),
    };
  }
  return { ok: true, value };
}

export function parseOperationId(value: unknown, correlationId: string): ContractResult<string> {
  if (!isUuid(value)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'operationId must be a UUID'),
    };
  }
  return { ok: true, value };
}

export function parseIdempotencyKey(value: unknown, correlationId: string): ContractResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return {
      ok: false,
      error: apiError(
        correlationId,
        400,
        'validation_failed',
        'Idempotency-Key must be a non-empty string',
      ),
    };
  }
  return { ok: true, value };
}

export function parseIfMatch(
  value: string | undefined,
  correlationId: string,
): ContractResult<number | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return {
      ok: false,
      error: apiError(
        correlationId,
        400,
        'validation_failed',
        'If-Match must be an integer rowVersion',
      ),
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'If-Match exceeds a safe integer'),
    };
  }
  return { ok: true, value: parsed };
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
