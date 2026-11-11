import { describe, expect, it } from '@jest/globals';
import { IDEMPOTENCY_KEY_HEADER } from '@sync/contracts';
import { salesforceRequest } from './salesforce-client';

describe('salesforce request', () => {
  it('sends the changed-field JSON and the operation id as the idempotency key', () => {
    const request = salesforceRequest('http://127.0.0.1:3001/', {
      method: 'PATCH',
      path: '/sf/v1/accounts/SF-1',
      body: { name: 'Ada' },
      operationId: '3c0a9b44-1111-4222-8333-444444444444',
      correlationId: '3c0a9b44-1111-4222-8333-555555555555',
    });
    expect(request.url).toBe('http://127.0.0.1:3001/sf/v1/accounts/SF-1');
    expect(request.headers[IDEMPOTENCY_KEY_HEADER]).toBe('3c0a9b44-1111-4222-8333-444444444444');
    expect(JSON.parse(request.body)).toEqual({ name: 'Ada' });
  });
});
