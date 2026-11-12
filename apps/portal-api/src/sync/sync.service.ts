import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OutboxStatus, SyncHealth } from '@sync/contracts';
import { Clock } from '../clock';
import { requestError } from '../http/portal-request.error';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookCounters } from './webhook-counters';
import { workerWasObserved } from './worker-observed';

const CHANGES_STREAM = 'sf_changes';
const QUOTA_BUCKET = 'external_api';
const UNFINISHED = ['PENDING', 'IN_FLIGHT', 'RETRY'] as const;
const LATENCY_BOUNDS = [1, 5, 10, 30, 60, 300] as const;

export interface OutboxInspection {
  id: string;
  operationId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  changedFields: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationRequest {
  id: string;
  command: 'reconciliation';
  status: 'PENDING';
}

export interface SyncMetrics {
  outbox_pending_total: number;
  outbox_oldest_age_seconds: number;
  sync_latency_seconds: {
    count: number;
    sum: number;
    buckets: Array<{ le: string; count: number }>;
  };
  webhook_duplicates_total: number;
  webhook_invalid_signature_total: number;
  outbound_retry_total: Record<string, number>;
  dead_letter_total: number;
  reconciliation_lag_seconds: number;
  reconciliation_discrepancies_total: number;
  external_api_request_rate: number;
}

interface LatencyRow {
  count: number;
  sum_seconds: number;
  le_1: number;
  le_5: number;
  le_10: number;
  le_30: number;
  le_60: number;
  le_300: number;
}

interface RetryRow {
  label: string;
  total: number;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly counters: WebhookCounters,
  ) {}

  async health(): Promise<SyncHealth> {
    const now = this.clock.now();
    const [pending, deadLetterTotal, checkpoint, latest, leased, touched] = await Promise.all([
      this.prisma.client.outboxEvent.aggregate({
        where: { status: { in: [...UNFINISHED] } },
        _count: true,
        _min: { createdAt: true },
      }),
      this.prisma.client.outboxEvent.count({ where: { status: 'DEAD' } }),
      this.prisma.client.syncCheckpoint.findUnique({ where: { streamName: CHANGES_STREAM } }),
      this.prisma.client.reconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.client.outboxEvent.findFirst({
        where: { status: 'IN_FLIGHT', leaseUntil: { gt: now } },
        orderBy: { leaseUntil: 'desc' },
        select: { leaseUntil: true },
      }),
      this.prisma.client.outboxEvent.aggregate({
        where: { status: { in: ['IN_FLIGHT', 'RETRY', 'COMPLETED', 'DEAD'] } },
        _max: { updatedAt: true },
      }),
    ]);
    const oldest = pending._min.createdAt;
    const caughtUp = latest === null || latest.status === 'SUCCEEDED';
    const since = checkpoint?.lastSuccessAt ?? latest?.startedAt ?? now;
    return {
      outboxPending: pending._count,
      outboxOldestAgeSeconds: oldest === null ? 0 : secondsSince(now, oldest),
      reconciliationLagSeconds: caughtUp ? 0 : secondsSince(now, since),
      deadLetterTotal,
      checkpointCursor: checkpoint?.cursor ?? null,
      workerObserved: workerWasObserved({
        now,
        recent: [
          checkpoint?.lastSuccessAt ?? null,
          touched._max.updatedAt,
          latest?.completedAt ?? null,
        ],
        leaseUntil: leased?.leaseUntil ?? null,
      }),
    };
  }

  async metrics(): Promise<SyncMetrics> {
    const [view, latency, retries, bucket, discrepancies] = await Promise.all([
      this.health(),
      this.latency(),
      this.retries(),
      this.prisma.client.apiQuotaBucket.findUnique({ where: { bucket: QUOTA_BUCKET } }),
      this.prisma.client.fieldHistory.count({
        where: { decision: { in: ['REJECTED_STALE', 'CONFLICT_LOST'] } },
      }),
    ]);
    const counts = [
      latency.le_1,
      latency.le_5,
      latency.le_10,
      latency.le_30,
      latency.le_60,
      latency.le_300,
    ];
    return {
      outbox_pending_total: view.outboxPending,
      outbox_oldest_age_seconds: view.outboxOldestAgeSeconds,
      sync_latency_seconds: {
        count: asNumber(latency.count),
        sum: asNumber(latency.sum_seconds),
        buckets: [
          ...LATENCY_BOUNDS.map((bound, index) => ({
            le: String(bound),
            count: asNumber(counts[index]),
          })),
          { le: '+Inf', count: asNumber(latency.count) },
        ],
      },
      webhook_duplicates_total: this.counters.duplicates,
      webhook_invalid_signature_total: this.counters.invalidSignatures,
      outbound_retry_total: retries,
      dead_letter_total: view.deadLetterTotal,
      reconciliation_lag_seconds: view.reconciliationLagSeconds,
      reconciliation_discrepancies_total: discrepancies,
      external_api_request_rate: bucket === null ? 0 : asNumber(bucket.refillPerSecondMilli) / 1000,
    };
  }

  async list(status: OutboxStatus | undefined): Promise<OutboxInspection[]> {
    const rows = await this.prisma.client.outboxEvent.findMany({
      where: status === undefined ? undefined : { status },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      operationId: row.operationId,
      entityType: row.entityType,
      entityId: row.entityId,
      eventType: row.eventType,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      leaseUntil: row.leaseUntil === null ? null : row.leaseUntil.toISOString(),
      lastError: row.lastError,
      changedFields: row.changedFields,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async replay(
    operationId: string,
    correlationId: string,
  ): Promise<{ operationId: string; status: 'RETRY' }> {
    const now = this.clock.now();
    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE outbox_events
        SET status = 'RETRY',
            next_attempt_at = ${now},
            lease_until = NULL,
            updated_at = ${now}
        WHERE operation_id = ${operationId}::uuid
          AND status = 'DEAD'
        RETURNING id
      `;
      if (updated.length !== 1) {
        const existing = await tx.outboxEvent.findUnique({ where: { operationId } });
        return existing === null ? 'missing' : 'blocked';
      }
      await tx.syncOperation.updateMany({
        where: { operationId, status: 'FAILED' },
        data: { status: 'PENDING' },
      });
      return 'replayed';
    });
    if (outcome === 'missing') {
      throw requestError(correlationId, 404, 'Outbox operation was not found');
    }
    if (outcome === 'blocked') {
      throw requestError(correlationId, 409, 'Only a dead-letter row can be replayed');
    }
    return { operationId, status: 'RETRY' };
  }

  async requestReconciliation(correlationId: string): Promise<ReconciliationRequest> {
    const id = randomUUID();
    const requestedAt = this.clock.now();
    await this.prisma.client.$executeRaw`
      INSERT INTO sync_commands (id, command, status, correlation_id, requested_at)
      VALUES (${id}::uuid, 'reconciliation', 'PENDING', ${correlationId}, ${requestedAt})
    `;
    return { id, command: 'reconciliation', status: 'PENDING' };
  }

  private async latency(): Promise<LatencyRow> {
    const rows = await this.prisma.client.$queryRaw<LatencyRow[]>`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(EXTRACT(EPOCH FROM (updated_at - created_at))), 0)::float8 AS sum_seconds,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 1)::int AS le_1,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 5)::int AS le_5,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 10)::int AS le_10,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 30)::int AS le_30,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 60)::int AS le_60,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) <= 300)::int AS le_300
      FROM outbox_events
      WHERE status = 'COMPLETED'
    `;
    const row = rows[0];
    if (row === undefined) {
      return {
        count: 0,
        sum_seconds: 0,
        le_1: 0,
        le_5: 0,
        le_10: 0,
        le_30: 0,
        le_60: 0,
        le_300: 0,
      };
    }
    return row;
  }

  private async retries(): Promise<Record<string, number>> {
    const rows = await this.prisma.client.$queryRaw<RetryRow[]>`
      SELECT COALESCE(last_error, 'recovered') AS label,
             COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)::int AS total
      FROM outbox_events
      WHERE attempts > 1
      GROUP BY COALESCE(last_error, 'recovered')
    `;
    const totals: Record<string, number> = {};
    for (const row of rows) {
      totals[row.label] = asNumber(row.total);
    }
    return totals;
  }
}

function secondsSince(now: Date, then: Date): number {
  const seconds = (now.getTime() - then.getTime()) / 1000;
  return Math.max(0, Math.round(seconds * 1000) / 1000);
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
