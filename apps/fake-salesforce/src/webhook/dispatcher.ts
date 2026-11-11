import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { readSimulatorConfig } from '../simulator/simulator-config';
import { Clock } from './clock';
import {
  DELIVERY_DELIVERING,
  DELIVERY_PENDING,
  deliveryOutcome,
  type DeliveryOutcome,
  type WebhookPostResult,
} from './delivery-policy';
import { PortalWebhookClient } from './portal-client';
import { SALESFORCE_SIGNATURE_HEADER, signWebhookPayload, stableWebhookJson } from './signature';

export interface FlushResult {
  attempted: number;
  delivered: number;
}

@Injectable()
export class Dispatcher {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly client: PortalWebhookClient,
    private readonly config: ConfigService,
  ) {}

  flush(): Promise<FlushResult> {
    const run = this.tail.then(() => this.flushOnce());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushOnce(): Promise<FlushResult> {
    await this.prisma.client.sfWebhookDelivery.updateMany({
      where: { status: DELIVERY_DELIVERING },
      data: { status: DELIVERY_PENDING },
    });
    const simulator = await readSimulatorConfig(this.prisma.client);
    if (!simulator.webhookEnabled) {
      return { attempted: 0, delivered: 0 };
    }
    const now = this.clock.now();
    const claimed = await this.prisma.client.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM sf_webhook_deliveries
        WHERE status = 'PENDING' AND scheduled_at <= ${now}
        ORDER BY scheduled_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
      `;
      if (due.length === 0) {
        return [];
      }
      const ids = due.map((row) => row.id);
      await tx.sfWebhookDelivery.updateMany({
        where: { id: { in: ids } },
        data: { status: DELIVERY_DELIVERING, attempts: { increment: 1 } },
      });
      return tx.sfWebhookDelivery.findMany({
        where: { id: { in: ids } },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      });
    });
    let delivered = 0;
    for (const row of claimed) {
      const finished = await this.send(row.id, row.payload, row.attempts);
      if (finished) {
        delivered += 1;
      }
    }
    return { attempted: claimed.length, delivered };
  }

  private async send(id: string, payload: unknown, attempt: number): Promise<boolean> {
    const nowMs = this.clock.now().getTime();
    let raw: string;
    try {
      raw = stableWebhookJson(payload);
    } catch {
      await this.finish(id, {
        status: 'FAILED',
        lastHttpStatus: null,
        scheduledAtMs: nowMs,
        deliveredAtMs: null,
      });
      return false;
    }
    const secret = this.config.getOrThrow<string>('WEBHOOK_HMAC_SECRET');
    const url = this.config.getOrThrow<string>('PORTAL_WEBHOOK_URL');
    let result: WebhookPostResult;
    try {
      result = await this.client.post(url, raw, {
        'content-type': 'application/json',
        [SALESFORCE_SIGNATURE_HEADER]: signWebhookPayload(secret, raw),
      });
    } catch {
      result = { timeout: true };
    }
    const outcome = deliveryOutcome({
      attempt,
      nowMs: this.clock.now().getTime(),
      result,
    });
    await this.finish(id, outcome);
    return outcome.status === 'DELIVERED';
  }

  private async finish(id: string, outcome: DeliveryOutcome): Promise<void> {
    await this.prisma.client.sfWebhookDelivery.update({
      where: { id },
      data: {
        status: outcome.status,
        lastHttpStatus: outcome.lastHttpStatus,
        scheduledAt: new Date(outcome.scheduledAtMs),
        deliveredAt: outcome.deliveredAtMs === null ? null : new Date(outcome.deliveredAtMs),
      },
    });
  }
}
