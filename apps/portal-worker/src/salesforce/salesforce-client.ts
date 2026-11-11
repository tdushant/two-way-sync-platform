import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDEMPOTENCY_KEY_HEADER } from '@sync/contracts';
import { HTTP_TIMEOUT_MS, type FieldMap, parseRetryAfter } from '../outbox/policy';

export interface SalesforceCall {
  method: 'POST' | 'PATCH';
  path: string;
  body: FieldMap;
  operationId: string;
  correlationId: string;
}

export interface SalesforceResult {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

export class SalesforceTransportError extends Error {
  constructor(readonly reason: 'timeout' | 'network') {
    super(reason);
    this.name = 'SalesforceTransportError';
  }
}

export abstract class SalesforceClient {
  abstract send(call: SalesforceCall): Promise<SalesforceResult>;
}

export function salesforceRequest(
  baseUrl: string,
  call: SalesforceCall,
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${baseUrl.replace(/\/$/, '')}${call.path}`,
    headers: {
      'content-type': 'application/json',
      [IDEMPOTENCY_KEY_HEADER]: call.operationId,
      'x-correlation-id': call.correlationId,
      'x-changed-by': 'portal-worker',
    },
    body: JSON.stringify(call.body),
  };
}

@Injectable()
export class FetchSalesforceClient extends SalesforceClient {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(call: SalesforceCall): Promise<SalesforceResult> {
    const request = salesforceRequest(
      this.config.getOrThrow<string>('FAKE_SALESFORCE_BASE_URL'),
      call,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: call.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: readJson(text),
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new SalesforceTransportError('timeout');
      }
      throw new SalesforceTransportError('network');
    } finally {
      clearTimeout(timer);
    }
  }
}

function readJson(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
