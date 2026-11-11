import { IsDefined, IsInt, IsString, IsUUID, Min, MinLength, ValidateIf } from 'class-validator';
import { apiError, type ContractResult } from './errors';
import { IsUtcTimestamp, isUuid } from './ids';
import { parseDto } from './validate';

export const CUSTOMER_WRITE_FIELDS = ['name', 'status', 'ownerId'] as const;
export const CUSTOMER_RESPONSE_FIELDS = [
  'id',
  'salesforceId',
  'name',
  'status',
  'ownerId',
  'rowVersion',
  'createdAt',
  'updatedAt',
] as const;

export interface CreateCustomer {
  name: string;
  status?: string | null;
  ownerId?: string | null;
}

export interface CustomerPatch {
  name?: string;
  status?: string | null;
  ownerId?: string | null;
}

export interface Customer {
  id: string;
  salesforceId: string | null;
  name: string;
  status: string | null;
  ownerId: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateAccount = CreateCustomer;
export type AccountPatch = CustomerPatch;

class CreateCustomerDto {
  @IsDefined()
  @IsString()
  @MinLength(1)
  name!: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  status?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  ownerId?: string | null;
}

class CustomerPatchDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  name?: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  status?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  ownerId?: string | null;
}

class CustomerDto {
  @IsUUID('all')
  id!: string;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  salesforceId!: string | null;

  @IsString()
  @MinLength(1)
  name!: string;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  status!: string | null;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  ownerId!: string | null;

  @IsInt()
  @Min(0)
  rowVersion!: number;

  @IsUtcTimestamp()
  createdAt!: string;

  @IsUtcTimestamp()
  updatedAt!: string;
}

export function parseCreateCustomer(
  input: unknown,
  correlationId: string,
): ContractResult<CreateCustomer> {
  return parseDto(CreateCustomerDto, input, CUSTOMER_WRITE_FIELDS, correlationId);
}

export function parseCustomerPatch(
  input: unknown,
  correlationId: string,
): ContractResult<CustomerPatch> {
  return parseDto(CustomerPatchDto, input, CUSTOMER_WRITE_FIELDS, correlationId);
}

export function parseCustomer(input: unknown, correlationId: string): ContractResult<Customer> {
  const parsed = parseDto(CustomerDto, input, CUSTOMER_RESPONSE_FIELDS, correlationId);
  if (!parsed.ok) {
    return parsed;
  }
  for (const key of CUSTOMER_RESPONSE_FIELDS) {
    if (!Object.hasOwn(parsed.value as object, key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'validation_failed', `${key} is required`),
      };
    }
  }
  if (!isUuid((parsed.value as Customer).id)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'id must be a UUID'),
    };
  }
  return parsed as ContractResult<Customer>;
}

export const parseCreateAccount = parseCreateCustomer;
export const parseAccountPatch = parseCustomerPatch;
