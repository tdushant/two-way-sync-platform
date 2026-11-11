import process from 'node:process';
import { URL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';

const databaseUrl = process.env.SALESFORCE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('SALESFORCE_DATABASE_URL is required');
}
const parsed = new URL(databaseUrl);
if (parsed.username !== 'salesforce' || parsed.pathname !== '/salesforce') {
  throw new Error('Refusing to seed a database that is not salesforce-db');
}

const at = new Date('2026-11-11T10:00:00.000Z');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

const accounts = [
  {
    id: 'SF-ACC-001',
    name: 'Seed Account',
    status: 'active',
    ownerId: 'owner-seed',
    version: 1n,
    systemModstamp: at,
    createdAt: at,
  },
  {
    id: 'SF-ACC-002',
    name: 'Second Account',
    status: 'active',
    ownerId: 'owner-seed',
    version: 1n,
    systemModstamp: at,
    createdAt: at,
  },
];

const contacts = [
  {
    id: 'SF-CON-001',
    accountId: 'SF-ACC-001',
    fullName: 'Seed Contact',
    email: 'seed.contact@example.com',
    phone: '+15555550100',
    city: 'Austin',
    ownerId: 'owner-seed',
    version: 1n,
    systemModstamp: at,
  },
  {
    id: 'SF-CON-002',
    accountId: 'SF-ACC-002',
    fullName: 'Second Contact',
    email: 'second.contact@example.com',
    phone: '+15555550101',
    city: 'Dallas',
    ownerId: 'owner-seed',
    version: 1n,
    systemModstamp: at,
  },
];

try {
  await prisma.$transaction(async (tx) => {
    for (const account of accounts) {
      const { id, ...fields } = account;
      await tx.sfAccount.upsert({
        where: { id },
        create: account,
        update: fields,
      });
    }
    for (const contact of contacts) {
      const { id, ...fields } = contact;
      await tx.sfContact.upsert({
        where: { id },
        create: contact,
        update: fields,
      });
    }
  });
} finally {
  await prisma.$disconnect();
}
