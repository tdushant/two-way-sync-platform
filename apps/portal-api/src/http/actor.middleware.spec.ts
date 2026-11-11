import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { ActorMiddleware } from './actor.middleware';
import type { PortalRequest, PortalResponse } from './portal-request';

const CORRELATION_ID = '3c0a9b44-1111-4222-8333-444444444444';

function config(nodeEnv: string): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key === 'NODE_ENV') {
        return nodeEnv;
      }
      throw new Error(key);
    },
  } as ConfigService;
}

function response(): PortalResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as PortalResponse & { statusCode: number; body: unknown };
}

describe('local actor middleware', () => {
  it('stores the development header and ignores actor fields on the body', () => {
    const middleware = new ActorMiddleware(config('test'));
    const request = {
      correlationId: CORRELATION_ID,
      body: { changedBy: 'from-body', actorId: 'from-body' },
      header: (name: string) => (name === 'x-actor-id' ? 'dev-user' : undefined),
    } as unknown as PortalRequest;
    const next = jest.fn();
    middleware.use(request, response(), next);
    expect(request.actorId).toBe('dev-user');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing header in local mode', () => {
    const middleware = new ActorMiddleware(config('development'));
    const res = response();
    const next = jest.fn();
    middleware.use(
      {
        correlationId: CORRELATION_ID,
        header: () => undefined,
      } as unknown as PortalRequest,
      res,
      next,
    );
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not authenticate from the header when the process is production', () => {
    const middleware = new ActorMiddleware(config('production'));
    const res = response();
    const next = jest.fn();
    middleware.use(
      {
        correlationId: CORRELATION_ID,
        header: () => 'dev-user',
      } as unknown as PortalRequest,
      res,
      next,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ message: 'Local authentication is not available' });
    expect(next).not.toHaveBeenCalled();
  });
});
