import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { signWebhookBody, webhookSignaturesMatch } from './signature';

describe('webhook signature', () => {
  it('compares the lowercase hex HMAC of the raw bytes', () => {
    const raw = Buffer.from('{"eventId":"1"}');
    const digest = signWebhookBody('local-webhook-secret', raw);
    expect(digest).toBe(createHmac('sha256', 'local-webhook-secret').update(raw).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookSignaturesMatch(digest, digest)).toBe(true);
    expect(webhookSignaturesMatch(`${digest.slice(0, 63)}a`, digest)).toBe(false);
    expect(webhookSignaturesMatch(digest.slice(0, 10), digest)).toBe(false);
    expect(webhookSignaturesMatch(undefined, digest)).toBe(false);
    expect(webhookSignaturesMatch(` ${digest}`, digest)).toBe(false);
  });
});
