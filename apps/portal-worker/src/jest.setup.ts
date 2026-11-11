import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function portalDatabaseUrl(): string {
  const text = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('PORTAL_DATABASE_URL=')) {
      return line.slice('PORTAL_DATABASE_URL='.length);
    }
  }
  throw new Error('PORTAL_DATABASE_URL is missing from .env.example');
}

process.env.NODE_ENV = 'test';
process.env.PORTAL_DATABASE_URL = portalDatabaseUrl();
process.env.FAKE_SALESFORCE_BASE_URL = 'http://127.0.0.1:3001';
