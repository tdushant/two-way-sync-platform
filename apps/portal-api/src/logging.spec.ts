import { describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { assignRequestId, correlationIdFromRequest, REDACTED_LOG_PATHS } from './logging';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('correlation id', () => {
  it('keeps a UUID already assigned to the request', () => {
    const request = { id: '6b1f0a2e-7c10-4d0a-9a1e-222222222222' } as IncomingMessage;
    expect(correlationIdFromRequest(request)).toBe('6b1f0a2e-7c10-4d0a-9a1e-222222222222');
  });

  it('generates a UUID when the request id is missing, empty, or not a string', () => {
    expect(correlationIdFromRequest({} as IncomingMessage)).toMatch(UUID);
    expect(correlationIdFromRequest({ id: '' } as IncomingMessage)).toMatch(UUID);
    expect(correlationIdFromRequest({ id: 12 } as unknown as IncomingMessage)).toMatch(UUID);
  });

  it('uses a UUID correlation header as the request id', () => {
    const request = {
      id: '6b1f0a2e-7c10-4d0a-9a1e-111111111111',
      headers: { 'x-correlation-id': '6b1f0a2e-7c10-4d0a-9a1e-222222222222' },
    } as unknown as IncomingMessage;
    expect(assignRequestId(request)).toBe('6b1f0a2e-7c10-4d0a-9a1e-222222222222');
  });

  it('redacts email, phone, full name, and changed fields', () => {
    expect(REDACTED_LOG_PATHS).toEqual(
      expect.arrayContaining(['email', 'phone', 'fullName', 'changedFields']),
    );
  });
});
