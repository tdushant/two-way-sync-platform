import 'reflect-metadata';
import { validateSync, type ValidationError } from 'class-validator';
import { apiError, type ContractResult } from './errors';
import { assertCorrelationId } from './ids';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function presentValue<T>(input: Record<string, unknown>, allowed: readonly string[]): T {
  const value: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(input, key)) {
      value[key] = input[key];
    }
  }
  return value as T;
}

export function parseDto<T extends object>(
  dto: new () => T,
  input: unknown,
  allowed: readonly string[],
  correlationId: string,
): ContractResult<T> {
  assertCorrelationId(correlationId);
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', 'Body must be a JSON object'),
    };
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        error: apiError(correlationId, 400, 'unknown_field', `Unknown field ${key}`),
      };
    }
  }
  const instance = new dto();
  for (const key of allowed) {
    if (Object.hasOwn(input, key)) {
      (instance as Record<string, unknown>)[key] = input[key];
    }
  }
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    skipMissingProperties: false,
    skipNullProperties: false,
    skipUndefinedProperties: false,
  });
  if (errors.length > 0) {
    return {
      ok: false,
      error: apiError(correlationId, 400, 'validation_failed', formatErrors(errors)),
    };
  }
  return { ok: true, value: presentValue<T>(input, allowed) };
}

function formatErrors(errors: ValidationError[]): string {
  const messages: string[] = [];
  const visit = (error: ValidationError, prefix: string): void => {
    const name = prefix.length === 0 ? error.property : `${prefix}.${error.property}`;
    const constraints = error.constraints ? Object.values(error.constraints) : [];
    if (constraints.length > 0) {
      messages.push(constraints.map((message) => `${name}: ${message}`).join('; '));
    } else if ((error.children ?? []).length === 0) {
      messages.push(`${name} is invalid`);
    }
    for (const child of error.children ?? []) {
      visit(child, name);
    }
  };
  for (const error of errors) {
    visit(error, '');
  }
  return messages.join('; ');
}
