import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';
const SECRET = 'local-webhook-secret';
const ACTOR = 'dev-user';

describe('portal inbound salesforce webhook', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const created: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup(prisma, created);
    }
    await app?.close();
  });

  it('applies only the changed fields and does not enqueue an outbound row', async () => {
    const customer = await seedCustomer(prisma, created);
    const before = await prisma.client.outboxEvent.count({ where: { entityId: customer.id } });
    const response = await post(
      app,
      envelope({
        recordId: customer.salesforceId,
        changedFields: { name: 'Remote' },
        recordVersion: 4,
        occurredAt: '2026-11-12T00:00:00.000Z',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'applied' });
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe('Remote');
    expect(row.status).toBe('active');
    expect(row.rowVersion).toBe(2n);
    expect(await prisma.client.outboxEvent.count({ where: { entityId: customer.id } })).toBe(
      before,
    );
    const history = await prisma.client.fieldHistory.findMany({ where: { entityId: customer.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fieldName: 'name',
      source: 'SALESFORCE',
      actorId: null,
      decision: 'APPLIED',
      eventId: response.body.eventId,
    });
    const state = await prisma.client.fieldSyncState.findUniqueOrThrow({
      where: {
        entityType_entityId_fieldName: {
          entityType: 'customer',
          entityId: customer.id,
          fieldName: 'name',
        },
      },
    });
    expect(state).toMatchObject({ source: 'SALESFORCE', sourceVersion: '4' });
  });

  it('acknowledges a duplicate payload and rejects a different hash', async () => {
    const customer = await seedCustomer(prisma, created, 'First');
    const eventId = randomUUID();
    const raw = envelope({
      eventId,
      recordId: customer.salesforceId,
      changedFields: { name: 'Once' },
      recordVersion: 3,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    expect((await post(app, raw)).status).toBe(200);
    const replay = await post(app, raw);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe('duplicate');
    const third = await post(app, raw);
    expect(third.status).toBe(200);
    expect(third.body.outcome).toBe('duplicate');
    expect(await prisma.client.fieldHistory.count({ where: { entityId: customer.id } })).toBe(1);
    const changed = envelope({
      eventId,
      recordId: customer.salesforceId,
      changedFields: { name: 'Twice' },
      recordVersion: 3,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const mismatch = await post(app, changed);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('integrity_error');
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe('Once');
    expect(await prisma.client.processedEvent.count({ where: { eventId } })).toBe(1);
  });

  it('applies one of two concurrent deliveries of the same event', async () => {
    const customer = await seedCustomer(prisma, created, 'Race');
    const raw = envelope({
      recordId: customer.salesforceId,
      changedFields: { name: 'Winner' },
      recordVersion: 5,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const [left, right] = await Promise.all([post(app, raw), post(app, raw)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect([left.body.outcome, right.body.outcome].sort()).toEqual(['applied', 'duplicate']);
    expect(await prisma.client.fieldHistory.count({ where: { entityId: customer.id } })).toBe(1);
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe('Winner');
    expect(await prisma.client.outboxEvent.count({ where: { entityId: customer.id } })).toBe(0);
  });

  it('keeps a newer field version and still applies an older event to another field', async () => {
    const customer = await seedCustomer(prisma, created, 'Ordered');
    const newer = await post(
      app,
      envelope({
        recordId: customer.salesforceId,
        changedFields: { name: 'Version 12' },
        recordVersion: 12,
        occurredAt: '2026-11-11T10:00:00.000Z',
      }),
    );
    expect(newer.body.outcome).toBe('applied');
    const older = await post(
      app,
      envelope({
        recordId: customer.salesforceId,
        changedFields: { name: 'Version 11', status: 'paused' },
        recordVersion: 11,
        occurredAt: '2026-11-12T10:00:00.000Z',
      }),
    );
    expect(older.status).toBe(200);
    expect(older.body.outcome).toBe('applied');
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe('Version 12');
    expect(row.status).toBe('paused');
    const history = await prisma.client.fieldHistory.findMany({
      where: { entityId: customer.id, eventId: older.body.eventId as string },
      orderBy: { fieldName: 'asc' },
    });
    expect(history.map((item) => ({ field: item.fieldName, decision: item.decision }))).toEqual([
      { field: 'name', decision: 'REJECTED_STALE' },
      { field: 'status', decision: 'APPLIED' },
    ]);
  });

  it('rejects a bad signature and an unknown field without a database write', async () => {
    const customer = await seedCustomer(prisma, created, 'Untouched');
    const raw = envelope({
      recordId: customer.salesforceId,
      changedFields: { name: 'Tampered' },
      recordVersion: 2,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const missing = await request(app.getHttpServer())
      .post('/webhooks/salesforce')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-Id', CORRELATION_ID)
      .send(raw);
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('invalid_signature');
    const tampered = await post(app, raw, sign(`${raw} `));
    expect(tampered.status).toBe(401);
    expect(tampered.body.code).toBe('invalid_signature');
    const unknown = envelope({
      recordId: customer.salesforceId,
      changedFields: { name: 'Nope', nickname: 'extra' },
      recordVersion: 2,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const rejected = await post(app, unknown);
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('unknown_field');
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe('Untouched');
    expect(
      await prisma.client.processedEvent.count({ where: { externalId: customer.salesforceId } }),
    ).toBe(0);
  });

  it('acks an echoed operation without a second outbound row', async () => {
    const key = `it-wh-${randomUUID()}`;
    const createdResponse = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', key)
      .set('X-Correlation-Id', CORRELATION_ID)
      .send({ name: 'Echo Co', status: 'active' });
    expect(createdResponse.status).toBe(201);
    const entityId = createdResponse.body.id as string;
    created.push(entityId);
    const operation = await prisma.client.syncOperation.findFirstOrThrow({ where: { entityId } });
    const before = await prisma.client.outboxEvent.count({ where: { entityId } });
    const recordId = `SF-WH-${randomUUID()}`;
    const response = await post(
      app,
      envelope({
        recordId,
        eventType: 'created',
        changedFields: operation.expectedValues as Record<string, string | null>,
        recordVersion: 2,
        occurredAt: '2026-11-12T12:00:00.000Z',
        originOperationId: operation.operationId,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('ignored');
    expect(await prisma.client.outboxEvent.count({ where: { entityId } })).toBe(before);
    const acked = await prisma.client.syncOperation.findUniqueOrThrow({
      where: { operationId: operation.operationId },
    });
    expect(acked).toMatchObject({ status: 'ACKED', externalId: recordId });
    const row = await prisma.client.customer.findUniqueOrThrow({ where: { id: entityId } });
    expect(row.salesforceId).toBe(recordId);
    expect(row.name).toBe('Echo Co');
    expect(row.rowVersion).toBe(1n);
  });

  it('defers an unknown external id and a contact whose parent is unmapped', async () => {
    const raw = envelope({
      recordId: `SF-WH-${randomUUID()}`,
      changedFields: { name: 'Ghost' },
      recordVersion: 1,
      occurredAt: '2026-11-12T00:00:00.000Z',
    });
    const missing = await post(app, raw);
    expect(missing.status).toBe(409);
    expect(missing.body.message).toBe('External mapping is not available');
    expect(
      await prisma.client.processedEvent.count({
        where: { eventId: (JSON.parse(raw) as { eventId: string }).eventId },
      }),
    ).toBe(0);

    const customer = await seedCustomer(prisma, created, 'Parent');
    const contactId = randomUUID();
    created.push(contactId);
    await prisma.client.contact.create({
      data: {
        id: contactId,
        salesforceId: `SF-WH-${randomUUID()}`,
        customerId: customer.id,
        fullName: 'Ada',
        rowVersion: 1n,
        createdAt: new Date('2026-11-11T09:00:00.000Z'),
        updatedAt: new Date('2026-11-11T09:00:00.000Z'),
      },
    });
    const contact = await prisma.client.contact.findUniqueOrThrow({ where: { id: contactId } });
    const deferred = await post(
      app,
      envelope({
        objectType: 'Contact',
        recordId: contact.salesforceId ?? '',
        changedFields: { accountId: `SF-WH-${randomUUID()}`, city: 'Paris' },
        recordVersion: 2,
        occurredAt: '2026-11-12T00:00:00.000Z',
      }),
    );
    expect(deferred.status).toBe(409);
    expect(deferred.body.message).toBe('Parent mapping is not available');
    const stored = await prisma.client.contact.findUniqueOrThrow({ where: { id: contactId } });
    expect(stored.customerId).toBe(customer.id);
    expect(stored.city).toBeNull();
    expect(
      await prisma.client.processedEvent.count({ where: { externalId: contact.salesforceId } }),
    ).toBe(0);
  });

  it('merges an independent field and keeps the newer portal value on the same field', async () => {
    const customer = await seedCustomer(prisma, created, 'Portal name');
    const stamp = new Date('2026-11-11T10:00:00.000Z');
    await prisma.client.fieldSyncState.create({
      data: {
        entityType: 'customer',
        entityId: customer.id,
        fieldName: 'name',
        source: 'PORTAL',
        sourceVersion: '2',
        sourceChangedAt: stamp,
        lastAppliedAt: stamp,
      },
    });
    const lost = await post(
      app,
      envelope({
        recordId: customer.salesforceId,
        changedFields: { name: 'Older remote', ownerId: 'owner-remote' },
        recordVersion: 6,
        occurredAt: '2026-11-11T09:00:00.000Z',
      }),
    );
    expect(lost.status).toBe(200);
    expect(lost.body.outcome).toBe('applied');
    const merged = await prisma.client.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(merged.name).toBe('Portal name');
    expect(merged.ownerId).toBe('owner-remote');
    const decisions = await prisma.client.fieldHistory.findMany({
      where: { entityId: customer.id },
      orderBy: { fieldName: 'asc' },
    });
    expect(decisions.map((item) => item.decision)).toEqual(['CONFLICT_LOST', 'APPLIED']);
    expect(await prisma.client.outboxEvent.count({ where: { entityId: customer.id } })).toBe(0);

    const tied = await seedCustomer(prisma, created, 'Tied');
    await prisma.client.fieldSyncState.create({
      data: {
        entityType: 'customer',
        entityId: tied.id,
        fieldName: 'name',
        source: 'PORTAL',
        sourceVersion: '2',
        sourceChangedAt: stamp,
        lastAppliedAt: stamp,
      },
    });
    const winner = await post(
      app,
      envelope({
        recordId: tied.salesforceId,
        changedFields: { name: 'Salesforce tie' },
        recordVersion: 7,
        occurredAt: stamp.toISOString(),
      }),
    );
    expect(winner.body.outcome).toBe('applied');
    const tieRow = await prisma.client.customer.findUniqueOrThrow({ where: { id: tied.id } });
    expect(tieRow.name).toBe('Salesforce tie');
  });
});

function envelope(input: {
  eventId?: string;
  objectType?: 'Account' | 'Contact';
  recordId: string;
  eventType?: 'created' | 'updated';
  changedFields: Record<string, string | null>;
  recordVersion: number;
  occurredAt: string;
  originOperationId?: string | null;
  changeSequence?: number;
}): string {
  return JSON.stringify({
    eventId: input.eventId ?? randomUUID(),
    objectType: input.objectType ?? 'Account',
    recordId: input.recordId,
    eventType: input.eventType ?? 'updated',
    changedFields: input.changedFields,
    changedBy: 'sf-user-1',
    recordVersion: input.recordVersion,
    occurredAt: input.occurredAt,
    originOperationId: input.originOperationId ?? null,
    changeSequence: input.changeSequence ?? 1,
  });
}

function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex');
}

function post(app: INestApplication, raw: string, signature = sign(raw)) {
  return request(app.getHttpServer())
    .post('/webhooks/salesforce')
    .set('Content-Type', 'application/json')
    .set('X-Salesforce-Signature', signature)
    .set('X-Correlation-Id', CORRELATION_ID)
    .send(raw);
}

async function seedCustomer(
  prisma: PrismaService,
  created: string[],
  name = 'Old',
): Promise<{ id: string; salesforceId: string }> {
  const id = randomUUID();
  const salesforceId = `SF-WH-${randomUUID()}`;
  const at = new Date('2026-11-11T08:00:00.000Z');
  created.push(id);
  await prisma.client.customer.create({
    data: {
      id,
      salesforceId,
      name,
      status: 'active',
      ownerId: null,
      rowVersion: 1n,
      createdAt: at,
      updatedAt: at,
    },
  });
  return { id, salesforceId };
}

async function cleanup(prisma: PrismaService, created: string[]): Promise<void> {
  const customers = await prisma.client.customer.findMany({
    where: { OR: [{ salesforceId: { startsWith: 'SF-WH-' } }, { id: { in: created } }] },
    select: { id: true },
  });
  const customerIds = customers.map((row) => row.id);
  const contacts = await prisma.client.contact.findMany({
    where: {
      OR: [
        { salesforceId: { startsWith: 'SF-WH-' } },
        { customerId: { in: customerIds } },
        { id: { in: created } },
      ],
    },
    select: { id: true },
  });
  const ids = [...customerIds, ...contacts.map((row) => row.id)];
  if (ids.length > 0) {
    await prisma.client.fieldHistory.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.fieldSyncState.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.outboxEvent.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.client.syncOperation.deleteMany({ where: { entityId: { in: ids } } });
  }
  await prisma.client.processedEvent.deleteMany({
    where: { externalId: { startsWith: 'SF-WH-' } },
  });
  if (contacts.length > 0) {
    await prisma.client.contact.deleteMany({
      where: { id: { in: contacts.map((row) => row.id) } },
    });
  }
  if (customerIds.length > 0) {
    await prisma.client.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  await prisma.client.clientIdempotencyKey.deleteMany({
    where: { idempotencyKey: { startsWith: 'it-wh-' } },
  });
}
