import { Body, Controller, Get, Headers, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { parseAccountPatch, parseCreateAccount } from '@sync/contracts';
import { IDEMPOTENCY_KEY_HEADER, changedBy, operationId } from '../http/headers';
import type { SalesforceRequest, SalesforceResponse } from '../http/salesforce-request';
import { unwrap } from '../http/unwrap';
import { AccountsService, type WriteContext } from './accounts.service';

@Controller('sf/v1/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  async create(
    @Req() request: SalesforceRequest,
    @Res({ passthrough: true }) response: SalesforceResponse,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | string[] | undefined,
    @Headers('x-changed-by') editor: string | string[] | undefined,
  ): Promise<unknown> {
    const result = await this.accounts.create(
      unwrap(parseCreateAccount(body, request.correlationId)),
      this.context(request, 'POST', '/sf/v1/accounts', idempotencyKey, editor),
    );
    response.status(result.status);
    return result.body;
  }

  @Get(':id')
  get(@Req() request: SalesforceRequest, @Param('id') id: string): Promise<unknown> {
    return this.accounts.get(id, request.correlationId);
  }

  @Patch(':id')
  async patch(
    @Req() request: SalesforceRequest,
    @Res({ passthrough: true }) response: SalesforceResponse,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | string[] | undefined,
    @Headers('x-changed-by') editor: string | string[] | undefined,
  ): Promise<unknown> {
    const result = await this.accounts.patch(
      id,
      unwrap(parseAccountPatch(body, request.correlationId)),
      this.context(request, 'PATCH', `/sf/v1/accounts/${id}`, idempotencyKey, editor),
    );
    response.status(result.status);
    return result.body;
  }

  private context(
    request: SalesforceRequest,
    method: string,
    path: string,
    idempotencyKey: string | string[] | undefined,
    editor: string | string[] | undefined,
  ): WriteContext {
    return {
      correlationId: request.correlationId,
      operationId: operationId(idempotencyKey, request.correlationId),
      changedBy: changedBy(editor, request.correlationId),
      method,
      path,
    };
  }
}
