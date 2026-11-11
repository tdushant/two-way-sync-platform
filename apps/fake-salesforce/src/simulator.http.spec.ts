import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseWebhook, type SimulatorConfig } from '@sync/contracts';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { DEFAULT_SIMULATOR_CONFIG } from './simulator/defaults';
import { Clock } from './webhook/clock';
import {
  DELIVERY_MAX_ATTEMPTS,
  backoffMs,
  type WebhookPostResult,
} from './webhook/delivery-policy';
import { PortalWebhookClient } from './webhook/portal-client';
import { SALESFORCE_SIGNATURE_HEADER, stableWebhookJson } from './webhook/signature';
import { TokenBucket } from './webhook/token-bucket';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';
const TOKEN = process.env.SIMULATOR_ADMIN_TOKEN ?? '';
const SECRET = process.env.WEBHOOK_HMAC_SECRET ?? '';
const WEBHOOK_URL = process.env.PORTAL_WEBHOOK_URL ?? '';
const SEED_AT = new Date('2026-11-11T10:00:00.000Z');

describe('fake salesforce webhook delivery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const script: WebhookPostResult[] = [];
  const clock = {
    current: new Date('2026-11-12T00:00:00.000Z'),
    now(): Date {
      return new Date(this.current.getTime());
    },
  };
  const client = {
    post(url: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult> {
      calls.push({ url, body, headers });
      return Promise.resolve(script.shift() ?? { status: 200, retryAfterSeconds: null });
    },
  } as PortalWebhookClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(PortalWebhookClient)
      .useValue(client)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    clock.current = new Date('2026-11-12T00:00:00.000Z');
    calls.length = 0;
    script.length = 0;
    await cleanTestRows(prisma);
    await prisma.client.sfApiRequestLog.deleteMany();
    await prisma.client.sfSimulatorConfig.upsert({
      where: { id: 1 },
      create: { id: 1, ...DEFAULT_SIMULATOR_CONFIG },
      update: DEFAULT_SIMULATOR_CONFIG,
    });
    app.get(TokenBucket).reset();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanTestRows(prisma);
      await prisma.client.sfApiRequestLog.deleteMany();
      await prisma.client.sfSimulatorConfig.deleteMany();
      await restoreSeed(prisma);
    }
    await app?.close();
  });

  it('signs the raw JSON body and stores a delivered attempt', async () => {
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const result = await flush(app);
    expect(result).toEqual({ attempted: 1, delivered: 1 });
    const sent = calls[0];
    expect(sent?.url).toBe(WEBHOOK_URL);
    expect(sent?.headers['content-type']).toBe('application/json');
    const raw = sent?.body ?? '';
    expect(sent?.headers[SALESFORCE_SIGNATURE_HEADER]).toBe(
      createHmac('sha256', SECRET).update(raw).digest('hex'),
    );
    expect(sent?.headers[SALESFORCE_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    const stored = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: eventId(raw) },
    });
    expect(raw).toBe(stableWebhookJson(stored.payload));
    expect(parseWebhook(JSON.parse(raw), CORRELATION_ID).ok).toBe(true);
    expect(stored).toMatchObject({ status: 'DELIVERED', attempts: 1, lastHttpStatus: 200 });
    expect(await prisma.client.sfChangeLog.count({ where: { recordId } })).toBe(1);
  });

  it('retries non-2xx with bounded backoff and stops after the attempt limit', async () => {
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const event = await changeEvent(prisma, recordId);
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      script.push({ status: 500, retryAfterSeconds: null });
      const sentAt = clock.current.getTime();
      expect(await flush(app)).toEqual({ attempted: 1, delivered: 0 });
      const row = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
        where: { eventId: event },
      });
      expect(row.attempts).toBe(attempt);
      expect(row.lastHttpStatus).toBe(500);
      if (attempt < DELIVERY_MAX_ATTEMPTS) {
        expect(row.status).toBe('PENDING');
        expect(row.scheduledAt.getTime()).toBe(sentAt + backoffMs(attempt));
        clock.current = new Date(row.scheduledAt.getTime());
      } else {
        expect(row.status).toBe('FAILED');
      }
    }
    expect(await flush(app)).toEqual({ attempted: 0, delivered: 0 });
    expect(calls).toHaveLength(DELIVERY_MAX_ATTEMPTS);
  });

  it('schedules a timeout and waits for Retry-After seconds', async () => {
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const event = await changeEvent(prisma, created.body.id as string);
    script.push({ timeout: true });
    const sentAt = clock.current.getTime();
    await flush(app);
    const timedOut = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(timedOut).toMatchObject({ status: 'PENDING', attempts: 1, lastHttpStatus: null });
    expect(timedOut.scheduledAt.getTime()).toBe(sentAt + backoffMs(1));

    clock.current = new Date(timedOut.scheduledAt.getTime());
    script.push({ status: 429, retryAfterSeconds: 30 });
    const retriedAt = clock.current.getTime();
    await flush(app);
    const limited = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(limited).toMatchObject({ status: 'PENDING', attempts: 2, lastHttpStatus: 429 });
    expect(limited.scheduledAt.getTime()).toBe(retriedAt + 30_000);
    clock.current = new Date(limited.scheduledAt.getTime() - 1);
    await flush(app);
    expect(calls).toHaveLength(2);
    clock.current = new Date(limited.scheduledAt.getTime());
    await flush(app);
    expect(calls).toHaveLength(3);
    const delivered = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(delivered.status).toBe('DELIVERED');
  });

  it('queues duplicateCount extra copies of the same event id', async () => {
    await putConfig(app, { duplicateCount: 2 });
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const event = await changeEvent(prisma, recordId);
    const rows = await prisma.client.sfWebhookDelivery.findMany({ where: { eventId: event } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => stableWebhookJson(row.payload))).size).toBe(1);
    expect(await prisma.client.sfChangeLog.count({ where: { recordId } })).toBe(1);
    expect(await flush(app)).toEqual({ attempted: 3, delivered: 3 });
    expect(calls.map((call) => call.body)).toEqual([
      calls[0]?.body,
      calls[0]?.body,
      calls[0]?.body,
    ]);
  });

  it('keeps a pending delivery while webhooks are disabled and sends it when enabled', async () => {
    await putConfig(app, { webhookEnabled: false });
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const event = await changeEvent(prisma, created.body.id as string);
    expect(await flush(app)).toEqual({ attempted: 0, delivered: 0 });
    expect(calls).toHaveLength(0);
    const waiting = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 0 });
    await putConfig(app, { webhookEnabled: true });
    expect(await flush(app)).toEqual({ attempted: 1, delivered: 1 });
    expect(calls).toHaveLength(1);
  });

  it('marks a dropped webhook without deleting the change log', async () => {
    await putConfig(app, { dropWebhookRate: 1 });
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const event = await changeEvent(prisma, recordId);
    const row = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(row).toMatchObject({ status: 'DROPPED', attempts: 0 });
    expect(await flush(app)).toEqual({ attempted: 0, delivered: 0 });
    expect(calls).toHaveLength(0);
    expect(await prisma.client.sfChangeLog.count({ where: { recordId } })).toBe(1);
  });

  it('waits until delayMs has elapsed on the injected clock', async () => {
    await putConfig(app, { delayMs: 5000 });
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const event = await changeEvent(prisma, created.body.id as string);
    const row = await prisma.client.sfWebhookDelivery.findFirstOrThrow({
      where: { eventId: event },
    });
    expect(row.scheduledAt.getTime()).toBe(clock.current.getTime() + 5000);
    expect(await flush(app)).toEqual({ attempted: 0, delivered: 0 });
    clock.current = new Date(row.scheduledAt.getTime() - 1);
    expect(await flush(app)).toEqual({ attempted: 0, delivered: 0 });
    clock.current = new Date(row.scheduledAt.getTime());
    expect(await flush(app)).toEqual({ attempted: 1, delivered: 1 });
  });

  it('replays the stored payload with the same event id', async () => {
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const event = await changeEvent(prisma, recordId);
    await flush(app);
    const replay = await request(app.getHttpServer())
      .post(`/simulator/replay-event/${event}`)
      .set('X-Simulator-Token', TOKEN);
    expect(replay.status).toBe(200);
    expect(replay.body.eventId).toBe(event);
    expect(await prisma.client.sfChangeLog.count({ where: { recordId } })).toBe(1);
    const rows = await prisma.client.sfWebhookDelivery.findMany({ where: { eventId: event } });
    expect(rows).toHaveLength(2);
    const pending = rows.find((row) => row.status === 'PENDING');
    const delivered = rows.find((row) => row.status === 'DELIVERED');
    expect(pending).toMatchObject({ attempts: 0 });
    expect(stableWebhookJson(pending?.payload)).toBe(stableWebhookJson(delivered?.payload));
    await flush(app);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });

  it('reorders delivery and rejects a record version decrease', async () => {
    const created = await postAccount(app, 'Original');
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    const emitted = await request(app.getHttpServer())
      .post('/simulator/emit-event')
      .set('X-Simulator-Token', TOKEN)
      .send({
        objectType: 'Account',
        recordId,
        occurredAt: '2026-11-12T00:00:01.000Z',
        changedFields: { name: 'Renamed' },
        changedBy: 'sf-user-1',
        recordVersion: 2,
      });
    expect(emitted.status).toBe(200);
    const log = await prisma.client.sfChangeLog.findMany({
      where: { recordId },
      orderBy: { sequence: 'asc' },
    });
    expect(log).toHaveLength(2);
    const first = log[0]?.eventId ?? '';
    const second = log[1]?.eventId ?? '';
    const reorder = await request(app.getHttpServer())
      .post('/simulator/reorder-deliveries')
      .set('X-Simulator-Token', TOKEN)
      .send({ eventIds: [second, first] });
    expect(reorder.status).toBe(200);
    const after = await prisma.client.sfChangeLog.findMany({
      where: { recordId },
      orderBy: { sequence: 'asc' },
    });
    expect(after.map((row) => row.sequence)).toEqual(log.map((row) => row.sequence));
    await flush(app);
    expect(calls.map((call) => eventId(call.body))).toEqual([second, first]);

    const decrease = await request(app.getHttpServer())
      .post('/simulator/emit-event')
      .set('X-Simulator-Token', TOKEN)
      .send({
        objectType: 'Account',
        recordId,
        occurredAt: '2026-11-12T00:00:02.000Z',
        changedFields: { name: 'Older' },
        changedBy: 'sf-user-1',
        recordVersion: 1,
      });
    expect(decrease.status).toBe(409);
    const account = await prisma.client.sfAccount.findUniqueOrThrow({ where: { id: recordId } });
    expect(account.version).toBe(2n);
    expect(account.name).toBe('Renamed');
  });

  it('emits the next contact version and leaves an unknown record unchanged', async () => {
    const account = await postAccount(app);
    expect(account.status).toBe(201);
    const contact = await request(app.getHttpServer())
      .post('/sf/v1/contacts')
      .set('X-Changed-By', 'sf-user-1')
      .send({ accountId: account.body.id, fullName: 'Ada' });
    expect(contact.status).toBe(201);
    const contactId = contact.body.id as string;
    const emitted = await request(app.getHttpServer())
      .post('/simulator/emit-event')
      .set('X-Simulator-Token', TOKEN)
      .send({
        objectType: 'Contact',
        recordId: contactId,
        occurredAt: '2026-11-12T00:00:03.000Z',
        changedFields: { phone: '+15555550123' },
        changedBy: 'sf-user-1',
      });
    expect(emitted.status).toBe(200);
    expect(emitted.body.recordVersion).toBe(2);
    const stale = await request(app.getHttpServer())
      .post('/simulator/emit-event')
      .set('X-Simulator-Token', TOKEN)
      .send({
        objectType: 'Contact',
        recordId: contactId,
        occurredAt: '2026-11-12T00:00:04.000Z',
        changedFields: { city: 'Austin' },
        changedBy: 'sf-user-1',
        recordVersion: 2,
      });
    expect(stale.status).toBe(409);
    const missing = await request(app.getHttpServer())
      .post('/simulator/emit-event')
      .set('X-Simulator-Token', TOKEN)
      .send({
        objectType: 'Account',
        recordId: 'SF-IT-MISSING',
        occurredAt: '2026-11-12T00:00:04.000Z',
        changedFields: { name: 'Ghost' },
        changedBy: 'sf-user-1',
      });
    expect(missing.status).toBe(404);
    expect(await prisma.client.sfAccount.count({ where: { id: 'SF-IT-MISSING' } })).toBe(0);
  });

  it('injects outage, 500, timeout, and 429 without committing a write', async () => {
    const created = await postAccount(app, 'Kept');
    expect(created.status).toBe(201);
    const recordId = created.body.id as string;
    await putConfig(app, { outageEnabled: true });
    const read = await request(app.getHttpServer()).get(`/sf/v1/accounts/${recordId}`);
    expect(read.status).toBe(200);
    const outage = await postAccount(app, 'Blocked');
    expect(outage.status).toBe(503);
    expect(await testAccountCount(prisma)).toBe(1);

    await putConfig(app, { failureRate: 1 });
    const failed = await postAccount(app, 'Broken');
    expect(failed.status).toBe(500);
    expect(await testAccountCount(prisma)).toBe(1);

    await putConfig(app, { responseDelayMs: 2500 });
    const timedOut = await postAccount(app, 'Slow');
    expect(timedOut.status).toBe(408);
    expect(await testAccountCount(prisma)).toBe(1);
    const requests = await request(app.getHttpServer())
      .get('/simulator/requests')
      .set('X-Simulator-Token', TOKEN);
    expect(requests.status).toBe(200);
    const timeoutLog = (requests.body as Array<Record<string, unknown>>).find(
      (row) => row.statusCode === 408,
    );
    expect(timeoutLog).toMatchObject({
      method: 'POST',
      path: '/sf/v1/accounts',
      latencyMs: 2500,
      operationId: null,
    });
    expect(timeoutLog).not.toHaveProperty('body');

    const operationId = '66666666-6666-4666-8666-666666666666';
    await putConfig(app, { rateLimitPerSec: 0 });
    const limited = await postAccount(app, 'Limited', operationId);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(await testAccountCount(prisma)).toBe(1);
    const limitedLog = await prisma.client.sfApiRequestLog.findFirst({
      where: { statusCode: 429, operationId },
    });
    expect(limitedLog?.path).toBe('/sf/v1/accounts');

    await putConfig(app, { rateLimitPerSec: 1 });
    expect((await postAccount(app, 'One')).status).toBe(201);
    expect((await postAccount(app, 'Two')).status).toBe(429);
    clock.current = new Date(clock.current.getTime() + 1000);
    expect((await postAccount(app, 'Three')).status).toBe(201);
    expect(await testAccountCount(prisma)).toBe(3);
  });

  it('resets business rows and returns the simulator to a writable default', async () => {
    try {
      await putConfig(app, { outageEnabled: true });
      expect((await postAccount(app, 'During outage')).status).toBe(503);
      const reset = await request(app.getHttpServer())
        .post('/simulator/reset')
        .set('X-Simulator-Token', TOKEN);
      expect(reset.status).toBe(200);
      expect(await prisma.client.sfAccount.count()).toBe(0);
      expect(await prisma.client.sfChangeLog.count()).toBe(0);
      expect(await prisma.client.sfWebhookDelivery.count()).toBe(0);
      expect((await postAccount(app, 'After reset')).status).toBe(201);
    } finally {
      await restoreSeed(prisma);
    }
  });

  it('requires the admin token and lists a queued delivery', async () => {
    const created = await postAccount(app);
    expect(created.status).toBe(201);
    const event = await changeEvent(prisma, created.body.id as string);
    const missing = await request(app.getHttpServer()).get('/simulator/deliveries');
    expect(missing.status).toBe(401);
    const wrong = await request(app.getHttpServer())
      .get('/simulator/deliveries')
      .set('X-Simulator-Token', 'other-token');
    expect(wrong.status).toBe(403);
    const invalid = await request(app.getHttpServer())
      .put('/simulator/config')
      .set('X-Simulator-Token', TOKEN)
      .send({ webhookEnabled: true });
    expect(invalid.status).toBe(400);
    const listed = await request(app.getHttpServer())
      .get('/simulator/deliveries')
      .set('X-Simulator-Token', TOKEN);
    expect(listed.status).toBe(200);
    const row = (listed.body as Array<Record<string, unknown>>).find(
      (item) => item.eventId === event,
    );
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, eventId: event });
  });
});

function postAccount(app: INestApplication, name = 'Acme', idempotencyKey?: string) {
  const call = request(app.getHttpServer())
    .post('/sf/v1/accounts')
    .set('X-Changed-By', 'sf-user-1')
    .set('X-Correlation-Id', CORRELATION_ID)
    .send({ name, status: 'active' });
  if (idempotencyKey !== undefined) {
    call.set('Idempotency-Key', idempotencyKey);
  }
  return call;
}

async function putConfig(
  app: INestApplication,
  overrides: Partial<SimulatorConfig>,
): Promise<void> {
  const response = await request(app.getHttpServer())
    .put('/simulator/config')
    .set('X-Simulator-Token', TOKEN)
    .send({ ...DEFAULT_SIMULATOR_CONFIG, ...overrides });
  expect(response.status).toBe(200);
}

async function flush(app: INestApplication): Promise<{ attempted: number; delivered: number }> {
  const response = await request(app.getHttpServer())
    .post('/simulator/flush-deliveries')
    .set('X-Simulator-Token', TOKEN);
  expect(response.status).toBe(200);
  return response.body as { attempted: number; delivered: number };
}

async function changeEvent(prisma: PrismaService, recordId: string): Promise<string> {
  const row = await prisma.client.sfChangeLog.findFirstOrThrow({
    where: { recordId },
    orderBy: { sequence: 'desc' },
  });
  return row.eventId;
}

function eventId(raw: string): string {
  const parsed = JSON.parse(raw) as { eventId?: unknown };
  return typeof parsed.eventId === 'string' ? parsed.eventId : '';
}

function testAccountCount(prisma: PrismaService): Promise<number> {
  return prisma.client.sfAccount.count({ where: { id: { startsWith: 'SF-IT-' } } });
}

async function cleanTestRows(prisma: PrismaService): Promise<void> {
  await prisma.client.$executeRaw`
    DELETE FROM sf_webhook_deliveries
    WHERE change_sequence IN (
      SELECT sequence FROM sf_change_log WHERE record_id LIKE 'SF-IT-%'
    )
  `;
  await prisma.client.$executeRaw`
    DELETE FROM sf_idempotency_keys WHERE record_id LIKE 'SF-IT-%'
  `;
  await prisma.client.$executeRaw`
    DELETE FROM sf_change_log WHERE record_id LIKE 'SF-IT-%'
  `;
  await prisma.client.$executeRaw`
    DELETE FROM sf_contacts WHERE id LIKE 'SF-IT-%' OR account_id LIKE 'SF-IT-%'
  `;
  await prisma.client.$executeRaw`
    DELETE FROM sf_accounts WHERE id LIKE 'SF-IT-%'
  `;
}

async function restoreSeed(prisma: PrismaService): Promise<void> {
  const accounts = [
    { id: 'SF-ACC-001', name: 'Seed Account' },
    { id: 'SF-ACC-002', name: 'Second Account' },
  ];
  for (const account of accounts) {
    const fields = {
      name: account.name,
      status: 'active',
      ownerId: 'owner-seed',
      version: 1n,
      systemModstamp: SEED_AT,
      createdAt: SEED_AT,
    };
    await prisma.client.sfAccount.upsert({
      where: { id: account.id },
      create: { id: account.id, ...fields },
      update: fields,
    });
  }
  const contacts = [
    {
      id: 'SF-CON-001',
      accountId: 'SF-ACC-001',
      fullName: 'Seed Contact',
      email: 'seed.contact@example.com',
      phone: '+15555550100',
      city: 'Austin',
    },
    {
      id: 'SF-CON-002',
      accountId: 'SF-ACC-002',
      fullName: 'Second Contact',
      email: 'second.contact@example.com',
      phone: '+15555550101',
      city: 'Dallas',
    },
  ];
  for (const contact of contacts) {
    const { id, ...fields } = contact;
    const stored = { ...fields, ownerId: 'owner-seed', version: 1n, systemModstamp: SEED_AT };
    await prisma.client.sfContact.upsert({
      where: { id },
      create: { id, ...stored },
      update: stored,
    });
  }
}
