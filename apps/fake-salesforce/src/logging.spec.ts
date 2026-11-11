import { describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { correlationIdFromRequest } from './logging';

describe('correlation id', () => {
  it('keeps a UUID already assigned to the request', () => {
    const request = { id: '6b1f0a2e-7c10-4d0a-9a1e-222222222222' } as IncomingMessage;
    expect(correlationIdFromRequest(request)).toBe('6b1f0a2e-7c10-4d0a-9a1e-222222222222');
  });
});
