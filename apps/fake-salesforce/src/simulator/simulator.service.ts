import { Injectable } from '@nestjs/common';
import {
  isUuid,
  parseReorderDeliveries,
  parseSimulatorConfig,
  type SimulatorConfig,
} from '@sync/contracts';
import { Prisma } from '../../generated/prisma/client';
import { requestError } from '../http/salesforce-request.error';
import { unwrap } from '../http/unwrap';
import { PrismaService } from '../prisma/prisma.service';
import { Ids } from '../records/ids';
import {
  appendChange,
  lockAccount,
  lockContact,
  shareAccount,
  versionNumber,
  type FieldChange,
  type SalesforceTx,
} from '../records/writes';
import { Clock } from '../webhook/clock';
import { DELIVERY_PENDING } from '../webhook/delivery-policy';
import { TokenBucket } from '../webhook/token-bucket';
import { DEFAULT_SIMULATOR_CONFIG } from './defaults';
import { parseEmitEvent, type EmitEvent } from './emit-event';
import { readSimulatorConfig } from './simulator-config';

export interface EmittedEvent {
  eventId: string;
  changeSequence: number;
  recordVersion: number;
}

@Injectable()
export class SimulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly bucket: TokenBucket,
  ) {}

  async replaceConfig(body: unknown, correlationId: string): Promise<SimulatorConfig> {
    const config = unwrap(parseSimulatorConfig(body, correlationId));
    await this.writeConfig(config);
    return config;
  }

  async reset(): Promise<{ reset: true }> {
    await this.prisma.client.$transaction([
      this.prisma.client.sfContact.deleteMany(),
      this.prisma.client.sfWebhookDelivery.deleteMany(),
      this.prisma.client.sfChangeLog.deleteMany(),
      this.prisma.client.sfIdempotencyKey.deleteMany(),
      this.prisma.client.sfApiRequestLog.deleteMany(),
      this.prisma.client.sfAccount.deleteMany(),
    ]);
    await this.writeConfig(DEFAULT_SIMULATOR_CONFIG);
    return { reset: true };
  }

  async emit(body: unknown, correlationId: string): Promise<EmittedEvent> {
    const event = parseEmitEvent(body, correlationId);
    const occurredAt = new Date(event.occurredAt);
    return this.prisma.client.$transaction(async (tx) => {
      if (event.objectType === 'Account') {
        return this.emitAccount(tx, event, occurredAt, correlationId);
      }
      return this.emitContact(tx, event, occurredAt, correlationId);
    });
  }

  async replay(
    eventId: string,
    correlationId: string,
  ): Promise<{ eventId: string; deliveryId: string }> {
    if (!isUuid(eventId)) {
      throw requestError(correlationId, 400, 'eventId must be a UUID');
    }
    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.sfWebhookDelivery.findFirst({
        where: { eventId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!existing) {
        throw requestError(correlationId, 404, 'Webhook delivery not found');
      }
      const config = await readSimulatorConfig(tx);
      const now = this.clock.now();
      const created = await tx.sfWebhookDelivery.create({
        data: {
          changeSequence: existing.changeSequence,
          eventId: existing.eventId,
          payload: existing.payload as Prisma.InputJsonValue,
          attempts: 0,
          scheduledAt: new Date(now.getTime() + config.delayMs),
          status: DELIVERY_PENDING,
          createdAt: now,
        },
      });
      return { eventId: created.eventId, deliveryId: created.id };
    });
  }

  async reorder(body: unknown, correlationId: string): Promise<{ eventIds: string[] }> {
    const { eventIds } = unwrap(parseReorderDeliveries(body, correlationId));
    const now = this.clock.now().getTime();
    const start = now - eventIds.length;
    await this.prisma.client.$transaction(async (tx) => {
      for (let index = 0; index < eventIds.length; index += 1) {
        const eventId = eventIds[index];
        if (eventId === undefined) {
          throw requestError(correlationId, 400, 'eventIds must contain non-empty strings');
        }
        const updated = await tx.sfWebhookDelivery.updateMany({
          where: { eventId, status: DELIVERY_PENDING },
          data: { scheduledAt: new Date(start + index) },
        });
        if (updated.count === 0) {
          throw requestError(correlationId, 404, 'Pending webhook delivery not found');
        }
      }
    });
    return { eventIds };
  }

  async deliveries(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.client.sfWebhookDelivery.findMany({
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      changeSequence: versionNumber(row.changeSequence),
      eventId: row.eventId,
      payload: row.payload,
      attempts: row.attempts,
      scheduledAt: row.scheduledAt.toISOString(),
      status: row.status,
      lastHttpStatus: row.lastHttpStatus,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async requests(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.client.sfApiRequestLog.findMany({
      orderBy: [{ requestAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      method: row.method,
      path: row.path,
      operationId: row.operationId,
      statusCode: row.statusCode,
      requestAt: row.requestAt.toISOString(),
      latencyMs: row.latencyMs,
    }));
  }

  private async emitAccount(
    tx: SalesforceTx,
    event: EmitEvent,
    occurredAt: Date,
    correlationId: string,
  ): Promise<EmittedEvent> {
    if (!(await lockAccount(tx, event.recordId))) {
      throw requestError(correlationId, 404, 'Account not found');
    }
    const row = await tx.sfAccount.findUniqueOrThrow({ where: { id: event.recordId } });
    const next = this.nextVersion(row.version, event, correlationId);
    const fields = event.changedFields;
    await tx.sfAccount.update({
      where: { id: event.recordId },
      data: {
        version: BigInt(next),
        systemModstamp: occurredAt,
        ...(Object.hasOwn(fields, 'name')
          ? { name: requiredText(fields.name, 'name', correlationId) }
          : {}),
        ...(Object.hasOwn(fields, 'status') ? { status: fields.status } : {}),
        ...(Object.hasOwn(fields, 'ownerId') ? { ownerId: fields.ownerId } : {}),
      },
    });
    const appended = await appendChange(tx, this.ids, {
      objectType: 'Account',
      recordId: event.recordId,
      changes: asChanges({ name: row.name, status: row.status, ownerId: row.ownerId }, fields),
      version: next,
      changedBy: event.changedBy,
      originOperationId: event.originOperationId,
      now: occurredAt,
      enqueuedAt: this.clock.now(),
    });
    return {
      eventId: appended.eventId,
      changeSequence: versionNumber(appended.sequence),
      recordVersion: next,
    };
  }

  private async emitContact(
    tx: SalesforceTx,
    event: EmitEvent,
    occurredAt: Date,
    correlationId: string,
  ): Promise<EmittedEvent> {
    if (!(await lockContact(tx, event.recordId))) {
      throw requestError(correlationId, 404, 'Contact not found');
    }
    const row = await tx.sfContact.findUniqueOrThrow({ where: { id: event.recordId } });
    const nextAccountId = event.changedFields.accountId;
    if (typeof nextAccountId === 'string' && !(await shareAccount(tx, nextAccountId))) {
      throw requestError(correlationId, 404, 'Account not found');
    }
    const next = this.nextVersion(row.version, event, correlationId);
    const fields = event.changedFields;
    await tx.sfContact.update({
      where: { id: event.recordId },
      data: {
        version: BigInt(next),
        systemModstamp: occurredAt,
        ...(Object.hasOwn(fields, 'accountId')
          ? { accountId: requiredText(fields.accountId, 'accountId', correlationId) }
          : {}),
        ...(Object.hasOwn(fields, 'fullName') ? { fullName: fields.fullName } : {}),
        ...(Object.hasOwn(fields, 'email') ? { email: fields.email } : {}),
        ...(Object.hasOwn(fields, 'phone') ? { phone: fields.phone } : {}),
        ...(Object.hasOwn(fields, 'city') ? { city: fields.city } : {}),
        ...(Object.hasOwn(fields, 'ownerId') ? { ownerId: fields.ownerId } : {}),
      },
    });
    const appended = await appendChange(tx, this.ids, {
      objectType: 'Contact',
      recordId: event.recordId,
      changes: asChanges(
        {
          accountId: row.accountId,
          fullName: row.fullName,
          email: row.email,
          phone: row.phone,
          city: row.city,
          ownerId: row.ownerId,
        },
        fields,
      ),
      version: next,
      changedBy: event.changedBy,
      originOperationId: event.originOperationId,
      now: occurredAt,
      enqueuedAt: this.clock.now(),
    });
    return {
      eventId: appended.eventId,
      changeSequence: versionNumber(appended.sequence),
      recordVersion: next,
    };
  }

  private nextVersion(current: bigint, event: EmitEvent, correlationId: string): number {
    const next = versionNumber(current) + 1;
    if (event.recordVersion !== undefined && event.recordVersion !== next) {
      throw requestError(correlationId, 409, 'recordVersion must be the next stored version');
    }
    return next;
  }

  private async writeConfig(config: SimulatorConfig): Promise<void> {
    await this.prisma.client.sfSimulatorConfig.upsert({
      where: { id: 1 },
      create: { id: 1, ...config },
      update: config,
    });
    this.bucket.reset();
  }
}

function asChanges(
  current: Record<string, string | null>,
  fields: Record<string, string | null>,
): FieldChange[] {
  return Object.keys(fields).map((field) => ({
    field,
    oldValue: current[field] ?? null,
    newValue: fields[field] ?? null,
  }));
}

function requiredText(
  value: string | null | undefined,
  field: string,
  correlationId: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError(correlationId, 400, `${field} cannot be cleared`);
  }
  return value;
}
