import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import { pingPostgres } from './ping-postgres';

describe('portal-api database readiness', () => {
  it('returns false when postgres refuses the connection', async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key !== 'PORTAL_DATABASE_URL') {
          throw new Error(key);
        }
        return 'postgresql://portal:portal@127.0.0.1:1/portal';
      },
    } as unknown as ConfigService;
    const service = new HealthService(config);
    await expect(service.isDatabaseReachable()).resolves.toBe(false);
  });

  it('rejects a connection to a closed port', async () => {
    await expect(
      pingPostgres('postgresql://portal:portal@127.0.0.1:1/portal', 300),
    ).rejects.toThrow();
  });
});
