import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SalesforceRequest extends IncomingMessage {
  correlationId: string;
  header(name: string): string | undefined;
}

export interface SalesforceResponse extends ServerResponse {
  status(code: number): SalesforceResponse;
  json(body: unknown): SalesforceResponse;
}
