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
import { SALESFORCE_API_CAP_PER_SECOND } from './budget/external-api-budget';

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
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'must be an http(s) URL';
  }
}

class PortalWorkerEnvironment {
  @Expose()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV!: 'development' | 'test' | 'production';

  @Expose()
  @Validate(PostgresUrlConstraint)
  PORTAL_DATABASE_URL!: string;

  @Expose()
  @Validate(HttpUrlConstraint)
  FAKE_SALESFORCE_BASE_URL!: string;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SALESFORCE_API_CAP_PER_SECOND)
  OUTBOUND_BUDGET_PER_SECOND!: number;

  @Expose()
  @Validate(HttpUrlConstraint)
  PORTAL_WEBHOOK_URL!: string;

  @Expose()
  @IsString()
  @MinLength(1)
  WEBHOOK_HMAC_SECRET!: string;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  RECONCILIATION_PAGE_LIMIT!: number;
}

export interface PortalWorkerEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PORTAL_DATABASE_URL: string;
  FAKE_SALESFORCE_BASE_URL: string;
  OUTBOUND_BUDGET_PER_SECOND: number;
  PORTAL_WEBHOOK_URL: string;
  WEBHOOK_HMAC_SECRET: string;
  RECONCILIATION_PAGE_LIMIT: number;
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

const LOCAL_WEBHOOK_HMAC_SECRET = 'local-webhook-secret';
const DEFAULT_PORTAL_WEBHOOK_URL = 'http://127.0.0.1:3000/webhooks/salesforce';

export function validatePortalWorkerEnv(config: Record<string, unknown>): PortalWorkerEnv {
  const nodeEnv = filled(config['NODE_ENV'], 'development');
  const secret = config['WEBHOOK_HMAC_SECRET'];
  if (
    nodeEnv === 'production' &&
    (secret === undefined || secret === '' || secret === LOCAL_WEBHOOK_HMAC_SECRET)
  ) {
    throw new Error(
      'Invalid environment: WEBHOOK_HMAC_SECRET: a non-default secret is required in production',
    );
  }
  const converted = plainToInstance(
    PortalWorkerEnvironment,
    {
      ...config,
      NODE_ENV: nodeEnv,
      OUTBOUND_BUDGET_PER_SECOND: filled(config['OUTBOUND_BUDGET_PER_SECOND'], '80'),
      PORTAL_WEBHOOK_URL: filled(config['PORTAL_WEBHOOK_URL'], DEFAULT_PORTAL_WEBHOOK_URL),
      WEBHOOK_HMAC_SECRET: filled(secret, LOCAL_WEBHOOK_HMAC_SECRET),
      RECONCILIATION_PAGE_LIMIT: filled(config['RECONCILIATION_PAGE_LIMIT'], '100'),
    },
    { excludeExtraneousValues: true, enableImplicitConversion: true },
  );
  const errors = validateSync(converted, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(`Invalid environment: ${formatValidationErrors(errors)}`);
  }
  return {
    NODE_ENV: converted.NODE_ENV,
    PORTAL_DATABASE_URL: converted.PORTAL_DATABASE_URL,
    FAKE_SALESFORCE_BASE_URL: converted.FAKE_SALESFORCE_BASE_URL,
    OUTBOUND_BUDGET_PER_SECOND: converted.OUTBOUND_BUDGET_PER_SECOND,
    PORTAL_WEBHOOK_URL: converted.PORTAL_WEBHOOK_URL,
    WEBHOOK_HMAC_SECRET: converted.WEBHOOK_HMAC_SECRET,
    RECONCILIATION_PAGE_LIMIT: converted.RECONCILIATION_PAGE_LIMIT,
  };
}
