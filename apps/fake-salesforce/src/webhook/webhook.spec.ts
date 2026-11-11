import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
  DELIVERY_BACKOFF_CAP_MS,
  DELIVERY_MAX_ATTEMPTS,
  backoffMs,
  deliveryOutcome,
} from './delivery-policy';
import { signWebhookPayload, stableWebhookJson } from './signature';

describe('webhook signature and retry schedule', () => {
  it('signs the stable raw JSON bytes with lowercase hex HMAC SHA-256', () => {
    const raw = stableWebhookJson({
      changeSequence: 4,
      originOperationId: null,
      changedBy: null,
      occurredAt: '2026-11-12T00:00:00.000Z',
      recordVersion: 2,
      changedFields: { status: null, name: 'Acme' },
      eventType: 'updated',
      recordId: 'SF-ACC-001',
      objectType: 'Account',
      eventId: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(raw).toBe(
      '{"eventId":"00000000-0000-4000-8000-0000000000aa","objectType":"Account","recordId":"SF-ACC-001","eventType":"updated","changedFields":{"name":"Acme","status":null},"changedBy":null,"recordVersion":2,"occurredAt":"2026-11-12T00:00:00.000Z","originOperationId":null,"changeSequence":4}',
    );
    const digest = signWebhookPayload('local-webhook-secret', raw);
    expect(digest).toBe(createHmac('sha256', 'local-webhook-secret').update(raw).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhookPayload('local-webhook-secret', `${raw} `)).not.toBe(digest);
  });

  it('uses a capped exponential delay and stops after the attempt bound', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(20)).toBe(DELIVERY_BACKOFF_CAP_MS);
    const now = 1_000_000;
    expect(
      deliveryOutcome({
        attempt: 1,
        nowMs: now,
        result: { status: 204, retryAfterSeconds: null },
      }),
    ).toEqual({
      status: 'DELIVERED',
      lastHttpStatus: 204,
      scheduledAtMs: now,
      deliveredAtMs: now,
    });
    expect(
      deliveryOutcome({
        attempt: 2,
        nowMs: now,
        result: { status: 429, retryAfterSeconds: 30 },
      }).scheduledAtMs,
    ).toBe(now + 30_000);
    expect(deliveryOutcome({ attempt: 1, nowMs: now, result: { timeout: true } })).toMatchObject({
      status: 'PENDING',
      lastHttpStatus: null,
      scheduledAtMs: now + 1000,
    });
    expect(
      deliveryOutcome({
        attempt: DELIVERY_MAX_ATTEMPTS,
        nowMs: now,
        result: { status: 500, retryAfterSeconds: null },
      }).status,
    ).toBe('FAILED');
    expect(
      deliveryOutcome({
        attempt: DELIVERY_MAX_ATTEMPTS - 1,
        nowMs: now,
        result: { status: 500, retryAfterSeconds: null },
      }).status,
    ).toBe('PENDING');
  });
});
