import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseContact, parseCustomer } from '@sync/contracts';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { Ids } from './sync/ids';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';
const ACTOR = 'dev-user';
const BLOCKED_ENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BLOCKED_OPERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function portalDatabaseUrl(): string {
  if (process.env.PORTAL_SCHEMA_DATABASE_URL) {
    return process.env.PORTAL_SCHEMA_DATABASE_URL;
  }
  const text = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('PORTAL_DATABASE_URL=')) {
      return line.slice('PORTAL_DATABASE_URL='.length);
    }
  }
  throw new Error('PORTAL_DATABASE_URL is missing from .env.example');
}

describe('portal customer and contact writes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ids: Ids = {
    entityId: () => randomUUID(),
    operationId: () => randomUUID(),
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORTAL_HTTP_PORT = '3000';
    process.env.PORTAL_DATABASE_URL = portalDatabaseUrl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Ids)
      .useValue(ids)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.client.$executeRaw`
        DELETE FROM field_sync_state
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR entity_id = ${BLOCKED_ENTITY}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM field_history
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR entity_id = ${BLOCKED_ENTITY}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM outbox_events
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR entity_id = ${BLOCKED_ENTITY}::uuid OR operation_id = ${BLOCKED_OPERATION}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sync_operations
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR entity_id = ${BLOCKED_ENTITY}::uuid OR operation_id = ${BLOCKED_OPERATION}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM contacts
        WHERE id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR customer_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR id = ${BLOCKED_ENTITY}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM customers
        WHERE id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
        ) OR id = ${BLOCKED_ENTITY}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM client_idempotency_keys WHERE idempotency_key LIKE 'it-%'
      `;
    }
    await app?.close();
  });

  function key(): string {
    return `it-${randomUUID()}`;
  }

  it('creates one customer for an idempotency key and records the header actor', async () => {
    const idempotencyKey = key();
    const created = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('X-Correlation-Id', CORRELATION_ID)
      .set('Idempotency-Key', idempotencyKey)
      .send({ name: 'Acme', status: 'active', changedBy: 'from-body' });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('unknown_field');

    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('X-Correlation-Id', CORRELATION_ID)
      .set('Idempotency-Key', idempotencyKey)
      .send({ name: 'Acme', status: 'active' });
    expect(response.status).toBe(201);
    expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
    expect(parseCustomer(response.body, CORRELATION_ID).ok).toBe(true);
    expect(response.body.salesforceId).toBeNull();
    expect(response.body.rowVersion).toBe(1);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', 'other-user')
      .set('Idempotency-Key', idempotencyKey)
      .send({ name: 'Acme', status: 'active' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(response.body.id);

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', idempotencyKey)
      .send({ name: 'Other' });
    expect(conflict.status).toBe(409);

    const history = await prisma.client.fieldHistory.findMany({
      where: { entityId: response.body.id as string },
      orderBy: { fieldName: 'asc' },
    });
    expect(history.map((row) => row.fieldName)).toEqual(['name', 'status']);
    expect(history.every((row) => row.actorId === ACTOR && row.source === 'PORTAL')).toBe(true);
    expect(history.every((row) => row.decision === 'APPLIED' && row.eventId === null)).toBe(true);
    const outbox = await prisma.client.outboxEvent.findMany({
      where: { entityId: response.body.id as string },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: 'created',
      status: 'PENDING',
      entityType: 'customer',
    });
    expect(outbox[0]?.changedFields).toEqual({ name: 'Acme', status: 'active' });
    const operations = await prisma.client.syncOperation.findMany({
      where: { entityId: response.body.id as string },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operationId).toBe(outbox[0]?.operationId);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/customers/${response.body.id}`)
      .set('X-Actor-Id', ACTOR);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(response.body);
    const missingActor = await request(app.getHttpServer()).get(
      `/api/v1/customers/${response.body.id}`,
    );
    expect(missingActor.status).toBe(401);
  });

  it('rolls back the customer, history, sync state, and idempotency key together', async () => {
    const entityId = ids.entityId;
    const operationId = ids.operationId;
    ids.entityId = () => BLOCKED_ENTITY;
    ids.operationId = () => BLOCKED_OPERATION;
    const idempotencyKey = key();
    try {
      await prisma.client.outboxEvent.create({
        data: {
          operationId: BLOCKED_OPERATION,
          entityType: 'customer',
          entityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          eventType: 'created',
          changedFields: { name: 'blocker' },
          baseVersions: { rowVersion: 1, fields: { name: '1' } },
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('X-Actor-Id', ACTOR)
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Rollback' });
      expect(response.status).toBe(500);
      expect(await prisma.client.customer.findUnique({ where: { id: BLOCKED_ENTITY } })).toBeNull();
      expect(
        await prisma.client.clientIdempotencyKey.findUnique({
          where: {
            scope_idempotencyKey: { scope: 'customer.create', idempotencyKey },
          },
        }),
      ).toBeNull();
      expect(await prisma.client.fieldHistory.count({ where: { entityId: BLOCKED_ENTITY } })).toBe(
        0,
      );
      expect(
        await prisma.client.fieldSyncState.count({ where: { entityId: BLOCKED_ENTITY } }),
      ).toBe(0);
      expect(
        await prisma.client.syncOperation.findUnique({ where: { operationId: BLOCKED_OPERATION } }),
      ).toBeNull();
      expect(
        await prisma.client.outboxEvent.count({ where: { operationId: BLOCKED_OPERATION } }),
      ).toBe(1);
    } finally {
      ids.entityId = entityId;
      ids.operationId = operationId;
      await prisma.client.outboxEvent.deleteMany({ where: { operationId: BLOCKED_OPERATION } });
    }
  });

  it('keeps an unchanged patch and a null clear distinct, and rejects a stale rowVersion', async () => {
    const idempotencyKey = key();
    const created = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', idempotencyKey)
      .send({ name: 'Acme', status: 'active', ownerId: 'owner-1' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const unchanged = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}`)
      .set('X-Actor-Id', ACTOR)
      .set('If-Match', '1')
      .send({ name: 'Acme' });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.rowVersion).toBe(1);
    expect(await prisma.client.outboxEvent.count({ where: { entityId: id } })).toBe(1);
    expect(await prisma.client.fieldHistory.count({ where: { entityId: id } })).toBe(3);

    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}`)
      .set('X-Actor-Id', ACTOR)
      .set('If-Match', '0')
      .send({ status: null });
    expect(stale.status).toBe(412);
    expect(await prisma.client.customer.findUnique({ where: { id } })).toMatchObject({
      status: 'active',
      rowVersion: 1n,
    });
    expect(await prisma.client.outboxEvent.count({ where: { entityId: id } })).toBe(1);

    const cleared = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}`)
      .set('X-Actor-Id', ACTOR)
      .set('If-Match', '1')
      .send({ status: null, ownerId: 'owner-2' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: null, ownerId: 'owner-2', rowVersion: 2 });
    const outbox = await prisma.client.outboxEvent.findMany({
      where: { entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(outbox).toHaveLength(2);
    expect(outbox[1]?.eventType).toBe('updated');
    expect(outbox[1]?.changedFields).toEqual({ status: null, ownerId: 'owner-2' });
    const clearHistory = await prisma.client.fieldHistory.findMany({
      where: { entityId: id, operationId: outbox[1]?.operationId },
    });
    expect(clearHistory).toHaveLength(2);
    expect(clearHistory.find((row) => row.fieldName === 'status')).toMatchObject({
      oldValue: 'active',
      newValue: null,
      decision: 'APPLIED',
      actorId: ACTOR,
    });

    const again = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}`)
      .set('X-Actor-Id', ACTOR)
      .send({ status: null });
    expect(again.status).toBe(200);
    expect(again.body.rowVersion).toBe(2);
    expect(await prisma.client.outboxEvent.count({ where: { entityId: id } })).toBe(2);
  });

  it('requires a portal customer and holds the contact outbox until that parent is mapped', async () => {
    const missing = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const rejected = await request(app.getHttpServer())
      .post('/api/v1/contacts')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', key())
      .send({ customerId: missing, email: 'ada@example.com' });
    expect(rejected.status).toBe(404);
    expect(await prisma.client.contact.count({ where: { customerId: missing } })).toBe(0);
    expect(await prisma.client.outboxEvent.count({ where: { entityId: missing } })).toBe(0);

    const customer = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', key())
      .send({ name: 'Parent' });
    expect(customer.status).toBe(201);
    const customerId = customer.body.id as string;

    const contact = await request(app.getHttpServer())
      .post('/api/v1/contacts')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', key())
      .send({ customerId, email: 'ada@example.com', phone: null });
    expect(contact.status).toBe(201);
    expect(parseContact(contact.body, CORRELATION_ID).ok).toBe(true);
    expect(contact.body.customerId).toBe(customerId);
    expect(contact.body.phone).toBeNull();
    expect('phone' in contact.body).toBe(true);
    const contactId = contact.body.id as string;
    const held = await prisma.client.outboxEvent.findMany({ where: { entityId: contactId } });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      entityType: 'contact',
      eventType: 'created',
      status: 'RETRY',
      lastError: 'parent_unmapped',
    });
    expect(held[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(held[0]?.changedFields).toEqual({ customerId, email: 'ada@example.com' });

    const moved = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${contactId}`)
      .set('X-Actor-Id', ACTOR)
      .send({ customerId: missing });
    expect(moved.status).toBe(404);
    expect(await prisma.client.contact.findUnique({ where: { id: contactId } })).toMatchObject({
      customerId,
      rowVersion: 1n,
    });
    expect(await prisma.client.outboxEvent.count({ where: { entityId: contactId } })).toBe(1);

    await prisma.client.customer.update({
      where: { id: customerId },
      data: { salesforceId: `SF-IT-${customerId}` },
    });
    const mapped = await request(app.getHttpServer())
      .post('/api/v1/contacts')
      .set('X-Actor-Id', ACTOR)
      .set('Idempotency-Key', key())
      .send({ customerId, city: 'Paris' });
    expect(mapped.status).toBe(201);
    const due = await prisma.client.outboxEvent.findFirstOrThrow({
      where: { entityId: mapped.body.id as string },
    });
    expect(due.status).toBe('PENDING');
    expect(due.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${contactId}`)
      .set('X-Actor-Id', ACTOR)
      .set('If-Match', '1')
      .send({ phone: '555', city: 'Austin' });
    expect(patched.status).toBe(200);
    expect(patched.body.rowVersion).toBe(2);
    const updates = await prisma.client.outboxEvent.findMany({
      where: { entityId: contactId, eventType: 'updated' },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.changedFields).toEqual({ phone: '555', city: 'Austin' });
    expect(updates[0]?.status).toBe('RETRY');
    expect(updates[0]?.lastError).toBe('unmapped');
    const repeat = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${contactId}`)
      .set('X-Actor-Id', ACTOR)
      .send({ phone: '555', city: 'Austin' });
    expect(repeat.status).toBe(200);
    expect(repeat.body.rowVersion).toBe(2);
    expect(
      await prisma.client.outboxEvent.count({
        where: { entityId: contactId, eventType: 'updated' },
      }),
    ).toBe(1);
  });
});
