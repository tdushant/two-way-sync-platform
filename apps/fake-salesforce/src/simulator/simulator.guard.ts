import { timingSafeEqual } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError, isUuid } from '@sync/contracts';
import type { SalesforceRequest, SalesforceResponse } from '../http/salesforce-request';

export const SIMULATOR_TOKEN_HEADER = 'x-simulator-token';
const MISSING_CORRELATION_ID = '00000000-0000-4000-8000-000000000000';

@Injectable()
export class SimulatorGuard implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(
    request: SalesforceRequest,
    response: SalesforceResponse,
    next: (error?: unknown) => void,
  ): void {
    const correlationId = isUuid(request.correlationId)
      ? request.correlationId
      : MISSING_CORRELATION_ID;
    if (this.config.get<string>('NODE_ENV') === 'production') {
      response.status(404).json({
        correlationId,
        statusCode: 404,
        message: 'Not found',
      });
      return;
    }
    const supplied = request.header(SIMULATOR_TOKEN_HEADER);
    if (supplied === undefined || supplied.length === 0 || supplied !== supplied.trim()) {
      response
        .status(401)
        .json(apiError(correlationId, 401, 'validation_failed', 'Simulator token is required'));
      return;
    }
    const expected = this.config.getOrThrow<string>('SIMULATOR_ADMIN_TOKEN');
    if (!tokensMatch(supplied, expected)) {
      response
        .status(403)
        .json(apiError(correlationId, 403, 'validation_failed', 'Simulator token is invalid'));
      return;
    }
    next();
  }
}

function tokensMatch(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
