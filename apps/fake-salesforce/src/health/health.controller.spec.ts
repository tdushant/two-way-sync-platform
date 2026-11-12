import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { HealthService } from './health.service';

describe('fake-salesforce health routes', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(reachable: boolean): Promise<void> {
    const probe = jest.fn<() => Promise<boolean>>().mockResolvedValue(reachable);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HealthService)
      .useValue({ isDatabaseReachable: probe })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  it('answers liveness', async () => {
    await start(true);
    const response = await request(app!.getHttpServer()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('answers readiness 503 when the database probe fails', async () => {
    await start(false);
    const response = await request(app!.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error' });
  });

  it('answers /sf/v1/health from the same database probe', async () => {
    await start(true);
    const live = await request(app!.getHttpServer()).get('/sf/v1/health');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    await app?.close();
    await start(false);
    const down = await request(app!.getHttpServer()).get('/sf/v1/health');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: 'error' });
  });

  it('serves the OpenAPI document and Swagger page', async () => {
    await start(true);
    const spec = await request(app!.getHttpServer()).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.paths['/sf/v1/health']).toBeDefined();
    const docs = await request(app!.getHttpServer()).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('/openapi.json');
    expect(docs.text).toContain('swagger-ui');
  });
});
