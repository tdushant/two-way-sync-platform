import { Injectable } from '@nestjs/common';
import type { ChangesQuery } from '@sync/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { versionNumber } from './writes';

@Injectable()
export class ChangesService {
  constructor(private readonly prisma: PrismaService) {}

  async page(query: ChangesQuery): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.client.sfChangeLog.findMany({
      where: query.after === undefined ? undefined : { sequence: { gt: BigInt(query.after) } },
      orderBy: { sequence: 'asc' },
      take: query.limit,
    });
    return rows.map((row) => {
      const recordVersion = versionNumber(row.version);
      return {
        eventId: row.eventId,
        objectType: row.objectType,
        recordId: row.recordId,
        eventType: recordVersion === 1 ? 'created' : 'updated',
        changedFields: row.changedFields,
        changedBy: row.changedBy,
        occurredAt: row.occurredAt.toISOString(),
        recordVersion,
        originOperationId: row.originOperationId,
        changeSequence: versionNumber(row.sequence),
      };
    });
  }
}
