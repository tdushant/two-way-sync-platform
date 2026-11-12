import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void,
      ) => {
        if (origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH'],
      allowedHeaders: [
        'content-type',
        'x-simulator-token',
        'x-changed-by',
        'idempotency-key',
        'x-correlation-id',
      ],
    });
  }
  app.enableShutdownHooks();
  const port = app.get(ConfigService).getOrThrow<number>('SALESFORCE_HTTP_PORT');
  await app.listen(port);
  app.get(Logger).log({ correlationId: randomUUID() }, 'fake-salesforce listening');
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
