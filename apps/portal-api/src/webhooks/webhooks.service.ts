import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { apiError, type CanonicalWebhook } from '@sync/contracts';
import { Prisma } from '../../generated/prisma/client';
import { PortalRequestError, requestError } from '../http/portal-request.error';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaError, lockContact, lockCustomer, shareCustomer } from '../sync/mutation';
import { WebhookCounters } from '../sync/webhook-counters';
import { decideInboundField, type FieldVerdict } from './decide';

const DEFERRABLE = 'External mapping is not available';
const PARENT_DEFERRED = 'Parent mapping is not available';

class DuplicateEventError extends Error {
  constructor() {
    super('processed event already exists');
    this.name = 'DuplicateEventError';
  }
}

interface PortalField {
  field: string;
  candidate: string | null;
}

interface LockedEntity {
  id: string;
  salesforceId: string | null;
  rowVersion: bigint;
  values: Record<string, string | null>;
}

export interface InboundResult {
  eventId: string;
  outcome: 'applied' | 'ignored' | 'duplicate';
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: WebhookCounters,
  ) {}

  async receive(
    rawBody: Buffer,
    event: CanonicalWebhook,
    correlationId: string,
  ): Promise<InboundResult> {
    const recordVersion = event.recordVersion;
    if (recordVersion === undefined) {
      throw requestError(correlationId, 400, 'recordVersion is required');
    }
    if (event.changedFields.name === null || event.changedFields.accountId === null) {
      throw requestError(correlationId, 400, 'name and accountId cannot be cleared');
    }
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const now = new Date();
    const inbound = await this.withSourceSnapshot(event);
    try {
      const result = await this.prisma.client.$transaction((tx) =>
        this.apply(tx, inbound, recordVersion, payloadHash, now, correlationId),
      );
      this.logger.log({
        correlationId,
        eventId: result.eventId,
        message: `webhook ${result.outcome}`,
      });
      return result;
    } catch (error) {
      if (error instanceof DuplicateEventError) {
        return this.acknowledgeDuplicate(event.eventId, payloadHash, correlationId);
      }
      throw error;
    }
  }

  private async apply(
    tx: Prisma.TransactionClient,
    event: CanonicalWebhook,
    recordVersion: number,
    payloadHash: string,
    now: Date,
    correlationId: string,
  ): Promise<InboundResult> {
    const entityType = event.objectType === 'Account' ? 'customer' : 'contact';
    const occurredAt = new Date(event.occurredAt);
    try {
      await tx.processedEvent.create({
        data: {
          eventId: event.eventId,
          payloadHash,
          entityType,
          externalId: event.recordId,
          status: 'PROCESSING',
          receivedAt: now,
        },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new DuplicateEventError();
      }
      throw error;
    }
    const portalFields = await this.portalFields(tx, event, correlationId);
    const operation = await this.operation(tx, event.originOperationId);
    const echoCandidate =
      operation !== undefined &&
      this.echoMatches(operation, entityType, event.recordId, portalFields);
    let echo = false;
    let locked: LockedEntity | undefined;
    if (echoCandidate && operation) {
      const mapped = await this.lockEntity(tx, entityType, operation.entityId);
      if (mapped && (mapped.salesforceId === null || mapped.salesforceId === event.recordId)) {
        locked = mapped;
        echo = true;
      }
    }
    if (!locked) {
      locked = await this.lockExternal(
        tx,
        entityType,
        event.recordId,
        portalFields,
        now,
        correlationId,
      );
    }
    const verdicts = new Map<string, FieldVerdict>();
    for (const field of portalFields) {
      const state = await tx.fieldSyncState.findUnique({
        where: {
          entityType_entityId_fieldName: {
            entityType,
            entityId: locked.id,
            fieldName: field.field,
          },
        },
      });
      verdicts.set(
        field.field,
        decideInboundField({
          current: locked.values[field.field] ?? null,
          candidate: field.candidate,
          occurredAt,
          recordVersion,
          state,
        }),
      );
    }
    const applied = portalFields.filter(
      (field) => verdicts.get(field.field)?.persistValue === true,
    );
    const versioned = portalFields.filter(
      (field) => verdicts.get(field.field)?.persistVersion === true,
    );
    if (applied.length > 0 || (echo && locked.salesforceId === null)) {
      await this.persistEntity(tx, entityType, locked, applied, event.recordId, echo, now);
    }
    if (portalFields.length > 0) {
      await tx.fieldHistory.createMany({
        data: portalFields.map((field) => ({
          entityType,
          entityId: locked.id,
          fieldName: field.field,
          oldValue: jsonValue(locked.values[field.field] ?? null),
          newValue: jsonValue(field.candidate),
          source: 'SALESFORCE',
          actorId: null,
          eventId: event.eventId,
          operationId: event.originOperationId ?? null,
          sourceChangedAt: occurredAt,
          appliedAt: now,
          decision: verdicts.get(field.field)?.decision ?? 'NOOP',
        })),
      });
    }
    for (const field of versioned) {
      const metadata = {
        source: 'SALESFORCE',
        sourceVersion: String(recordVersion),
        sourceChangedAt: occurredAt,
        lastAppliedAt: now,
        lastOperationId: event.originOperationId ?? null,
      };
      await tx.fieldSyncState.upsert({
        where: {
          entityType_entityId_fieldName: {
            entityType,
            entityId: locked.id,
            fieldName: field.field,
          },
        },
        create: {
          entityType,
          entityId: locked.id,
          fieldName: field.field,
          ...metadata,
        },
        update: metadata,
      });
    }
    if (echo && operation) {
      await tx.syncOperation.update({
        where: { operationId: operation.operationId },
        data: { status: 'ACKED', externalId: event.recordId },
      });
    }
    const outcome = applied.length > 0 ? 'applied' : 'ignored';
    await tx.processedEvent.update({
      where: { eventId: event.eventId },
      data: {
        status: outcome === 'applied' ? 'APPLIED' : 'IGNORED',
        entityType,
        externalId: event.recordId,
        processedAt: now,
      },
    });
    return { eventId: event.eventId, outcome };
  }

  private async acknowledgeDuplicate(
    eventId: string,
    payloadHash: string,
    correlationId: string,
  ): Promise<InboundResult> {
    const existing = await this.prisma.client.processedEvent.findUnique({ where: { eventId } });
    if (!existing) {
      throw new Error('Duplicate event row was not visible');
    }
    if (existing.payloadHash !== payloadHash) {
      throw new PortalRequestError(
        apiError(
          correlationId,
          409,
          'integrity_error',
          'eventId was already stored with a different payload',
        ),
      );
    }
    this.counters.duplicates += 1;
    this.logger.log({ correlationId, eventId, message: 'webhook duplicate' });
    return { eventId, outcome: 'duplicate' };
  }

  private async portalFields(
    tx: Prisma.TransactionClient,
    event: CanonicalWebhook,
    correlationId: string,
  ): Promise<PortalField[]> {
    const fields: PortalField[] = [];
    for (const [field, candidate] of Object.entries(event.changedFields)) {
      if (field === 'accountId') {
        if (candidate === null) {
          throw requestError(correlationId, 400, 'accountId cannot be cleared');
        }
        const parent = await tx.customer.findUnique({ where: { salesforceId: candidate } });
        if (!parent || !(await shareCustomer(tx, parent.id))) {
          throw requestError(correlationId, 409, PARENT_DEFERRED);
        }
        fields.push({ field: 'customerId', candidate: parent.id });
        continue;
      }
      fields.push({ field, candidate });
    }
    return fields;
  }

  private async operation(
    tx: Prisma.TransactionClient,
    originOperationId: string | null | undefined,
  ): Promise<
    | {
        operationId: string;
        entityType: string;
        entityId: string;
        externalId: string | null;
        expectedValues: unknown;
      }
    | undefined
  > {
    if (originOperationId === undefined || originOperationId === null) {
      return undefined;
    }
    const row = await tx.syncOperation.findUnique({ where: { operationId: originOperationId } });
    return row ?? undefined;
  }

  private echoMatches(
    operation: { entityType: string; externalId: string | null; expectedValues: unknown },
    entityType: 'customer' | 'contact',
    recordId: string,
    fields: PortalField[],
  ): boolean {
    if (operation.entityType !== entityType) {
      return false;
    }
    if (operation.externalId !== null && operation.externalId !== recordId) {
      return false;
    }
    if (!isRecord(operation.expectedValues)) {
      return false;
    }
    const actual: Record<string, string | null> = {};
    for (const field of fields) {
      actual[field.field] = field.candidate;
    }
    const expected = operation.expectedValues;
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length) {
      return false;
    }
    return actualKeys.every((key) => Object.hasOwn(expected, key) && expected[key] === actual[key]);
  }

  private async withSourceSnapshot(event: CanonicalWebhook): Promise<CanonicalWebhook> {
    if (await this.findMapped(event)) {
      return event;
    }
    if (canInsert(event)) {
      return event;
    }
    const fetched = await fetchSourceFields(event);
    if (fetched === undefined) {
      return event;
    }
    return { ...event, changedFields: { ...fetched, ...event.changedFields } };
  }

  private async findMapped(event: CanonicalWebhook): Promise<boolean> {
    if (event.objectType === 'Account') {
      const row = await this.prisma.client.customer.findUnique({
        where: { salesforceId: event.recordId },
        select: { id: true },
      });
      return row !== null;
    }
    const row = await this.prisma.client.contact.findUnique({
      where: { salesforceId: event.recordId },
      select: { id: true },
    });
    return row !== null;
  }

  private async lockExternal(
    tx: Prisma.TransactionClient,
    entityType: 'customer' | 'contact',
    recordId: string,
    fields: PortalField[],
    now: Date,
    correlationId: string,
  ): Promise<LockedEntity> {
    const found =
      entityType === 'customer'
        ? await tx.customer.findUnique({ where: { salesforceId: recordId }, select: { id: true } })
        : await tx.contact.findUnique({ where: { salesforceId: recordId }, select: { id: true } });
    if (!found) {
      return this.createMapped(tx, entityType, recordId, fields, now, correlationId);
    }
    const locked = await this.lockEntity(tx, entityType, found.id);
    if (!locked || locked.salesforceId !== recordId) {
      throw requestError(correlationId, 409, DEFERRABLE);
    }
    return locked;
  }

  private async createMapped(
    tx: Prisma.TransactionClient,
    entityType: 'customer' | 'contact',
    recordId: string,
    fields: PortalField[],
    now: Date,
    correlationId: string,
  ): Promise<LockedEntity> {
    const id = randomUUID();
    if (entityType === 'customer') {
      const name = candidate(fields, 'name');
      if (name === null || name.length === 0) {
        throw requestError(correlationId, 409, DEFERRABLE);
      }
      await tx.customer.create({
        data: {
          id,
          salesforceId: recordId,
          name,
          rowVersion: 0n,
          createdAt: now,
          updatedAt: now,
        },
      });
      if (!(await lockCustomer(tx, id))) {
        throw requestError(correlationId, 409, DEFERRABLE);
      }
      return {
        id,
        salesforceId: recordId,
        rowVersion: 0n,
        values: { name: null, status: null, ownerId: null },
      };
    }
    const customerId = candidate(fields, 'customerId');
    if (customerId === null) {
      throw requestError(correlationId, 409, DEFERRABLE);
    }
    await tx.contact.create({
      data: {
        id,
        salesforceId: recordId,
        customerId,
        rowVersion: 0n,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!(await lockContact(tx, id))) {
      throw requestError(correlationId, 409, DEFERRABLE);
    }
    return {
      id,
      salesforceId: recordId,
      rowVersion: 0n,
      values: {
        customerId: null,
        fullName: null,
        email: null,
        phone: null,
        city: null,
        ownerId: null,
      },
    };
  }

  private async lockEntity(
    tx: Prisma.TransactionClient,
    entityType: 'customer' | 'contact',
    id: string,
  ): Promise<LockedEntity | undefined> {
    if (entityType === 'customer') {
      if (!(await lockCustomer(tx, id))) {
        return undefined;
      }
      const row = await tx.customer.findUnique({ where: { id } });
      if (!row) {
        return undefined;
      }
      return {
        id: row.id,
        salesforceId: row.salesforceId,
        rowVersion: row.rowVersion,
        values: { name: row.name, status: row.status, ownerId: row.ownerId },
      };
    }
    if (!(await lockContact(tx, id))) {
      return undefined;
    }
    const row = await tx.contact.findUnique({ where: { id } });
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      salesforceId: row.salesforceId,
      rowVersion: row.rowVersion,
      values: {
        customerId: row.customerId,
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        city: row.city,
        ownerId: row.ownerId,
      },
    };
  }

  private async persistEntity(
    tx: Prisma.TransactionClient,
    entityType: 'customer' | 'contact',
    locked: LockedEntity,
    applied: PortalField[],
    recordId: string,
    echo: boolean,
    now: Date,
  ): Promise<void> {
    const nextVersion = locked.rowVersion + (applied.length > 0 ? 1n : 0n);
    if (entityType === 'customer') {
      const data: Prisma.CustomerUpdateManyMutationInput = {
        updatedAt: now,
        ...(applied.length > 0 ? { rowVersion: nextVersion } : {}),
        ...(echo && locked.salesforceId === null ? { salesforceId: recordId } : {}),
      };
      for (const field of applied) {
        if (field.field === 'name' && field.candidate !== null) {
          data.name = field.candidate;
        } else if (field.field === 'status') {
          data.status = field.candidate;
        } else if (field.field === 'ownerId') {
          data.ownerId = field.candidate;
        }
      }
      const updated = await tx.customer.updateMany({
        where: { id: locked.id, rowVersion: locked.rowVersion },
        data,
      });
      if (updated.count !== 1) {
        throw new Error('Customer changed during inbound apply');
      }
      return;
    }
    const data: Prisma.ContactUncheckedUpdateManyInput = {
      updatedAt: now,
      ...(applied.length > 0 ? { rowVersion: nextVersion } : {}),
      ...(echo && locked.salesforceId === null ? { salesforceId: recordId } : {}),
    };
    for (const field of applied) {
      if (field.field === 'customerId' && field.candidate !== null) {
        data.customerId = field.candidate;
      } else if (field.field === 'fullName') {
        data.fullName = field.candidate;
      } else if (field.field === 'email') {
        data.email = field.candidate;
      } else if (field.field === 'phone') {
        data.phone = field.candidate;
      } else if (field.field === 'city') {
        data.city = field.candidate;
      } else if (field.field === 'ownerId') {
        data.ownerId = field.candidate;
      }
    }
    const updated = await tx.contact.updateMany({
      where: { id: locked.id, rowVersion: locked.rowVersion },
      data,
    });
    if (updated.count !== 1) {
      throw new Error('Contact changed during inbound apply');
    }
  }
}

function jsonValue(value: string | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}

function candidate(fields: PortalField[], field: string): string | null {
  const found = fields.find((item) => item.field === field);
  return found === undefined ? null : found.candidate;
}

function canInsert(event: CanonicalWebhook): boolean {
  if (event.objectType === 'Account') {
    const name = event.changedFields.name;
    return typeof name === 'string' && name.length > 0;
  }
  const accountId = event.changedFields.accountId;
  return typeof accountId === 'string' && accountId.length > 0;
}

const ACCOUNT_SOURCE_FIELDS = ['name', 'status', 'ownerId'] as const;
const CONTACT_SOURCE_FIELDS = [
  'accountId',
  'fullName',
  'email',
  'phone',
  'city',
  'ownerId',
] as const;

async function fetchSourceFields(
  event: CanonicalWebhook,
): Promise<Record<string, string | null> | undefined> {
  const base = process.env.FAKE_SALESFORCE_BASE_URL;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return undefined;
  }
  const path =
    event.objectType === 'Account'
      ? `/sf/v1/accounts/${encodeURIComponent(event.recordId)}`
      : `/sf/v1/contacts/${encodeURIComponent(event.recordId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(new URL(path, base), { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    return readSourceFields(event.objectType, await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function readSourceFields(
  objectType: CanonicalWebhook['objectType'],
  body: unknown,
): Record<string, string | null> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const keys = objectType === 'Account' ? ACCOUNT_SOURCE_FIELDS : CONTACT_SOURCE_FIELDS;
  const fields: Record<string, string | null> = {};
  for (const key of keys) {
    if (!Object.hasOwn(body, key)) {
      continue;
    }
    const value = Reflect.get(body, key);
    if (key === 'name' || key === 'accountId') {
      if (typeof value === 'string' && value.length > 0) {
        fields[key] = value;
      }
      continue;
    }
    if (typeof value === 'string' || value === null) {
      fields[key] = value;
    }
  }
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
