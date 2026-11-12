import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { Clock } from '../clock';
import { AdminLimiter } from './admin-limiter';

class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function limiter(raw: string | undefined, clock: FixedClock): AdminLimiter {
  const config = {
    get: (key: string) => (key === 'SYNC_ADMIN_REQUESTS_PER_SECOND' ? raw : undefined),
  } as ConfigService;
  return new AdminLimiter(config, clock);
}

describe('admin limiter', () => {
  it('allows the configured number of calls in one second and rejects the next', () => {
    const clock = new FixedClock(new Date('2026-11-12T12:00:00.000Z'));
    const limited = limiter('1', clock);
    limited.take('3c0a9b44-1111-4222-8333-444444444444');
    expect(() => limited.take('3c0a9b44-1111-4222-8333-444444444444')).toThrow(HttpException);
    try {
      limited.take('3c0a9b44-1111-4222-8333-444444444444');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it('opens a new window on the next second and falls back when the setting is not an integer', () => {
    const clock = new FixedClock(new Date('2026-11-12T12:00:00.000Z'));
    const limited = limiter('nope', clock);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limited.take('3c0a9b44-1111-4222-8333-444444444444');
    }
    expect(() => limited.take('3c0a9b44-1111-4222-8333-444444444444')).toThrow(HttpException);
    clock.advance(1000);
    limited.take('3c0a9b44-1111-4222-8333-444444444444');
  });
});
