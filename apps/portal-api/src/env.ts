import { Expose, Type, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  Max,
  Min,
  Validate,
  ValidationError,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

@ValidatorConstraint({ name: 'postgresUrl', async: false })
export class PostgresUrlConstraint implements ValidatorConstraintInterface {
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

class PortalApiEnvironment {
  @Expose()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV!: 'development' | 'test' | 'production';

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  PORTAL_HTTP_PORT!: number;

  @Expose()
  @Validate(PostgresUrlConstraint)
  PORTAL_DATABASE_URL!: string;
}

export interface PortalApiEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PORTAL_HTTP_PORT: number;
  PORTAL_DATABASE_URL: string;
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

export function validatePortalApiEnv(config: Record<string, unknown>): PortalApiEnv {
  const converted = plainToInstance(
    PortalApiEnvironment,
    {
      ...config,
      NODE_ENV: filled(config['NODE_ENV'], 'development'),
      PORTAL_HTTP_PORT: filled(config['PORTAL_HTTP_PORT'], '3000'),
    },
    { excludeExtraneousValues: true, enableImplicitConversion: true },
  );
  const errors = validateSync(converted, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(`Invalid environment: ${formatValidationErrors(errors)}`);
  }
  return {
    NODE_ENV: converted.NODE_ENV,
    PORTAL_HTTP_PORT: converted.PORTAL_HTTP_PORT,
    PORTAL_DATABASE_URL: converted.PORTAL_DATABASE_URL,
  };
}
