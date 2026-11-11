import { Body, Controller, Get, Headers, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { parseCreateSfContact, parseSfContactPatch } from '@sync/contracts';
import { IDEMPOTENCY_KEY_HEADER, changedBy, operationId } from '../http/headers';
import type { SalesforceRequest, SalesforceResponse } from '../http/salesforce-request';
import { unwrap } from '../http/unwrap';
import type { WriteContext } from './accounts.service';
import { ContactsService } from './contacts.service';

@Controller('sf/v1/contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Post()
  async create(
    @Req() request: SalesforceRequest,
    @Res({ passthrough: true }) response: SalesforceResponse,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | string[] | undefined,
    @Headers('x-changed-by') editor: string | string[] | undefined,
  ): Promise<unknown> {
    const result = await this.contacts.create(
      unwrap(parseCreateSfContact(body, request.correlationId)),
      this.context(request, 'POST', '/sf/v1/contacts', idempotencyKey, editor),
    );
    response.status(result.status);
    return result.body;
  }

  @Get(':id')
  get(@Req() request: SalesforceRequest, @Param('id') id: string): Promise<unknown> {
    return this.contacts.get(id, request.correlationId);
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
    const result = await this.contacts.patch(
      id,
      unwrap(parseSfContactPatch(body, request.correlationId)),
      this.context(request, 'PATCH', `/sf/v1/contacts/${id}`, idempotencyKey, editor),
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
