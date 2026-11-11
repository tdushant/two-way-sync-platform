import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { HealthService } from './health.service';

describe('portal-api health routes', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(reachable: boolean): Promise<{
    probe: jest.Mock<() => Promise<boolean>>;
  }> {
    const probe = jest.fn<() => Promise<boolean>>().mockResolvedValue(reachable);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HealthService)
      .useValue({ isDatabaseReachable: probe })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return { probe };
  }

  it('answers liveness without calling the database probe', async () => {
    const { probe } = await start(true);
    const response = await request(app!.getHttpServer()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('answers readiness 200 when the database probe succeeds', async () => {
    const { probe } = await start(true);
    const response = await request(app!.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('answers readiness 503 when the database probe fails', async () => {
    await start(false);
    const response = await request(app!.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error' });
  });
});
