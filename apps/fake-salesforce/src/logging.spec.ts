import { describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { assignRequestId, correlationIdFromRequest, REDACTED_LOG_PATHS } from './logging';

describe('correlation id', () => {
  it('keeps a UUID already assigned to the request', () => {
    const request = { id: '6b1f0a2e-7c10-4d0a-9a1e-222222222222' } as IncomingMessage;
    expect(correlationIdFromRequest(request)).toBe('6b1f0a2e-7c10-4d0a-9a1e-222222222222');
  });

  it('uses a UUID correlation header as the request id and redacts field values', () => {
    const request = {
      headers: { 'x-correlation-id': '6b1f0a2e-7c10-4d0a-9a1e-333333333333' },
    } as unknown as IncomingMessage;
    expect(assignRequestId(request)).toBe('6b1f0a2e-7c10-4d0a-9a1e-333333333333');
    expect(REDACTED_LOG_PATHS).toEqual(expect.arrayContaining(['email', 'phone', 'fullName']));
  });
});
