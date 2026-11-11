import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ManualClock } from '../clock';
import { PrismaService } from '../prisma/prisma.service';
import { QUOTA_BUCKET } from '../outbox/policy';
import { ExternalApiBudget, type BudgetPurpose } from './external-api-budget';

describe('global outbound budget', () => {
  let prisma: PrismaService;
  let clock: ManualClock;
  const left = () => new ExternalApiBudget(prisma);
  const right = () => new ExternalApiBudget(prisma);

  beforeAll(() => {
    clock = new ManualClock(new Date('2026-11-12T03:00:00.000Z'));
    prisma = new PrismaService(new ConfigService());
  });

  beforeEach(async () => {
    await resetBudget(prisma, clock, 4n, 0n);
  });

  afterAll(async () => {
    await resetBudget(prisma, clock, 80n, 80_000n);
    await prisma.client.$disconnect();
  });

  it('lets two instances share one bucket, including reconciliation calls', async () => {
    const now = clock.now();
    const first = await left().acquire(now, 'outbound');
    const second = await right().acquire(now, 'reconciliation');
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    const purposes: BudgetPurpose[] = ['outbound', 'reconciliation'];
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? left() : right()).acquire(now, purposes[index % 2] ?? 'outbound'),
      ),
    );
    const granted = [first, second, ...results].filter((result) => result.granted);
    expect(granted).toHaveLength(4);
    const metrics = await left().metrics();
    expect(metrics.outboundGrantedTotal + metrics.reconciliationGrantedTotal).toBe(4);
    expect(metrics.outboundGrantedTotal).toBeGreaterThan(0);
    expect(metrics.reconciliationGrantedTotal).toBeGreaterThan(0);
    expect(metrics.grantedTotal).toBe(4);
    expect(metrics.deniedTotal).toBe(14);
    expect(metrics.tokens).toBe(0);
    expect(metrics.externalApiRequestRate).toBe(0);
  });

  it('stops the other instance after Retry-After and reports the shared metrics', async () => {
    await resetBudget(prisma, clock, 5n, 0n);
    const now = clock.now();
    await left().observeRetryAfter(now, 0);
    await left().observeRetryAfter(now, undefined);
    await left().observeRetryAfter(now, 30);
    const blocked = await right().acquire(new Date(now.getTime() + 1_000), 'reconciliation');
    expect(blocked).toEqual({ granted: false, retryAfterMs: 29_000 });
    const metrics = await right().metrics();
    expect(metrics.retryAfterTotal).toBe(1);
    expect(metrics.blockedUntil).toBe(new Date(now.getTime() + 30_000).toISOString());
    expect(metrics.tokens).toBe(5);
    clock.advance(30_000);
    const later = await left().acquire(clock.now(), 'outbound');
    expect(later.granted).toBe(true);
    expect((await right().metrics()).externalApiRequestRate).toBe(0);
  });

  it('applies one configured rate without refilling tokens on startup', async () => {
    await resetBudget(prisma, clock, 50n, 50_000n);
    await prisma.client.apiQuotaBucket.update({
      where: { bucket: QUOTA_BUCKET },
      data: { tokens: 40n, maxTokens: 50n },
    });
    await left().configure(80, clock.now());
    const kept = await prisma.client.apiQuotaBucket.findUniqueOrThrow({
      where: { bucket: QUOTA_BUCKET },
    });
    expect(kept.tokens).toBe(40n);
    expect(kept.maxTokens).toBe(80n);
    expect(kept.refillPerSecondMilli).toBe(80_000n);
    await left().configure(10, clock.now());
    const capped = await prisma.client.apiQuotaBucket.findUniqueOrThrow({
      where: { bucket: QUOTA_BUCKET },
    });
    expect(capped.tokens).toBe(10n);
    expect(capped.maxTokens).toBe(10n);
    expect((await right().metrics()).externalApiRequestRate).toBe(10);
  });
});

async function resetBudget(
  prisma: PrismaService,
  clock: ManualClock,
  tokens: bigint,
  refillPerSecondMilli: bigint,
): Promise<void> {
  const max = tokens > 0n ? tokens : 1n;
  await prisma.client.apiQuotaBucket.update({
    where: { bucket: QUOTA_BUCKET },
    data: {
      tokens,
      maxTokens: max,
      refillPerSecondMilli,
      updatedAt: clock.now(),
      blockedUntil: null,
      grantedTotal: 0n,
      deniedTotal: 0n,
      outboundGrantedTotal: 0n,
      reconciliationGrantedTotal: 0n,
      retryAfterTotal: 0n,
    },
  });
}
