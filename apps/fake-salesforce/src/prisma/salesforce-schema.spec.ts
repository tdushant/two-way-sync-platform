import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const TIMESTAMP_COLUMNS = [
  ['sf_accounts', 'system_modstamp'],
  ['sf_accounts', 'created_at'],
  ['sf_contacts', 'system_modstamp'],
  ['sf_change_log', 'occurred_at'],
  ['sf_webhook_deliveries', 'scheduled_at'],
  ['sf_webhook_deliveries', 'delivered_at'],
  ['sf_webhook_deliveries', 'created_at'],
  ['sf_api_request_log', 'request_at'],
  ['sf_idempotency_keys', 'created_at'],
] as const;

function salesforceDatabaseUrl(): string {
  const url = process.env.SALESFORCE_DATABASE_URL;
  if (!url) {
    throw new Error('SALESFORCE_DATABASE_URL is required');
  }
  const parsed = new URL(url);
  if (
    parsed.username !== 'salesforce' ||
    parsed.pathname !== '/salesforce' ||
    parsed.port === '5434'
  ) {
    throw new Error('Refusing to open a database that is not salesforce-db');
  }
  return url;
}

describe('fake salesforce database schema', () => {
  const client = new Client({
    connectionString: salesforceDatabaseUrl(),
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function expectSqlState(sql: string, code: string): Promise<void> {
    await client.query('BEGIN');
    try {
      await expect(client.query(sql)).rejects.toMatchObject({ code });
    } finally {
      await client.query('ROLLBACK');
    }
  }

  it('reads only the salesforce database url', () => {
    const config = readFileSync(resolve(__dirname, '../../prisma.config.ts'), 'utf8');
    const example = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
    expect(config).toContain("env('SALESFORCE_DATABASE_URL')");
    expect(config).not.toContain('PORTAL_DATABASE_URL');
    const values = new Map<string, string>();
    for (const line of example.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0 && !line.startsWith('#')) {
        values.set(line.slice(0, separator), line.slice(separator + 1));
      }
    }
    expect(values.get('SALESFORCE_DATABASE_URL')).not.toBe(values.get('PORTAL_DATABASE_URL'));
  });

  it('is connected to the salesforce database as the salesforce user', async () => {
    const identity = await client.query<{ current_database: string; current_user: string }>(
      'SELECT current_database(), current_user',
    );
    expect(identity.rows[0]).toEqual({
      current_database: 'salesforce',
      current_user: 'salesforce',
    });
  });

  it('creates the fake salesforce tables and no portal tables', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      '_prisma_migrations',
      'sf_accounts',
      'sf_api_request_log',
      'sf_change_log',
      'sf_contacts',
      'sf_idempotency_keys',
      'sf_simulator_config',
      'sf_webhook_deliveries',
    ]);
  });

  it('stores timestamps as timestamptz', async () => {
    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND column_name = ANY($2::text[])
       ORDER BY table_name, column_name`,
      [
        [...new Set(TIMESTAMP_COLUMNS.map(([table]) => table))],
        TIMESTAMP_COLUMNS.map(([, column]) => column),
      ],
    );
    expect(result.rows).toEqual(
      TIMESTAMP_COLUMNS.map(([table_name, column_name]) => ({
        table_name,
        column_name,
        data_type: 'timestamp with time zone',
      })).sort((left, right) =>
        `${left.table_name}.${left.column_name}`.localeCompare(
          `${right.table_name}.${right.column_name}`,
        ),
      ),
    );
  });

  it('requires an account and refuses to delete one that still has contacts', async () => {
    const definition = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'sf_contacts_account_id_fkey'`,
    );
    expect(definition.rows[0]?.definition).toBe(
      'FOREIGN KEY (account_id) REFERENCES sf_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    );
    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'sf_contacts_account_id_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(account_id)');

    await expectSqlState(
      `INSERT INTO sf_contacts (id, account_id, version, system_modstamp) VALUES ('SF-CON-MISSING', 'SF-ACC-MISSING', 1, now())`,
      '23503',
    );

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO sf_accounts (id, version, system_modstamp) VALUES ('SF-ACC-PARENT', 1, now())`,
      );
      const contacts = await client.query(
        `INSERT INTO sf_contacts (id, account_id, email, version, system_modstamp)
         VALUES ('SF-CON-A', 'SF-ACC-PARENT', 'same@example.com', 1, now()),
                ('SF-CON-B', 'SF-ACC-PARENT', 'same@example.com', 1, now())`,
      );
      expect(contacts.rowCount).toBe(2);
      await expect(
        client.query(`DELETE FROM sf_accounts WHERE id = 'SF-ACC-PARENT'`),
      ).rejects.toMatchObject({
        code: '23503',
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('uses a BIGSERIAL change-log cursor and a unique event id', async () => {
    const sequence = await client.query<{ data_type: string; serial: string | null }>(
      `SELECT data_type, pg_get_serial_sequence('sf_change_log', 'sequence') AS serial
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sf_change_log' AND column_name = 'sequence'`,
    );
    expect(sequence.rows[0]?.data_type).toBe('bigint');
    expect(sequence.rows[0]?.serial).toContain('sf_change_log_sequence_seq');

    const key = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'sf_change_log'::regclass AND contype = 'p'`,
    );
    expect(key.rows[0]?.definition).toBe('PRIMARY KEY (sequence)');

    await client.query('BEGIN');
    try {
      const inserted = await client.query<{ sequence: string }>(
        `INSERT INTO sf_change_log (event_id, object_type, record_id, changed_fields, version, occurred_at)
         VALUES
           (gen_random_uuid(), 'Account', 'SF-ACC-001', '{"name":"A"}'::jsonb, 1, '2026-11-11T10:00:00.000Z'),
           (gen_random_uuid(), 'Contact', 'SF-CON-001', '{"email":"a@example.com"}'::jsonb, 2, '2026-11-11T10:00:01.000Z')
         RETURNING sequence::text`,
      );
      const first = inserted.rows[0]?.sequence;
      const second = inserted.rows[1]?.sequence;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(BigInt(second ?? '0') > BigInt(first ?? '0')).toBe(true);
      const instant = await client.query<{ occurred_at: string }>(
        `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
         FROM sf_change_log WHERE sequence = $1`,
        [first],
      );
      expect(instant.rows[0]?.occurred_at).toBe('2026-11-11T10:00:00.000Z');
    } finally {
      await client.query('ROLLBACK');
    }

    await expectSqlState(
      `INSERT INTO sf_change_log (event_id, object_type, record_id, changed_fields, version, occurred_at)
       VALUES
         ('00000000-0000-4000-8000-0000000000cc', 'Account', 'SF-ACC-001', '{}'::jsonb, 1, now()),
         ('00000000-0000-4000-8000-0000000000cc', 'Account', 'SF-ACC-001', '{}'::jsonb, 2, now())`,
      '23505',
    );
    await expectSqlState(
      `INSERT INTO sf_change_log (event_id, object_type, record_id, changed_fields, version, occurred_at)
       VALUES (gen_random_uuid(), 'Lead', 'SF-ACC-001', '{}'::jsonb, 1, now())`,
      '23514',
    );
  });

  it('indexes webhook deliveries for claim and replay without making event id unique', async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE indexname IN (
         'sf_webhook_deliveries_status_scheduled_idx',
         'sf_webhook_deliveries_event_id_idx'
       )`,
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('sf_webhook_deliveries_status_scheduled_idx')).toContain(
      '(status, scheduled_at)',
    );
    expect(byName.get('sf_webhook_deliveries_event_id_idx')).toContain('(event_id)');
    expect(byName.get('sf_webhook_deliveries_event_id_idx')).not.toContain('UNIQUE');

    const checks = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'sf_webhook_deliveries'::regclass AND contype = 'c'`,
    );
    expect(checks.rows).toEqual([]);

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO sf_webhook_deliveries (change_sequence, event_id, payload, attempts, scheduled_at, status)
         VALUES
           (1, '00000000-0000-4000-8000-0000000000dd', '{}'::jsonb, 0, now(), 'PENDING'),
           (1, '00000000-0000-4000-8000-0000000000dd', '{}'::jsonb, 1, now(), 'HOLD')`,
      );
      expect(inserted.rowCount).toBe(2);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps one simulator row and numeric rates', async () => {
    const rates = await client.query<{
      column_name: string;
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'sf_simulator_config'
         AND column_name IN ('failure_rate', 'rate_limit_per_sec', 'drop_webhook_rate')
       ORDER BY column_name`,
    );
    expect(rates.rows).toEqual([
      {
        column_name: 'drop_webhook_rate',
        data_type: 'numeric',
        numeric_precision: 65,
        numeric_scale: 30,
      },
      {
        column_name: 'failure_rate',
        data_type: 'numeric',
        numeric_precision: 65,
        numeric_scale: 30,
      },
      {
        column_name: 'rate_limit_per_sec',
        data_type: 'numeric',
        numeric_precision: 65,
        numeric_scale: 30,
      },
    ]);

    await expectSqlState(
      `INSERT INTO sf_simulator_config (
         id, outage_enabled, webhook_enabled, duplicate_count, delay_ms, disorder_mode,
         failure_rate, rate_limit_per_sec, drop_webhook_rate, response_delay_ms
       ) VALUES (2, false, true, 0, 0, 'ordered', 0, 1, 0, 0)`,
      '23514',
    );

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO sf_simulator_config (
           id, outage_enabled, webhook_enabled, duplicate_count, delay_ms, disorder_mode,
           failure_rate, rate_limit_per_sec, drop_webhook_rate, response_delay_ms
         ) VALUES (1, false, true, 0, 0, 'not-a-closed-mode', 0.5, 10, 0, 0)`,
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('logs requests without a body and without a unique operation id', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sf_api_request_log'
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'latency_ms',
      'method',
      'operation_id',
      'path',
      'request_at',
      'status_code',
    ]);

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO sf_api_request_log (method, path, operation_id, status_code, request_at, latency_ms)
         VALUES
           ('PATCH', '/sf/v1/accounts/SF-ACC-001', '66666666-6666-4666-8666-666666666666', 200, now(), 4),
           ('PATCH', '/sf/v1/accounts/SF-ACC-001', '66666666-6666-4666-8666-666666666666', 200, now(), 5)`,
      );
      expect(inserted.rowCount).toBe(2);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
