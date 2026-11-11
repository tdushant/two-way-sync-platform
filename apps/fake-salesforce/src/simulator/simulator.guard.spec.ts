import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { SalesforceRequest, SalesforceResponse } from '../http/salesforce-request';
import { SimulatorGuard } from './simulator.guard';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';

describe('simulator admin access', () => {
  it('does not serve the route in production', () => {
    const { response, state, next } = harness();
    guard({ NODE_ENV: 'production' }).use(request('local-simulator-token'), response, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(404);
    expect(state.body).toMatchObject({ statusCode: 404, message: 'Not found' });
  });

  it('requires the local token and rejects a mismatch', () => {
    const missing = harness();
    guard({ NODE_ENV: 'test', SIMULATOR_ADMIN_TOKEN: 'local-simulator-token' }).use(
      request(undefined),
      missing.response,
      missing.next,
    );
    expect(missing.state.statusCode).toBe(401);

    const padded = harness();
    guard({ NODE_ENV: 'development', SIMULATOR_ADMIN_TOKEN: 'local-simulator-token' }).use(
      request(' local-simulator-token'),
      padded.response,
      padded.next,
    );
    expect(padded.state.statusCode).toBe(401);

    const wrong = harness();
    guard({ NODE_ENV: 'test', SIMULATOR_ADMIN_TOKEN: 'local-simulator-token' }).use(
      request('other-token'),
      wrong.response,
      wrong.next,
    );
    expect(wrong.state.statusCode).toBe(403);
    expect(wrong.next).not.toHaveBeenCalled();

    const allowed = harness();
    guard({ NODE_ENV: 'test', SIMULATOR_ADMIN_TOKEN: 'local-simulator-token' }).use(
      request('local-simulator-token'),
      allowed.response,
      allowed.next,
    );
    expect(allowed.next).toHaveBeenCalledTimes(1);
  });
});

function guard(values: Record<string, string>): SimulatorGuard {
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(key);
      }
      return value;
    },
  } as unknown as ConfigService;
  return new SimulatorGuard(config);
}

function request(token: string | undefined): SalesforceRequest {
  return {
    correlationId: CORRELATION_ID,
    header: (name: string) => (name === 'x-simulator-token' ? token : undefined),
  } as SalesforceRequest;
}

function harness(): {
  response: SalesforceResponse;
  state: { statusCode: number; body: unknown };
  next: ReturnType<typeof jest.fn>;
} {
  const state = { statusCode: 0, body: undefined as unknown };
  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  } as SalesforceResponse;
  return { response, state, next: jest.fn() };
}
