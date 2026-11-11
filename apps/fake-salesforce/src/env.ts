import { Expose, Type, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  Validate,
  ValidationError,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

const LOCAL_PORTAL_WEBHOOK_URL = 'http://127.0.0.1:3000/webhooks/salesforce';
const LOCAL_WEBHOOK_HMAC_SECRET = 'local-webhook-secret';
const LOCAL_SIMULATOR_ADMIN_TOKEN = 'local-simulator-token';

@ValidatorConstraint({ name: 'postgresUrl', async: false })
class PostgresUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
    try {
      const url = new URL(value);
      const database = url.pathname.replace(/^\//, '');
      return (
        (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
        url.username.length > 0 &&
        url.password.length > 0 &&
        database.length > 0
      );
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'must be a postgres URL with a user, password, and database name';
  }
}

@ValidatorConstraint({ name: 'httpUrl', async: false })
class HttpUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'must be an http or https URL';
  }
}

class FakeSalesforceEnvironment {
  @Expose()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV!: 'development' | 'test' | 'production';

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  SALESFORCE_HTTP_PORT!: number;

  @Expose()
  @Validate(PostgresUrlConstraint)
  SALESFORCE_DATABASE_URL!: string;

  @Expose()
  @Validate(HttpUrlConstraint)
  PORTAL_WEBHOOK_URL!: string;

  @Expose()
  @IsString()
  @MinLength(1)
  WEBHOOK_HMAC_SECRET!: string;

  @Expose()
  @IsString()
  @MinLength(1)
  SIMULATOR_ADMIN_TOKEN!: string;
}

export interface FakeSalesforceEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  SALESFORCE_HTTP_PORT: number;
  SALESFORCE_DATABASE_URL: string;
  PORTAL_WEBHOOK_URL: string;
  WEBHOOK_HMAC_SECRET: string;
  SIMULATOR_ADMIN_TOKEN: string;
}

function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((error) => {
      const messages = error.constraints ? Object.values(error.constraints) : [];
      const text = messages.length > 0 ? messages.join(', ') : 'invalid';
      return `${error.property}: ${text}`;
    })
    .join('; ');
}

function filled(value: unknown, fallback: string): unknown {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

export function validateFakeSalesforceEnv(config: Record<string, unknown>): FakeSalesforceEnv {
  const nodeEnv = filled(config['NODE_ENV'], 'development');
  if (nodeEnv === 'production') {
    requireProductionSetting(config, 'PORTAL_WEBHOOK_URL', LOCAL_PORTAL_WEBHOOK_URL);
    requireProductionSetting(config, 'WEBHOOK_HMAC_SECRET', LOCAL_WEBHOOK_HMAC_SECRET);
    requireProductionSetting(config, 'SIMULATOR_ADMIN_TOKEN', LOCAL_SIMULATOR_ADMIN_TOKEN);
  }
  const converted = plainToInstance(
    FakeSalesforceEnvironment,
    {
      ...config,
      NODE_ENV: nodeEnv,
      SALESFORCE_HTTP_PORT: filled(config['SALESFORCE_HTTP_PORT'], '3001'),
      PORTAL_WEBHOOK_URL: filled(config['PORTAL_WEBHOOK_URL'], LOCAL_PORTAL_WEBHOOK_URL),
      WEBHOOK_HMAC_SECRET: filled(config['WEBHOOK_HMAC_SECRET'], LOCAL_WEBHOOK_HMAC_SECRET),
      SIMULATOR_ADMIN_TOKEN: filled(config['SIMULATOR_ADMIN_TOKEN'], LOCAL_SIMULATOR_ADMIN_TOKEN),
    },
    { excludeExtraneousValues: true, enableImplicitConversion: true },
  );
  const errors = validateSync(converted, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(`Invalid environment: ${formatValidationErrors(errors)}`);
  }
  return {
    NODE_ENV: converted.NODE_ENV,
    SALESFORCE_HTTP_PORT: converted.SALESFORCE_HTTP_PORT,
    SALESFORCE_DATABASE_URL: converted.SALESFORCE_DATABASE_URL,
    PORTAL_WEBHOOK_URL: converted.PORTAL_WEBHOOK_URL,
    WEBHOOK_HMAC_SECRET: converted.WEBHOOK_HMAC_SECRET,
    SIMULATOR_ADMIN_TOKEN: converted.SIMULATOR_ADMIN_TOKEN,
  };
}

function requireProductionSetting(
  config: Record<string, unknown>,
  key: string,
  localDefault: string,
): void {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new Error(`Invalid environment: ${key}: is required in production`);
  }
  if (value === localDefault) {
    throw new Error(`Invalid environment: ${key}: local default is not allowed in production`);
  }
}
