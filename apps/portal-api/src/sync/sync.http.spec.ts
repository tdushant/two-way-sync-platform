import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseSyncHealth } from '@sync/contracts';
import request from 'supertest';
import { AppModule } from '../app.module';
import { Clock } from '../clock';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLimiter } from './admin-limiter';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';
const ACTOR = 'dev-user';
const NOW = new Date('2026-11-12T12:00:00.000Z');

class FixedClock extends Clock {
  now(): Date {
    return new Date(NOW);
  }
}

function portalDatabaseUrl(): string {
  const url = process.env.PORTAL_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('PORTAL_DATABASE_URL is required');
  }
  return url;
}

describe('sync inspection', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const operationId = randomUUID();
  const entityId = randomUUID();

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORTAL_HTTP_PORT = '3000';
    process.env.PORTAL_DATABASE_URL = portalDatabaseUrl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(new FixedClock())
      .overrideProvider(AdminLimiter)
      .useValue({ take: () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.client.outboxEvent.deleteMany({ where: { operationId } });
      await prisma.client.syncOperation.deleteMany({ where: { operationId } });
      await prisma.client.$executeRaw`
        DELETE FROM sync_commands WHERE correlation_id = ${CORRELATION_ID}
      `;
    }
    await app?.close();
  });

  it('reports health, lists a dead letter, and replays only that row', async () => {
    const createdAt = new Date(NOW.getTime() - 15_000);
    await prisma.client.syncOperation.create({
      data: {
        operationId,
        entityType: 'contact',
        entityId,
        fields: { phone: '555-0199' },
        expectedValues: { phone: '1' },
        status: 'FAILED',
      },
    });
    await prisma.client.outboxEvent.create({
      data: {
        operationId,
        entityType: 'contact',
        entityId,
        eventType: 'updated',
        changedFields: { phone: '555-0199' },
        baseVersions: { phone: '1' },
        status: 'DEAD',
        attempts: 2,
        lastError: 'http_404',
        nextAttemptAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
    });
    await prisma.client.outboxEvent.update({
      where: { operationId },
      data: { status: 'IN_FLIGHT', leaseUntil: new Date('2099-01-01T00:00:00.000Z') },
    });
    const health = await agent().get('/api/v1/sync/health');
    expect(health.status).toBe(200);
    expect(parseSyncHealth(health.body, CORRELATION_ID).ok).toBe(true);
    expect(health.body.workerObserved).toBe(true);
    await prisma.client.outboxEvent.update({
      where: { operationId },
      data: { status: 'DEAD', leaseUntil: null },
    });
    const deadHealth = await agent().get('/api/v1/sync/health');
    expect(deadHealth.body.deadLetterTotal).toBeGreaterThanOrEqual(1);

    const dead = await agent().get('/api/v1/sync/outbox').query({ status: 'DEAD' });
    expect(dead.status).toBe(200);
    const listed = dead.body.items.find(
      (item: { operationId: string }) => item.operationId === operationId,
    );
    expect(listed).toMatchObject({
      status: 'DEAD',
      lastError: 'http_404',
      changedFields: { phone: '555-0199' },
    });
    const pending = await agent().get('/api/v1/sync/outbox').query({ status: 'PENDING' });
    expect(
      pending.body.items.some((item: { operationId: string }) => item.operationId === operationId),
    ).toBe(false);
    const invalid = await agent().get('/api/v1/sync/outbox').query({ status: 'BLOCKED' });
    expect(invalid.status).toBe(400);

    const replay = await agent().post(`/api/v1/sync/outbox/${operationId}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ operationId, status: 'RETRY' });
    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { operationId } });
    expect(row.status).toBe('RETRY');
    expect(row.lastError).toBe('http_404');
    expect(row.nextAttemptAt.toISOString()).toBe(NOW.toISOString());
    expect(await prisma.client.outboxEvent.count({ where: { operationId } })).toBe(1);
    expect(
      await prisma.client.syncOperation.findUniqueOrThrow({ where: { operationId } }),
    ).toMatchObject({ status: 'PENDING' });
    const again = await agent().post(`/api/v1/sync/outbox/${operationId}/replay`);
    expect(again.status).toBe(409);
    expect(
      (await prisma.client.outboxEvent.findUniqueOrThrow({ where: { operationId } })).status,
    ).toBe('RETRY');

    const missing = await agent().post(`/api/v1/sync/outbox/${randomUUID()}/replay`);
    expect(missing.status).toBe(404);
    const malformed = await agent().post('/api/v1/sync/outbox/not-a-uuid/replay');
    expect(malformed.status).toBe(400);
    const anonymous = await request(app.getHttpServer()).get('/api/v1/sync/health');
    expect(anonymous.status).toBe(401);

    const metrics = await agent().get('/api/v1/sync/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body.outbox_pending_total).toBeGreaterThanOrEqual(1);
    expect(metrics.body.outbox_oldest_age_seconds).toBeGreaterThanOrEqual(15);
    expect(metrics.body.sync_latency_seconds.count).toEqual(expect.any(Number));
    expect(metrics.body.sync_latency_seconds.buckets.at(-1)).toMatchObject({ le: '+Inf' });
    expect(metrics.body.outbound_retry_total).toEqual(expect.any(Object));
    expect(metrics.body.webhook_duplicates_total).toEqual(expect.any(Number));
    expect(metrics.body.webhook_invalid_signature_total).toEqual(expect.any(Number));
    expect(metrics.body.reconciliation_lag_seconds).toEqual(expect.any(Number));
    expect(metrics.body.reconciliation_discrepancies_total).toEqual(expect.any(Number));
    expect(metrics.body.external_api_request_rate).toEqual(expect.any(Number));
    expect(metrics.body.dead_letter_total).toEqual(expect.any(Number));

    const requested = await agent().post('/api/v1/sync/reconciliation/runs');
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ command: 'reconciliation', status: 'PENDING' });
    expect(requested.body.cursor).toBeUndefined();
    const stored = await prisma.client.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM sync_commands WHERE id = ${requested.body.id}::uuid
    `;
    expect(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']).toContain(stored[0]?.status);

    const spec = await request(app.getHttpServer()).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.paths['/api/v1/sync/outbox/{operationId}/replay']).toBeDefined();
    expect(spec.body.paths['/api/v1/sync/reconciliation/runs']).toBeDefined();
    const docs = await request(app.getHttpServer()).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('/openapi.json');
    expect(docs.text).toContain('swagger-ui');
    const table = await prisma.client.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('sync_commands')::text AS name
    `;
    expect(table[0]?.name).toBe('sync_commands');
  });

  function agent(): ReturnType<typeof request.agent> {
    return request
      .agent(app.getHttpServer())
      .set('x-actor-id', ACTOR)
      .set('x-correlation-id', CORRELATION_ID);
  }
});
