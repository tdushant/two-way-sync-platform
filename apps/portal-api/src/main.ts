import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const port = app.get(ConfigService).getOrThrow<number>('PORTAL_HTTP_PORT');
  await app.listen(port);
  app.get(Logger).log({ correlationId: randomUUID() }, 'portal-api listening');
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
