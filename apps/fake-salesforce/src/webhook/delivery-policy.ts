export const DELIVERY_BACKOFF_BASE_MS = 1000;
export const DELIVERY_BACKOFF_CAP_MS = 60_000;
export const DELIVERY_MAX_ATTEMPTS = 5;
export const WEBHOOK_HTTP_TIMEOUT_MS = 1000;
export const EMPTY_BUCKET_RETRY_AFTER_SECONDS = 1;

export const DELIVERY_PENDING = 'PENDING';
export const DELIVERY_DELIVERING = 'DELIVERING';
export const DELIVERY_DELIVERED = 'DELIVERED';
export const DELIVERY_DROPPED = 'DROPPED';
export const DELIVERY_FAILED = 'FAILED';

export interface PortalWebhookResult {
  status: number;
  retryAfterSeconds: number | null;
}

export interface PortalWebhookTimeout {
  timeout: true;
}

export type WebhookPostResult = PortalWebhookResult | PortalWebhookTimeout;

export interface DeliveryOutcome {
  status: 'DELIVERED' | 'FAILED' | 'PENDING';
  lastHttpStatus: number | null;
  scheduledAtMs: number;
  deliveredAtMs: number | null;
}

export function backoffMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16);
  return Math.min(DELIVERY_BACKOFF_CAP_MS, DELIVERY_BACKOFF_BASE_MS * 2 ** exponent);
}

export function deliveryOutcome(input: {
  attempt: number;
  nowMs: number;
  result: WebhookPostResult;
}): DeliveryOutcome {
  if ('status' in input.result && input.result.status >= 200 && input.result.status < 300) {
    return {
      status: DELIVERY_DELIVERED,
      lastHttpStatus: input.result.status,
      scheduledAtMs: input.nowMs,
      deliveredAtMs: input.nowMs,
    };
  }
  const lastHttpStatus = 'status' in input.result ? input.result.status : null;
  if (input.attempt >= DELIVERY_MAX_ATTEMPTS) {
    return {
      status: DELIVERY_FAILED,
      lastHttpStatus,
      scheduledAtMs: input.nowMs,
      deliveredAtMs: null,
    };
  }
  let wait = backoffMs(input.attempt);
  if ('status' in input.result && input.result.retryAfterSeconds !== null) {
    wait = Math.max(wait, input.result.retryAfterSeconds * 1000);
  }
  return {
    status: DELIVERY_PENDING,
    lastHttpStatus,
    scheduledAtMs: input.nowMs + wait,
    deliveredAtMs: null,
  };
}
