import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION_HEADER = 'x-correlation-id';

export const REDACTED_LOG_PATHS = [
  'email',
  'phone',
  'fullName',
  'full_name',
  '*.email',
  '*.phone',
  '*.fullName',
  '*.full_name',
  'changedFields',
  '*.changedFields',
  'req.body.email',
  'req.body.phone',
  'req.body.fullName',
  'req.body.full_name',
  'req.body.changedFields',
];

export function correlationIdFromRequest(request: IncomingMessage): string {
  const candidate = Reflect.get(request, 'id');
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate : randomUUID();
}

export function assignRequestId(request: IncomingMessage): string {
  const header = request.headers[CORRELATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && UUID.test(value)) {
    return value;
  }
  return correlationIdFromRequest(request);
}

export const logging = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    autoLogging: process.env.NODE_ENV !== 'test',
    genReqId: (request: IncomingMessage) => assignRequestId(request),
    customProps: (request: IncomingMessage) => ({
      correlationId: correlationIdFromRequest(request),
    }),
    redact: {
      paths: REDACTED_LOG_PATHS,
      censor: '[redacted]',
    },
  },
});
