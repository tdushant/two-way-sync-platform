import { Injectable } from '@nestjs/common';
import type { AccountPatch, CreateAccount } from '@sync/contracts';
import { requestError } from '../http/salesforce-request.error';
import { PrismaService } from '../prisma/prisma.service';
import { Ids } from './ids';
import {
  appendChange,
  fieldChanges,
  isPrismaError,
  lockAccount,
  readReplay,
  requestHash,
  saveReplay,
  toAccount,
  versionNumber,
  type AccountView,
  type SalesforceTx,
  type StoredResponse,
} from './writes';

export interface WriteContext {
  correlationId: string;
  operationId: string | null;
  changedBy: string | null;
  method: string;
  path: string;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: Ids,
  ) {}

  async create(body: CreateAccount, context: WriteContext): Promise<StoredResponse> {
    const hash = requestHash(context.method, context.path, body);
    try {
      return await this.prisma.client.$transaction((tx) => this.insert(tx, body, context, hash));
    } catch (error) {
      return this.afterConflict(error, context, hash);
    }
  }

  async get(id: string, correlationId: string): Promise<AccountView> {
    const row = await this.prisma.client.sfAccount.findUnique({ where: { id } });
    if (!row) {
      throw requestError(correlationId, 404, 'Account not found');
    }
    return toAccount(row);
  }

  async patch(id: string, patch: AccountPatch, context: WriteContext): Promise<StoredResponse> {
    const hash = requestHash(context.method, context.path, patch);
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.update(tx, id, patch, context, hash),
      );
    } catch (error) {
      return this.afterConflict(error, context, hash);
    }
  }

  private async insert(
    tx: SalesforceTx,
    body: CreateAccount,
    context: WriteContext,
    hash: string,
  ): Promise<StoredResponse> {
    if (context.operationId) {
      const replay = await readReplay(tx, context.operationId, hash, context.correlationId);
      if (replay) {
        return replay;
      }
    }
    const id = this.ids.accountId();
    const now = new Date();
    const stored = {
      name: body.name,
      status: body.status ?? null,
      ownerId: body.ownerId ?? null,
    };
    await tx.sfAccount.create({
      data: {
        id,
        ...stored,
        version: 1n,
        systemModstamp: now,
        createdAt: now,
      },
    });
    await appendChange(tx, this.ids, {
      objectType: 'Account',
      recordId: id,
      changes: fieldChanges({ name: null, status: null, ownerId: null }, body),
      version: 1,
      changedBy: context.changedBy,
      originOperationId: context.operationId,
      now,
    });
    const view = toAccount({ id, ...stored, version: 1n, systemModstamp: now });
    if (context.operationId) {
      await saveReplay(tx, context.operationId, hash, 201, view, id, now);
    }
    return { status: 201, body: view };
  }

  private async update(
    tx: SalesforceTx,
    id: string,
    patch: AccountPatch,
    context: WriteContext,
    hash: string,
  ): Promise<StoredResponse> {
    if (context.operationId) {
      const replay = await readReplay(tx, context.operationId, hash, context.correlationId);
      if (replay) {
        return replay;
      }
    }
    if (!(await lockAccount(tx, id))) {
      throw requestError(context.correlationId, 404, 'Account not found');
    }
    const row = await tx.sfAccount.findUniqueOrThrow({ where: { id } });
    const changes = fieldChanges(
      { name: row.name, status: row.status, ownerId: row.ownerId },
      patch,
    );
    if (changes.length === 0) {
      const view = toAccount(row);
      if (context.operationId) {
        await saveReplay(tx, context.operationId, hash, 200, view, id, new Date());
      }
      return { status: 200, body: view };
    }
    const now = new Date();
    const next = row.version + 1n;
    const data: {
      name?: string;
      status?: string | null;
      ownerId?: string | null;
      version: bigint;
      systemModstamp: Date;
    } = { version: next, systemModstamp: now };
    for (const change of changes) {
      if (change.field === 'name') {
        if (change.newValue === null) {
          throw requestError(context.correlationId, 400, 'name cannot be cleared');
        }
        data.name = change.newValue;
      } else if (change.field === 'status') {
        data.status = change.newValue;
      } else if (change.field === 'ownerId') {
        data.ownerId = change.newValue;
      }
    }
    const updated = await tx.sfAccount.updateMany({
      where: { id, version: row.version },
      data,
    });
    if (updated.count !== 1) {
      throw requestError(context.correlationId, 409, 'Account version changed');
    }
    const version = versionNumber(next);
    await appendChange(tx, this.ids, {
      objectType: 'Account',
      recordId: id,
      changes,
      version,
      changedBy: context.changedBy,
      originOperationId: context.operationId,
      now,
    });
    const view = toAccount(await tx.sfAccount.findUniqueOrThrow({ where: { id } }));
    if (context.operationId) {
      await saveReplay(tx, context.operationId, hash, 200, view, id, now);
    }
    return { status: 200, body: view };
  }

  private async afterConflict(
    error: unknown,
    context: WriteContext,
    hash: string,
  ): Promise<StoredResponse> {
    if (context.operationId && isPrismaError(error, 'P2002')) {
      const replay = await readReplay(
        this.prisma.client,
        context.operationId,
        hash,
        context.correlationId,
      );
      if (replay) {
        return replay;
      }
    }
    if (isPrismaError(error, 'P2003')) {
      throw requestError(context.correlationId, 404, 'Account not found');
    }
    throw error;
  }
}
