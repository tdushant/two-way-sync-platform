import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { OutboundWorker } from './outbox/outbound-worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  await app.get(OutboundWorker).start();
  const correlationId = randomUUID();
  logger.log({ correlationId, message: 'portal-worker started' });

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  await app
    .get(OutboundWorker)
    .flush()
    .catch(() => undefined);
  app.get(OutboundWorker).stop();
  await app.close();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
