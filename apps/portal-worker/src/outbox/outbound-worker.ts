import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { Clock } from '../clock';
import type { PrismaService } from '../prisma/prisma.service';
import {
  SalesforceTransportError,
  type SalesforceClient,
  type SalesforceResult,
} from '../salesforce/salesforce-client';
import {
  BACKOFF_BASE_MS,
  LEASE_MS,
  PARENT_WAIT_MS,
  POLL_MS,
  QUOTA_BUCKET,
  QUOTA_WAIT_MS,
  backoffMs,
  baseFieldVersions,
  classifyStatus,
  fieldMap,
  readExternalId,
  retryDelayMs,
  selectOutboundFields,
  wireBody,
  type FieldMap,
} from './policy';

export type Jitter = () => number;

interface Claimed {
  id: string;
  operationId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  changedFields: unknown;
  baseVersions: unknown;
  attempts: number;
}

interface EntityState {
  salesforceId: string | null;
  values: FieldMap;
}

type Prepared =
  | { action: 'wait'; reason: string; delayMs: number }
  | { action: 'skip' }
  | { action: 'dead'; reason: string }
  | {
      action: 'send';
      method: 'POST' | 'PATCH';
      path: string;
      body: FieldMap;
      salesforceId: string | null;
    };

class ExternalIdConflict extends Error {
  constructor() {
    super('external_id_conflict');
    this.name = 'ExternalIdConflict';
  }
}

export class OutboundWorker {
  batchSize = 10;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly logger = new Logger(OutboundWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly salesforce: SalesforceClient,
    private readonly jitter: Jitter,
    private readonly scopePrefix: string | null,
  ) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      void this.flush().catch(() => {
        this.logger.error({ message: 'outbound flush failed' });
      });
    }, POLL_MS);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async flush(): Promise<void> {
    const run = this.tail.then(() => this.flushOnce());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async claimDue(): Promise<Claimed[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH due AS (
          SELECT id
          FROM outbox_events
          WHERE (
            (status IN ('PENDING', 'RETRY') AND next_attempt_at <= ${now})
            OR (status = 'IN_FLIGHT' AND lease_until IS NOT NULL AND lease_until <= ${now})
          )
          ${this.scopeSql()}
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.batchSize}
        )
        UPDATE outbox_events AS outbox
        SET status = 'IN_FLIGHT',
            lease_until = ${leaseUntil},
            attempts = outbox.attempts + 1,
            updated_at = ${now}
        FROM due
        WHERE outbox.id = due.id
        RETURNING outbox.id
      `);
      if (claimed.length === 0) {
        return [];
      }
      const rows = await tx.outboxEvent.findMany({
        where: { id: { in: claimed.map((row) => row.id) } },
      });
      return rows
        .slice()
        .sort(
          (left, right) =>
            left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .map((row) => ({
          id: row.id,
          operationId: row.operationId,
          entityType: row.entityType,
          entityId: row.entityId,
          eventType: row.eventType,
          changedFields: row.changedFields,
          baseVersions: row.baseVersions,
          attempts: row.attempts,
        }));
    });
  }

  private async flushOnce(): Promise<void> {
    const rows = await this.claimDue();
    for (const row of rows) {
      await this.deliver(row);
    }
  }

  private async deliver(row: Claimed): Promise<void> {
    const now = this.clock.now();
    try {
      const prepared = await this.prepare(row);
      if (prepared.action === 'wait') {
        await this.reschedule(row, prepared.reason, prepared.delayMs, now);
        return;
      }
      if (prepared.action === 'skip') {
        await this.finishSkipped(row, now);
        return;
      }
      if (prepared.action === 'dead') {
        await this.kill(row, prepared.reason, now);
        return;
      }
      const allowed = await this.takeToken(now);
      if (!allowed) {
        await this.reschedule(row, 'quota', QUOTA_WAIT_MS, now);
        return;
      }
      const result = await this.salesforce.send({
        method: prepared.method,
        path: prepared.path,
        body: prepared.body,
        operationId: row.operationId,
        correlationId: randomUUID(),
      });
      await this.finishRemote(row, prepared.salesforceId, result, now);
    } catch (error) {
      if (error instanceof SalesforceTransportError) {
        await this.reschedule(row, error.reason, backoffMs(row.attempts, this.jitter()), now);
        return;
      }
      if (error instanceof ExternalIdConflict) {
        await this.kill(row, 'external_id_conflict', now);
        return;
      }
      throw error;
    }
  }

  private async prepare(row: Claimed): Promise<Prepared> {
    const changed = fieldMap(row.changedFields);
    const entity = await this.loadEntity(row);
    if (!entity) {
      return { action: 'dead', reason: 'missing_entity' };
    }
    if (row.eventType !== 'created' && entity.salesforceId === null) {
      return { action: 'wait', reason: 'unmapped', delayMs: PARENT_WAIT_MS };
    }
    const selected = selectOutboundFields({
      eventType: row.eventType,
      changedFields: changed,
      baseFields: baseFieldVersions(row.baseVersions),
      current: entity.values,
      sync: await this.syncVersions(row),
    });
    if (Object.keys(selected.send).length === 0) {
      return { action: 'skip' };
    }
    const parentSalesforceId = await this.parentSalesforceId(row.entityType, selected.send);
    const wired = wireBody(row.entityType, selected.send, parentSalesforceId);
    if (wired.pendingParent || Object.keys(wired.body).length === 0) {
      return { action: 'wait', reason: 'parent_unmapped', delayMs: PARENT_WAIT_MS };
    }
    const target = route(row.entityType, row.eventType, entity.salesforceId);
    if (!target) {
      return { action: 'wait', reason: 'unmapped', delayMs: PARENT_WAIT_MS };
    }
    return { action: 'send', ...target, body: wired.body, salesforceId: entity.salesforceId };
  }

  private async finishRemote(
    row: Claimed,
    currentSalesforceId: string | null,
    result: SalesforceResult,
    now: Date,
  ): Promise<void> {
    const kind = classifyStatus(result.status);
    if (kind === 'retry') {
      const delay =
        result.status === 429
          ? retryDelayMs(row.attempts, this.jitter(), result.retryAfterSeconds)
          : backoffMs(row.attempts, this.jitter());
      await this.reschedule(row, `http_${result.status}`, delay, now);
      return;
    }
    if (kind === 'dead') {
      await this.kill(row, `http_${result.status}`, now);
      return;
    }
    const externalId =
      row.eventType === 'created' ? readExternalId(result.body) : currentSalesforceId;
    if (row.eventType === 'created' && externalId === undefined) {
      await this.reschedule(
        row,
        'missing_external_id',
        backoffMs(row.attempts, this.jitter()),
        now,
      );
      return;
    }
    await this.finishSent(row, externalId ?? null, now);
  }

  private async finishSent(row: Claimed, externalId: string | null, now: Date): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      if (row.eventType === 'created' && externalId !== null) {
        await this.storeExternalId(tx, row, externalId);
      }
      const operation = await tx.syncOperation.updateMany({
        where: { operationId: row.operationId },
        data: {
          status: 'SENT',
          ...(externalId !== null ? { externalId } : {}),
        },
      });
      if (operation.count !== 1) {
        throw new Error('sync operation missing');
      }
      await tx.outboxEvent.update({
        where: { id: row.id },
        data: { status: 'COMPLETED', leaseUntil: null, lastError: null, updatedAt: now },
      });
    });
  }

  private async storeExternalId(
    tx: Prisma.TransactionClient,
    row: Claimed,
    externalId: string,
  ): Promise<void> {
    if (row.entityType === 'customer') {
      const current = await tx.customer.findUnique({ where: { id: row.entityId } });
      if (!current) {
        throw new Error('missing customer');
      }
      if (current.salesforceId === null) {
        await tx.customer.update({
          where: { id: current.id },
          data: { salesforceId: externalId },
        });
        return;
      }
      if (current.salesforceId !== externalId) {
        throw new ExternalIdConflict();
      }
      return;
    }
    const current = await tx.contact.findUnique({ where: { id: row.entityId } });
    if (!current) {
      throw new Error('missing contact');
    }
    if (current.salesforceId === null) {
      await tx.contact.update({
        where: { id: current.id },
        data: { salesforceId: externalId },
      });
      return;
    }
    if (current.salesforceId !== externalId) {
      throw new ExternalIdConflict();
    }
  }

  private async finishSkipped(row: Claimed, now: Date): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETED',
          leaseUntil: null,
          lastError: 'superseded',
          updatedAt: now,
        },
      });
      await tx.syncOperation.updateMany({
        where: { operationId: row.operationId },
        data: { status: 'FAILED' },
      });
    });
  }

  private async reschedule(
    row: Claimed,
    reason: string,
    delayMs: number,
    now: Date,
  ): Promise<void> {
    await this.prisma.client.outboxEvent.update({
      where: { id: row.id },
      data: {
        status: 'RETRY',
        nextAttemptAt: new Date(now.getTime() + delayMs),
        leaseUntil: null,
        lastError: reason,
        updatedAt: now,
      },
    });
    this.logger.log({ operationId: row.operationId, outcome: reason });
  }

  private async kill(row: Claimed, reason: string, now: Date): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: row.id },
        data: { status: 'DEAD', leaseUntil: null, lastError: reason, updatedAt: now },
      });
      await tx.syncOperation.updateMany({
        where: { operationId: row.operationId },
        data: { status: 'FAILED' },
      });
    });
    this.logger.log({ operationId: row.operationId, outcome: reason });
  }

  private async takeToken(now: Date): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          tokens: bigint;
          max_tokens: bigint;
          refill_per_second_milli: bigint;
          updated_at: Date;
        }>
      >`
        SELECT tokens, max_tokens, refill_per_second_milli, updated_at
        FROM api_quota_buckets
        WHERE bucket = ${QUOTA_BUCKET}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('external_api quota bucket is missing');
      }
      const elapsed = BigInt(Math.max(0, now.getTime() - row.updated_at.getTime()));
      const refilled = (elapsed * row.refill_per_second_milli) / 1_000_000n;
      let tokens = row.tokens + refilled;
      if (tokens > row.max_tokens) {
        tokens = row.max_tokens;
      }
      if (tokens < 1n) {
        if (refilled > 0n) {
          await tx.$executeRaw`
            UPDATE api_quota_buckets
            SET tokens = ${tokens}, updated_at = ${now}
            WHERE bucket = ${QUOTA_BUCKET}
          `;
        }
        return false;
      }
      tokens -= 1n;
      await tx.$executeRaw`
        UPDATE api_quota_buckets
        SET tokens = ${tokens}, updated_at = ${now}
        WHERE bucket = ${QUOTA_BUCKET}
      `;
      return true;
    });
  }

  private async loadEntity(row: Claimed): Promise<EntityState | undefined> {
    if (row.entityType === 'customer') {
      const found = await this.prisma.client.customer.findUnique({ where: { id: row.entityId } });
      if (!found) {
        return undefined;
      }
      return {
        salesforceId: found.salesforceId,
        values: { name: found.name, status: found.status, ownerId: found.ownerId },
      };
    }
    if (row.entityType !== 'contact') {
      return undefined;
    }
    const found = await this.prisma.client.contact.findUnique({ where: { id: row.entityId } });
    if (!found) {
      return undefined;
    }
    return {
      salesforceId: found.salesforceId,
      values: {
        customerId: found.customerId,
        fullName: found.fullName,
        email: found.email,
        phone: found.phone,
        city: found.city,
        ownerId: found.ownerId,
      },
    };
  }

  private async parentSalesforceId(entityType: string, fields: FieldMap): Promise<string | null> {
    if (entityType !== 'contact' || !Object.hasOwn(fields, 'customerId')) {
      return null;
    }
    const parentId = fields.customerId;
    if (parentId === null) {
      return null;
    }
    const parent = await this.prisma.client.customer.findUnique({
      where: { id: parentId },
      select: { salesforceId: true },
    });
    return parent?.salesforceId ?? null;
  }

  private async syncVersions(
    row: Claimed,
  ): Promise<Array<{ fieldName: string; source: string; sourceVersion: string }>> {
    const rows = await this.prisma.client.fieldSyncState.findMany({
      where: { entityType: row.entityType, entityId: row.entityId },
    });
    return rows.map((item) => ({
      fieldName: item.fieldName,
      source: item.source,
      sourceVersion: item.sourceVersion,
    }));
  }

  private scopeSql(): Prisma.Sql {
    if (this.scopePrefix === null) {
      return Prisma.empty;
    }
    const prefix = this.scopePrefix;
    return Prisma.sql`
      AND (
        entity_id IN (
          SELECT id FROM customers WHERE left(name, char_length(${prefix})) = ${prefix}
        )
        OR entity_id IN (
          SELECT id FROM contacts
          WHERE left(coalesce(full_name, ''), char_length(${prefix})) = ${prefix}
        )
      )
    `;
  }
}

function route(
  entityType: string,
  eventType: string,
  salesforceId: string | null,
): { method: 'POST' | 'PATCH'; path: string } | undefined {
  if (entityType === 'customer' && eventType === 'created') {
    return { method: 'POST', path: '/sf/v1/accounts' };
  }
  if (entityType === 'contact' && eventType === 'created') {
    return { method: 'POST', path: '/sf/v1/contacts' };
  }
  if (salesforceId === null) {
    return undefined;
  }
  const encoded = encodeURIComponent(salesforceId);
  if (entityType === 'customer') {
    return { method: 'PATCH', path: `/sf/v1/accounts/${encoded}` };
  }
  if (entityType === 'contact') {
    return { method: 'PATCH', path: `/sf/v1/contacts/${encoded}` };
  }
  return undefined;
}

export const outboundTiming = {
  leaseMs: LEASE_MS,
  parentWaitMs: PARENT_WAIT_MS,
  quotaWaitMs: QUOTA_WAIT_MS,
  backoffBaseMs: BACKOFF_BASE_MS,
};
