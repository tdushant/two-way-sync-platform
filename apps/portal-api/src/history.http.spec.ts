import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseHistoryEntry } from '@sync/contracts';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

const ACTOR = 'dev-user';
const CORRELATION_ID = '3c0a9b44-1111-4222-8333-555555555555';

describe('field history and local dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.client.$executeRaw`
        DELETE FROM field_history
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM field_sync_state
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM outbox_events
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM sync_operations
        WHERE entity_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM contacts
        WHERE customer_id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM customers
        WHERE id IN (
          SELECT entity_id FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
        )
      `;
      await prisma.client.$executeRaw`
        DELETE FROM client_idempotency_keys WHERE idempotency_key LIKE 'hist-%'
      `;
    }
    await app?.close();
  });

  it('pages contact history in applied order and leaves an unknown id unread', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('x-actor-id', ACTOR)
      .set('Idempotency-Key', `hist-${randomUUID()}`)
      .send({ name: 'History Co' });
    expect(customer.status).toBe(201);
    const contact = await request(app.getHttpServer())
      .post('/api/v1/contacts')
      .set('x-actor-id', ACTOR)
      .set('Idempotency-Key', `hist-${randomUUID()}`)
      .send({
        customerId: customer.body.id,
        fullName: 'Ada',
        phone: '555-0100',
        city: 'Paris',
      });
    expect(contact.status).toBe(201);
    const phone = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${contact.body.id}`)
      .set('x-actor-id', ACTOR)
      .set('If-Match', String(contact.body.rowVersion))
      .send({ phone: '555-0199' });
    expect(phone.status).toBe(200);
    const city = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${contact.body.id}`)
      .set('x-actor-id', ACTOR)
      .set('If-Match', String(phone.body.rowVersion))
      .send({ city: 'Lyon' });
    expect(city.status).toBe(200);

    const first = await request(app.getHttpServer())
      .get(`/api/v1/contacts/${contact.body.id}/history`)
      .query({ limit: '1' })
      .set('x-actor-id', ACTOR)
      .set('x-correlation-id', CORRELATION_ID);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(parseHistoryEntry(first.body.items[0], CORRELATION_ID).ok).toBe(true);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app.getHttpServer())
      .get(`/api/v1/contacts/${contact.body.id}/history`)
      .query({ after: first.body.nextCursor, limit: '50' })
      .set('x-actor-id', ACTOR);
    expect(second.status).toBe(200);
    const fields = [first.body.items[0], ...second.body.items].map(
      (item: { fieldName: string; decision: string }) => `${item.fieldName}:${item.decision}`,
    );
    expect(fields).toContain('phone:APPLIED');
    expect(fields).toContain('city:APPLIED');

    const missing = await request(app.getHttpServer())
      .get(`/api/v1/contacts/${randomUUID()}/history`)
      .set('x-actor-id', ACTOR);
    expect(missing.status).toBe(404);
    const anonymous = await request(app.getHttpServer()).get(
      `/api/v1/customers/${customer.body.id}/history`,
    );
    expect(anonymous.status).toBe(401);
  });

  it('serves the local dashboard as a page that calls the HTTP APIs', async () => {
    const response = await request(app.getHttpServer()).get('/dashboard');
    expect(response.status).toBe(200);
    expect(response.text).toContain('/api/v1/sync/health');
    expect(response.text).toContain('/simulator/reorder-deliveries');
    expect(response.text).toContain('/simulator/config');
    expect(response.text).toContain('Recent events');
    expect(response.text).toContain('All events');
    expect(response.text).toContain('id="recentWindow"');
    expect(response.text).not.toContain('CONFLICT_LOST');
  });
});
