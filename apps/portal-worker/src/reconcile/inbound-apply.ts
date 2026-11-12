import { createHmac } from 'node:crypto';
import { HTTP_TIMEOUT_MS } from '../outbox/policy';

export const SALESFORCE_SIGNATURE_HEADER = 'x-salesforce-signature';

export type ApplyResult = { ok: true } | { ok: false; reason: string };

export interface InboundApply {
  apply(body: string): Promise<ApplyResult>;
}

/** Posts the canonical event bytes to the portal webhook handler. */
export class HttpInboundApply implements InboundApply {
  constructor(
    private readonly webhookUrl: string,
    private readonly secret: string,
  ) {}

  async apply(body: string): Promise<ApplyResult> {
    const raw = Buffer.from(body, 'utf8');
    const signature = createHmac('sha256', this.secret).update(raw).digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SALESFORCE_SIGNATURE_HEADER]: signature,
        },
        body: raw,
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      return { ok: false, reason: `http_${response.status}` };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { ok: false, reason: 'timeout' };
      }
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}
