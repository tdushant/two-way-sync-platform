import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';

const databaseUrl = process.env.PORTAL_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('PORTAL_DATABASE_URL is required');
}

const at = new Date('2026-11-11T10:00:00.000Z');
const customerId = '11111111-1111-4111-8111-111111111111';
const unmappedCustomerId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const historyId = '44444444-4444-4444-8444-444444444444';
const outboxId = '55555555-5555-4555-8555-555555555555';
const operationId = '66666666-6666-4666-8666-666666666666';
const reconciliationId = '77777777-7777-4777-8777-777777777777';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

try {
  await prisma.$transaction(async (tx) => {
    await tx.customer.upsert({
      where: { id: customerId },
      create: {
        id: customerId,
        salesforceId: 'SF-ACC-001',
        name: 'Seed Customer',
        status: 'active',
        ownerId: 'owner-seed',
        rowVersion: 1n,
        createdAt: at,
        updatedAt: at,
      },
      update: {
        salesforceId: 'SF-ACC-001',
        name: 'Seed Customer',
        status: 'active',
        ownerId: 'owner-seed',
        rowVersion: 1n,
        updatedAt: at,
      },
    });

    await tx.customer.upsert({
      where: { id: unmappedCustomerId },
      create: {
        id: unmappedCustomerId,
        name: 'Unmapped Customer',
        rowVersion: 0n,
        createdAt: at,
        updatedAt: at,
      },
      update: {
        name: 'Unmapped Customer',
        salesforceId: null,
        rowVersion: 0n,
        updatedAt: at,
      },
    });

    await tx.contact.upsert({
      where: { id: contactId },
      create: {
        id: contactId,
        salesforceId: 'SF-CON-001',
        customerId,
        fullName: 'Seed Contact',
        email: 'seed.contact@example.com',
        phone: '+15555550100',
        city: 'Austin',
        ownerId: 'owner-seed',
        rowVersion: 1n,
        createdAt: at,
        updatedAt: at,
      },
      update: {
        salesforceId: 'SF-CON-001',
        customerId,
        fullName: 'Seed Contact',
        email: 'seed.contact@example.com',
        phone: '+15555550100',
        city: 'Austin',
        ownerId: 'owner-seed',
        rowVersion: 1n,
        updatedAt: at,
      },
    });

    await tx.syncOperation.upsert({
      where: { operationId },
      create: {
        operationId,
        entityType: 'customer',
        entityId: customerId,
        fields: ['name'],
        expectedValues: { name: 'Seed Customer' },
        externalId: 'SF-ACC-001',
        status: 'ACKED',
        createdAt: at,
      },
      update: {
        entityType: 'customer',
        entityId: customerId,
        fields: ['name'],
        expectedValues: { name: 'Seed Customer' },
        externalId: 'SF-ACC-001',
        status: 'ACKED',
      },
    });

    await tx.outboxEvent.upsert({
      where: { id: outboxId },
      create: {
        id: outboxId,
        operationId,
        entityType: 'customer',
        entityId: customerId,
        eventType: 'created',
        changedFields: { name: 'Seed Customer' },
        baseVersions: { rowVersion: 0, fields: {} },
        status: 'COMPLETED',
        attempts: 1,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      },
      update: {
        operationId,
        status: 'COMPLETED',
        attempts: 1,
        updatedAt: at,
      },
    });

    await tx.fieldHistory.upsert({
      where: { id: historyId },
      create: {
        id: historyId,
        entityType: 'customer',
        entityId: customerId,
        fieldName: 'name',
        newValue: 'Seed Customer',
        source: 'PORTAL',
        operationId,
        sourceChangedAt: at,
        appliedAt: at,
        decision: 'APPLIED',
      },
      update: {
        decision: 'APPLIED',
        source: 'PORTAL',
      },
    });

    await tx.fieldSyncState.upsert({
      where: {
        entityType_entityId_fieldName: {
          entityType: 'customer',
          entityId: customerId,
          fieldName: 'name',
        },
      },
      create: {
        entityType: 'customer',
        entityId: customerId,
        fieldName: 'name',
        source: 'PORTAL',
        sourceVersion: '1',
        sourceChangedAt: at,
        lastAppliedAt: at,
        lastOperationId: operationId,
      },
      update: {
        source: 'PORTAL',
        sourceVersion: '1',
        sourceChangedAt: at,
        lastAppliedAt: at,
        lastOperationId: operationId,
      },
    });

    await tx.processedEvent.upsert({
      where: { eventId: 'seed-event-001' },
      create: {
        eventId: 'seed-event-001',
        payloadHash: 'seed-payload-hash',
        entityType: 'customer',
        externalId: 'SF-ACC-001',
        status: 'APPLIED',
        receivedAt: at,
        processedAt: at,
      },
      update: {
        payloadHash: 'seed-payload-hash',
        status: 'APPLIED',
        processedAt: at,
      },
    });

    await tx.syncCheckpoint.upsert({
      where: { streamName: 'sf_changes' },
      create: {
        streamName: 'sf_changes',
        cursor: '0',
        lastSuccessAt: at,
        updatedAt: at,
      },
      update: {
        cursor: '0',
        lastSuccessAt: at,
        updatedAt: at,
      },
    });

    await tx.reconciliationRun.upsert({
      where: { id: reconciliationId },
      create: {
        id: reconciliationId,
        startedAt: at,
        completedAt: at,
        status: 'SUCCEEDED',
        fromCursor: null,
        toCursor: '0',
        processedCount: 1,
      },
      update: {
        status: 'SUCCEEDED',
        completedAt: at,
        toCursor: '0',
        processedCount: 1,
        error: null,
      },
    });
  });
} finally {
  await prisma.$disconnect();
}
