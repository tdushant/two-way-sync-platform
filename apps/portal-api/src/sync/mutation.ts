import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import type { Ids } from './ids';

export type PortalTx = Prisma.TransactionClient;

/** Working assumption for open OD-TIMING. The row stays inside the status enum. */
export const PARENT_WAIT_MS = 60_000;

export const CUSTOMER_CREATE_SCOPE = 'customer.create';
export const CONTACT_CREATE_SCOPE = 'contact.create';

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export function requestHash(body: object): string {
  const record = body as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (Object.hasOwn(record, key)) {
      canonical[key] = record[key];
    }
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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

export function rowVersionNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error('rowVersion exceeds a safe integer');
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

export async function lockCustomer(
  tx: PortalTx,
  id: string,
): Promise<{ salesforceId: string | null } | undefined> {
  const rows = await tx.$queryRaw<Array<{ salesforce_id: string | null }>>`
    SELECT salesforce_id FROM customers WHERE id = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  return row ? { salesforceId: row.salesforce_id } : undefined;
}

export async function shareCustomer(
  tx: PortalTx,
  id: string,
): Promise<{ salesforceId: string | null } | undefined> {
  const rows = await tx.$queryRaw<Array<{ salesforce_id: string | null }>>`
    SELECT salesforce_id FROM customers WHERE id = ${id}::uuid FOR SHARE
  `;
  const row = rows[0];
  return row ? { salesforceId: row.salesforce_id } : undefined;
}

export async function lockContact(tx: PortalTx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM contacts WHERE id = ${id}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export async function commitFieldChanges(
  tx: PortalTx,
  ids: Ids,
  input: {
    entityType: 'customer' | 'contact';
    entityId: string;
    eventType: 'created' | 'updated';
    changes: FieldChange[];
    rowVersion: number;
    salesforceId: string | null;
    actorId: string;
    now: Date;
    hold: 'parent_unmapped' | 'unmapped' | null;
  },
): Promise<void> {
  if (input.changes.length === 0) {
    throw new Error('A logical change requires at least one field difference');
  }
  const operationId = ids.operationId();
  const due = input.hold === null;
  const changedFields: Record<string, string | null> = {};
  const versions: Record<string, string> = {};
  for (const change of input.changes) {
    changedFields[change.field] = change.newValue;
    versions[change.field] = String(input.rowVersion);
  }
  const baseVersions = { rowVersion: input.rowVersion, fields: versions };
  await tx.fieldHistory.createMany({
    data: input.changes.map((change) => ({
      entityType: input.entityType,
      entityId: input.entityId,
      fieldName: change.field,
      oldValue: jsonValue(change.oldValue),
      newValue: jsonValue(change.newValue),
      source: 'PORTAL',
      actorId: input.actorId,
      eventId: null,
      operationId,
      sourceChangedAt: input.now,
      appliedAt: input.now,
      decision: 'APPLIED',
    })),
  });
  for (const change of input.changes) {
    const state = {
      source: 'PORTAL',
      sourceVersion: String(input.rowVersion),
      sourceChangedAt: input.now,
      lastAppliedAt: input.now,
      lastOperationId: operationId,
    };
    await tx.fieldSyncState.upsert({
      where: {
        entityType_entityId_fieldName: {
          entityType: input.entityType,
          entityId: input.entityId,
          fieldName: change.field,
        },
      },
      create: {
        entityType: input.entityType,
        entityId: input.entityId,
        fieldName: change.field,
        ...state,
      },
      update: state,
    });
  }
  await tx.outboxEvent.create({
    data: {
      operationId,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      changedFields: changedFields as Prisma.InputJsonValue,
      baseVersions: baseVersions as Prisma.InputJsonValue,
      status: due ? 'PENDING' : 'RETRY',
      attempts: 0,
      nextAttemptAt: due ? input.now : new Date(input.now.getTime() + PARENT_WAIT_MS),
      leaseUntil: null,
      lastError: input.hold,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  await tx.syncOperation.create({
    data: {
      operationId,
      entityType: input.entityType,
      entityId: input.entityId,
      fields: input.changes.map((change) => change.field) as Prisma.InputJsonValue,
      expectedValues: changedFields as Prisma.InputJsonValue,
      externalId: input.salesforceId,
      status: 'PENDING',
      createdAt: input.now,
      expiresAt: null,
    },
  });
}

function jsonValue(value: string | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}
