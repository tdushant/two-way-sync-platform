import type { IncomingMessage, ServerResponse } from 'node:http';

export interface PortalRequest extends IncomingMessage {
  correlationId: string;
  actorId?: string;
  header(name: string): string | undefined;
  body?: unknown;
}

export interface PortalResponse extends ServerResponse {
  status(code: number): PortalResponse;
  json(body: unknown): PortalResponse;
}
