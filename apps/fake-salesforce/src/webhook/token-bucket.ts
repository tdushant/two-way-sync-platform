import { Injectable } from '@nestjs/common';

@Injectable()
export class TokenBucket {
  private windowStart = Number.NaN;
  private used = 0;

  allow(ratePerSec: number, nowMs: number): boolean {
    const max = Math.floor(ratePerSec);
    if (max <= 0) {
      return false;
    }
    const window = Math.floor(nowMs / 1000);
    if (window !== this.windowStart) {
      this.windowStart = window;
      this.used = 0;
    }
    if (this.used >= max) {
      return false;
    }
    this.used += 1;
    return true;
  }

  reset(): void {
    this.windowStart = Number.NaN;
    this.used = 0;
  }
}
