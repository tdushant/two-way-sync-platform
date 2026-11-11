import { IsDefined, IsInt, IsString, IsUUID, Min, MinLength, ValidateIf } from 'class-validator';
import { apiError, type ContractResult } from './errors';
import { IsUtcTimestamp } from './ids';
import { parseDto } from './validate';

export const CONTACT_WRITE_FIELDS = [
  'customerId',
  'fullName',
  'email',
  'phone',
  'city',
  'ownerId',
] as const;

export const CONTACT_PATCH_FIELDS = [...CONTACT_WRITE_FIELDS] as const;

export const CONTACT_RESPONSE_FIELDS = [
  'id',
  'salesforceId',
  'customerId',
  'fullName',
  'email',
  'phone',
  'city',
  'ownerId',
  'rowVersion',
  'createdAt',
  'updatedAt',
] as const;

export interface CreateContact {
  customerId: string;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  ownerId?: string | null;
}

export interface ContactPatch {
  customerId?: string;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  ownerId?: string | null;
}

export interface Contact {
  id: string;
  salesforceId: string | null;
  customerId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  ownerId: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

class ContactFieldsDto {
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

class CreateContactDto extends ContactFieldsDto {
  @IsDefined()
  @IsUUID('all')
  customerId!: string;
}

class ContactPatchDto extends ContactFieldsDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID('all')
  customerId?: string;
}

class ContactDto extends ContactFieldsDto {
  @IsUUID('all')
  id!: string;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  salesforceId!: string | null;

  @IsUUID('all')
  customerId!: string;

  @IsInt()
  @Min(0)
  rowVersion!: number;

  @IsUtcTimestamp()
  createdAt!: string;

  @IsUtcTimestamp()
  updatedAt!: string;
}

export function parseCreateContact(
  input: unknown,
  correlationId: string,
): ContractResult<CreateContact> {
  return parseDto(CreateContactDto, input, CONTACT_WRITE_FIELDS, correlationId);
}

export function parseContactPatch(
  input: unknown,
  correlationId: string,
): ContractResult<ContactPatch> {
  return parseDto(ContactPatchDto, input, CONTACT_PATCH_FIELDS, correlationId);
}

export function parseContact(input: unknown, correlationId: string): ContractResult<Contact> {
  const parsed = parseDto(ContactDto, input, CONTACT_RESPONSE_FIELDS, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  for (const key of CONTACT_RESPONSE_FIELDS) {
    if (!Object.hasOwn(parsed.value as object, key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', `${key} is required`),
      };
    }
  }
  return parsed as ContractResult<Contact>;
}
