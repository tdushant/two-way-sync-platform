import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { ManualClock } from '../clock';
import { PrismaService } from '../prisma/prisma.service';
import {
  SalesforceClient,
  SalesforceTransportError,
  type SalesforceCall,
  type SalesforceResult,
} from '../salesforce/salesforce-client';
import { QUOTA_BUCKET } from './policy';
import { OutboundWorker, outboundTiming } from './outbound-worker';

const SCOPE = 'wkx';

describe('portal outbound worker', () => {
  let moduleRef: { close: () => Promise<void> };
  let prisma: PrismaService;
  let clock: ManualClock;
  let client: RecordingClient;
  let worker: OutboundWorker;

  beforeAll(async () => {
    const compiled = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef = compiled;
    await compiled.init();
    prisma = compiled.get(PrismaService);
    clock = new ManualClock(new Date('2026-11-12T00:00:00.000Z'));
    client = new RecordingClient(prisma);
    worker = new OutboundWorker(prisma, clock, client, () => 0, SCOPE);
    await cleanup(prisma);
    await setQuota(prisma, clock, 1000n, 1000n, 1_000_000n);
  });

  beforeEach(async () => {
    client.calls = [];
    client.results = [];
    worker.batchSize = 10;
    await setQuota(prisma, clock, 1000n, 1000n, 1_000_000n);
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup(prisma);
      await setQuota(prisma, clock, 1000n, 1000n, 1_000_000n);
      await moduleRef.close();
    }
  });

  it('reclaims an expired lease and sends the original operation once', async () => {
    const customerId = await insertCustomer(prisma, clock, {
      name: 'wkx Crash',
      salesforceId: 'SF-WK-crash',
    });
    const operationId = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { name: 'wkx Crash' },
      versions: { name: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-crash',
    });
    const second = new OutboundWorker(prisma, clock, client, () => 0, SCOPE);
    expect(await worker.claimDue()).toHaveLength(1);
    expect(client.calls).toHaveLength(0);
    const held = await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId } });
    expect(held).toMatchObject({ status: 'IN_FLIGHT', attempts: 1 });
    await second.flush();
    expect(client.calls).toHaveLength(0);
    clock.advance(outboundTiming.leaseMs);
    await second.flush();
    expect(client.calls.map((call) => call.operationId)).toEqual([operationId]);
    expect(client.calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/sf/v1/accounts/SF-WK-crash',
      body: { name: 'wkx Crash' },
    });
    const done = await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId } });
    expect(done).toMatchObject({ status: 'COMPLETED', attempts: 2, lastError: null });
  });

  it('retries 500, 429, and timeout, and dead-letters a permanent 400', async () => {
    const customerId = await insertCustomer(prisma, clock, {
      name: 'wkx Retry',
      salesforceId: 'SF-WK-retry',
    });
    const failed = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { name: 'wkx Retry' },
      versions: { name: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-retry',
    });
    client.results.push({ status: 500, body: { phone: '555-0100' } });
    await worker.flush();
    const waiting = await prisma.client.outboxEvent.findFirstOrThrow({
      where: { operationId: failed },
    });
    expect(waiting.status).toBe('RETRY');
    expect(waiting.lastError).toBe('http_500');
    expect(waiting.nextAttemptAt.getTime()).toBe(
      clock.now().getTime() + outboundTiming.backoffBaseMs,
    );
    await worker.flush();
    expect(client.calls).toHaveLength(1);
    clock.advance(outboundTiming.backoffBaseMs);
    await worker.flush();
    expect(client.calls.map((call) => call.operationId)).toEqual([failed, failed]);
    expect(
      (await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: failed } })).status,
    ).toBe('COMPLETED');

    await prisma.client.customer.update({
      where: { id: customerId },
      data: { status: 'paused' },
    });
    const limited = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { status: 'paused' },
      versions: { status: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-retry',
    });
    client.results.push({ status: 429, body: { message: 'slow down' }, retryAfterSeconds: 30 });
    await worker.flush();
    const paused = await prisma.client.outboxEvent.findFirstOrThrow({
      where: { operationId: limited },
    });
    expect(paused.status).toBe('RETRY');
    expect(paused.lastError).toBe('http_429');
    expect(paused.nextAttemptAt.getTime()).toBe(clock.now().getTime() + 30_000);
    clock.advance(29_999);
    await worker.flush();
    expect(client.calls.filter((call) => call.operationId === limited)).toHaveLength(1);
    clock.advance(1);
    await worker.flush();
    expect(
      (await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: limited } }))
        .status,
    ).toBe('COMPLETED');

    await prisma.client.customer.update({
      where: { id: customerId },
      data: { ownerId: 'owner-1' },
    });
    const timed = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { ownerId: 'owner-1' },
      versions: { ownerId: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-retry',
    });
    client.results.push(new SalesforceTransportError('timeout'));
    await worker.flush();
    expect(
      await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: timed } }),
    ).toMatchObject({ status: 'RETRY', lastError: 'timeout' });

    const deadId = await insertCustomer(prisma, clock, {
      name: 'wkx Dead',
      salesforceId: 'SF-WK-dead',
      rowVersion: 4n,
    });
    const dead = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: deadId,
      eventType: 'updated',
      changedFields: { name: 'wkx Dead' },
      versions: { name: '4' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-dead',
    });
    client.results.push({ status: 400, body: { name: 'bad value' } });
    await worker.flush();
    expect(
      await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: dead } }),
    ).toMatchObject({
      status: 'DEAD',
      lastError: 'http_400',
    });
    expect(
      await prisma.client.syncOperation.findUniqueOrThrow({ where: { operationId: dead } }),
    ).toMatchObject({ status: 'FAILED' });
    const unchanged = await prisma.client.customer.findUniqueOrThrow({ where: { id: deadId } });
    expect(unchanged.name).toBe('wkx Dead');
    expect(unchanged.rowVersion).toBe(4n);
    clock.advance(60_000);
    await worker.flush();
    expect(client.calls.filter((call) => call.operationId === dead)).toHaveLength(1);
  });

  it('does not send a stale field and still sends a current field on the same row', async () => {
    const customerId = await insertCustomer(prisma, clock, {
      name: 'wkx New',
      status: 'paused',
      salesforceId: 'SF-WK-order',
    });
    await prisma.client.fieldSyncState.createMany({
      data: [sync(customerId, 'name', '2', clock), sync(customerId, 'status', '1', clock)],
    });
    const history = await prisma.client.fieldHistory.create({
      data: historyRow(customerId, 'name', clock),
    });
    const stale = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { name: 'wkx Old', status: 'paused' },
      versions: { name: '1', status: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-order',
    });
    await worker.flush();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.body).toEqual({ status: 'paused' });
    expect(JSON.stringify(client.calls[0]?.body)).not.toContain('wkx Old');
    expect(
      await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: stale } }),
    ).toMatchObject({ status: 'COMPLETED', lastError: null });
    const stored = await prisma.client.fieldHistory.findUniqueOrThrow({
      where: { id: history.id },
    });
    expect(stored).toMatchObject({ fieldName: 'name', decision: 'APPLIED', source: 'PORTAL' });

    const onlyOld = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { name: 'wkx Older' },
      versions: { name: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-order',
    });
    await worker.flush();
    expect(client.calls).toHaveLength(1);
    expect(
      await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: onlyOld } }),
    ).toMatchObject({ status: 'COMPLETED', lastError: 'superseded' });
    expect(
      await prisma.client.syncOperation.findUniqueOrThrow({ where: { operationId: onlyOld } }),
    ).toMatchObject({ status: 'FAILED' });
    expect(await prisma.client.fieldHistory.count({ where: { entityId: customerId } })).toBe(1);
  });

  it('sends a create before a later update and does not merge them', async () => {
    const customerId = await insertCustomer(prisma, clock, {
      name: 'wkx Renamed',
      salesforceId: null,
      rowVersion: 2n,
    });
    await prisma.client.fieldSyncState.create({ data: sync(customerId, 'name', '2', clock) });
    const created = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'created',
      changedFields: { name: 'wkx Created' },
      versions: { name: '1' },
      dueOffsetMs: -1,
    });
    const updated = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'updated',
      changedFields: { name: 'wkx Renamed' },
      versions: { name: '2' },
      dueOffsetMs: 0,
    });
    client.results.push({ status: 201, body: { id: 'SF-WK-created' } });
    await worker.flush();
    expect(
      client.calls.map((call) => ({
        method: call.method,
        body: call.body,
        operationId: call.operationId,
      })),
    ).toEqual([
      { method: 'POST', body: { name: 'wkx Created' }, operationId: created },
      { method: 'PATCH', body: { name: 'wkx Renamed' }, operationId: updated },
    ]);
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(row.salesforceId).toBe('SF-WK-created');
    expect(row.rowVersion).toBe(2n);
    expect(
      await prisma.client.syncOperation.findUniqueOrThrow({ where: { operationId: created } }),
    ).toMatchObject({ status: 'SENT', externalId: 'SF-WK-created' });
  });

  it('creates the account before the contact and keeps a later contact field on its own request', async () => {
    const customerId = await insertCustomer(prisma, clock, {
      name: 'wkx Parent',
      salesforceId: null,
    });
    const contactId = await insertContact(prisma, clock, customerId);
    const account = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: customerId,
      eventType: 'created',
      changedFields: { name: 'wkx Parent' },
      versions: { name: '1' },
      dueOffsetMs: -2,
    });
    const contact = await insertOutbox(prisma, clock, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'created',
      changedFields: { customerId, fullName: 'wkx Ada' },
      versions: { customerId: '1', fullName: '1' },
      dueOffsetMs: -1,
    });
    const city = await insertOutbox(prisma, clock, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'updated',
      changedFields: { city: 'Paris' },
      versions: { city: '2' },
      dueOffsetMs: 0,
    });
    client.results.push(
      { status: 201, body: { id: 'SF-WK-parent' } },
      { status: 201, body: { id: 'SF-WK-ada' } },
      { status: 200, body: { id: 'SF-WK-ada' } },
    );
    await worker.flush();
    expect(client.calls.map((call) => call.operationId)).toEqual([account, contact, city]);
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      path: '/sf/v1/accounts',
      body: { name: 'wkx Parent' },
    });
    expect(client.calls[1]).toMatchObject({
      method: 'POST',
      path: '/sf/v1/contacts',
      body: { accountId: 'SF-WK-parent', fullName: 'wkx Ada' },
    });
    expect(client.calls[1]?.body).not.toHaveProperty('city');
    expect(client.calls[1]?.body).not.toHaveProperty('customerId');
    expect(client.calls[2]).toMatchObject({
      method: 'PATCH',
      path: '/sf/v1/contacts/SF-WK-ada',
      body: { city: 'Paris' },
    });
    expect(
      (await prisma.client.customer.findUniqueOrThrow({ where: { id: customerId } })).salesforceId,
    ).toBe('SF-WK-parent');
    expect(
      (await prisma.client.contact.findUniqueOrThrow({ where: { id: contactId } })).salesforceId,
    ).toBe('SF-WK-ada');
  });

  it('shares one quota bucket across workers and does not drop the unsent row', async () => {
    const firstId = await insertCustomer(prisma, clock, {
      name: 'wkx One',
      salesforceId: 'SF-WK-one',
    });
    const secondId = await insertCustomer(prisma, clock, {
      name: 'wkx Two',
      salesforceId: 'SF-WK-two',
    });
    const first = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: firstId,
      eventType: 'updated',
      changedFields: { name: 'wkx One' },
      versions: { name: '1' },
      dueOffsetMs: -1,
      externalId: 'SF-WK-one',
    });
    const second = await insertOutbox(prisma, clock, {
      entityType: 'customer',
      entityId: secondId,
      eventType: 'updated',
      changedFields: { name: 'wkx Two' },
      versions: { name: '1' },
      dueOffsetMs: 0,
      externalId: 'SF-WK-two',
    });
    await setQuota(prisma, clock, 1n, 1n, 0n);
    worker.batchSize = 1;
    const otherClient = new RecordingClient(prisma);
    const other = new OutboundWorker(prisma, clock, otherClient, () => 0, SCOPE);
    other.batchSize = 1;
    await worker.flush();
    await other.flush();
    expect(client.calls.map((call) => call.operationId)).toEqual([first]);
    expect(otherClient.calls).toHaveLength(0);
    expect(
      await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: second } }),
    ).toMatchObject({ status: 'RETRY', lastError: 'quota' });
    expect(
      (await prisma.client.apiQuotaBucket.findUniqueOrThrow({ where: { bucket: QUOTA_BUCKET } }))
        .tokens,
    ).toBe(0n);
    await setQuota(prisma, clock, 1n, 1n, 0n);
    clock.advance(outboundTiming.quotaWaitMs);
    await other.flush();
    expect(otherClient.calls.map((call) => call.operationId)).toEqual([second]);
    expect(
      (await prisma.client.outboxEvent.findFirstOrThrow({ where: { operationId: second } })).status,
    ).toBe('COMPLETED');
  });
});

class RecordingClient extends SalesforceClient {
  calls: SalesforceCall[] = [];
  results: Array<SalesforceResult | SalesforceTransportError> = [];

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async send(call: SalesforceCall): Promise<SalesforceResult> {
    const row = await this.prisma.client.outboxEvent.findFirst({
      where: { operationId: call.operationId },
    });
    expect(row?.status).toBe('IN_FLIGHT');
    expect(row?.leaseUntil).not.toBeNull();
    this.calls.push(call);
    const next = this.results.shift();
    if (next instanceof SalesforceTransportError) {
      throw next;
    }
    if (next) {
      return next;
    }
    return { status: 201, body: { id: `SF-WK-${call.operationId}` } };
  }
}

async function insertCustomer(
  prisma: PrismaService,
  clock: ManualClock,
  input: { name: string; salesforceId: string | null; status?: string; rowVersion?: bigint },
): Promise<string> {
  const id = randomUUID();
  await prisma.client.customer.create({
    data: {
      id,
      name: input.name,
      status: input.status ?? 'active',
      ownerId: null,
      salesforceId: input.salesforceId,
      rowVersion: input.rowVersion ?? 1n,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  return id;
}

async function insertContact(
  prisma: PrismaService,
  clock: ManualClock,
  customerId: string,
): Promise<string> {
  const id = randomUUID();
  await prisma.client.contact.create({
    data: {
      id,
      customerId,
      fullName: 'wkx Ada',
      city: 'Paris',
      rowVersion: 2n,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  return id;
}

async function insertOutbox(
  prisma: PrismaService,
  clock: ManualClock,
  input: {
    entityType: 'customer' | 'contact';
    entityId: string;
    eventType: 'created' | 'updated';
    changedFields: Record<string, string | null>;
    versions: Record<string, string>;
    dueOffsetMs: number;
    externalId?: string | null;
  },
): Promise<string> {
  const operationId = randomUUID();
  const now = clock.now();
  await prisma.client.outboxEvent.create({
    data: {
      operationId,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      changedFields: input.changedFields,
      baseVersions: { rowVersion: 1, fields: input.versions },
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() + input.dueOffsetMs),
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.client.syncOperation.create({
    data: {
      operationId,
      entityType: input.entityType,
      entityId: input.entityId,
      fields: Object.keys(input.changedFields),
      expectedValues: input.changedFields,
      externalId: input.externalId ?? null,
      status: 'PENDING',
      createdAt: now,
    },
  });
  return operationId;
}

function sync(entityId: string, fieldName: string, sourceVersion: string, clock: ManualClock) {
  return {
    entityType: 'customer',
    entityId,
    fieldName,
    source: 'PORTAL',
    sourceVersion,
    sourceChangedAt: clock.now(),
    lastAppliedAt: clock.now(),
  };
}

function historyRow(entityId: string, fieldName: string, clock: ManualClock) {
  return {
    entityType: 'customer',
    entityId,
    fieldName,
    oldValue: 'before',
    newValue: 'after',
    source: 'PORTAL',
    decision: 'APPLIED',
    sourceChangedAt: clock.now(),
    appliedAt: clock.now(),
  };
}

async function setQuota(
  prisma: PrismaService,
  clock: ManualClock,
  tokens: bigint,
  maxTokens: bigint,
  refillPerSecondMilli: bigint,
): Promise<void> {
  await prisma.client.apiQuotaBucket.update({
    where: { bucket: QUOTA_BUCKET },
    data: { tokens, maxTokens, refillPerSecondMilli, updatedAt: clock.now() },
  });
}

async function cleanup(prisma: PrismaService): Promise<void> {
  const customers = await prisma.client.customer.findMany({
    where: { OR: [{ name: { startsWith: SCOPE } }, { salesforceId: { startsWith: 'SF-WK-' } }] },
    select: { id: true },
  });
  const contacts = await prisma.client.contact.findMany({
    where: {
      OR: [{ fullName: { startsWith: SCOPE } }, { salesforceId: { startsWith: 'SF-WK-' } }],
    },
    select: { id: true },
  });
  const ids = [...customers, ...contacts].map((row) => row.id);
  if (ids.length === 0) {
    return;
  }
  await prisma.client.fieldHistory.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.client.fieldSyncState.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.client.outboxEvent.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.client.syncOperation.deleteMany({ where: { entityId: { in: ids } } });
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
}
