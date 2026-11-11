import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { SalesforceRequestError } from './salesforce-request.error';
import type { SalesforceRequest, SalesforceResponse } from './salesforce-request';

@Catch()
export class SalesforceExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SalesforceExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<SalesforceResponse>();
    const request = http.getRequest<SalesforceRequest>();
    if (exception instanceof SalesforceRequestError) {
      response.status(exception.failure.statusCode).json(exception.failure);
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const correlationId = request.correlationId ?? '00000000-0000-4000-8000-000000000000';
    this.logger.error({ correlationId }, 'Fake Salesforce request failed');
    response.status(500).json({
      correlationId,
      statusCode: 500,
      message: 'Request failed',
    });
  }
}
