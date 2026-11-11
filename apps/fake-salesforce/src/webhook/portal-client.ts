import { Injectable } from '@nestjs/common';
import { WEBHOOK_HTTP_TIMEOUT_MS, type WebhookPostResult } from './delivery-policy';

export abstract class PortalWebhookClient {
  abstract post(
    url: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookPostResult>;
}

@Injectable()
export class FetchPortalWebhookClient extends PortalWebhookClient {
  override async post(
    url: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookPostResult> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(WEBHOOK_HTTP_TIMEOUT_MS),
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
      };
    } catch {
      return { timeout: true };
    }
  }
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  return seconds;
}
