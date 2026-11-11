import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { isUuid } from '@sync/contracts';
import { CORRELATION_HEADER } from './headers';
import type { PortalRequest, PortalResponse } from './portal-request';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: PortalRequest, response: PortalResponse, next: (error?: unknown) => void): void {
    const supplied = request.header(CORRELATION_HEADER);
    const correlationId = supplied && isUuid(supplied) ? supplied : randomUUID();
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    next();
  }
}
