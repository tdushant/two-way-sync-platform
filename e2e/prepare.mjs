import { execSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { Client } from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const portalUrl = 'postgresql://portal:portal@127.0.0.1:5434/portal_e2e';
const salesforceUrl = 'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce_e2e';

async function ensureDatabase(adminUrl, database) {
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to ${adminUrl}. Start the local databases with "docker compose up -d --wait". ${message}`,
      { cause: error },
    );
  }
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await client.end();
  }
}

function migrate(filter, env) {
  execSync(`pnpm --filter ${filter} exec prisma migrate deploy`, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

await ensureDatabase('postgresql://portal:portal@127.0.0.1:5434/portal', 'portal_e2e');
await ensureDatabase(
  'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce',
  'salesforce_e2e',
);
migrate('portal-api', { PORTAL_DATABASE_URL: portalUrl });
migrate('fake-salesforce', { SALESFORCE_DATABASE_URL: salesforceUrl });
