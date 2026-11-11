import { describe, expect, it } from '@jest/globals';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  classifyStatus,
  parseRetryAfter,
  retryDelayMs,
  selectOutboundFields,
  wireBody,
} from './policy';

describe('outbound policy', () => {
  it('backs off exponentially, adds jitter, and caps the delay', () => {
    expect(backoffMs(1, 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, 0)).toBe(2_000);
    expect(backoffMs(1, 0.5)).toBe(1_500);
    expect(backoffMs(20, 1)).toBe(BACKOFF_CAP_MS);
  });

  it('honors an integer Retry-After and retries 408, 429, and 5xx', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    expect(retryDelayMs(1, 0, 30)).toBe(30_000);
    expect(retryDelayMs(4, 0, 1)).toBe(8_000);
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(408)).toBe('retry');
    expect(classifyStatus(429)).toBe('retry');
    expect(classifyStatus(503)).toBe('retry');
    expect(classifyStatus(400)).toBe('dead');
    expect(classifyStatus(409)).toBe('dead');
  });

  it('drops a stale field, keeps a current one, and never trims a create', () => {
    const mixed = selectOutboundFields({
      eventType: 'updated',
      changedFields: { name: 'Old', status: 'paused' },
      baseFields: { name: '1', status: '1' },
      current: { name: 'New', status: 'paused' },
      sync: [
        { fieldName: 'name', source: 'PORTAL', sourceVersion: '2' },
        { fieldName: 'status', source: 'PORTAL', sourceVersion: '1' },
      ],
    });
    expect(mixed.send).toEqual({ status: 'paused' });
    expect(mixed.superseded).toEqual(['name']);
    const created = selectOutboundFields({
      eventType: 'created',
      changedFields: { name: 'Created' },
      baseFields: { name: '1' },
      current: { name: 'Renamed' },
      sync: [{ fieldName: 'name', source: 'PORTAL', sourceVersion: '2' }],
    });
    expect(created).toEqual({ send: { name: 'Created' }, superseded: [] });
  });

  it('maps a contact parent to accountId and waits when that parent has no external id', () => {
    expect(wireBody('contact', { customerId: 'portal-1', fullName: 'Ada' }, 'SF-1').body).toEqual({
      accountId: 'SF-1',
      fullName: 'Ada',
    });
    expect(wireBody('contact', { customerId: 'portal-1', city: 'Paris' }, null).pendingParent).toBe(
      true,
    );
    expect(wireBody('customer', { name: 'Acme', customerId: 'ignored' }, null).body).toEqual({
      name: 'Acme',
    });
  });
});
