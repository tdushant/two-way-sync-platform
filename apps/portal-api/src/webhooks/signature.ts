import { createHmac, timingSafeEqual } from 'node:crypto';

export const SALESFORCE_SIGNATURE_HEADER = 'x-salesforce-signature';

export function signWebhookBody(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function webhookSignaturesMatch(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined || supplied.length === 0 || supplied !== supplied.trim()) {
    return false;
  }
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
