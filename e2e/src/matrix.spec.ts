import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ExternalApiBudget } from '../../apps/portal-worker/src/budget/external-api-budget';
import { OutboundWorker } from '../../apps/portal-worker/src/outbox/outbound-worker';
import { HttpChangesFeed } from '../../apps/portal-worker/src/reconcile/changes-feed';
import { HttpInboundApply } from '../../apps/portal-worker/src/reconcile/inbound-apply';
import {
  CHANGES_STREAM,
  CheckpointInterrupt,
  ReconciliationWorker,
} from '../../apps/portal-worker/src/reconcile/reconciliation-worker';
import {
  ACTOR,
  LEASE_MS,
  PARENT_WAIT_MS,
  SECRET,
  asRecord,
  changes,
  createContact,
  createCustomer,
  deliveries,
  emitContact,
  fakeCreateAccount,
  fakeCreateContact,
  fakeGetContact,
  fakePatchContact,
  flushWebhooks,
  getContact,
  getCustomer,
  jsonBody,
  patchContact,
  portalAgent,
  postWebhook,
  putConfig,
  reorder,
  requests,
  settle,
  signWebhookPayload,
  sim,
  syncContact,
  syncCustomer,
  type CapturedCall,
  type World,
  boot,
  reset,
  shutdown,
  writes,
} from './harness';

/**
 * Partial product gaps, asserted only for the behavior that exists:
 * - T03 and T15 have no webhook_duplicates_total or webhook_invalid_signature_total.
 * - T14 creates a portal customer for an unknown Account and does not enqueue an outbox row.
 * - T18 records the dead letter. No replay route is bound.
 * - T11's timeout case uses the simulator's immediate 408, not a held socket.
 */

const T06 = '2026-06-01T00:00:00.000Z';

describe('sync matrix', () => {
  let world: World;

  beforeAll(async () => {
    world = await boot();
  });

  afterAll(async () => {
    await shutdown(world);
  });

  beforeEach(async () => {
    await reset(world);
  });

  it('T01 acks a portal phone update without a second outbox row', async () => {
    const synced = await syncContact(world, {
      label: 't01',
      phone: '555-0100',
      city: 'Paris',
    });
    world.calls.length = 0;
    const before = await outboxCount(world, synced.contact.id);
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    await settle(world);
    const call = only(contactWrites(world), 'contact write');
    const body = jsonBody(call);
    expect(body.phone).toBe('555-0199');
    expect(body.city).toBeUndefined();
    const operationId = readString(call.headers['idempotency-key'], 'operation');
    expect(successWrites(await requests(world), operationId)).toHaveLength(1);
    const echo = await originDelivery(world, operationId);
    expect(echo.payload.originOperationId).toBe(operationId);
    await flushWebhooks(world);
    expect(await operationStatus(world, operationId)).toBe('ACKED');
    expect(await outboxStatus(world, operationId)).toBe('COMPLETED');
    expect(await outboxCount(world, synced.contact.id)).toBe(before + 1);
    expect((await getContact(world, patched.id)).phone).toBe('555-0199');
    const remote = await fakeGetContact(world, required(synced.contact.salesforceId));
    expect(remote.phone).toBe('555-0199');
  });

  it('T02 applies a Salesforce city update without an outbound loop or plaintext PII in the log', async () => {
    const phone = '555-0142-t02';
    const email = 'ada.t02@example.test';
    const synced = await syncContact(world, {
      label: 'NameT02',
      phone,
      city: 'Paris',
      email,
    });
    const before = await outboxCount(world, synced.contact.id);
    world.logger.lines.length = 0;
    await fakePatchContact(world, required(synced.contact.salesforceId), { city: 'Nantes' });
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    expect(contact.city).toBe('Nantes');
    const history = await fieldHistory(world, synced.contact.id, 'city');
    expect(history.some((row) => row.source === 'SALESFORCE' && row.decision === 'APPLIED')).toBe(
      true,
    );
    const event = await deliveryWith(world, 'city', 'Nantes');
    expect((await processed(world, event.eventId))?.status).toBe('APPLIED');
    expect(await outboxCount(world, synced.contact.id)).toBe(before);
    const logged = world.logger.lines.join('\n');
    expect(logged).not.toContain(phone);
    expect(logged).not.toContain(email);
    expect(logged).not.toContain('wkx e2e NameT02');
  });

  it('T03 acknowledges three identical deliveries and does not move rowVersion', async () => {
    const synced = await syncContact(world, { label: 't03', phone: '555-0100', city: 'Paris' });
    await fakePatchContact(world, required(synced.contact.salesforceId), { city: 'Lyon' });
    await flushWebhooks(world);
    const event = await deliveryWith(world, 'city', 'Lyon');
    const afterFirst = await getContact(world, synced.contact.id);
    const historyAfterFirst = await fieldHistory(world, synced.contact.id, 'city');
    await sim(world).post(`/simulator/replay-event/${event.eventId}`).expect(200);
    await flushWebhooks(world);
    await sim(world).post(`/simulator/replay-event/${event.eventId}`).expect(200);
    await flushWebhooks(world);
    const copies = (await deliveries(world)).filter(
      (row) =>
        row.eventId === event.eventId && row.status === 'DELIVERED' && row.lastHttpStatus === 200,
    );
    expect(copies).toHaveLength(3);
    const after = await getContact(world, synced.contact.id);
    expect(after.city).toBe('Lyon');
    expect(after.rowVersion).toBe(afterFirst.rowVersion);
    expect(await fieldHistory(world, synced.contact.id, 'city')).toHaveLength(
      historyAfterFirst.length,
    );
    expect(
      await world.portal.client.processedEvent.count({ where: { eventId: event.eventId } }),
    ).toBe(1);
  });

  it('T03b rejects a second body for the same eventId', async () => {
    const synced = await syncContact(world, { label: 't03b', phone: '555-0100', city: 'Paris' });
    await fakePatchContact(world, required(synced.contact.salesforceId), { city: 'Lyon' });
    await flushWebhooks(world);
    const cityEvent = await deliveryWith(world, 'city', 'Lyon');
    const changed = asRecord(cityEvent.payload.changedFields);
    const raw = JSON.stringify({
      ...cityEvent.payload,
      changedFields: { ...changed, city: 'Nice' },
    });
    const response = await postWebhook(world, raw, signWebhookPayload(SECRET, raw));
    expect(response.ok).toBe(false);
    expect((await getContact(world, synced.contact.id)).city).toBe('Lyon');
    expect(
      await world.portal.client.processedEvent.count({ where: { eventId: cityEvent.eventId } }),
    ).toBe(1);
  });

  it('T04 keeps version 12 when version 11 arrives later and still applies the other field', async () => {
    const synced = await syncContact(world, { label: 't04', phone: '555-0100', city: 'Paris' });
    const recordId = required(synced.contact.salesforceId);
    const before = await outboxCount(world, synced.contact.id);
    await putConfig(world, { delayMs: 86_400_000 });
    const earlier = world.clock.now().toISOString();
    for (let version = 2; version <= 10; version += 1) {
      const emitted = await emitContact(world, {
        recordId,
        occurredAt: earlier,
        changedFields: { ownerId: `owner-${version}` },
      });
      expect(emitted.recordVersion).toBe(version);
    }
    const later = new Date(world.clock.now().getTime() + 86_400_000).toISOString();
    const version11 = await emitContact(world, {
      recordId,
      occurredAt: later,
      changedFields: { phone: '555-0011', city: 'Lyon' },
    });
    const version12 = await emitContact(world, {
      recordId,
      occurredAt: earlier,
      changedFields: { phone: '555-0012' },
    });
    expect(version11.recordVersion).toBe(11);
    expect(version12.recordVersion).toBe(12);
    await reorder(world, [version12.eventId]);
    await flushWebhooks(world);
    expect((await getContact(world, synced.contact.id)).phone).toBe('555-0012');
    await reorder(world, [version11.eventId]);
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    expect(contact.phone).toBe('555-0012');
    expect(contact.city).toBe('Lyon');
    const phone = await fieldHistory(world, synced.contact.id, 'phone');
    expect(
      phone.some((row) => row.eventId === version11.eventId && row.decision === 'REJECTED_STALE'),
    ).toBe(true);
    const city = await fieldHistory(world, synced.contact.id, 'city');
    expect(
      city.some((row) => row.eventId === version11.eventId && row.decision === 'APPLIED'),
    ).toBe(true);
    expect((await processed(world, version11.eventId))?.eventId).toBe(version11.eventId);
    expect((await processed(world, version12.eventId))?.eventId).toBe(version12.eventId);
    expect(await outboxCount(world, synced.contact.id)).toBe(before);
  });

  it('T05 keeps concurrent edits to different fields', async () => {
    const synced = await syncContact(world, { label: 't05', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    await Promise.all([
      patchContact(world, synced.contact.id, synced.contact.rowVersion, { phone: '555-1111' }),
      fakePatchContact(world, externalId, { city: 'Lyon' }),
    ]);
    await settle(world);
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    const remote = await fakeGetContact(world, externalId);
    expect(contact.phone).toBe('555-1111');
    expect(contact.city).toBe('Lyon');
    expect(remote.phone).toBe('555-1111');
    expect(remote.city).toBe('Lyon');
    const phone = await fieldHistory(world, synced.contact.id, 'phone');
    const city = await fieldHistory(world, synced.contact.id, 'city');
    expect(phone.some((row) => row.decision === 'CONFLICT_LOST')).toBe(false);
    expect(city.some((row) => row.decision === 'CONFLICT_LOST')).toBe(false);
  });

  it('T06a stores the later Salesforce phone even when recordVersion is below rowVersion', async () => {
    const synced = await syncedPhone(world, 't06a');
    world.clock.set(T06);
    const patched = await patchContact(world, synced.contact.id, synced.rowVersion, {
      phone: '555-1000',
    });
    world.clock.advance(1000);
    await fakePatchContact(world, synced.externalId, { phone: '555-2000' });
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    const remote = await fakeGetContact(world, synced.externalId);
    expect(contact.phone).toBe('555-2000');
    expect(remote.version).toBeLessThan(patched.rowVersion);
    const history = await fieldHistory(world, synced.contact.id, 'phone');
    expect(history.some((row) => row.source === 'PORTAL' && row.decision === 'APPLIED')).toBe(true);
    expect(history.some((row) => row.source === 'SALESFORCE' && row.decision === 'APPLIED')).toBe(
      true,
    );
  });

  it('T06b keeps the later portal phone and audits CONFLICT_LOST', async () => {
    const synced = await syncedPhone(world, 't06b');
    world.clock.set(new Date(Date.parse(T06) + 1000).toISOString());
    const patched = await patchContact(world, synced.contact.id, synced.rowVersion, {
      phone: '555-3000',
    });
    const event = await emitContact(world, {
      recordId: synced.externalId,
      occurredAt: T06,
      changedFields: { phone: '555-4000' },
    });
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    expect(contact.phone).toBe('555-3000');
    expect(event.recordVersion).toBeLessThan(patched.rowVersion);
    const history = await fieldHistory(world, synced.contact.id, 'phone');
    expect(history.some((row) => row.source === 'PORTAL' && row.decision === 'APPLIED')).toBe(true);
    expect(
      history.some((row) => row.eventId === event.eventId && row.decision === 'CONFLICT_LOST'),
    ).toBe(true);
  });

  it('T06c stores the Salesforce phone when the timestamps are equal', async () => {
    const synced = await syncedPhone(world, 't06c');
    world.clock.set(T06);
    const patched = await patchContact(world, synced.contact.id, synced.rowVersion, {
      phone: '555-5000',
    });
    await fakePatchContact(world, synced.externalId, { phone: '555-6000' });
    await flushWebhooks(world);
    const contact = await getContact(world, synced.contact.id);
    const remote = await fakeGetContact(world, synced.externalId);
    expect(contact.phone).toBe('555-6000');
    expect(remote.version).toBeLessThan(patched.rowVersion);
    const history = await fieldHistory(world, synced.contact.id, 'phone');
    expect(history.some((row) => row.source === 'SALESFORCE' && row.decision === 'APPLIED')).toBe(
      true,
    );
  });

  it('T07 does not enqueue another outbox row when an echo is replayed', async () => {
    const synced = await syncContact(world, { label: 't07', phone: '555-0100', city: 'Paris' });
    const before = await outboxCount(world, synced.contact.id);
    await patchContact(world, synced.contact.id, synced.contact.rowVersion, { phone: '555-0199' });
    await settle(world);
    const operationId = outboxField(
      await outboxRows(world, synced.contact.id),
      'phone',
      '555-0199',
    ).operationId;
    const pendingEcho = (await deliveries(world)).find(
      (row) => row.payload.originOperationId === operationId && row.status === 'PENDING',
    );
    if (pendingEcho === undefined) {
      throw new Error('echo delivery was not pending');
    }
    await flushWebhooks(world);
    expect(await operationStatus(world, operationId)).toBe('ACKED');
    expect(await outboxCount(world, synced.contact.id)).toBe(before + 1);
    await sim(world).post(`/simulator/replay-event/${pendingEcho.eventId}`).expect(200);
    await flushWebhooks(world);
    expect(await outboxCount(world, synced.contact.id)).toBe(before + 1);
    expect(
      await world.portal.client.processedEvent.count({ where: { eventId: pendingEcho.eventId } }),
    ).toBe(1);
    const copies = (await deliveries(world)).filter(
      (row) => row.eventId === pendingEcho.eventId && row.lastHttpStatus === 200,
    );
    expect(copies.length).toBeGreaterThanOrEqual(2);
  });

  it('T08 repairs a dropped webhook in change-log sequence order', async () => {
    const synced = await syncContact(world, { label: 't08', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    const cursor = await catchUp(world);
    const before = await outboxCount(world, synced.contact.id);
    await putConfig(world, { webhookEnabled: false });
    await fakePatchContact(world, externalId, { phone: '555-2222' });
    await fakePatchContact(world, externalId, { phone: '555-3333' });
    const page = await changes(world, cursor);
    expect(page).toHaveLength(2);
    const sequences = page.map((row) => row.changeSequence);
    await reorder(world, [at(page, 1).eventId, at(page, 0).eventId]);
    expect((await changes(world, cursor)).map((row) => row.changeSequence)).toEqual(sequences);
    expect((await getContact(world, synced.contact.id)).phone).toBe('555-0100');
    await catchUp(world);
    expect((await getContact(world, synced.contact.id)).phone).toBe('555-3333');
    const history = await fieldHistory(world, synced.contact.id, 'phone');
    for (const row of page) {
      expect(
        history.some((item) => item.eventId === row.eventId && item.decision === 'APPLIED'),
      ).toBe(true);
      expect(
        history.some((item) => item.eventId === row.eventId && item.decision === 'REJECTED_STALE'),
      ).toBe(false);
    }
    expect(await outboxCount(world, synced.contact.id)).toBe(before);
    expect(await cursorOf(world)).toBe(String(at(sequences, sequences.length - 1)));
  });

  it('T09 keeps the portal write during an outage and drains it after recovery', async () => {
    const synced = await syncContact(world, { label: 't09', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    await putConfig(world, { outageEnabled: true });
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    const during = await portalAgent(world.portalApp)
      .get(`/api/v1/contacts/${patched.id}`)
      .set('x-actor-id', ACTOR);
    expect(during.status).toBe(200);
    await world.worker.flush();
    const pending = outboxField(await outboxRows(world, patched.id), 'phone', '555-0199');
    expect(pending.status === 'COMPLETED' || pending.status === 'DEAD').toBe(false);
    expect((await fakeGetContact(world, externalId)).phone).toBe('555-0100');
    await putConfig(world, { outageEnabled: false });
    world.clock.advance(1000);
    await settle(world);
    await flushWebhooks(world);
    expect(await outboxStatus(world, pending.operationId)).toBe('COMPLETED');
    expect((await fakeGetContact(world, externalId)).phone).toBe('555-0199');
  });

  it('T10 retries a 429 on the injected clock and completes the same operation', async () => {
    const synced = await syncContact(world, { label: 't10', phone: '555-0100', city: 'Paris' });
    await putConfig(world, { rateLimitPerSec: 0 });
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    const started = world.clock.now().getTime();
    await world.worker.flush();
    const waiting = only(
      (await outboxRows(world, patched.id)).filter((row) => row.status === 'RETRY'),
      'retry',
    );
    expect(waiting.attempts).toBeGreaterThanOrEqual(1);
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 1000);
    expect(waiting.status).not.toBe('DEAD');
    await putConfig(world, { rateLimitPerSec: 1000 });
    world.clock.advance(1000);
    await settle(world);
    expect(await outboxStatus(world, waiting.operationId)).toBe('COMPLETED');
    expect(successWrites(await requests(world), waiting.operationId)).toHaveLength(1);
  });

  it('T11 retries a forced 500 and then completes one remote write', async () => {
    const synced = await syncContact(world, { label: 't11-500', phone: '555-0100', city: 'Paris' });
    await putConfig(world, { failureRate: 1 });
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    await world.worker.flush();
    const waiting = only(
      (await outboxRows(world, patched.id)).filter((row) => row.status === 'RETRY'),
      'retry',
    );
    expect(waiting.lastError).toBe('http_500');
    expect(waiting.status).not.toBe('DEAD');
    await putConfig(world, { failureRate: 0 });
    world.clock.advance(1000);
    await settle(world);
    expect(await outboxStatus(world, waiting.operationId)).toBe('COMPLETED');
    expect(successWrites(await requests(world), waiting.operationId)).toHaveLength(1);
  });

  it('T11 retries an immediate 408 above the client timeout and then completes', async () => {
    const synced = await syncContact(world, { label: 't11-408', phone: '555-0100', city: 'Paris' });
    await putConfig(world, { responseDelayMs: 6000 });
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    await world.worker.flush();
    const waiting = only(
      (await outboxRows(world, patched.id)).filter((row) => row.status === 'RETRY'),
      'retry',
    );
    expect(waiting.lastError).toBe('http_408');
    expect(waiting.status).not.toBe('DEAD');
    await putConfig(world, { responseDelayMs: 0 });
    world.clock.advance(1000);
    await settle(world);
    expect(await outboxStatus(world, waiting.operationId)).toBe('COMPLETED');
    expect(successWrites(await requests(world), waiting.operationId)).toHaveLength(1);
  });

  it('T12 sends a crashed in-flight row once after the lease expires', async () => {
    const customer = await syncCustomer(world, 't12');
    world.calls.length = 0;
    const contact = await createContact(world, {
      customerId: customer.id,
      fullName: 'wkx e2e t12',
      phone: '555-0100',
    });
    const claimed = await world.worker.claimDue();
    expect(claimed).toHaveLength(1);
    expect(world.calls).toHaveLength(0);
    const crashedAttempts = at(claimed, 0).attempts;
    const other = new OutboundWorker(
      world.workerPrisma,
      world.clock,
      world.salesforce,
      () => 0,
      world.budget,
      80,
      'wkx',
    );
    await other.flush();
    expect(world.calls).toHaveLength(0);
    expect(only(await outboxRows(world, contact.id), 'in flight').status).toBe('IN_FLIGHT');
    world.clock.advance(LEASE_MS);
    await other.flush();
    const call = only(contactWrites(world), 'contact create');
    const operationId = only(await outboxRows(world, contact.id), 'create').operationId;
    expect(call.headers['idempotency-key']).toBe(operationId);
    expect(call.method).toBe('POST');
    await flushWebhooks(world);
    const finished = only(await outboxRows(world, contact.id), 'create');
    expect(finished.attempts).toBeGreaterThan(crashedAttempts);
    expect(finished.status).toBe('COMPLETED');
    expect(await operationStatus(world, operationId)).toBe('ACKED');
    expect(await world.fake.client.sfContact.count()).toBe(1);
  });

  it('T13 sends the contact create only after the account exists, with its own fields', async () => {
    const customer = await createCustomer(world, 'wkx e2e t13');
    const contact = await createContact(world, {
      customerId: customer.id,
      fullName: 'wkx e2e t13 contact',
      phone: '555-0100',
    });
    await patchContact(world, contact.id, contact.rowVersion, { city: 'Lyon' });
    const rows = await outboxRows(world, contact.id);
    const created = only(
      rows.filter((row) => row.eventType === 'created'),
      'create',
    );
    const updated = only(
      rows.filter((row) => row.eventType === 'updated'),
      'update',
    );
    expect(asRecord(created.changedFields).city).toBeUndefined();
    expect(asRecord(updated.changedFields).city).toBe('Lyon');
    world.calls.length = 0;
    let post: CapturedCall | undefined;
    let cityPatch: CapturedCall | undefined;
    for (
      let attempt = 0;
      attempt < 6 && (post === undefined || cityPatch === undefined);
      attempt += 1
    ) {
      await world.worker.flush();
      post = contactWrites(world).find((call) => call.method === 'POST');
      cityPatch = contactWrites(world).find((call) => call.method === 'PATCH');
      if (post === undefined || cityPatch === undefined) {
        world.clock.advance(PARENT_WAIT_MS);
      }
    }
    if (post === undefined || cityPatch === undefined) {
      throw new Error('contact create and city patch were not both sent');
    }
    const accountCall = writes(world).find((call) => call.url.includes('/sf/v1/accounts'));
    if (accountCall === undefined) {
      throw new Error('account create was not sent');
    }
    expect(jsonBody(accountCall).fullName).toBeUndefined();
    expect(jsonBody(post).city).toBeUndefined();
    expect(typeof jsonBody(post).accountId).toBe('string');
    expect(jsonBody(cityPatch).city).toBe('Lyon');
    expect(await world.fake.client.sfContact.count()).toBe(1);
  });

  it('T14 creates an unknown Account and leaves the change log in place', async () => {
    const account = await fakeCreateAccount(world, 'wkx e2e unknown account');
    await flushWebhooks(world);
    const delivery = only(await deliveries(world), 'account delivery');
    expect(delivery.lastHttpStatus).toBe(200);
    const customers = await world.portal.client.customer.findMany();
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      salesforceId: account.id,
      name: 'wkx e2e unknown account',
    });
    expect(await world.portal.client.outboxEvent.count()).toBe(0);
    expect(await world.portal.client.processedEvent.count()).toBe(1);
    const page = await changes(world, null);
    expect(page.some((row) => row.recordId === account.id)).toBe(true);
  });

  it('T14 leaves an unmapped parent uncommitted until that parent exists', async () => {
    const synced = await syncContact(world, { label: 't14', phone: '555-0100', city: 'Paris' });
    await putConfig(world, { delayMs: 86_400_000 });
    const account = await fakeCreateAccount(world, 'wkx e2e other account');
    await putConfig(world, { delayMs: 0 });
    const event = await emitContact(world, {
      recordId: required(synced.contact.salesforceId),
      occurredAt: world.clock.now().toISOString(),
      changedFields: { accountId: account.id },
    });
    const before = await outboxCount(world, synced.contact.id);
    await flushWebhooks(world);
    const delivery = (await deliveries(world)).find((row) => row.eventId === event.eventId);
    expect(delivery?.lastHttpStatus).toBe(409);
    expect(await processed(world, event.eventId)).toBeNull();
    expect((await getContact(world, synced.contact.id)).customerId).toBe(synced.customer.id);
    expect((await changes(world, null)).some((row) => row.eventId === event.eventId)).toBe(true);
    const parentId = randomUUID();
    await world.portal.client.customer.create({
      data: {
        id: parentId,
        name: 'wkx e2e linked parent',
        salesforceId: account.id,
        rowVersion: 1n,
        createdAt: world.clock.now(),
        updatedAt: world.clock.now(),
      },
    });
    const pass = await world.reconcile.trigger();
    expect(pass.status).toBe('SUCCEEDED');
    expect((await getContact(world, synced.contact.id)).customerId).toBe(parentId);
    expect(await outboxCount(world, synced.contact.id)).toBe(before);
    expect((await processed(world, event.eventId))?.status).toBe('APPLIED');
  });

  it('T15 rejects a bad signature and still applies a later event', async () => {
    const synced = await syncContact(world, { label: 't15', phone: '555-0100', city: 'Paris' });
    const before = await portalCounts(world);
    const raw = JSON.stringify({
      eventId: randomUUID(),
      objectType: 'Contact',
      recordId: required(synced.contact.salesforceId),
      eventType: 'updated',
      changedFields: { city: 'Lyon' },
      changedBy: 'sf-user-1',
      occurredAt: world.clock.now().toISOString(),
      recordVersion: 2,
      originOperationId: null,
    });
    const response = await postWebhook(world, raw, signWebhookPayload('wrong-secret', raw));
    expect([401, 403]).toContain(response.status);
    expect(await portalCounts(world)).toEqual(before);
    await fakePatchContact(world, required(synced.contact.salesforceId), { city: 'Lyon' });
    await flushWebhooks(world);
    expect((await getContact(world, synced.contact.id)).city).toBe('Lyon');
  });

  it('T16 rejects a missing eventId, an unknown field, and changedFields without values', async () => {
    const synced = await syncContact(world, { label: 't16', phone: '555-0100', city: 'Paris' });
    const before = await portalCounts(world);
    const base = {
      objectType: 'Contact',
      recordId: required(synced.contact.salesforceId),
      eventType: 'updated',
      changedBy: 'sf-user-1',
      occurredAt: world.clock.now().toISOString(),
      recordVersion: 2,
      originOperationId: null,
    };
    const missingId = JSON.stringify({ ...base, changedFields: { city: 'Lyon' } });
    const unknown = JSON.stringify({
      ...base,
      eventId: randomUUID(),
      changedFields: { city: 'Lyon' },
      extra: true,
    });
    const arrayFields = JSON.stringify({
      ...base,
      eventId: randomUUID(),
      changedFields: ['city'],
    });
    for (const raw of [missingId, unknown, arrayFields]) {
      const response = await postWebhook(world, raw, signWebhookPayload(SECRET, raw));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(await portalCounts(world)).toEqual(before);
    expect(await world.portal.client.processedEvent.count()).toBe(before.processed);
  });

  it('T17 creates one customer and one remote account for one idempotency key', async () => {
    const key = randomUUID();
    const first = await portalAgent(world.portalApp)
      .post('/api/v1/customers')
      .set('x-actor-id', ACTOR)
      .set('Idempotency-Key', key)
      .send({ name: 'wkx e2e t17' });
    const second = await portalAgent(world.portalApp)
      .post('/api/v1/customers')
      .set('x-actor-id', ACTOR)
      .set('Idempotency-Key', key)
      .send({ name: 'wkx e2e t17' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const customer = (await getCustomer(world, readId(first.body))).id;
    expect(readId(second.body)).toBe(customer);
    expect(await world.portal.client.customer.count()).toBe(1);
    const row = only(await outboxRows(world, customer), 'create');
    expect(await world.portal.client.syncOperation.count()).toBe(1);
    await settle(world);
    expect(await world.fake.client.sfAccount.count()).toBe(1);
    expect(successWrites(await requests(world), row.operationId)).toHaveLength(1);
  });

  it('T18 dead-letters a permanent 404 and keeps the portal value', async () => {
    const synced = await syncContact(world, { label: 't18', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    const wiped = await sim(world).post('/simulator/reset');
    expect(wiped.status).toBe(200);
    const patched = await patchContact(world, synced.contact.id, synced.contact.rowVersion, {
      phone: '555-0199',
    });
    await world.worker.flush();
    const dead = only(
      (await outboxRows(world, patched.id)).filter((row) => row.status === 'DEAD'),
      'dead letter',
    );
    expect(dead.status).toBe('DEAD');
    expect(dead.lastError).toBe('http_404');
    expect(await operationStatus(world, dead.operationId)).toBe('FAILED');
    expect((await getContact(world, patched.id)).phone).toBe('555-0199');
    expect((await fakeGetContact(world, externalId)).status).toBe(404);
  });

  it('T19 replays a page after the checkpoint write is interrupted', async () => {
    const synced = await syncContact(world, { label: 't19', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    const cursor = await catchUp(world);
    await putConfig(world, { webhookEnabled: false });
    await fakePatchContact(world, externalId, { phone: '555-2222' });
    await fakePatchContact(world, externalId, { city: 'Lyon' });
    const page = await changes(world, cursor);
    expect(page).toHaveLength(2);
    const historyBefore = await world.portal.client.fieldHistory.count();
    const pass = await crashingReconciler(world).trigger();
    expect(pass.status).toBe('FAILED');
    expect(pass.error).toBe('interrupted');
    expect(await cursorOf(world)).toBe(cursor);
    const contact = await getContact(world, synced.contact.id);
    expect(contact.phone).toBe('555-2222');
    expect(contact.city).toBe('Lyon');
    const historyAfter = await world.portal.client.fieldHistory.count();
    const processedAfter = await world.portal.client.processedEvent.count();
    expect(historyAfter).toBeGreaterThan(historyBefore);
    const replay = await world.reconcile.trigger();
    expect(replay.status).toBe('SUCCEEDED');
    expect(await cursorOf(world)).toBe(String(at(page, page.length - 1).changeSequence));
    expect(await world.portal.client.fieldHistory.count()).toBe(historyAfter);
    expect(await world.portal.client.processedEvent.count()).toBe(processedAfter);
    expect((await getContact(world, synced.contact.id)).phone).toBe('555-2222');
  });

  it('T19 leaves the cursor on the previous page when a middle event fails', async () => {
    const synced = await syncContact(world, { label: 't19b', phone: '555-0100', city: 'Paris' });
    const externalId = required(synced.contact.salesforceId);
    const cursor = await catchUp(world);
    await putConfig(world, { webhookEnabled: false });
    await fakePatchContact(world, externalId, { phone: '555-2222' });
    await fakeCreateContact(world, required(synced.customer.salesforceId), 'wkx e2e stranger');
    await fakePatchContact(world, externalId, { city: 'Lyon' });
    const page = await changes(world, cursor);
    expect(page).toHaveLength(3);
    expect(at(page, 0).recordId).toBe(externalId);
    expect(at(page, 1).recordId).not.toBe(externalId);
    expect(at(page, 2).recordId).toBe(externalId);
    const pass = await world.reconcile.trigger();
    expect(pass.status).toBe('FAILED');
    expect(await cursorOf(world)).toBe(cursor);
    const contact = await getContact(world, synced.contact.id);
    expect(contact.phone).toBe('555-2222');
    expect(contact.city).toBe('Paris');
    expect(await processed(world, at(page, 2).eventId)).toBeNull();
  });

  it('spends one shared token bucket across two worker instances', async () => {
    await createCustomer(world, 'wkx e2e quota a');
    await createCustomer(world, 'wkx e2e quota b');
    await world.portal.client.apiQuotaBucket.update({
      where: { bucket: 'external_api' },
      data: {
        tokens: 1n,
        maxTokens: 1n,
        refillPerSecondMilli: 0n,
        blockedUntil: null,
        updatedAt: world.clock.now(),
      },
    });
    world.calls.length = 0;
    const other = new OutboundWorker(
      world.workerPrisma,
      world.clock,
      world.salesforce,
      () => 0,
      world.budget,
      80,
      'wkx',
    );
    await Promise.all([world.worker.flush(), other.flush()]);
    const accountWrites = writes(world).filter((call) => call.url.includes('/sf/v1/accounts'));
    expect(accountWrites).toHaveLength(1);
    const rows = await world.portal.client.outboxEvent.findMany();
    expect(rows.map((row) => row.status).sort()).toEqual(['COMPLETED', 'RETRY']);
    expect(world.budget).toBeInstanceOf(ExternalApiBudget);
  });
});

async function syncedPhone(
  world: World,
  label: string,
): Promise<{ contact: { id: string }; externalId: string; rowVersion: number }> {
  const synced = await syncContact(world, { label, phone: '555-0100', city: 'Paris' });
  let rowVersion = synced.contact.rowVersion;
  for (let index = 0; index < 8; index += 1) {
    const next = await patchContact(world, synced.contact.id, rowVersion, {
      ownerId: `owner-${index}`,
    });
    rowVersion = next.rowVersion;
  }
  return { contact: synced.contact, externalId: required(synced.contact.salesforceId), rowVersion };
}

function crashingReconciler(world: World): ReconciliationWorker {
  const databaseUrl = process.env.PORTAL_DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error('PORTAL_DATABASE_URL is not set');
  }
  return new ReconciliationWorker(
    world.workerPrisma,
    world.clock,
    world.budget,
    new HttpChangesFeed(world.fakeBase),
    new HttpInboundApply(world.webhookUrl, SECRET),
    databaseUrl,
    100,
    () => {
      throw new CheckpointInterrupt();
    },
  );
}

async function catchUp(world: World): Promise<string | null> {
  const pass = await world.reconcile.trigger();
  if (pass.status !== 'SUCCEEDED') {
    throw new Error(`reconciliation ${pass.status} ${pass.error ?? ''}`);
  }
  return cursorOf(world);
}

async function cursorOf(world: World): Promise<string | null> {
  const row = await world.portal.client.syncCheckpoint.findUnique({
    where: { streamName: CHANGES_STREAM },
  });
  return row?.cursor ?? null;
}

async function outboxRows(world: World, entityId: string) {
  return world.portal.client.outboxEvent.findMany({
    where: { entityId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function outboxCount(world: World, entityId: string): Promise<number> {
  return world.portal.client.outboxEvent.count({ where: { entityId } });
}

async function outboxStatus(world: World, operationId: string): Promise<string> {
  const row = await world.portal.client.outboxEvent.findUniqueOrThrow({ where: { operationId } });
  return row.status;
}

async function operationStatus(world: World, operationId: string): Promise<string> {
  const row = await world.portal.client.syncOperation.findUniqueOrThrow({ where: { operationId } });
  return row.status;
}

async function fieldHistory(world: World, entityId: string, fieldName: string) {
  return world.portal.client.fieldHistory.findMany({
    where: { entityId, fieldName },
    orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }],
  });
}

async function processed(world: World, eventId: string) {
  return world.portal.client.processedEvent.findUnique({ where: { eventId } });
}

async function portalCounts(world: World) {
  const [history, processedEvents, outbox, operations, contacts, customers] = await Promise.all([
    world.portal.client.fieldHistory.count(),
    world.portal.client.processedEvent.count(),
    world.portal.client.outboxEvent.count(),
    world.portal.client.syncOperation.count(),
    world.portal.client.contact.count(),
    world.portal.client.customer.count(),
  ]);
  return { history, processed: processedEvents, outbox, operations, contacts, customers };
}

async function deliveryWith(world: World, field: string, value: string) {
  const row = (await deliveries(world)).find(
    (item) => asRecord(item.payload.changedFields)[field] === value,
  );
  if (row === undefined) {
    throw new Error(`no delivery changed ${field} to ${value}`);
  }
  return row;
}

function outboxField(
  rows: {
    changedFields: unknown;
    operationId: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    lastError: string | null;
  }[],
  field: string,
  value: string,
) {
  const row = rows.find((item) => asRecord(item.changedFields)[field] === value);
  if (row === undefined) {
    throw new Error(`no outbox row changed ${field} to ${value}`);
  }
  return row;
}

async function originDelivery(world: World, operationId: string) {
  const row = (await deliveries(world)).find(
    (item) => item.payload.originOperationId === operationId,
  );
  if (row === undefined) {
    throw new Error('origin delivery was not found');
  }
  return row;
}

function contactWrites(world: World): CapturedCall[] {
  return writes(world).filter((call) => call.url.includes('/sf/v1/contacts'));
}

function successWrites(
  rows: { operationId: string | null; statusCode: number }[],
  operationId: string,
) {
  return rows.filter(
    (row) => row.operationId === operationId && row.statusCode >= 200 && row.statusCode < 300,
  );
}

function only<T>(rows: T[], label: string): T {
  if (rows.length !== 1) {
    throw new Error(`${label} count ${rows.length}`);
  }
  return at(rows, 0);
}

function at<T>(rows: T[], index: number): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`missing ${index}`);
  }
  return row;
}

function required(value: string | null): string {
  if (value === null) {
    throw new Error('salesforce id is missing');
  }
  return value;
}

function readId(value: unknown): string {
  return readString(asRecord(value).id, 'id');
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} was not a string`);
  }
  return value;
}
