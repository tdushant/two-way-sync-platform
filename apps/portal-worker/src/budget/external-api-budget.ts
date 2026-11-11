import { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { QUOTA_BUCKET, QUOTA_WAIT_MS } from '../outbox/policy';

export const DEFAULT_OUTBOUND_BUDGET_PER_SECOND = 80;
export const SALESFORCE_API_CAP_PER_SECOND = 100;

export type BudgetPurpose = 'outbound' | 'reconciliation';

export interface BudgetDecision {
  granted: boolean;
  retryAfterMs: number;
}

export interface ExternalApiMetrics {
  externalApiRequestRate: number;
  tokens: number;
  grantedTotal: number;
  deniedTotal: number;
  outboundGrantedTotal: number;
  reconciliationGrantedTotal: number;
  retryAfterTotal: number;
  blockedUntil: string | null;
}

interface BucketRow {
  tokens: bigint;
  max_tokens: bigint;
  refill_per_second_milli: bigint;
  updated_at: Date;
  blocked_until: Date | null;
  granted_total: bigint;
  denied_total: bigint;
  outbound_granted_total: bigint;
  reconciliation_granted_total: bigint;
  retry_after_total: bigint;
}

/**
 * One PostgreSQL row limits every portal worker. Outbound sends and reconciliation
 * reads spend the same tokens. Fake Salesforce webhook dispatch is a separate limiter.
 */
export class ExternalApiBudget {
  constructor(private readonly prisma: PrismaService) {}

  async configure(perSecond: number, now: Date): Promise<void> {
    const max = BigInt(perSecond);
    const refill = max * 1_000n;
    await this.prisma.client.$executeRaw`
      UPDATE api_quota_buckets
      SET max_tokens = ${max},
          refill_per_second_milli = ${refill},
          tokens = LEAST(tokens, ${max}),
          updated_at = ${now}
      WHERE bucket = ${QUOTA_BUCKET}
    `;
  }

  async acquire(now: Date, purpose: BudgetPurpose): Promise<BudgetDecision> {
    return this.prisma.client.$transaction(async (tx) => {
      const row = await lockBucket(tx);
      const elapsed = BigInt(Math.max(0, now.getTime() - row.updated_at.getTime()));
      const refilled = (elapsed * row.refill_per_second_milli) / 1_000_000n;
      let tokens = row.tokens + refilled;
      if (tokens > row.max_tokens) {
        tokens = row.max_tokens;
      }
      const blockedMs = blockRemaining(row.blocked_until, now);
      if (blockedMs > 0 || tokens < 1n) {
        const wait = Math.max(
          blockedMs,
          tokens < 1n ? tokenWaitMs(row.refill_per_second_milli) : 0,
        );
        if (refilled > 0n) {
          await tx.$executeRaw`
            UPDATE api_quota_buckets
            SET tokens = ${tokens},
                updated_at = ${now},
                denied_total = denied_total + 1
            WHERE bucket = ${QUOTA_BUCKET}
          `;
        } else {
          await tx.$executeRaw`
            UPDATE api_quota_buckets
            SET denied_total = denied_total + 1
            WHERE bucket = ${QUOTA_BUCKET}
          `;
        }
        return { granted: false, retryAfterMs: wait };
      }
      tokens -= 1n;
      const outbound = purpose === 'outbound' ? 1 : 0;
      const reconciliation = purpose === 'reconciliation' ? 1 : 0;
      await tx.$executeRaw`
        UPDATE api_quota_buckets
        SET tokens = ${tokens},
            updated_at = ${now},
            granted_total = granted_total + 1,
            outbound_granted_total = outbound_granted_total + ${outbound},
            reconciliation_granted_total = reconciliation_granted_total + ${reconciliation}
        WHERE bucket = ${QUOTA_BUCKET}
      `;
      return { granted: true, retryAfterMs: 0 };
    });
  }

  async observeRetryAfter(now: Date, retryAfterSeconds: number | undefined): Promise<void> {
    if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
      return;
    }
    const until = new Date(now.getTime() + retryAfterSeconds * 1000);
    await this.prisma.client.$transaction(async (tx) => {
      const row = await lockBucket(tx);
      const next =
        row.blocked_until !== null && row.blocked_until.getTime() > until.getTime()
          ? row.blocked_until
          : until;
      await tx.$executeRaw`
        UPDATE api_quota_buckets
        SET blocked_until = ${next},
            retry_after_total = retry_after_total + 1
        WHERE bucket = ${QUOTA_BUCKET}
      `;
    });
  }

  async metrics(): Promise<ExternalApiMetrics> {
    const row = await lockBucket(this.prisma.client);
    return {
      externalApiRequestRate: Number(row.refill_per_second_milli) / 1000,
      tokens: Number(row.tokens),
      grantedTotal: Number(row.granted_total),
      deniedTotal: Number(row.denied_total),
      outboundGrantedTotal: Number(row.outbound_granted_total),
      reconciliationGrantedTotal: Number(row.reconciliation_granted_total),
      retryAfterTotal: Number(row.retry_after_total),
      blockedUntil: row.blocked_until === null ? null : row.blocked_until.toISOString(),
    };
  }
}

function tokenWaitMs(refillPerSecondMilli: bigint): number {
  if (refillPerSecondMilli <= 0n) {
    return QUOTA_WAIT_MS;
  }
  return Math.max(1, Math.ceil(1_000_000 / Number(refillPerSecondMilli)));
}

function blockRemaining(blockedUntil: Date | null, now: Date): number {
  if (blockedUntil === null) {
    return 0;
  }
  return Math.max(0, blockedUntil.getTime() - now.getTime());
}

async function lockBucket(
  tx: Prisma.TransactionClient | PrismaService['client'],
): Promise<BucketRow> {
  const rows = await tx.$queryRaw<BucketRow[]>`
    SELECT tokens, max_tokens, refill_per_second_milli, updated_at, blocked_until,
           granted_total, denied_total, outbound_granted_total,
           reconciliation_granted_total, retry_after_total
    FROM api_quota_buckets
    WHERE bucket = ${QUOTA_BUCKET}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('external_api quota bucket is missing');
  }
  return row;
}
