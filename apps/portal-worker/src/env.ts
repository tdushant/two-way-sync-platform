import { Expose, plainToInstance } from 'class-transformer';
import {
  IsIn,
  Validate,
  ValidationError,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

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
}

export interface PortalWorkerEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PORTAL_DATABASE_URL: string;
  FAKE_SALESFORCE_BASE_URL: string;
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

export function validatePortalWorkerEnv(config: Record<string, unknown>): PortalWorkerEnv {
  const nodeEnv = config['NODE_ENV'];
  const converted = plainToInstance(
    PortalWorkerEnvironment,
    {
      ...config,
      NODE_ENV: nodeEnv === undefined || nodeEnv === '' ? 'development' : nodeEnv,
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
  };
}
