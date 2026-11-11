import { Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { PortalRequestError } from './portal-request.error';
import type { PortalRequest, PortalResponse } from './portal-request';

@Catch()
export class PortalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PortalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<PortalResponse>();
    const request = http.getRequest<PortalRequest>();
    if (exception instanceof PortalRequestError) {
      response.status(exception.failure.statusCode).json(exception.failure);
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const correlationId = request.correlationId ?? '00000000-0000-4000-8000-000000000000';
    this.logger.error({ correlationId }, 'Portal request failed');
    response.status(500).json({
      correlationId,
      statusCode: 500,
      message: 'Request failed',
    });
  }
}
