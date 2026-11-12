import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { apiError, isUuid, type ApiError } from '@sync/contracts';
import { catchError, concatMap, from, switchMap, throwError, type Observable } from 'rxjs';
import { SalesforceRequestError } from '../http/salesforce-request.error';
import type { SalesforceRequest, SalesforceResponse } from '../http/salesforce-request';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../webhook/clock';
import { EMPTY_BUCKET_RETRY_AFTER_SECONDS } from '../webhook/delivery-policy';
import { TokenBucket } from '../webhook/token-bucket';
import { readSimulatorConfig } from './simulator-config';

class DataPlaneFault extends HttpException {
  readonly latencyMs: number;

  constructor(failure: ApiError, latencyMs: number) {
    super(failure, failure.statusCode);
    this.latencyMs = latencyMs;
  }
}

@Injectable()
export class DataPlaneInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly bucket: TokenBucket,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<SalesforceRequest>();
    const response = http.getResponse<SalesforceResponse>();
    const path = requestPath(request.url);
    if (!path.startsWith('/sf/v1') || path === '/sf/v1/health') {
      return next.handle();
    }
    return from(this.admit(request, response)).pipe(
      switchMap(() => next.handle()),
      concatMap(async (body) => {
        await this.record(request, path, response.statusCode || 200, 0);
        return body;
      }),
      catchError((error: unknown) =>
        from(this.record(request, path, httpStatus(error), faultLatency(error))).pipe(
          switchMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private async admit(request: SalesforceRequest, response: SalesforceResponse): Promise<void> {
    const config = await readSimulatorConfig(this.prisma.client);
    const method = request.method ?? 'GET';
    const mutating = method === 'POST' || method === 'PATCH';
    if (mutating && config.outageEnabled) {
      throw fault(request, 503, 'Salesforce outage', 0);
    }
    if (mutating && config.responseDelayMs > 0) {
      throw fault(request, 408, 'Salesforce timeout', config.responseDelayMs);
    }
    if (mutating && config.failureRate === 1) {
      throw fault(request, 500, 'Injected Salesforce failure', 0);
    }
    if (!this.bucket.allow(config.rateLimitPerSec, this.clock.now().getTime())) {
      response.setHeader('Retry-After', String(EMPTY_BUCKET_RETRY_AFTER_SECONDS));
      throw fault(request, 429, 'Salesforce rate limit exceeded', 0);
    }
  }

  private async record(
    request: SalesforceRequest,
    path: string,
    statusCode: number,
    latencyMs: number,
  ): Promise<void> {
    const header = request.header('idempotency-key');
    await this.prisma.client.sfApiRequestLog.create({
      data: {
        method: request.method ?? 'GET',
        path,
        operationId: header !== undefined && isUuid(header) ? header : null,
        statusCode,
        requestAt: this.clock.now(),
        latencyMs,
      },
    });
  }
}

function fault(
  request: SalesforceRequest,
  statusCode: number,
  message: string,
  latencyMs: number,
): DataPlaneFault {
  return new DataPlaneFault(
    apiError(request.correlationId, statusCode, 'validation_failed', message),
    latencyMs,
  );
}

function httpStatus(error: unknown): number {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (error instanceof SalesforceRequestError) {
    return error.failure.statusCode;
  }
  return 500;
}

function faultLatency(error: unknown): number {
  return error instanceof DataPlaneFault ? error.latencyMs : 0;
}

function requestPath(url: string | undefined): string {
  const raw = url ?? '';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}
