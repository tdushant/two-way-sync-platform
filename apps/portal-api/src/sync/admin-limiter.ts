import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../clock';

const DEFAULT_PER_SECOND = 10;

@Injectable()
export class AdminLimiter {
  private windowStart = -1;
  private used = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  take(correlationId: string): void {
    const second = Math.floor(this.clock.now().getTime() / 1000);
    if (second !== this.windowStart) {
      this.windowStart = second;
      this.used = 0;
    }
    this.used += 1;
    if (this.used > this.limit()) {
      throw new HttpException(
        { correlationId, statusCode: 429, message: 'Admin rate limit exceeded' },
        429,
      );
    }
  }

  private limit(): number {
    const raw = this.config.get<string>('SYNC_ADMIN_REQUESTS_PER_SECOND');
    if (raw === undefined || raw === '') {
      return DEFAULT_PER_SECOND;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      return DEFAULT_PER_SECOND;
    }
    return parsed;
  }
}
