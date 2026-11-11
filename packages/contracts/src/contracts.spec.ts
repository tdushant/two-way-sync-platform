import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  IDEMPOTENCY_KEY_HEADER,
  parseAccountPatch,
  parseApiError,
  parseChangesQuery,
  parseContactPatch,
  parseCreateContact,
  parseCreateCustomer,
  parseCreateSfContact,
  parseCustomer,
  parseCustomerPatch,
  parseIdempotencyKey,
  parseIfMatch,
  parseOperationId,
  parseOutboxStatus,
  parseReorderDeliveries,
  parseSfContactPatch,
  parseSimulatorConfig,
  parseWebhook,
} from './index';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  minLength?: number;
  minimum?: number;
  items?: JsonSchema;
}

function example(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, '../examples', name), 'utf8')) as unknown;
}

function schema(name: string): JsonSchema {
  return JSON.parse(readFileSync(resolve(__dirname, '../examples', name), 'utf8')) as JsonSchema;
}

function matchesSchema(definition: JsonSchema, value: unknown): boolean {
  if (definition.oneOf) {
    return definition.oneOf.filter((item) => matchesSchema(item, value)).length === 1;
  }
  if (definition.enum) {
    return definition.enum.some((item) => item === value);
  }
  if (definition.type) {
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    if (!types.some((type) => typeMatches(type, value))) {
      return false;
    }
  }
  if (
    typeof definition.minLength === 'number' &&
    typeof value === 'string' &&
    value.length < definition.minLength
  ) {
    return false;
  }
  if (
    typeof definition.minimum === 'number' &&
    typeof value === 'number' &&
    value < definition.minimum
  ) {
    return false;
  }
  if (Array.isArray(value)) {
    return (
      definition.items === undefined ||
      value.every((item) => matchesSchema(definition.items as JsonSchema, item))
    );
  }
  if (typeof value === 'object' && value !== null) {
    const properties = definition.properties ?? {};
    for (const key of definition.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        return false;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const property = properties[key];
      if (property) {
        if (!matchesSchema(property, child)) {
          return false;
        }
      } else if (typeof definition.additionalProperties === 'object') {
        if (!matchesSchema(definition.additionalProperties, child)) {
          return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

describe('customer and contact contracts', () => {
  it('accepts the create example and keeps null distinct from a missing field', () => {
    const body = example('customer.create.example.json');
    expect(matchesSchema(schema('customer.create.schema.json'), body)).toBe(true);
    const created = parseCreateCustomer(body, CORRELATION_ID);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value).toEqual({ name: 'Acme', status: 'active', ownerId: 'owner-1' });
    }
    const cleared = parseCreateCustomer({ name: 'Acme', status: null }, CORRELATION_ID);
    const omitted = parseCreateCustomer({ name: 'Acme' }, CORRELATION_ID);
    expect(cleared.ok && omitted.ok).toBe(true);
    if (cleared.ok && omitted.ok) {
      expect(cleared.value.status).toBeNull();
      expect('status' in omitted.value).toBe(false);
    }
  });

  it('rejects a null customer name and unknown fields on patch', () => {
    const cleared = example('customer.patch.clear.example.json');
    expect(matchesSchema(schema('customer.patch.schema.json'), cleared)).toBe(true);
    expect(matchesSchema(schema('customer.patch.schema.json'), {})).toBe(true);
    expect(matchesSchema(schema('customer.patch.schema.json'), { name: null })).toBe(false);
    const patch = parseCustomerPatch(cleared, CORRELATION_ID);
    const empty = parseCustomerPatch({}, CORRELATION_ID);
    expect(patch.ok && empty.ok).toBe(true);
    if (patch.ok && empty.ok) {
      expect(patch.value).toEqual({ status: null });
      expect(empty.value).toEqual({});
      expect('status' in empty.value).toBe(false);
    }
    expect(parseCustomerPatch({ name: null }, CORRELATION_ID).ok).toBe(false);
    expect(parseCustomerPatch({ name: '' }, CORRELATION_ID).ok).toBe(false);
    const unknown = parseCustomerPatch({ nickname: 'x' }, CORRELATION_ID);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('unknown_field');
      expect(unknown.error.correlationId).toBe(CORRELATION_ID);
    }
  });

  it('reads the documented customer response', () => {
    const body = example('customer.response.example.json');
    const parsed = parseCustomer(body, CORRELATION_ID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.salesforceId).toBeNull();
      expect(parsed.value.rowVersion).toBe(1);
    }
  });

  it('requires a portal customer id and rejects clearing it', () => {
    const customerId = '2f1c1c4a-1d1e-4b1a-9c1a-111111111111';
    const created = parseCreateContact({ customerId, email: null }, CORRELATION_ID);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.email).toBeNull();
      expect('fullName' in created.value).toBe(false);
    }
    expect(parseCreateContact({ email: 'a@example.com' }, CORRELATION_ID).ok).toBe(false);
    expect(parseCreateContact({ customerId, email: 1 }, CORRELATION_ID).ok).toBe(false);
    const patch = parseContactPatch({ email: null }, CORRELATION_ID);
    expect(patch.ok).toBe(true);
    if (patch.ok) {
      expect(patch.value).toEqual({ email: null });
    }
    expect(parseContactPatch({ customerId: null }, CORRELATION_ID).ok).toBe(false);
    expect(parseContactPatch({ accountId: 'SF-ACC-001' }, CORRELATION_ID).ok).toBe(false);
  });
});

describe('webhook envelope', () => {
  it('accepts shape A, shape B, and the emitted simulator body', () => {
    const shapeA = example('webhook.shape-a.example.json');
    const shapeB = example('webhook.shape-b.example.json');
    const emitted = example('webhook.emitted.example.json');
    const webhookSchema = schema('webhook.schema.json');
    expect(matchesSchema(webhookSchema, shapeA)).toBe(true);
    expect(matchesSchema(webhookSchema, shapeB)).toBe(true);
    expect(matchesSchema(webhookSchema, emitted)).toBe(true);

    const parsedA = parseWebhook(shapeA, CORRELATION_ID);
    const parsedB = parseWebhook(shapeB, CORRELATION_ID);
    const parsedEmitted = parseWebhook(emitted, CORRELATION_ID);
    expect(parsedA.ok && parsedB.ok && parsedEmitted.ok).toBe(true);
    if (parsedA.ok && parsedB.ok && parsedEmitted.ok) {
      expect(parsedA.value.changedFields).toEqual({ city: 'Paris' });
      expect('originOperationId' in parsedA.value).toBe(false);
      expect(parsedB.value.changedFields).toEqual({ name: 'New Name' });
      expect(parsedB.value.originOperationId).toBeNull();
      expect(parsedEmitted.value.recordVersion).toBe(8);
      expect(parsedEmitted.value.changeSequence).toBe(101);
      expect(parsedEmitted.value.originOperationId).toBe(CORRELATION_ID);
    }
  });

  it('preserves a null clear and rejects a null name, disagreement, and malformed envelopes', () => {
    const cleared = parseWebhook(
      {
        eventId: 'evt-1',
        objectType: 'Account',
        recordId: 'SF-ACC-001',
        eventType: 'updated',
        changedFields: { status: null },
        changedBy: 'sf-user-1',
        occurredAt: '2026-11-11T10:00:00.000Z',
      },
      CORRELATION_ID,
    );
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.changedFields).toEqual({ status: null });
    }
    expect(
      parseWebhook(
        {
          eventId: 'evt-1',
          objectType: 'Account',
          recordId: 'SF-ACC-001',
          eventType: 'updated',
          changedFields: { name: null },
          changedBy: 'sf-user-1',
          occurredAt: '2026-11-11T10:00:00.000Z',
        },
        CORRELATION_ID,
      ).ok,
    ).toBe(false);
    expect(
      parseWebhook(
        {
          eventId: 'evt-1',
          objectType: 'Account',
          recordId: 'SF-ACC-001',
          eventType: 'updated',
          changedFields: { name: 'One' },
          values: { name: 'Two' },
          changedBy: 'sf-user-1',
          occurredAt: '2026-11-11T10:00:00.000Z',
        },
        CORRELATION_ID,
      ).ok,
    ).toBe(false);
    expect(
      parseWebhook(
        {
          eventId: 'evt-1',
          objectType: 'Account',
          recordId: 'SF-ACC-001',
          eventType: 'updated',
          changedFields: ['name'],
          occurredAt: '2026-11-11T10:00:00.000Z',
        },
        CORRELATION_ID,
      ).ok,
    ).toBe(false);
    const missingEvent = parseWebhook({ objectType: 'Account' }, CORRELATION_ID);
    expect(missingEvent.ok).toBe(false);
    if (!missingEvent.ok) {
      expect(missingEvent.error.code).toBe('validation_failed');
    }
    expect(
      parseWebhook(
        {
          eventId: 'evt-1',
          objectType: 'Lead',
          recordId: 'SF-ACC-001',
          eventType: 'updated',
          changedFields: {},
          changedBy: 'sf-user-1',
          occurredAt: '2026-11-11T10:00:00.000Z',
        },
        CORRELATION_ID,
      ).ok,
    ).toBe(false);
  });
});

describe('operation and correlation identifiers', () => {
  it('uses Idempotency-Key for a client key or a UUID operation id', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(parseIdempotencyKey('client-key', CORRELATION_ID).ok).toBe(true);
    expect(parseIdempotencyKey('', CORRELATION_ID).ok).toBe(false);
    expect(parseOperationId(CORRELATION_ID, CORRELATION_ID).ok).toBe(true);
    expect(parseOperationId('client-key', CORRELATION_ID).ok).toBe(false);
    const absent = parseIfMatch(undefined, CORRELATION_ID);
    const present = parseIfMatch('3', CORRELATION_ID);
    expect(absent.ok && present.ok).toBe(true);
    if (absent.ok && present.ok) {
      expect(absent.value).toBeUndefined();
      expect(present.value).toBe(3);
    }
    expect(parseIfMatch('01', CORRELATION_ID).ok).toBe(false);
  });
});

describe('salesforce and sync query contracts', () => {
  it('rejects a null account id and keeps an omitted limit at 100', () => {
    expect(parseCreateSfContact({ accountId: 'SF-ACC-001', city: null }, CORRELATION_ID).ok).toBe(
      true,
    );
    expect(parseCreateSfContact({ fullName: 'Ada' }, CORRELATION_ID).ok).toBe(false);
    const patch = parseSfContactPatch({ accountId: 'SF-ACC-002' }, CORRELATION_ID);
    expect(patch.ok).toBe(true);
    expect(parseSfContactPatch({ accountId: null }, CORRELATION_ID).ok).toBe(false);
    expect(parseSfContactPatch({ customerId: CORRELATION_ID }, CORRELATION_ID).ok).toBe(false);
    expect(parseAccountPatch({ ownerId: null }, CORRELATION_ID).ok).toBe(true);
    const query = parseChangesQuery({}, CORRELATION_ID);
    const bounded = parseChangesQuery({ after: 10, limit: 100 }, CORRELATION_ID);
    expect(query.ok && bounded.ok).toBe(true);
    if (query.ok && bounded.ok) {
      expect(query.value).toEqual({ limit: 100 });
      expect('after' in query.value).toBe(false);
      expect(bounded.value).toEqual({ after: 10, limit: 100 });
    }
    expect(parseChangesQuery({ limit: 0 }, CORRELATION_ID).ok).toBe(false);
  });

  it('treats simulator config as a full replace and validates the error example', () => {
    const config = {
      outageEnabled: false,
      webhookEnabled: true,
      duplicateCount: 0,
      delayMs: 0,
      disorderMode: 'ordered',
      failureRate: 0,
      rateLimitPerSec: 10,
      dropWebhookRate: 0,
      responseDelayMs: 0,
    };
    expect(parseSimulatorConfig(config, CORRELATION_ID).ok).toBe(true);
    expect(parseSimulatorConfig({ ...config, disorderMode: undefined }, CORRELATION_ID).ok).toBe(
      false,
    );
    expect(parseReorderDeliveries({ eventIds: ['a', 'b'] }, CORRELATION_ID).ok).toBe(true);
    expect(parseOutboxStatus(undefined, CORRELATION_ID).ok).toBe(true);
    expect(parseOutboxStatus('BLOCKED', CORRELATION_ID).ok).toBe(false);
    const body = example('error.example.json');
    expect(matchesSchema(schema('error.schema.json'), body)).toBe(true);
    const parsed = parseApiError(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.code).toBe('unknown_field');
      expect(parsed.value.correlationId).toBe(CORRELATION_ID);
    }
  });
});
