import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseWebhook } from '@sync/contracts';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { Ids } from './records/ids';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';
const BLOCKED_EVENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BLOCKED_ACCOUNT = 'SF-IT-ACC-blocked';

describe('fake salesforce account and contact writes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ids: Ids = {
    accountId: () => `SF-IT-ACC-${randomUUID()}`,
    contactId: () => `SF-IT-CON-${randomUUID()}`,
    eventId: () => randomUUID(),
  };

  beforeAll(async () => {
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
        DELETE FROM sf_webhook_deliveries
        WHERE event_id = ${BLOCKED_EVENT}::uuid
           OR change_sequence IN (
             SELECT sequence FROM sf_change_log WHERE record_id LIKE 'SF-IT-%'
           )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sf_idempotency_keys WHERE record_id LIKE 'SF-IT-%'
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sf_change_log
        WHERE record_id LIKE 'SF-IT-%' OR event_id = ${BLOCKED_EVENT}::uuid
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sf_contacts
        WHERE id LIKE 'SF-IT-%' OR account_id LIKE 'SF-IT-%'
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sf_accounts WHERE id LIKE 'SF-IT-%'
      `;
    }
    await app?.close();
  });

  function operation(): string {
    return randomUUID();
  }

  it('appends one change-log row for a create and replays the same operation', async () => {
    const key = operation();
    const created = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .set('Idempotency-Key', key)
      .set('X-Changed-By', 'sf-user-1')
      .set('X-Correlation-Id', CORRELATION_ID)
      .send({ name: 'Acme', status: 'active', nickname: 'nope' });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('unknown_field');

    const response = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .set('Idempotency-Key', key)
      .set('X-Changed-By', 'sf-user-1')
      .set('X-Correlation-Id', CORRELATION_ID)
      .send({ name: 'Acme', status: 'active' });
    expect(response.status).toBe(201);
    expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
    const id = response.body.id as string;
    expect(id.startsWith('SF-IT-ACC-')).toBe(true);
    expect(response.body).toMatchObject({
      id,
      name: 'Acme',
      status: 'active',
      ownerId: null,
      version: 1,
    });
    expect(response.body.systemModstamp).toEqual(expect.any(String));

    const replay = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .set('Idempotency-Key', key)
      .send({ name: 'Acme', status: 'active' });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(response.body);

    const conflict = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .set('Idempotency-Key', key)
      .send({ name: 'Other' });
    expect(conflict.status).toBe(409);

    const log = await prisma.client.sfChangeLog.findMany({ where: { recordId: id } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      objectType: 'Account',
      changedBy: 'sf-user-1',
      changedFields: { name: 'Acme', status: 'active' },
      values: { name: 'Acme', status: 'active' },
      version: 1n,
      originOperationId: key,
    });
    expect(log[0]?.occurredAt.toISOString()).toBe(response.body.systemModstamp);
    const envelope = {
      eventId: log[0]?.eventId,
      objectType: 'Account',
      recordId: id,
      eventType: 'created',
      changedFields: log[0]?.changedFields,
      changedBy: 'sf-user-1',
      occurredAt: log[0]?.occurredAt.toISOString(),
      recordVersion: 1,
      originOperationId: key,
      changeSequence: Number(log[0]?.sequence),
    };
    expect(parseWebhook(envelope, CORRELATION_ID).ok).toBe(true);
    expect(
      await prisma.client.sfWebhookDelivery.count({ where: { eventId: log[0]?.eventId } }),
    ).toBe(0);

    const read = await request(app.getHttpServer()).get(`/sf/v1/accounts/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(response.body);
    expect((await request(app.getHttpServer()).get('/sf/v1/accounts/missing')).status).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .post('/sf/v1/accounts')
          .set('Idempotency-Key', 'not-a-uuid')
          .send({ name: 'Nope' })
      ).status,
    ).toBe(400);
  });

  it('rolls back the account when the change-log insert fails', async () => {
    const accountId = ids.accountId;
    const eventId = ids.eventId;
    ids.accountId = () => BLOCKED_ACCOUNT;
    ids.eventId = () => BLOCKED_EVENT;
    const key = operation();
    try {
      await prisma.client.sfChangeLog.create({
        data: {
          eventId: BLOCKED_EVENT,
          objectType: 'Account',
          recordId: 'SF-IT-BLOCKER',
          changedFields: { name: 'blocker' },
          values: { name: 'blocker' },
          version: 1n,
          occurredAt: new Date(),
        },
      });
      const response = await request(app.getHttpServer())
        .post('/sf/v1/accounts')
        .set('Idempotency-Key', key)
        .send({ name: 'Rollback' });
      expect(response.status).toBe(500);
      expect(
        await prisma.client.sfAccount.findUnique({ where: { id: BLOCKED_ACCOUNT } }),
      ).toBeNull();
      expect(
        await prisma.client.sfIdempotencyKey.findUnique({ where: { operationId: key } }),
      ).toBeNull();
      expect(await prisma.client.sfChangeLog.count({ where: { eventId: BLOCKED_EVENT } })).toBe(1);
    } finally {
      ids.accountId = accountId;
      ids.eventId = eventId;
      await prisma.client.sfChangeLog.deleteMany({ where: { eventId: BLOCKED_EVENT } });
    }
  });

  it('keeps a null clear distinct from an unchanged patch', async () => {
    const created = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .set('X-Changed-By', 'local-user')
      .send({ name: 'Acme', status: 'active' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const stamp = created.body.systemModstamp as string;

    const cleared = await request(app.getHttpServer())
      .patch(`/sf/v1/accounts/${id}`)
      .set('X-Changed-By', 'local-user')
      .send({ name: 'Acme', status: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: null, version: 2 });
    expect(cleared.body.systemModstamp).not.toBe(stamp);
    const log = await prisma.client.sfChangeLog.findMany({
      where: { recordId: id },
      orderBy: { sequence: 'asc' },
    });
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({
      changedFields: { status: null },
      values: { status: null },
      version: 2n,
      originOperationId: null,
      changedBy: 'local-user',
    });

    const again = await request(app.getHttpServer())
      .patch(`/sf/v1/accounts/${id}`)
      .send({ status: null });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(2);
    expect(again.body.systemModstamp).toBe(cleared.body.systemModstamp);
    expect(await prisma.client.sfChangeLog.count({ where: { recordId: id } })).toBe(2);
  });

  it('requires an account for a contact and writes one log row per logical change', async () => {
    const missing = await request(app.getHttpServer())
      .post('/sf/v1/contacts')
      .set('Idempotency-Key', operation())
      .send({ accountId: 'SF-IT-MISSING', email: 'ada@example.com' });
    expect(missing.status).toBe(404);
    expect(await prisma.client.sfContact.count({ where: { accountId: 'SF-IT-MISSING' } })).toBe(0);

    const account = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .send({ name: 'Parent' });
    const other = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .send({ name: 'Other' });
    const key = operation();
    const created = await request(app.getHttpServer())
      .post('/sf/v1/contacts')
      .set('Idempotency-Key', key)
      .set('X-Changed-By', 'sf-user-1')
      .send({ accountId: account.body.id, email: 'ada@example.com', phone: null });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      accountId: account.body.id,
      email: 'ada@example.com',
      phone: null,
      version: 1,
    });
    const replay = await request(app.getHttpServer())
      .post('/sf/v1/contacts')
      .set('Idempotency-Key', key)
      .send({ accountId: account.body.id, email: 'ada@example.com', phone: null });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created.body.id);
    const contactId = created.body.id as string;
    expect(await prisma.client.sfChangeLog.count({ where: { recordId: contactId } })).toBe(1);

    const moved = await request(app.getHttpServer())
      .patch(`/sf/v1/contacts/${contactId}`)
      .send({ accountId: 'SF-IT-MISSING' });
    expect(moved.status).toBe(404);
    expect(await prisma.client.sfContact.findUnique({ where: { id: contactId } })).toMatchObject({
      accountId: account.body.id,
      version: 1n,
    });

    const patched = await request(app.getHttpServer())
      .patch(`/sf/v1/contacts/${contactId}`)
      .set('X-Changed-By', 'sf-user-1')
      .send({ phone: '555', city: 'Austin', accountId: other.body.id });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);
    const updates = await prisma.client.sfChangeLog.findMany({
      where: { recordId: contactId, version: 2n },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.objectType).toBe('Contact');
    expect(updates[0]?.changedFields).toEqual({
      phone: '555',
      city: 'Austin',
      accountId: other.body.id,
    });
    expect(updates[0]?.values).toEqual(updates[0]?.changedFields);
  });

  it('pages the change log by an exclusive sequence cursor', async () => {
    const before = await prisma.client.sfChangeLog.aggregate({ _max: { sequence: true } });
    const cursor = Number(before._max.sequence ?? 0n);
    const first = await request(app.getHttpServer()).post('/sf/v1/accounts').send({ name: 'One' });
    const second = await request(app.getHttpServer()).post('/sf/v1/accounts').send({ name: 'Two' });
    const page = await request(app.getHttpServer())
      .get('/sf/v1/changes')
      .query({ after: cursor, limit: 1 });
    expect(page.status).toBe(200);
    expect(page.body).toHaveLength(1);
    expect(page.body[0]).toMatchObject({
      recordId: first.body.id,
      eventType: 'created',
      changedFields: { name: 'One' },
      changedBy: null,
      originOperationId: null,
      recordVersion: 1,
    });
    expect(page.body[0].changeSequence).toBeGreaterThan(cursor);
    const repeated = await request(app.getHttpServer())
      .get('/sf/v1/changes')
      .query({ after: cursor, limit: 1 });
    expect(repeated.body).toEqual(page.body);

    const third = await request(app.getHttpServer())
      .post('/sf/v1/accounts')
      .send({ name: 'Three' });
    const stable = await request(app.getHttpServer())
      .get('/sf/v1/changes')
      .query({ after: cursor, limit: 1 });
    expect(stable.body).toEqual(page.body);
    const rest = await request(app.getHttpServer())
      .get('/sf/v1/changes')
      .query({ after: page.body[0].changeSequence });
    expect(rest.body.map((row: { recordId: string }) => row.recordId)).toEqual([
      second.body.id,
      third.body.id,
    ]);
    expect(
      rest.body.every(
        (row: { changeSequence: number }) => row.changeSequence > page.body[0].changeSequence,
      ),
    ).toBe(true);

    expect(
      (await request(app.getHttpServer()).get('/sf/v1/changes').query({ limit: 0 })).status,
    ).toBe(400);
    expect(
      (await request(app.getHttpServer()).get('/sf/v1/changes').query({ after: -1 })).status,
    ).toBe(400);
    const open = await request(app.getHttpServer()).get('/sf/v1/changes').query({ after: cursor });
    expect(open.body.length).toBeGreaterThanOrEqual(3);
    expect(open.body.length).toBeLessThanOrEqual(100);
  });
});
