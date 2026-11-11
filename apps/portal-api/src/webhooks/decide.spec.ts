import { describe, expect, it } from '@jest/globals';
import { decideInboundField } from './decide';

const EARLIER = new Date('2026-11-11T10:00:00.000Z');
const LATER = new Date('2026-11-11T11:00:00.000Z');
const AFTER = new Date('2026-11-11T12:00:00.000Z');

describe('inbound field decisions', () => {
  it('rejects an older or equal Salesforce version and still accepts another field version', () => {
    expect(
      decideInboundField({
        current: 'New',
        candidate: 'Old',
        occurredAt: LATER,
        recordVersion: 11,
        state: { source: 'SALESFORCE', sourceVersion: '12', sourceChangedAt: EARLIER },
      }).decision,
    ).toBe('REJECTED_STALE');
    expect(
      decideInboundField({
        current: 'New',
        candidate: 'Other',
        occurredAt: LATER,
        recordVersion: 12,
        state: { source: 'SALESFORCE', sourceVersion: '12', sourceChangedAt: EARLIER },
      }).decision,
    ).toBe('REJECTED_STALE');
    expect(
      decideInboundField({
        current: 'active',
        candidate: 'paused',
        occurredAt: EARLIER,
        recordVersion: 11,
        state: { source: 'SALESFORCE', sourceVersion: '10', sourceChangedAt: LATER },
      }),
    ).toMatchObject({ decision: 'APPLIED', persistValue: true, persistVersion: true });
  });

  it('keeps a newer portal value and lets Salesforce win an exact timestamp tie', () => {
    const portal = { source: 'PORTAL', sourceVersion: '4', sourceChangedAt: LATER };
    expect(
      decideInboundField({
        current: 'Portal',
        candidate: 'Remote',
        occurredAt: EARLIER,
        recordVersion: 3,
        state: portal,
      }).decision,
    ).toBe('CONFLICT_LOST');
    expect(
      decideInboundField({
        current: 'Portal',
        candidate: 'Remote',
        occurredAt: AFTER,
        recordVersion: 3,
        state: portal,
      }),
    ).toMatchObject({ decision: 'APPLIED', persistValue: true });
    expect(
      decideInboundField({
        current: 'Portal',
        candidate: 'Remote',
        occurredAt: LATER,
        recordVersion: 9,
        state: { source: 'PORTAL', sourceVersion: '4', sourceChangedAt: LATER },
      }).decision,
    ).toBe('APPLIED');
    expect(
      decideInboundField({
        current: 'Same',
        candidate: 'Same',
        occurredAt: LATER,
        recordVersion: 3,
        state: null,
      }),
    ).toMatchObject({ decision: 'NOOP', persistValue: false, persistVersion: true });
  });
});
