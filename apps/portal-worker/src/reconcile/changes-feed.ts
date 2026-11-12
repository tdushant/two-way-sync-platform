import { HTTP_TIMEOUT_MS, parseRetryAfter } from '../outbox/policy';
import { inboundBody } from './canonical';

export interface InboundEvent {
  sequence: number;
  occurredAt: string;
  body: string;
}

export type ChangesPage =
  { ok: true; events: InboundEvent[] } | { ok: false; reason: string; retryAfterSeconds?: number };

export interface ChangesFeed {
  fetch(after: string | null, limit: number): Promise<ChangesPage>;
}

export class HttpChangesFeed implements ChangesFeed {
  constructor(private readonly baseUrl: string) {}

  async fetch(after: string | null, limit: number): Promise<ChangesPage> {
    const url = new URL('/sf/v1/changes', this.baseUrl);
    url.searchParams.set('limit', String(limit));
    if (after !== null) {
      url.searchParams.set('after', after);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      if (!response.ok) {
        return {
          ok: false,
          reason: `http_${response.status}`,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        };
      }
      const text = await response.text();
      const parsed: unknown = text.trim().length === 0 ? [] : JSON.parse(text);
      return readPage(parsed);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { ok: false, reason: 'timeout' };
      }
      if (error instanceof SyntaxError) {
        return { ok: false, reason: 'invalid_page' };
      }
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function readPage(parsed: unknown): ChangesPage {
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_page' };
  }
  const events: InboundEvent[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ok: false, reason: 'invalid_change' };
    }
    const body = inboundBody(row as Record<string, unknown>);
    const sequence = Reflect.get(row, 'changeSequence');
    const occurredAt = Reflect.get(row, 'occurredAt');
    if (
      body === undefined ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      typeof occurredAt !== 'string'
    ) {
      return { ok: false, reason: 'invalid_change' };
    }
    events.push({ sequence, occurredAt, body });
  }
  events.sort((left, right) => left.sequence - right.sequence);
  return { ok: true, events };
}
