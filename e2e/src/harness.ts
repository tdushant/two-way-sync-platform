import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Contact, Customer, SimulatorConfig } from '@sync/contracts';
import { parseContact, parseCustomer } from '@sync/contracts';
import request, { type Agent } from 'supertest';
import { Clock as PortalClock } from '../../apps/portal-api/src/clock';
import { PrismaService as PortalPrisma } from '../../apps/portal-api/src/prisma/prisma.service';
import { PrismaService as FakePrisma } from '../../apps/fake-salesforce/src/prisma/prisma.service';
import { DEFAULT_SIMULATOR_CONFIG } from '../../apps/fake-salesforce/src/simulator/defaults';
import { Clock as FakeClock } from '../../apps/fake-salesforce/src/webhook/clock';
import {
  signWebhookPayload,
  stableWebhookJson,
} from '../../apps/fake-salesforce/src/webhook/signature';
import { ExternalApiBudget } from '../../apps/portal-worker/src/budget/external-api-budget';
import { Clock as WorkerClock } from '../../apps/portal-worker/src/clock';
import { PrismaService as WorkerPrisma } from '../../apps/portal-worker/src/prisma/prisma.service';
import { SalesforceClient } from '../../apps/portal-worker/src/salesforce/salesforce-client';
import { OutboundWorker } from '../../apps/portal-worker/src/outbox/outbound-worker';
import { OUTBOUND_JITTER } from '../../apps/portal-worker/src/outbox/outbound.module';
import { LEASE_MS, PARENT_WAIT_MS } from '../../apps/portal-worker/src/outbox/policy';
import { ReconciliationWorker } from '../../apps/portal-worker/src/reconcile/reconciliation-worker';
import { ManualClock } from './manual-clock';

export const SECRET = 'local-webhook-secret';
export const ACTOR = 'dev-user';
export const EDITOR = 'sf-user-1';
export { LEASE_MS, PARENT_WAIT_MS, stableWebhookJson, signWebhookPayload };

const QUOTA_TOKENS = 100_000n;
const EPOCH = '2026-01-01T00:00:00.000Z';

export interface CapturedCall {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export class MemoryLogger implements LoggerService {
  readonly lines: string[] = [];

  log(message: unknown, ...rest: unknown[]): void {
    this.keep(message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.keep(message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.keep(message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.keep(message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.keep(message, rest);
  }

  private keep(message: unknown, rest: unknown[]): void {
    this.lines.push([message, ...rest].map(textOf).join(' '));
  }
}

export interface World {
  clock: ManualClock;
  portalApp: INestApplication;
  fakeApp: INestApplication;
  workerApp: INestApplication;
  portal: PortalPrisma;
  fake: FakePrisma;
  worker: OutboundWorker;
  reconcile: ReconciliationWorker;
  budget: ExternalApiBudget;
  workerPrisma: WorkerPrisma;
  salesforce: SalesforceClient;
  logger: MemoryLogger;
  calls: CapturedCall[];
  fetchErrors: string[];
  webhookUrl: string;
  fakeBase: string;
  restoreFetch: () => void;
}

export async function boot(): Promise<World> {
  const clock = new ManualClock(new Date(EPOCH));
  const logger = new MemoryLogger();
  const calls: CapturedCall[] = [];
  const fetchErrors: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('/sf/v1')) {
      calls.push({ method, url, body, headers: headerMap(init?.headers) });
    }
    try {
      return await original(input, init);
    } catch (error) {
      const cause = error instanceof Error && 'cause' in error ? String(error.cause) : '';
      const message = error instanceof Error ? error.message : String(error);
      fetchErrors.push(`${method} ${url} ${message} ${cause}`);
      throw error;
    }
  };

  const portalSpecifier = '../../apps/portal-api/src/app.module';
  const PortalApp = await loadApp(portalSpecifier);
  const portalRef = await Test.createTestingModule({ imports: [PortalApp] })
    .overrideProvider(PortalClock)
    .useValue(clock as PortalClock)
    .compile();
  const portalApp = portalRef.createNestApplication({ rawBody: true, logger });
  await portalApp.listen(0, '127.0.0.1');
  const webhookUrl = `http://127.0.0.1:${tcpPort(portalApp)}/webhooks/salesforce`;
  process.env.PORTAL_WEBHOOK_URL = webhookUrl;

  const fakeSpecifier = '../../apps/fake-salesforce/src/app.module';
  const FakeApp = await loadApp(fakeSpecifier);
  const fakeRef = await Test.createTestingModule({ imports: [FakeApp] })
    .overrideProvider(FakeClock)
    .useValue(clock as FakeClock)
    .compile();
  const fakeApp = fakeRef.createNestApplication({ logger: false });
  await fakeApp.listen(0, '127.0.0.1');
  const fakeBase = `http://127.0.0.1:${tcpPort(fakeApp)}`;
  process.env.FAKE_SALESFORCE_BASE_URL = fakeBase;
  try {
    const health = await fetch(`${fakeBase}/health`);
    if (health.status >= 500) {
      throw new Error(`fake health returned ${health.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fetch to fake Salesforce failed: ${message}`, { cause: error });
  }

  const workerSpecifier = '../../apps/portal-worker/src/app.module';
  const WorkerApp = await loadApp(workerSpecifier);
  const workerRef = await Test.createTestingModule({ imports: [WorkerApp] })
    .overrideProvider(WorkerClock)
    .useValue(clock as WorkerClock)
    .overrideProvider(OUTBOUND_JITTER)
    .useValue(() => 0)
    .compile();
  const workerApp = workerRef.createNestApplication({ logger: false });
  await workerApp.init();

  const portal = portalApp.get(PortalPrisma);
  const created = parsed(
    parseCustomer(
      (
        await portalAgent(portalApp)
          .post('/api/v1/customers')
          .set('x-actor-id', ACTOR)
          .set('Idempotency-Key', randomUUID())
          .send({ name: 'wkx e2e clock probe' })
      ).body,
      randomUUID(),
    ),
  );
  if (created.createdAt !== clock.now().toISOString()) {
    throw new Error(`portal clock was not injected: ${created.createdAt}`);
  }
  const injectedWorkerClock = workerApp.get(WorkerClock, { strict: false });
  if (injectedWorkerClock.now().toISOString() !== clock.now().toISOString()) {
    throw new Error('worker clock was not injected');
  }
  const injectedFakeClock = fakeApp.get(FakeClock, { strict: false });
  if (injectedFakeClock.now().toISOString() !== clock.now().toISOString()) {
    throw new Error('fake Salesforce clock was not injected');
  }

  return {
    clock,
    portalApp,
    fakeApp,
    workerApp,
    portal,
    fake: fakeApp.get(FakePrisma),
    worker: workerApp.get(OutboundWorker),
    reconcile: workerApp.get(ReconciliationWorker),
    budget: workerApp.get(ExternalApiBudget, { strict: false }),
    workerPrisma: workerApp.get(WorkerPrisma),
    salesforce: workerApp.get(SalesforceClient, { strict: false }),
    logger,
    calls,
    fetchErrors,
    webhookUrl,
    fakeBase,
    restoreFetch: () => {
      globalThis.fetch = original;
    },
  };
}

export async function shutdown(world: World): Promise<void> {
  world.restoreFetch();
  await world.workerApp.close();
  await world.fakeApp.close();
  await world.portalApp.close();
}

export async function reset(world: World): Promise<void> {
  const resetResponse = await sim(world).post('/simulator/reset');
  if (resetResponse.status !== 200) {
    throw new Error(`simulator reset failed: ${resetResponse.status}`);
  }
  await world.portal.client.$transaction([
    world.portal.client.fieldHistory.deleteMany(),
    world.portal.client.fieldSyncState.deleteMany(),
    world.portal.client.outboxEvent.deleteMany(),
    world.portal.client.syncOperation.deleteMany(),
    world.portal.client.processedEvent.deleteMany(),
    world.portal.client.clientIdempotencyKey.deleteMany(),
    world.portal.client.reconciliationRun.deleteMany(),
    world.portal.client.contact.deleteMany(),
    world.portal.client.customer.deleteMany(),
    world.portal.client.syncCheckpoint.deleteMany(),
  ]);
  await world.portal.client.$executeRaw`DELETE FROM sync_commands`;
  await world.portal.client.apiQuotaBucket.update({
    where: { bucket: 'external_api' },
    data: {
      tokens: QUOTA_TOKENS,
      maxTokens: QUOTA_TOKENS,
      refillPerSecondMilli: 0n,
      blockedUntil: null,
      updatedAt: world.clock.now(),
    },
  });
  world.calls.length = 0;
  world.fetchErrors.length = 0;
  world.logger.lines.length = 0;
}

export function portalAgent(app: INestApplication): Agent {
  return request(app.getHttpServer());
}

export function sim(world: World): Agent {
  return request
    .agent(world.fakeApp.getHttpServer())
    .set('x-simulator-token', 'local-simulator-token');
}

export function fakeAgent(world: World): Agent {
  return request(world.fakeApp.getHttpServer());
}

export async function putConfig(world: World, patch: Partial<SimulatorConfig>): Promise<void> {
  const response = await sim(world)
    .put('/simulator/config')
    .send({ ...DEFAULT_SIMULATOR_CONFIG, ...patch });
  expectStatus(response.status, 200);
}

export async function settle(world: World): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await world.worker.flush();
    const open = await world.portal.client.outboxEvent.count({
      where: { status: { in: ['PENDING', 'RETRY', 'IN_FLIGHT'] } },
    });
    if (open === 0) {
      return;
    }
    world.clock.advance(PARENT_WAIT_MS);
  }
  const rows = await world.portal.client.outboxEvent.findMany();
  throw new Error(
    `outbox did not settle: ${rows.map((row) => `${row.status}:${row.lastError ?? ''}`).join(',')} calls=${world.calls.map((call) => `${call.method} ${call.url}`).join(';')} fetch=${world.fetchErrors.join(';')}`,
  );
}

export async function flushWebhooks(
  world: World,
): Promise<{ attempted: number; delivered: number }> {
  const response = await sim(world).post('/simulator/flush-deliveries');
  expectStatus(response.status, 200);
  return response.body as { attempted: number; delivered: number };
}

export async function createCustomer(world: World, name: string): Promise<Customer> {
  const response = await portalAgent(world.portalApp)
    .post('/api/v1/customers')
    .set('x-actor-id', ACTOR)
    .set('Idempotency-Key', randomUUID())
    .send({ name });
  expectStatus(response.status, 201);
  return parsed(parseCustomer(response.body, randomUUID()));
}

export async function createContact(
  world: World,
  input: { customerId: string; fullName: string; phone?: string; city?: string; email?: string },
): Promise<Contact> {
  const response = await portalAgent(world.portalApp)
    .post('/api/v1/contacts')
    .set('x-actor-id', ACTOR)
    .set('Idempotency-Key', randomUUID())
    .send(input);
  expectStatus(response.status, 201);
  return parsed(parseContact(response.body, randomUUID()));
}

export async function patchContact(
  world: World,
  id: string,
  rowVersion: number,
  body: { phone?: string; city?: string; email?: string; ownerId?: string | null },
): Promise<Contact> {
  const response = await portalAgent(world.portalApp)
    .patch(`/api/v1/contacts/${id}`)
    .set('x-actor-id', ACTOR)
    .set('If-Match', String(rowVersion))
    .send(body);
  expectStatus(response.status, 200);
  return parsed(parseContact(response.body, randomUUID()));
}

export async function getContact(world: World, id: string): Promise<Contact> {
  const response = await portalAgent(world.portalApp)
    .get(`/api/v1/contacts/${id}`)
    .set('x-actor-id', ACTOR);
  expectStatus(response.status, 200);
  return parsed(parseContact(response.body, randomUUID()));
}

export async function getCustomer(world: World, id: string): Promise<Customer> {
  const response = await portalAgent(world.portalApp)
    .get(`/api/v1/customers/${id}`)
    .set('x-actor-id', ACTOR);
  expectStatus(response.status, 200);
  return parsed(parseCustomer(response.body, randomUUID()));
}

export async function syncCustomer(world: World, label: string): Promise<Customer> {
  const customer = await createCustomer(world, `wkx e2e ${label}`);
  await settle(world);
  await flushWebhooks(world);
  return getCustomer(world, customer.id);
}

export async function syncContact(
  world: World,
  input: { label: string; phone: string; city: string; email?: string },
): Promise<{ customer: Customer; contact: Contact }> {
  const customer = await syncCustomer(world, `${input.label} account`);
  const created = await createContact(world, {
    customerId: customer.id,
    fullName: `wkx e2e ${input.label}`,
    phone: input.phone,
    city: input.city,
    email: input.email,
  });
  await settle(world);
  await flushWebhooks(world);
  return {
    customer: await getCustomer(world, customer.id),
    contact: await getContact(world, created.id),
  };
}

export async function fakePatchContact(
  world: World,
  id: string,
  body: { phone?: string; city?: string; email?: string; ownerId?: string | null },
): Promise<void> {
  const response = await fakeAgent(world)
    .patch(`/sf/v1/contacts/${id}`)
    .set('x-changed-by', EDITOR)
    .set('Idempotency-Key', randomUUID())
    .send(body);
  expectStatus(response.status, 200);
}

export async function fakeCreateAccount(world: World, name: string): Promise<{ id: string }> {
  const response = await fakeAgent(world)
    .post('/sf/v1/accounts')
    .set('x-changed-by', EDITOR)
    .set('Idempotency-Key', randomUUID())
    .send({ name });
  expectStatus(response.status, 201);
  return { id: readString(response.body, 'id') };
}

export async function fakeCreateContact(
  world: World,
  accountId: string,
  fullName: string,
): Promise<{ id: string }> {
  const response = await fakeAgent(world)
    .post('/sf/v1/contacts')
    .set('x-changed-by', EDITOR)
    .set('Idempotency-Key', randomUUID())
    .send({ accountId, fullName });
  expectStatus(response.status, 201);
  return { id: readString(response.body, 'id') };
}

export async function fakeGetContact(
  world: World,
  id: string,
): Promise<{ status: number; phone: string | null; city: string | null; version: number }> {
  const response = await fakeAgent(world).get(`/sf/v1/contacts/${id}`);
  if (response.status !== 200) {
    return { status: response.status, phone: null, city: null, version: 0 };
  }
  return {
    status: response.status,
    phone: readNullableString(response.body, 'phone'),
    city: readNullableString(response.body, 'city'),
    version: readNumber(response.body, 'version'),
  };
}

export interface DeliveryRow {
  eventId: string;
  status: string;
  lastHttpStatus: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function deliveries(world: World): Promise<DeliveryRow[]> {
  const response = await sim(world).get('/simulator/deliveries');
  expectStatus(response.status, 200);
  if (!Array.isArray(response.body)) {
    throw new Error('deliveries response was not an array');
  }
  return response.body.map((row) => {
    const record = asRecord(row);
    return {
      eventId: readString(record, 'eventId'),
      status: readString(record, 'status'),
      lastHttpStatus: readNullableNumber(record, 'lastHttpStatus'),
      payload: asRecord(record.payload),
      createdAt: readString(record, 'createdAt'),
    };
  });
}

export interface RequestRow {
  method: string;
  path: string;
  operationId: string | null;
  statusCode: number;
}

export async function requests(world: World): Promise<RequestRow[]> {
  const response = await sim(world).get('/simulator/requests');
  expectStatus(response.status, 200);
  if (!Array.isArray(response.body)) {
    throw new Error('requests response was not an array');
  }
  return response.body.map((row) => {
    const record = asRecord(row);
    const operationId = record.operationId;
    return {
      method: readString(record, 'method'),
      path: readString(record, 'path'),
      operationId: typeof operationId === 'string' ? operationId : null,
      statusCode: readNumber(record, 'statusCode'),
    };
  });
}

export interface ChangeRow {
  eventId: string;
  recordId: string;
  changeSequence: number;
  recordVersion: number;
  changedFields: Record<string, unknown>;
}

export async function changes(world: World, after: string | null): Promise<ChangeRow[]> {
  const query = after === null ? { limit: 100 } : { after, limit: 100 };
  const response = await fakeAgent(world).get('/sf/v1/changes').query(query);
  expectStatus(response.status, 200);
  if (!Array.isArray(response.body)) {
    throw new Error('changes response was not an array');
  }
  return response.body.map((row) => {
    const record = asRecord(row);
    return {
      eventId: readString(record, 'eventId'),
      recordId: readString(record, 'recordId'),
      changeSequence: readNumber(record, 'changeSequence'),
      recordVersion: readNumber(record, 'recordVersion'),
      changedFields: asRecord(record.changedFields),
    };
  });
}

export async function emitContact(
  world: World,
  input: {
    recordId: string;
    occurredAt: string;
    changedFields: Record<string, string>;
    recordVersion?: number;
  },
): Promise<{ eventId: string; recordVersion: number; changeSequence: number }> {
  const response = await sim(world)
    .post('/simulator/emit-event')
    .send({
      objectType: 'Contact',
      recordId: input.recordId,
      occurredAt: input.occurredAt,
      changedFields: input.changedFields,
      changedBy: EDITOR,
      originOperationId: null,
      ...(input.recordVersion === undefined ? {} : { recordVersion: input.recordVersion }),
    });
  expectStatus(response.status, 200);
  return {
    eventId: readString(response.body, 'eventId'),
    recordVersion: readNumber(response.body, 'recordVersion'),
    changeSequence: readNumber(response.body, 'changeSequence'),
  };
}

export async function reorder(world: World, eventIds: string[]): Promise<void> {
  const response = await sim(world).post('/simulator/reorder-deliveries').send({ eventIds });
  expectStatus(response.status, 200);
}

export async function postWebhook(world: World, raw: string, signature: string): Promise<Response> {
  return fetch(world.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-salesforce-signature': signature,
    },
    body: raw,
  });
}

export function writes(world: World): CapturedCall[] {
  return world.calls.filter((call) => call.method === 'POST' || call.method === 'PATCH');
}

export function jsonBody(call: CapturedCall): Record<string, unknown> {
  return asRecord(JSON.parse(call.body) as unknown);
}

export function parsed<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) {
    throw new Error('response did not match the contract');
  }
  return result.value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value;
}

async function loadApp(specifier: string): Promise<new (...args: never[]) => object> {
  const loaded = (await import(specifier)) as { AppModule: new (...args: never[]) => object };
  return loaded.AppModule;
}

function tcpPort(app: INestApplication): number {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return address.port;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (headers === undefined) {
    return map;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      map[key.toLowerCase()] = value;
    });
    return map;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const key = pair[0];
      const value = pair[1];
      if (key !== undefined && value !== undefined) {
        map[key.toLowerCase()] = value;
      }
    }
    return map;
  }
  for (const [key, value] of Object.entries(headers)) {
    map[key.toLowerCase()] = value;
  }
  return map;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function expectStatus(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`expected HTTP ${expected} but received ${actual}`);
  }
}

function readString(value: unknown, key: string): string {
  const record = asRecord(value);
  const item = record[key];
  if (typeof item !== 'string' || item.length === 0) {
    throw new Error(`${key} was not a string`);
  }
  return item;
}

function readNullableString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  const item = record[key];
  if (item === null) {
    return null;
  }
  if (typeof item !== 'string') {
    throw new Error(`${key} was not a string`);
  }
  return item;
}

function readNumber(value: unknown, key: string): number {
  const record = asRecord(value);
  const item = record[key];
  if (typeof item !== 'number') {
    throw new Error(`${key} was not a number`);
  }
  return item;
}

function readNullableNumber(value: unknown, key: string): number | null {
  const record = asRecord(value);
  const item = record[key];
  if (item === null) {
    return null;
  }
  if (typeof item !== 'number') {
    throw new Error(`${key} was not a number`);
  }
  return item;
}
