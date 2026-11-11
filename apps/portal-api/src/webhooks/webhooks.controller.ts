import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError, parseWebhook } from '@sync/contracts';
import { PortalRequestError, requestError } from '../http/portal-request.error';
import type { PortalRequest } from '../http/portal-request';
import { SALESFORCE_SIGNATURE_HEADER, signWebhookBody, webhookSignaturesMatch } from './signature';
import { WebhooksService, type InboundResult } from './webhooks.service';

interface RawBodyRequest extends PortalRequest {
  rawBody?: Buffer;
}

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  @Post('salesforce')
  @HttpCode(200)
  receive(@Req() request: RawBodyRequest, @Body() body: unknown): Promise<InboundResult> {
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      throw requestError(request.correlationId, 400, 'Raw request body is required');
    }
    const secret = this.config.getOrThrow<string>('WEBHOOK_HMAC_SECRET');
    const supplied = request.header(SALESFORCE_SIGNATURE_HEADER);
    if (!webhookSignaturesMatch(supplied, signWebhookBody(secret, rawBody))) {
      throw new PortalRequestError(
        apiError(request.correlationId, 401, 'invalid_signature', 'Invalid signature'),
      );
    }
    const parsed = parseWebhook(body, request.correlationId);
    if (!parsed.ok) {
      throw new PortalRequestError(parsed.error);
    }
    return this.webhooks.receive(rawBody, parsed.value, request.correlationId);
  }
}
