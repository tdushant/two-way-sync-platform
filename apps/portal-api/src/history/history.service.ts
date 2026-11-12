import { Injectable } from '@nestjs/common';
import {
  isUuid,
  parseHistoryEntry,
  type HistoryEntry,
  type PortalEntityType,
} from '@sync/contracts';
import { PortalRequestError, requestError } from '../http/portal-request.error';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface HistoryPage {
  items: HistoryEntry[];
  nextCursor: string | null;
}

@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    entityType: PortalEntityType,
    entityId: string,
    after: string | string[] | undefined,
    limit: string | string[] | undefined,
    correlationId: string,
  ): Promise<HistoryPage> {
    if (!isUuid(entityId)) {
      throw requestError(correlationId, 400, 'id must be a UUID');
    }
    const cursor = one(after, correlationId);
    const size = pageLimit(one(limit, correlationId), correlationId);
    if (cursor !== undefined && !isUuid(cursor)) {
      throw requestError(correlationId, 400, 'after must be a UUID');
    }
    const exists = await this.exists(entityType, entityId);
    if (!exists) {
      throw requestError(correlationId, 404, 'Record was not found');
    }
    const anchor =
      cursor === undefined
        ? null
        : await this.prisma.client.fieldHistory.findUnique({ where: { id: cursor } });
    if (
      cursor !== undefined &&
      (anchor === null || anchor.entityType !== entityType || anchor.entityId !== entityId)
    ) {
      throw requestError(correlationId, 400, 'after is not a history row for this record');
    }
    const rows = await this.prisma.client.fieldHistory.findMany({
      where: {
        entityType,
        entityId,
        ...(anchor === null
          ? {}
          : {
              OR: [
                { appliedAt: { gt: anchor.appliedAt } },
                { appliedAt: anchor.appliedAt, id: { gt: anchor.id } },
              ],
            }),
      },
      orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }],
      take: size,
    });
    const items = rows.map((row) => {
      const parsed = parseHistoryEntry(
        {
          id: row.id,
          entityType: row.entityType,
          entityId: row.entityId,
          fieldName: row.fieldName,
          oldValue: row.oldValue,
          newValue: row.newValue,
          source: row.source,
          actorId: row.actorId,
          eventId: row.eventId,
          operationId: row.operationId,
          sourceChangedAt: row.sourceChangedAt === null ? null : row.sourceChangedAt.toISOString(),
          appliedAt: row.appliedAt.toISOString(),
          decision: row.decision,
        },
        correlationId,
      );
      if (!parsed.ok) {
        throw new PortalRequestError(parsed.error);
      }
      return parsed.value;
    });
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: items.length === size && last !== undefined ? last.id : null,
    };
  }

  private async exists(entityType: PortalEntityType, entityId: string): Promise<boolean> {
    if (entityType === 'customer') {
      const row = await this.prisma.client.customer.findUnique({
        where: { id: entityId },
        select: { id: true },
      });
      return row !== null;
    }
    const row = await this.prisma.client.contact.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
    return row !== null;
  }
}

function one(value: string | string[] | undefined, correlationId: string): string | undefined {
  if (Array.isArray(value)) {
    throw requestError(correlationId, 400, 'Query parameter must be a single value');
  }
  return value;
}

function pageLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw requestError(correlationId, 400, 'limit must be an integer from 1 through 100');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIMIT) {
    throw requestError(correlationId, 400, 'limit must be an integer from 1 through 100');
  }
  return parsed;
}
