import { Body, Controller, Get, Headers, Param, Patch, Post, Res } from '@nestjs/common';
import {
  IDEMPOTENCY_KEY_HEADER,
  parseCreateCustomer,
  parseCustomerPatch,
  parseIdempotencyKey,
  parseIfMatch,
} from '@sync/contracts';
import type { PortalRequest, PortalResponse } from '../http/portal-request';
import { requestError } from '../http/portal-request.error';
import { unwrap } from '../http/unwrap';
import { CustomersService } from './customers.service';
import { Req } from '@nestjs/common';

@Controller('api/v1/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  async create(
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: PortalResponse,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | string[] | undefined,
  ): Promise<unknown> {
    const key = unwrap(
      parseIdempotencyKey(oneHeader(idempotencyKey, request.correlationId), request.correlationId),
    );
    const parsed = unwrap(parseCreateCustomer(body, request.correlationId));
    const result = await this.customers.create(
      parsed,
      actorId(request),
      key,
      request.correlationId,
    );
    response.status(result.created ? 201 : 200);
    return result.customer;
  }

  @Get(':id')
  get(@Req() request: PortalRequest, @Param('id') id: string): Promise<unknown> {
    return this.customers.get(id, request.correlationId);
  }

  @Patch(':id')
  patch(
    @Req() request: PortalRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | string[] | undefined,
  ): Promise<unknown> {
    const version = unwrap(
      parseIfMatch(oneHeader(ifMatch, request.correlationId), request.correlationId),
    );
    const parsed = unwrap(parseCustomerPatch(body, request.correlationId));
    return this.customers.patch(id, parsed, actorId(request), version, request.correlationId);
  }
}

function actorId(request: PortalRequest): string {
  if (!request.actorId) {
    throw requestError(request.correlationId, 401, 'Authentication required');
  }
  return request.actorId;
}

function oneHeader(
  value: string | string[] | undefined,
  correlationId: string,
): string | undefined {
  if (Array.isArray(value)) {
    throw requestError(correlationId, 400, 'Header must be a single value');
  }
  return value;
}
