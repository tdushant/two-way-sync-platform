import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsNumber,
  IsString,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { apiError, type ContractResult } from './errors';
import { isSafeInteger } from './ids';
import { parseDto } from './validate';

export const SF_CONTACT_FIELDS = [
  'accountId',
  'fullName',
  'email',
  'phone',
  'city',
  'ownerId',
] as const;

export interface CreateSfContact {
  accountId: string;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  ownerId?: string | null;
}

export interface SfContactPatch {
  accountId?: string;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  ownerId?: string | null;
}

export interface ChangesQuery {
  after?: number;
  limit: number;
}

export interface SimulatorConfig {
  outageEnabled: boolean;
  webhookEnabled: boolean;
  duplicateCount: number;
  delayMs: number;
  disorderMode: string;
  failureRate: number;
  rateLimitPerSec: number;
  dropWebhookRate: number;
  responseDelayMs: number;
}

export interface ReorderDeliveries {
  eventIds: string[];
}

class SfContactFieldsDto {
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  fullName?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  email?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  phone?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  city?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  ownerId?: string | null;
}

class CreateSfContactDto extends SfContactFieldsDto {
  @IsDefined()
  @IsString()
  @MinLength(1)
  accountId!: string;
}

class SfContactPatchDto extends SfContactFieldsDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  accountId?: string;
}

const SIMULATOR_FIELDS = [
  'outageEnabled',
  'webhookEnabled',
  'duplicateCount',
  'delayMs',
  'disorderMode',
  'failureRate',
  'rateLimitPerSec',
  'dropWebhookRate',
  'responseDelayMs',
] as const;

class SimulatorConfigDto {
  @IsBoolean()
  outageEnabled!: boolean;

  @IsBoolean()
  webhookEnabled!: boolean;

  @IsInt()
  @Min(0)
  duplicateCount!: number;

  @IsInt()
  @Min(0)
  delayMs!: number;

  @IsString()
  @MinLength(1)
  disorderMode!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  failureRate!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  rateLimitPerSec!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  dropWebhookRate!: number;

  @IsInt()
  @Min(0)
  responseDelayMs!: number;
}

export function parseCreateSfContact(
  input: unknown,
  correlationId: string,
): ContractResult<CreateSfContact> {
  return parseDto(CreateSfContactDto, input, SF_CONTACT_FIELDS, correlationId);
}

export function parseSfContactPatch(
  input: unknown,
  correlationId: string,
): ContractResult<SfContactPatch> {
  return parseDto(SfContactPatchDto, input, SF_CONTACT_FIELDS, correlationId);
}

export function parseSimulatorConfig(
  input: unknown,
  correlationId: string,
): ContractResult<SimulatorConfig> {
  const parsed = parseDto(SimulatorConfigDto, input, SIMULATOR_FIELDS, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  for (const key of SIMULATOR_FIELDS) {
    if (!Object.hasOwn(parsed.value as object, key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', `${key} is required`),
      };
    }
  }
  return parsed as ContractResult<SimulatorConfig>;
}

export function parseChangesQuery(
  input: { after?: unknown; limit?: unknown },
  correlationId: string,
): ContractResult<ChangesQuery> {
  const query: ChangesQuery = { limit: 100 };
  if (input.after !== undefined) {
    if (!isSafeInteger(input.after) || input.after < 0) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', 'after must be an integer >= 0'),
      };
    }
    query.after = input.after;
  }
  if (input.limit !== undefined) {
    if (!isSafeInteger(input.limit) || input.limit < 1) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', 'limit must be an integer >= 1'),
      };
    }
    query.limit = input.limit;
  }
  return { ok: true, value: query };
}

export function parseReorderDeliveries(
  input: unknown,
  correlationId: string,
): ContractResult<ReorderDeliveries> {
  const parsed = parseDto(ReorderDto, input, ['eventIds'], correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  const eventIds = (parsed.value as { eventIds?: unknown }).eventIds;
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return {
      ok: false,
      error: apiError(
        correlationId,
        400,
        'validation_failed',
        'eventIds must be a non-empty array',
      ),
    };
  }
  if (eventIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return {
      ok: false,
      error: apiError(
        correlationId,
        400,
        'validation_failed',
        'eventIds must contain non-empty strings',
      ),
    };
  }
  if (new Set(eventIds).size !== eventIds.length) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'eventIds must be unique'),
    };
  }
  return { ok: true, value: { eventIds } };
}

class ReorderDto {
  @IsDefined()
  eventIds!: unknown;
}
