import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function correlationIdFromRequest(request: IncomingMessage): string {
  const candidate = Reflect.get(request, 'id');
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate : randomUUID();
}

export const logging = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    autoLogging: process.env.NODE_ENV !== 'test',
    genReqId: () => randomUUID(),
    customProps: (request: IncomingMessage) => ({
      correlationId: correlationIdFromRequest(request),
    }),
  },
});
