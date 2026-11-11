import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { isUuid } from '@sync/contracts';
import type { SalesforceRequest, SalesforceResponse } from './salesforce-request';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    request: SalesforceRequest,
    response: SalesforceResponse,
    next: (error?: unknown) => void,
  ): void {
    const supplied = request.header('x-correlation-id');
    const correlationId = supplied && isUuid(supplied) ? supplied : randomUUID();
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    next();
  }
}
