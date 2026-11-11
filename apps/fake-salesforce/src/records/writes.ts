import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { requestError } from '../http/salesforce-request.error';
import { readSimulatorConfig } from '../simulator/simulator-config';
import { DELIVERY_DROPPED, DELIVERY_PENDING } from '../webhook/delivery-policy';
import type { Ids } from './ids';

export type SalesforceTx = Prisma.TransactionClient;

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface AccountView {
  id: string;
  name: string | null;
  status: string | null;
  ownerId: string | null;
  version: number;
  systemModstamp: string;
}

export interface ContactView {
  id: string;
  accountId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  ownerId: string | null;
  version: number;
  systemModstamp: string;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function requestHash(method: string, path: string, body: object): string {
  const record = body as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (Object.hasOwn(record, key)) {
      canonical[key] = record[key];
    }
  }
  return createHash('sha256')
    .update(JSON.stringify({ method, path, body: canonical }))
    .digest('hex');
}

export function fieldChanges(current: Record<string, string | null>, patch: object): FieldChange[] {
  const record = patch as Record<string, string | null | undefined>;
  const changes: FieldChange[] = [];
  for (const field of Object.keys(record)) {
    if (!Object.hasOwn(record, field)) {
      continue;
    }
    const newValue = record[field];
    if (newValue === undefined) {
      continue;
    }
    const oldValue = current[field] ?? null;
    if (oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}

export function versionNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error('version exceeds a safe integer');
  }
  return number;
}

export function isPrismaError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function lockAccount(tx: SalesforceTx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sf_accounts WHERE id = ${id} FOR UPDATE
  `;
  return rows.length > 0;
}

export async function shareAccount(tx: SalesforceTx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sf_accounts WHERE id = ${id} FOR SHARE
  `;
  return rows.length > 0;
}

export async function lockContact(tx: SalesforceTx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sf_contacts WHERE id = ${id} FOR UPDATE
  `;
  return rows.length > 0;
}

export async function appendChange(
  tx: SalesforceTx,
  ids: Ids,
  input: {
    objectType: 'Account' | 'Contact';
    recordId: string;
    changes: FieldChange[];
    version: number;
    changedBy: string | null;
    originOperationId: string | null;
    now: Date;
    enqueuedAt: Date;
  },
): Promise<{ eventId: string; sequence: bigint }> {
  if (input.changes.length === 0) {
    throw new Error('A change-log row requires an actual field difference');
  }
  const changedFields: Record<string, string | null> = {};
  for (const change of [...input.changes].sort((left, right) =>
    left.field.localeCompare(right.field),
  )) {
    changedFields[change.field] = change.newValue;
  }
  const stored = changedFields as Prisma.InputJsonValue;
  const eventId = ids.eventId();
  const created = await tx.sfChangeLog.create({
    data: {
      eventId,
      objectType: input.objectType,
      recordId: input.recordId,
      changedFields: stored,
      changedBy: input.changedBy,
      values: stored,
      version: BigInt(input.version),
      occurredAt: input.now,
      originOperationId: input.originOperationId,
    },
    select: { sequence: true },
  });
  await enqueueDelivery(tx, {
    eventId,
    sequence: created.sequence,
    enqueuedAt: input.enqueuedAt,
    envelope: {
      eventId,
      objectType: input.objectType,
      recordId: input.recordId,
      eventType: input.version === 1 ? 'created' : 'updated',
      changedFields,
      changedBy: input.changedBy,
      recordVersion: input.version,
      occurredAt: input.now.toISOString(),
      originOperationId: input.originOperationId,
      changeSequence: versionNumber(created.sequence),
    },
  });
  return { eventId, sequence: created.sequence };
}

async function enqueueDelivery(
  tx: SalesforceTx,
  input: {
    eventId: string;
    sequence: bigint;
    enqueuedAt: Date;
    envelope: Record<string, unknown>;
  },
): Promise<void> {
  const config = await readSimulatorConfig(tx);
  const copies = 1 + Math.max(0, config.duplicateCount);
  const scheduledAt = new Date(input.enqueuedAt.getTime() + config.delayMs);
  const payload = input.envelope as Prisma.InputJsonValue;
  await tx.sfWebhookDelivery.createMany({
    data: Array.from({ length: copies }, () => ({
      changeSequence: input.sequence,
      eventId: input.eventId,
      payload,
      attempts: 0,
      scheduledAt,
      status: config.dropWebhookRate >= 1 ? DELIVERY_DROPPED : DELIVERY_PENDING,
      createdAt: input.enqueuedAt,
    })),
  });
}

export async function readReplay(
  tx: SalesforceTx,
  operationId: string,
  hash: string,
  correlationId: string,
): Promise<StoredResponse | undefined> {
  const existing = await tx.sfIdempotencyKey.findUnique({ where: { operationId } });
  if (!existing) {
    return undefined;
  }
  if (existing.requestHash !== hash) {
    throw requestError(
      correlationId,
      409,
      'Idempotency-Key was already used with a different request',
    );
  }
  return { status: existing.statusCode, body: existing.responseBody };
}

export async function saveReplay(
  tx: SalesforceTx,
  operationId: string,
  hash: string,
  status: number,
  body: AccountView | ContactView,
  recordId: string,
  now: Date,
): Promise<void> {
  await tx.sfIdempotencyKey.create({
    data: {
      operationId,
      requestHash: hash,
      statusCode: status,
      responseBody: body as unknown as Prisma.InputJsonValue,
      recordId,
      createdAt: now,
    },
  });
}

export function toAccount(row: {
  id: string;
  name: string | null;
  status: string | null;
  ownerId: string | null;
  version: bigint;
  systemModstamp: Date;
}): AccountView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ownerId: row.ownerId,
    version: versionNumber(row.version),
    systemModstamp: row.systemModstamp.toISOString(),
  };
}

export function toContact(row: {
  id: string;
  accountId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  ownerId: string | null;
  version: bigint;
  systemModstamp: Date;
}): ContactView {
  return {
    id: row.id,
    accountId: row.accountId,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    city: row.city,
    ownerId: row.ownerId,
    version: versionNumber(row.version),
    systemModstamp: row.systemModstamp.toISOString(),
  };
}
