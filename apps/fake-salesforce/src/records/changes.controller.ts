import { Controller, Get, Query, Req } from '@nestjs/common';
import { parseChangesQuery } from '@sync/contracts';
import { requestError } from '../http/salesforce-request.error';
import type { SalesforceRequest } from '../http/salesforce-request';
import { unwrap } from '../http/unwrap';
import { ChangesService } from './changes.service';

@Controller('sf/v1/changes')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  @Get()
  page(
    @Req() request: SalesforceRequest,
    @Query('after') after?: string | string[],
    @Query('limit') limit?: string | string[],
  ): Promise<Record<string, unknown>[]> {
    const query = unwrap(
      parseChangesQuery(
        {
          after: queryInteger(oneQuery(after, request.correlationId)),
          limit: queryInteger(oneQuery(limit, request.correlationId)),
        },
        request.correlationId,
      ),
    );
    return this.changes.page(query);
  }
}

function oneQuery(value: string | string[] | undefined, correlationId: string): string | undefined {
  if (Array.isArray(value)) {
    throw requestError(correlationId, 400, 'Query parameter must be a single value');
  }
  return value;
}

function queryInteger(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}
