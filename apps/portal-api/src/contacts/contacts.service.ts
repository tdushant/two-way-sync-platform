import { Injectable } from '@nestjs/common';
import { isUuid, type Contact, type ContactPatch, type CreateContact } from '@sync/contracts';
import { Clock } from '../clock';
import { PrismaService } from '../prisma/prisma.service';
import { requestError } from '../http/portal-request.error';
import { Ids } from '../sync/ids';
import {
  CONTACT_CREATE_SCOPE,
  commitFieldChanges,
  fieldChanges,
  isPrismaError,
  lockContact,
  requestHash,
  rowVersionNumber,
  shareCustomer,
} from '../sync/mutation';

const BLANK_CONTACT = {
  customerId: null,
  fullName: null,
  email: null,
  phone: null,
  city: null,
  ownerId: null,
};

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: Ids,
    private readonly clock: Clock,
  ) {}

  async create(
    body: CreateContact,
    actorId: string,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ contact: Contact; created: boolean }> {
    const hash = requestHash(body);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.clientIdempotencyKey.findUnique({
          where: { scope_idempotencyKey: { scope: CONTACT_CREATE_SCOPE, idempotencyKey } },
        });
        if (existing) {
          return {
            contact: await this.contactForKey(tx, existing, hash, correlationId),
            created: false,
          };
        }
        const parent = await shareCustomer(tx, body.customerId);
        if (!parent) {
          throw requestError(correlationId, 404, 'Customer not found');
        }
        const id = this.ids.entityId();
        const now = this.clock.now();
        const stored = {
          customerId: body.customerId,
          fullName: body.fullName ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          city: body.city ?? null,
          ownerId: body.ownerId ?? null,
        };
        await tx.contact.create({
          data: {
            id,
            ...stored,
            rowVersion: 1n,
            createdAt: now,
            updatedAt: now,
          },
        });
        await commitFieldChanges(tx, this.ids, {
          entityType: 'contact',
          entityId: id,
          eventType: 'created',
          changes: fieldChanges(BLANK_CONTACT, body),
          rowVersion: 1,
          salesforceId: null,
          actorId,
          now,
          hold: parent.salesforceId === null ? 'parent_unmapped' : null,
        });
        await tx.clientIdempotencyKey.create({
          data: {
            scope: CONTACT_CREATE_SCOPE,
            idempotencyKey,
            requestHash: hash,
            entityId: id,
            createdAt: now,
          },
        });
        return {
          contact: toContact({
            id,
            salesforceId: null,
            ...stored,
            rowVersion: 1n,
            createdAt: now,
            updatedAt: now,
          }),
          created: true,
        };
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        return this.replay(idempotencyKey, hash, correlationId);
      }
      if (isPrismaError(error, 'P2003')) {
        throw requestError(correlationId, 404, 'Customer not found');
      }
      throw error;
    }
  }

  async get(id: string, correlationId: string): Promise<Contact> {
    this.requireUuid(id, correlationId);
    const row = await this.prisma.client.contact.findUnique({ where: { id } });
    if (!row) {
      throw requestError(correlationId, 404, 'Contact not found');
    }
    return toContact(row);
  }

  async patch(
    id: string,
    patch: ContactPatch,
    actorId: string,
    ifMatch: number | undefined,
    correlationId: string,
  ): Promise<Contact> {
    this.requireUuid(id, correlationId);
    return this.prisma.client.$transaction(async (tx) => {
      if (!(await lockContact(tx, id))) {
        throw requestError(correlationId, 404, 'Contact not found');
      }
      const row = await tx.contact.findUniqueOrThrow({ where: { id } });
      if (ifMatch !== undefined && rowVersionNumber(row.rowVersion) !== ifMatch) {
        throw requestError(correlationId, 412, 'rowVersion conflict');
      }
      const changes = fieldChanges(
        {
          customerId: row.customerId,
          fullName: row.fullName,
          email: row.email,
          phone: row.phone,
          city: row.city,
          ownerId: row.ownerId,
        },
        patch,
      );
      let parentSalesforceId: string | null = null;
      if (changes.some((change) => change.field === 'customerId')) {
        const nextCustomerId = changes.find((change) => change.field === 'customerId')?.newValue;
        if (!nextCustomerId) {
          throw requestError(correlationId, 400, 'customerId cannot be cleared');
        }
        const parent = await shareCustomer(tx, nextCustomerId);
        if (!parent) {
          throw requestError(correlationId, 404, 'Customer not found');
        }
        parentSalesforceId = parent.salesforceId;
      }
      if (changes.length === 0) {
        return toContact(row);
      }
      const now = this.clock.now();
      const next = row.rowVersion + 1n;
      const data: {
        customerId?: string;
        fullName?: string | null;
        email?: string | null;
        phone?: string | null;
        city?: string | null;
        ownerId?: string | null;
        rowVersion: bigint;
        updatedAt: Date;
      } = { rowVersion: next, updatedAt: now };
      for (const change of changes) {
        if (change.field === 'customerId') {
          if (change.newValue === null) {
            throw requestError(correlationId, 400, 'customerId cannot be cleared');
          }
          data.customerId = change.newValue;
        } else if (change.field === 'fullName') {
          data.fullName = change.newValue;
        } else if (change.field === 'email') {
          data.email = change.newValue;
        } else if (change.field === 'phone') {
          data.phone = change.newValue;
        } else if (change.field === 'city') {
          data.city = change.newValue;
        } else if (change.field === 'ownerId') {
          data.ownerId = change.newValue;
        }
      }
      const updated = await tx.contact.updateMany({
        where: { id, rowVersion: row.rowVersion },
        data,
      });
      if (updated.count !== 1) {
        throw requestError(correlationId, 412, 'rowVersion conflict');
      }
      await commitFieldChanges(tx, this.ids, {
        entityType: 'contact',
        entityId: id,
        eventType: 'updated',
        changes,
        rowVersion: rowVersionNumber(next),
        salesforceId: row.salesforceId,
        actorId,
        now,
        hold: contactHold(row.salesforceId, changes, parentSalesforceId),
      });
      return toContact(await tx.contact.findUniqueOrThrow({ where: { id } }));
    });
  }

  private requireUuid(id: string, correlationId: string): void {
    if (!isUuid(id)) {
      throw requestError(correlationId, 400, 'id must be a UUID');
    }
  }

  private async replay(
    idempotencyKey: string,
    hash: string,
    correlationId: string,
  ): Promise<{ contact: Contact; created: false }> {
    const existing = await this.prisma.client.clientIdempotencyKey.findUnique({
      where: { scope_idempotencyKey: { scope: CONTACT_CREATE_SCOPE, idempotencyKey } },
    });
    if (!existing) {
      throw new Error('Unique conflict was not a committed idempotency key');
    }
    return {
      contact: await this.contactForKey(this.prisma.client, existing, hash, correlationId),
      created: false,
    };
  }

  private async contactForKey(
    db: { contact: PrismaService['client']['contact'] },
    existing: { requestHash: string; entityId: string },
    hash: string,
    correlationId: string,
  ): Promise<Contact> {
    if (existing.requestHash !== hash) {
      throw requestError(
        correlationId,
        409,
        'Idempotency-Key was already used with a different body',
      );
    }
    const row = await db.contact.findUnique({ where: { id: existing.entityId } });
    if (!row) {
      throw new Error('Idempotency key has no contact');
    }
    return toContact(row);
  }
}

function contactHold(
  contactSalesforceId: string | null,
  changes: { field: string }[],
  parentSalesforceId: string | null,
): 'parent_unmapped' | 'unmapped' | null {
  if (contactSalesforceId === null) {
    return 'unmapped';
  }
  if (changes.some((change) => change.field === 'customerId') && parentSalesforceId === null) {
    return 'parent_unmapped';
  }
  return null;
}

function toContact(row: {
  id: string;
  salesforceId: string | null;
  customerId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  ownerId: string | null;
  rowVersion: bigint;
  createdAt: Date;
  updatedAt: Date;
}): Contact {
  return {
    id: row.id,
    salesforceId: row.salesforceId,
    customerId: row.customerId,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    city: row.city,
    ownerId: row.ownerId,
    rowVersion: rowVersionNumber(row.rowVersion),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
