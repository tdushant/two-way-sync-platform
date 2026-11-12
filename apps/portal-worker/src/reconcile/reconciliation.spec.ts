import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { ExternalApiBudget } from '../budget/external-api-budget';
import { ManualClock } from '../clock';
import { QUOTA_BUCKET } from '../outbox/policy';
import { PrismaService } from '../prisma/prisma.service';
import type { ChangesFeed, ChangesPage, InboundEvent } from './changes-feed';
import { inboundBody } from './canonical';
import { HttpInboundApply } from './inbound-apply';
import { CHANGES_STREAM, CheckpointInterrupt, ReconciliationWorker } from './reconciliation-worker';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SECRET = 'local-webhook-secret';

describe('reconciliation worker', () => {
  let portal: INestApplication;
  let prisma: PrismaService;
  let clock: ManualClock;
  let budget: ExternalApiBudget;
  let inbound: HttpInboundApply;
  let databaseUrl: string;

  beforeAll(async () => {
    const url = process.env.PORTAL_DATABASE_URL;
    if (url === undefined) {
      throw new Error('PORTAL_DATABASE_URL is required');
    }
    databaseUrl = url;
    clock = new ManualClock(new Date('2026-11-12T04:00:00.000Z'));
    prisma = new PrismaService(new ConfigService());
    budget = new ExternalApiBudget(prisma);
    const { AppModule } = await loadPortal();
    portal = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    await portal.listen(0, '127.0.0.1');
    const address = portal.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('portal test server did not bind a port');
    }
    inbound = new HttpInboundApply(`http://127.0.0.1:${address.port}/webhooks/salesforce`, SECRET);
  });

  beforeEach(async () => {
    await cleanup(prisma, clock);
    await setQuota(prisma, clock, 100n);
  });

  afterAll(async () => {
    await setQuota(prisma, clock, 80n, 80_000n);
    await portal.close();
    await prisma.client.$disconnect();
  });

  it('repairs a missed webhook without an outbound row', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old' });
    const feed = new ScriptedFeed([
      change(clock, { sequence: 1, recordId, changedFields: { city: 'Paris' } }),
    ]);
    const result = await worker(feed).trigger();
    expect(result).toMatchObject({ status: 'SUCCEEDED', cursor: '1' });
    expect(result.error).toBeUndefined();
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    expect(await outboxCount(prisma, recordId)).toBe(0);
    expect(await historyCount(prisma, recordId)).toBe(1);
    expect(await cursorOf(prisma)).toBe('1');
  });

  it('catches up after a six-hour outage on the virtual clock', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    await prisma.client.customer.update({
      where: { salesforceId: recordId.replace('contact', 'account') },
      data: { name: 'rcx During outage' },
    });
    const customerId = (
      await prisma.client.customer.findFirstOrThrow({
        where: { salesforceId: recordId.replace('contact', 'account') },
      })
    ).id;
    await prisma.client.outboxEvent.create({
      data: outbox(clock, customerId, { name: 'rcx During outage' }),
    });
    const feed = new ScriptedFeed([
      change(clock, {
        sequence: 4,
        recordId,
        occurredAt: new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(),
        changedFields: { city: 'Paris' },
      }),
    ]);
    feed.failing = true;
    clock.advance(SIX_HOURS_MS);
    const blocked = await worker(feed).trigger();
    expect(blocked).toMatchObject({ status: 'FAILED', error: 'http_503', cursor: null });
    expect(await contactCity(prisma, recordId)).toBe('Old');
    expect(
      (await prisma.client.outboxEvent.findFirstOrThrow({ where: { entityId: customerId } }))
        .status,
    ).toBe('PENDING');
    const lag = await worker(feed).metrics();
    expect(lag.reconciliationLagSeconds).toBe(SIX_HOURS_MS / 1000);
    expect(lag.lastRunStatus).toBe('FAILED');
    feed.failing = false;
    const recovered = await worker(feed).trigger();
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', cursor: '4' });
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    expect(await contactPhone(prisma, recordId)).toBe('111');
    expect(
      (await prisma.client.outboxEvent.findFirstOrThrow({ where: { entityId: customerId } }))
        .status,
    ).toBe('PENDING');
    expect((await worker(feed).metrics()).reconciliationLagSeconds).toBe(0);
  });

  it('replays a page after a crash before the checkpoint write', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    const events = [
      change(clock, { sequence: 1, recordId, changedFields: { city: 'Paris' } }),
      change(clock, { sequence: 2, recordId, changedFields: { phone: '222' } }),
    ];
    const feed = new ScriptedFeed(events);
    let crash = true;
    const first = await worker(feed, 10, {
      beforeCheckpoint: () => {
        if (crash) {
          throw new CheckpointInterrupt();
        }
      },
    }).trigger();
    expect(first).toMatchObject({ status: 'FAILED', error: 'interrupted', cursor: null });
    expect(await cursorOf(prisma)).toBeNull();
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    expect(await contactPhone(prisma, recordId)).toBe('222');
    const applied = await historyCount(prisma, recordId);
    expect(applied).toBe(2);
    expect(await processedCount(prisma)).toBe(2);
    crash = false;
    const second = await worker(feed, 10, {
      beforeCheckpoint: () => undefined,
    }).trigger();
    expect(second).toMatchObject({ status: 'SUCCEEDED', cursor: '2' });
    expect(await historyCount(prisma, recordId)).toBe(applied);
    expect(await processedCount(prisma)).toBe(2);
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    expect(await contactPhone(prisma, recordId)).toBe('222');
  });

  it('leaves the cursor on the previous page when a later event does not commit', async () => {
    const firstId = await insertContact(prisma, clock, { city: 'Old' });
    const secondId = `SF-RC-contact-${randomUUID()}`;
    const feed = new ScriptedFeed([
      change(clock, { sequence: 1, recordId: firstId, changedFields: { city: 'Paris' } }),
      change(clock, { sequence: 2, recordId: secondId, changedFields: { city: 'Lyon' } }),
    ]);
    const blocked = await worker(feed).trigger();
    expect(blocked).toMatchObject({ status: 'FAILED', error: 'http_409', cursor: null });
    expect(await cursorOf(prisma)).toBeNull();
    expect(await contactCity(prisma, firstId)).toBe('Paris');
    expect(await processedCount(prisma)).toBe(1);
    await insertContact(prisma, clock, { city: 'Old', salesforceId: secondId });
    const retried = await worker(feed).trigger();
    expect(retried).toMatchObject({ status: 'SUCCEEDED', cursor: '2' });
    expect(await historyCount(prisma, firstId)).toBe(1);
    expect(await contactCity(prisma, secondId)).toBe('Lyon');
  });

  it('acks an overlapping duplicate and applies only the new sequence', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    const first = change(clock, { sequence: 1, recordId, changedFields: { city: 'Paris' } });
    const second = change(clock, { sequence: 2, recordId, changedFields: { phone: '222' } });
    const feed = new ScriptedFeed([first]);
    expect(await worker(feed).trigger()).toMatchObject({ status: 'SUCCEEDED', cursor: '1' });
    feed.events = [first, second];
    feed.overlap = true;
    const result = await worker(feed).trigger();
    expect(result).toMatchObject({ status: 'SUCCEEDED', cursor: '2' });
    expect(await historyCount(prisma, recordId)).toBe(2);
    expect(await processedCount(prisma)).toBe(2);
    expect(await contactPhone(prisma, recordId)).toBe('222');
    expect(await contactCity(prisma, recordId)).toBe('Paris');
  });

  it('uses the inbound conflict rules for a simultaneous portal edit', async () => {
    const occurred = clock.now();
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    const contactId = await contactPrimaryKey(prisma, recordId);
    await prisma.client.fieldSyncState.createMany({
      data: [
        sync(contactId, 'phone', new Date(occurred.getTime() + 1000), clock),
        sync(contactId, 'city', occurred, clock),
      ],
    });
    const before = await discrepancyCount(prisma);
    const feed = new ScriptedFeed([
      change(clock, {
        sequence: 1,
        recordId,
        occurredAt: occurred.toISOString(),
        changedFields: { phone: '999', city: 'Paris' },
      }),
    ]);
    const result = await worker(feed).trigger();
    expect(result.status).toBe('SUCCEEDED');
    expect(await contactPhone(prisma, recordId)).toBe('111');
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    const rows = await prisma.client.fieldHistory.findMany({
      where: { entityId: contactId },
      orderBy: { fieldName: 'asc' },
    });
    expect(rows.map((row) => [row.fieldName, row.decision, row.source])).toEqual([
      ['city', 'APPLIED', 'SALESFORCE'],
      ['phone', 'CONFLICT_LOST', 'SALESFORCE'],
    ]);
    expect(await outboxCount(prisma, recordId)).toBe(0);
    const metrics = await worker(feed).metrics();
    expect(metrics.reconciliationDiscrepanciesTotal).toBeGreaterThanOrEqual(before + 1);
    expect(metrics.reconciliationLagSeconds).toBe(0);
    expect(
      (await prisma.client.contact.findUniqueOrThrow({ where: { id: contactId } })).rowVersion,
    ).toBe(2n);
  });

  it('drains a cursor in pages and starts that catch-up before the interval', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    const feed = new ScriptedFeed([
      change(clock, { sequence: 1, recordId, recordVersion: 2, changedFields: { city: 'Paris' } }),
      change(clock, { sequence: 2, recordId, recordVersion: 3, changedFields: { phone: '222' } }),
      change(clock, { sequence: 3, recordId, recordVersion: 4, changedFields: { city: 'Lyon' } }),
    ]);
    let tick: (() => void) | undefined;
    const running = worker(feed, 2, {
      schedule: (run) => {
        tick = run;
        return setInterval(() => undefined, 60_000);
      },
    });
    try {
      await running.start();
      expect(feed.calls).toBe(2);
      expect(await contactCity(prisma, recordId)).toBe('Lyon');
      expect(await cursorOf(prisma)).toBe('3');
      feed.events.push(
        change(clock, { sequence: 4, recordId, recordVersion: 5, changedFields: { phone: '333' } }),
      );
      expect(tick).toEqual(expect.any(Function));
      tick?.();
      await running.idle();
      expect(await contactPhone(prisma, recordId)).toBe('333');
    } finally {
      running.stop();
    }
  });

  it('stops a second page when the shared budget is empty', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old', phone: '111' });
    const feed = new ScriptedFeed([
      change(clock, { sequence: 1, recordId, recordVersion: 2, changedFields: { city: 'Paris' } }),
      change(clock, { sequence: 2, recordId, recordVersion: 3, changedFields: { phone: '222' } }),
      change(clock, { sequence: 3, recordId, recordVersion: 4, changedFields: { city: 'Lyon' } }),
    ]);
    await setQuota(prisma, clock, 1n);
    const limited = await worker(feed, 2).trigger();
    expect(limited).toMatchObject({ status: 'FAILED', error: 'quota', cursor: '2' });
    expect(feed.calls).toBe(1);
    expect(await contactCity(prisma, recordId)).toBe('Paris');
    expect(await contactPhone(prisma, recordId)).toBe('222');
    await setQuota(prisma, clock, 1n);
    const rest = await worker(feed, 2).trigger();
    expect(rest).toMatchObject({ status: 'SUCCEEDED', cursor: '3' });
    expect(await contactCity(prisma, recordId)).toBe('Lyon');
  });

  it('runs a requested reconciliation pass and leaves an empty cursor where it was', async () => {
    const id = randomUUID();
    const correlationId = '6b1f0a2e-7c10-4d0a-9a1e-555555555555';
    await prisma.client.$executeRaw`
      INSERT INTO sync_commands (id, command, status, correlation_id, requested_at)
      VALUES (${id}::uuid, 'reconciliation', 'PENDING', ${correlationId}, ${clock.now()})
    `;
    try {
      await worker(new ScriptedFeed([])).tick();
      const rows = await prisma.client.$queryRaw<Array<{ status: string; error: string | null }>>`
        SELECT status, error FROM sync_commands WHERE id = ${id}::uuid
      `;
      expect(rows[0]).toEqual({ status: 'SUCCEEDED', error: null });
      expect(await cursorOf(prisma)).toBeNull();
    } finally {
      await prisma.client.$executeRaw`DELETE FROM sync_commands WHERE id = ${id}::uuid`;
    }
  });

  it('shares one cursor across two worker instances', async () => {
    const recordId = await insertContact(prisma, clock, { city: 'Old' });
    const feed = new ScriptedFeed([
      change(clock, { sequence: 1, recordId, changedFields: { city: 'Paris' } }),
    ]);
    const results = await Promise.all([worker(feed).trigger(), worker(feed).trigger()]);
    expect(results.map((result) => result.status).sort()).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(await historyCount(prisma, recordId)).toBe(1);
    expect(await processedCount(prisma)).toBe(1);
    expect(await cursorOf(prisma)).toBe('1');
  });

  function worker(
    feed: ChangesFeed,
    pageLimit = 10,
    hooks?: {
      beforeCheckpoint?: () => void;
      schedule?: (run: () => void) => ReturnType<typeof setInterval>;
    },
  ): ReconciliationWorker {
    return new ReconciliationWorker(
      prisma,
      clock,
      budget,
      feed,
      inbound,
      databaseUrl,
      pageLimit,
      hooks?.beforeCheckpoint,
      hooks?.schedule,
    );
  }
});

class ScriptedFeed implements ChangesFeed {
  calls = 0;
  failing = false;
  overlap = false;

  constructor(public events: InboundEvent[]) {}

  async fetch(after: string | null, limit: number): Promise<ChangesPage> {
    this.calls += 1;
    if (this.failing) {
      return { ok: false, reason: 'http_503' };
    }
    const cursor = after === null ? 0 : Number(after);
    const floor = this.overlap ? cursor : cursor;
    const selected = this.events
      .filter((event) => (this.overlap ? event.sequence >= floor : event.sequence > cursor))
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
    return { ok: true, events: selected };
  }
}

async function loadPortal(): Promise<{ AppModule: new (...args: never[]) => object }> {
  const specifier = '../../../portal-api/src/app.module';
  return (await import(specifier)) as { AppModule: new (...args: never[]) => object };
}

function change(
  clock: ManualClock,
  input: {
    sequence: number;
    recordId: string;
    changedFields: Record<string, string | null>;
    occurredAt?: string;
    recordVersion?: number;
  },
): InboundEvent {
  const occurredAt = input.occurredAt ?? clock.now().toISOString();
  const body = inboundBody({
    eventId: randomUUID(),
    objectType: 'Contact',
    recordId: input.recordId,
    eventType: 'updated',
    changedFields: input.changedFields,
    changedBy: 'sf-user-1',
    recordVersion: input.recordVersion ?? 3,
    occurredAt,
    originOperationId: null,
    changeSequence: input.sequence,
  });
  if (body === undefined) {
    throw new Error('change was rejected by the inbound contract');
  }
  return { sequence: input.sequence, occurredAt, body };
}

async function insertContact(
  prisma: PrismaService,
  clock: ManualClock,
  input: { city: string; phone?: string; salesforceId?: string },
): Promise<string> {
  const salesforceId = input.salesforceId ?? `SF-RC-contact-${randomUUID()}`;
  const accountId = salesforceId.replace('contact', 'account');
  const existing = await prisma.client.customer.findUnique({ where: { salesforceId: accountId } });
  const customerId =
    existing?.id ??
    (
      await prisma.client.customer.create({
        data: {
          name: 'rcx Parent',
          salesforceId: accountId,
          status: 'active',
          rowVersion: 1n,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      })
    ).id;
  await prisma.client.contact.create({
    data: {
      customerId,
      fullName: 'rcx Ada',
      salesforceId,
      phone: input.phone ?? '111',
      city: input.city,
      rowVersion: 1n,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  return salesforceId;
}

function sync(entityId: string, fieldName: string, occurred: Date, clock: ManualClock) {
  return {
    entityType: 'contact',
    entityId,
    fieldName,
    source: 'PORTAL',
    sourceVersion: '2',
    sourceChangedAt: occurred,
    lastAppliedAt: clock.now(),
  };
}

function outbox(clock: ManualClock, entityId: string, changedFields: Record<string, string>) {
  const now = clock.now();
  return {
    operationId: randomUUID(),
    entityType: 'customer',
    entityId,
    eventType: 'updated',
    changedFields,
    baseVersions: { rowVersion: 1, fields: { name: '1' } },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function contactCity(prisma: PrismaService, salesforceId: string): Promise<string | null> {
  return (await prisma.client.contact.findUniqueOrThrow({ where: { salesforceId } })).city;
}

async function contactPhone(prisma: PrismaService, salesforceId: string): Promise<string | null> {
  return (await prisma.client.contact.findUniqueOrThrow({ where: { salesforceId } })).phone;
}

async function contactPrimaryKey(prisma: PrismaService, salesforceId: string): Promise<string> {
  return (await prisma.client.contact.findUniqueOrThrow({ where: { salesforceId } })).id;
}

async function historyCount(prisma: PrismaService, salesforceId: string): Promise<number> {
  const id = await contactPrimaryKey(prisma, salesforceId);
  return prisma.client.fieldHistory.count({ where: { entityId: id } });
}

async function outboxCount(prisma: PrismaService, salesforceId: string): Promise<number> {
  const contact = await prisma.client.contact.findUnique({ where: { salesforceId } });
  const ids = [contact?.id, contact?.customerId].filter((id): id is string => id !== undefined);
  return prisma.client.outboxEvent.count({ where: { entityId: { in: ids } } });
}

async function processedCount(prisma: PrismaService): Promise<number> {
  return prisma.client.processedEvent.count({
    where: { externalId: { startsWith: 'SF-RC-' } },
  });
}

async function cursorOf(prisma: PrismaService): Promise<string | null> {
  return (
    (await prisma.client.syncCheckpoint.findUnique({ where: { streamName: CHANGES_STREAM } }))
      ?.cursor ?? null
  );
}

async function discrepancyCount(prisma: PrismaService): Promise<number> {
  return prisma.client.fieldHistory.count({
    where: { decision: { in: ['REJECTED_STALE', 'CONFLICT_LOST'] } },
  });
}

async function setQuota(
  prisma: PrismaService,
  clock: ManualClock,
  tokens: bigint,
  refillPerSecondMilli = 0n,
): Promise<void> {
  await prisma.client.apiQuotaBucket.update({
    where: { bucket: QUOTA_BUCKET },
    data: {
      tokens,
      maxTokens: tokens > 0n ? tokens : 1n,
      refillPerSecondMilli,
      updatedAt: clock.now(),
      blockedUntil: null,
    },
  });
}

async function cleanup(prisma: PrismaService, clock: ManualClock): Promise<void> {
  const customers = await prisma.client.customer.findMany({
    where: { OR: [{ name: { startsWith: 'rcx' } }, { salesforceId: { startsWith: 'SF-RC-' } }] },
    select: { id: true },
  });
  const contacts = await prisma.client.contact.findMany({
    where: {
      OR: [{ fullName: { startsWith: 'rcx' } }, { salesforceId: { startsWith: 'SF-RC-' } }],
    },
    select: { id: true },
  });
  const ids = [...customers, ...contacts].map((row) => row.id);
  if (ids.length > 0) {
    await prisma.client.fieldHistory.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.fieldSyncState.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.outboxEvent.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.syncOperation.deleteMany({ where: { entityId: { in: ids } } });
  }
  await prisma.client.processedEvent.deleteMany({
    where: { externalId: { startsWith: 'SF-RC-' } },
  });
  if (contacts.length > 0) {
    await prisma.client.contact.deleteMany({
      where: { id: { in: contacts.map((row) => row.id) } },
    });
  }
  if (customers.length > 0) {
    await prisma.client.customer.deleteMany({
      where: { id: { in: customers.map((row) => row.id) } },
    });
  }
  await prisma.client.reconciliationRun.deleteMany();
  await prisma.client.syncCheckpoint.upsert({
    where: { streamName: CHANGES_STREAM },
    create: {
      streamName: CHANGES_STREAM,
      cursor: null,
      lastSuccessAt: clock.now(),
      updatedAt: clock.now(),
    },
    update: { cursor: null, lastSuccessAt: clock.now(), updatedAt: clock.now() },
  });
}
