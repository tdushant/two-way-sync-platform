import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';

describe('fake-salesforce database readiness', () => {
  it('returns false when postgres refuses the connection', async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key !== 'SALESFORCE_DATABASE_URL') {
          throw new Error(key);
        }
        return 'postgresql://salesforce:salesforce@127.0.0.1:1/salesforce';
      },
    } as unknown as ConfigService;
    await expect(new HealthService(config).isDatabaseReachable()).resolves.toBe(false);
  });
});
