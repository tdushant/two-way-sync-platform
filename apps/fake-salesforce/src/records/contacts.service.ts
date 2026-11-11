import { Injectable } from '@nestjs/common';
import type { CreateSfContact, SfContactPatch } from '@sync/contracts';
import { requestError } from '../http/salesforce-request.error';
import { PrismaService } from '../prisma/prisma.service';
import type { WriteContext } from './accounts.service';
import { Ids } from './ids';
import {
  appendChange,
  fieldChanges,
  isPrismaError,
  lockContact,
  readReplay,
  requestHash,
  saveReplay,
  shareAccount,
  toContact,
  versionNumber,
  type ContactView,
  type SalesforceTx,
  type StoredResponse,
} from './writes';

const BLANK_CONTACT = {
  accountId: null,
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
  ) {}

  async create(body: CreateSfContact, context: WriteContext): Promise<StoredResponse> {
    const hash = requestHash(context.method, context.path, body);
    try {
      return await this.prisma.client.$transaction((tx) => this.insert(tx, body, context, hash));
    } catch (error) {
      return this.afterConflict(error, context, hash);
    }
  }

  async get(id: string, correlationId: string): Promise<ContactView> {
    const row = await this.prisma.client.sfContact.findUnique({ where: { id } });
    if (!row) {
      throw requestError(correlationId, 404, 'Contact not found');
    }
    return toContact(row);
  }

  async patch(id: string, patch: SfContactPatch, context: WriteContext): Promise<StoredResponse> {
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
    body: CreateSfContact,
    context: WriteContext,
    hash: string,
  ): Promise<StoredResponse> {
    if (context.operationId) {
      const replay = await readReplay(tx, context.operationId, hash, context.correlationId);
      if (replay) {
        return replay;
      }
    }
    if (!(await shareAccount(tx, body.accountId))) {
      throw requestError(context.correlationId, 404, 'Account not found');
    }
    const id = this.ids.contactId();
    const now = new Date();
    const stored = {
      accountId: body.accountId,
      fullName: body.fullName ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      city: body.city ?? null,
      ownerId: body.ownerId ?? null,
    };
    await tx.sfContact.create({
      data: { id, ...stored, version: 1n, systemModstamp: now },
    });
    await appendChange(tx, this.ids, {
      objectType: 'Contact',
      recordId: id,
      changes: fieldChanges(BLANK_CONTACT, body),
      version: 1,
      changedBy: context.changedBy,
      originOperationId: context.operationId,
      now,
    });
    const view = toContact({ id, ...stored, version: 1n, systemModstamp: now });
    if (context.operationId) {
      await saveReplay(tx, context.operationId, hash, 201, view, id, now);
    }
    return { status: 201, body: view };
  }

  private async update(
    tx: SalesforceTx,
    id: string,
    patch: SfContactPatch,
    context: WriteContext,
    hash: string,
  ): Promise<StoredResponse> {
    if (context.operationId) {
      const replay = await readReplay(tx, context.operationId, hash, context.correlationId);
      if (replay) {
        return replay;
      }
    }
    if (!(await lockContact(tx, id))) {
      throw requestError(context.correlationId, 404, 'Contact not found');
    }
    const row = await tx.sfContact.findUniqueOrThrow({ where: { id } });
    const changes = fieldChanges(
      {
        accountId: row.accountId,
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        city: row.city,
        ownerId: row.ownerId,
      },
      patch,
    );
    if (changes.some((change) => change.field === 'accountId')) {
      const nextAccountId = changes.find((change) => change.field === 'accountId')?.newValue;
      if (!nextAccountId) {
        throw requestError(context.correlationId, 400, 'accountId cannot be cleared');
      }
      if (!(await shareAccount(tx, nextAccountId))) {
        throw requestError(context.correlationId, 404, 'Account not found');
      }
    }
    if (changes.length === 0) {
      const view = toContact(row);
      if (context.operationId) {
        await saveReplay(tx, context.operationId, hash, 200, view, id, new Date());
      }
      return { status: 200, body: view };
    }
    const now = new Date();
    const next = row.version + 1n;
    const data: {
      accountId?: string;
      fullName?: string | null;
      email?: string | null;
      phone?: string | null;
      city?: string | null;
      ownerId?: string | null;
      version: bigint;
      systemModstamp: Date;
    } = { version: next, systemModstamp: now };
    for (const change of changes) {
      if (change.field === 'accountId') {
        if (change.newValue === null) {
          throw requestError(context.correlationId, 400, 'accountId cannot be cleared');
        }
        data.accountId = change.newValue;
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
    const updated = await tx.sfContact.updateMany({
      where: { id, version: row.version },
      data,
    });
    if (updated.count !== 1) {
      throw requestError(context.correlationId, 409, 'Contact version changed');
    }
    await appendChange(tx, this.ids, {
      objectType: 'Contact',
      recordId: id,
      changes,
      version: versionNumber(next),
      changedBy: context.changedBy,
      originOperationId: context.operationId,
      now,
    });
    const view = toContact(await tx.sfContact.findUniqueOrThrow({ where: { id } }));
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
