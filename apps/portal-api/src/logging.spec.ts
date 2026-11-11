import { describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { correlationIdFromRequest } from './logging';

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
});
