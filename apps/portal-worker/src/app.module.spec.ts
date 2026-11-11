import { describe, it } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

describe('portal-worker bootstrap', () => {
  it('starts an application context and closes it', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    await app.close();
  });
});
