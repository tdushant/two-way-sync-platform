import { Injectable } from '@nestjs/common';
import { isUuid, type CreateCustomer, type Customer, type CustomerPatch } from '@sync/contracts';
import { Clock } from '../clock';
import { PrismaService } from '../prisma/prisma.service';
import { requestError } from '../http/portal-request.error';
import { Ids } from '../sync/ids';
import {
  CUSTOMER_CREATE_SCOPE,
  commitFieldChanges,
  fieldChanges,
  isPrismaError,
  lockCustomer,
  requestHash,
  rowVersionNumber,
} from '../sync/mutation';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: Ids,
    private readonly clock: Clock,
  ) {}

  async create(
    body: CreateCustomer,
    actorId: string,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ customer: Customer; created: boolean }> {
    const hash = requestHash(body);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.clientIdempotencyKey.findUnique({
          where: {
            scope_idempotencyKey: { scope: CUSTOMER_CREATE_SCOPE, idempotencyKey },
          },
        });
        if (existing) {
          return {
            customer: await this.customerForKey(tx, existing, hash, correlationId),
            created: false,
          };
        }
        const id = this.ids.entityId();
        const now = this.clock.now();
        const stored = {
          name: body.name,
          status: body.status ?? null,
          ownerId: body.ownerId ?? null,
        };
        await tx.customer.create({
          data: {
            id,
            name: stored.name,
            status: stored.status,
            ownerId: stored.ownerId,
            rowVersion: 1n,
            createdAt: now,
            updatedAt: now,
          },
        });
        await commitFieldChanges(tx, this.ids, {
          entityType: 'customer',
          entityId: id,
          eventType: 'created',
          changes: fieldChanges({ name: null, status: null, ownerId: null }, body),
          rowVersion: 1,
          salesforceId: null,
          actorId,
          now,
          hold: null,
        });
        await tx.clientIdempotencyKey.create({
          data: {
            scope: CUSTOMER_CREATE_SCOPE,
            idempotencyKey,
            requestHash: hash,
            entityId: id,
            createdAt: now,
          },
        });
        return {
          customer: toCustomer({
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
      throw error;
    }
  }

  async get(id: string, correlationId: string): Promise<Customer> {
    this.requireUuid(id, correlationId);
    const row = await this.prisma.client.customer.findUnique({ where: { id } });
    if (!row) {
      throw requestError(correlationId, 404, 'Customer not found');
    }
    return toCustomer(row);
  }

  async patch(
    id: string,
    patch: CustomerPatch,
    actorId: string,
    ifMatch: number | undefined,
    correlationId: string,
  ): Promise<Customer> {
    this.requireUuid(id, correlationId);
    return this.prisma.client.$transaction(async (tx) => {
      const locked = await lockCustomer(tx, id);
      if (!locked) {
        throw requestError(correlationId, 404, 'Customer not found');
      }
      const row = await tx.customer.findUniqueOrThrow({ where: { id } });
      if (ifMatch !== undefined && rowVersionNumber(row.rowVersion) !== ifMatch) {
        throw requestError(correlationId, 412, 'rowVersion conflict');
      }
      const changes = fieldChanges(
        { name: row.name, status: row.status, ownerId: row.ownerId },
        patch,
      );
      if (changes.length === 0) {
        return toCustomer(row);
      }
      const now = this.clock.now();
      const next = row.rowVersion + 1n;
      const data: {
        name?: string;
        status?: string | null;
        ownerId?: string | null;
        rowVersion: bigint;
        updatedAt: Date;
      } = { rowVersion: next, updatedAt: now };
      for (const change of changes) {
        if (change.field === 'name') {
          if (change.newValue === null) {
            throw requestError(correlationId, 400, 'name cannot be cleared');
          }
          data.name = change.newValue;
        } else if (change.field === 'status') {
          data.status = change.newValue;
        } else if (change.field === 'ownerId') {
          data.ownerId = change.newValue;
        }
      }
      const updated = await tx.customer.updateMany({
        where: { id, rowVersion: row.rowVersion },
        data,
      });
      if (updated.count !== 1) {
        throw requestError(correlationId, 412, 'rowVersion conflict');
      }
      await commitFieldChanges(tx, this.ids, {
        entityType: 'customer',
        entityId: id,
        eventType: 'updated',
        changes,
        rowVersion: rowVersionNumber(next),
        salesforceId: row.salesforceId,
        actorId,
        now,
        hold: null,
      });
      return toCustomer(await tx.customer.findUniqueOrThrow({ where: { id } }));
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
  ): Promise<{ customer: Customer; created: false }> {
    const existing = await this.prisma.client.clientIdempotencyKey.findUnique({
      where: { scope_idempotencyKey: { scope: CUSTOMER_CREATE_SCOPE, idempotencyKey } },
    });
    if (!existing) {
      throw new Error('Unique conflict was not a committed idempotency key');
    }
    return {
      customer: await this.customerForKey(this.prisma.client, existing, hash, correlationId),
      created: false,
    };
  }

  private async customerForKey(
    db: {
      customer: PrismaService['client']['customer'];
    },
    existing: { requestHash: string; entityId: string },
    hash: string,
    correlationId: string,
  ): Promise<Customer> {
    if (existing.requestHash !== hash) {
      throw requestError(
        correlationId,
        409,
        'Idempotency-Key was already used with a different body',
      );
    }
    const row = await db.customer.findUnique({ where: { id: existing.entityId } });
    if (!row) {
      throw new Error('Idempotency key has no customer');
    }
    return toCustomer(row);
  }
}

function toCustomer(row: {
  id: string;
  salesforceId: string | null;
  name: string;
  status: string | null;
  ownerId: string | null;
  rowVersion: bigint;
  createdAt: Date;
  updatedAt: Date;
}): Customer {
  return {
    id: row.id,
    salesforceId: row.salesforceId,
    name: row.name,
    status: row.status,
    ownerId: row.ownerId,
    rowVersion: rowVersionNumber(row.rowVersion),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
