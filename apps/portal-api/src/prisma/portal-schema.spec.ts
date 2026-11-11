import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const TIMESTAMP_COLUMNS = [
  ['customers', 'created_at'],
  ['customers', 'updated_at'],
  ['contacts', 'created_at'],
  ['contacts', 'updated_at'],
  ['field_history', 'source_changed_at'],
  ['field_history', 'applied_at'],
  ['processed_events', 'received_at'],
  ['processed_events', 'processed_at'],
  ['outbox_events', 'next_attempt_at'],
  ['outbox_events', 'lease_until'],
  ['outbox_events', 'created_at'],
  ['outbox_events', 'updated_at'],
  ['field_sync_state', 'source_changed_at'],
  ['field_sync_state', 'last_applied_at'],
  ['sync_checkpoints', 'last_success_at'],
  ['sync_checkpoints', 'updated_at'],
  ['sync_operations', 'created_at'],
  ['sync_operations', 'expires_at'],
  ['reconciliation_runs', 'started_at'],
  ['reconciliation_runs', 'completed_at'],
  ['client_idempotency_keys', 'created_at'],
] as const;

function portalDatabaseUrl(): string {
  if (process.env.PORTAL_SCHEMA_DATABASE_URL) {
    return process.env.PORTAL_SCHEMA_DATABASE_URL;
  }
  const text = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('PORTAL_DATABASE_URL=')) {
      return line.slice('PORTAL_DATABASE_URL='.length);
    }
  }
  throw new Error('PORTAL_DATABASE_URL is missing from .env.example');
}

describe('portal database schema', () => {
  const client = new Client({
    connectionString: portalDatabaseUrl(),
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

  it('creates the portal tables and no others', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      '_prisma_migrations',
      'client_idempotency_keys',
      'contacts',
      'customers',
      'field_history',
      'field_sync_state',
      'outbox_events',
      'processed_events',
      'reconciliation_runs',
      'sync_checkpoints',
      'sync_operations',
    ]);
  });

  it('stores every timestamp column as timestamptz', async () => {
    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND (column_name LIKE '%\\_at' OR column_name = 'lease_until')
       ORDER BY table_name, column_name`,
      [TIMESTAMP_COLUMNS.map(([table]) => table)],
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
    const naive = await client.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`,
    );
    expect(naive.rows).toEqual([]);
  });

  it('keeps a written instant in UTC', async () => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query<{ created_at: string }>(
        `INSERT INTO customers (name, created_at, updated_at)
         VALUES ('utc', '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:00.000Z')
         RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`,
      );
      expect(inserted.rows[0]?.created_at).toBe('2026-11-11T10:00:00.000Z');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('allows many null external ids and rejects a duplicate salesforce id', async () => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO customers (name) VALUES ('unmapped-a'), ('unmapped-b') RETURNING salesforce_id`,
      );
      expect(inserted.rowCount).toBe(2);
      expect(
        inserted.rows.every((row: { salesforce_id: string | null }) => row.salesforce_id === null),
      ).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }

    await expectSqlState(
      `INSERT INTO customers (name, salesforce_id) VALUES ('a', 'SF-DUP'), ('b', 'SF-DUP')`,
      '23505',
    );
    await expectSqlState(
      `INSERT INTO customers (id, name) VALUES (gen_random_uuid(), 'parent');
       INSERT INTO contacts (customer_id, salesforce_id)
       SELECT id, 'SF-CON-DUP' FROM customers WHERE name = 'parent';
       INSERT INTO contacts (customer_id, salesforce_id)
       SELECT id, 'SF-CON-DUP' FROM customers WHERE name = 'parent'`,
      '23505',
    );
  });

  it('requires an existing customer and refuses to delete one that still has contacts', async () => {
    const definition = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'contacts_customer_id_fkey'`,
    );
    expect(definition.rows[0]?.definition).toBe(
      'FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    );
    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'contacts_customer_id_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(customer_id)');

    await expectSqlState(
      `INSERT INTO contacts (customer_id) VALUES ('00000000-0000-4000-8000-000000000099')`,
      '23503',
    );

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO customers (id, name) VALUES ('00000000-0000-4000-8000-0000000000aa', 'parent')`,
      );
      const contacts = await client.query(
        `INSERT INTO contacts (customer_id, email)
         VALUES ('00000000-0000-4000-8000-0000000000aa', 'same@example.com'),
                ('00000000-0000-4000-8000-0000000000aa', 'same@example.com')`,
      );
      expect(contacts.rowCount).toBe(2);
      await expect(
        client.query(`DELETE FROM customers WHERE id = '00000000-0000-4000-8000-0000000000aa'`),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('checks field history source and decision values', async () => {
    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'field_history_entity_applied_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(entity_type, entity_id, applied_at)');

    await expectSqlState(
      `INSERT INTO field_history (entity_type, entity_id, field_name, source, decision)
       VALUES ('customer', gen_random_uuid(), 'name', 'LOCAL', 'APPLIED')`,
      '23514',
    );
    await expectSqlState(
      `INSERT INTO field_history (entity_type, entity_id, field_name, source, decision)
       VALUES ('customer', gen_random_uuid(), 'name', 'PORTAL', 'SUPERSEDED')`,
      '23514',
    );

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO field_history (
           entity_type, entity_id, field_name, old_value, new_value, source, decision
         ) VALUES (
           'customer', gen_random_uuid(), 'name', 'null'::jsonb, '"Seed"'::jsonb, 'SALESFORCE', 'CONFLICT_LOST'
         )`,
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('uses event_id as the processed_events primary key and checks status', async () => {
    const key = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'processed_events'::regclass AND contype = 'p'`,
    );
    expect(key.rows[0]?.definition).toBe('PRIMARY KEY (event_id)');

    await expectSqlState(
      `INSERT INTO processed_events (event_id, payload_hash, status) VALUES ('evt-1', 'hash', 'NOPE')`,
      '23514',
    );
    await expectSqlState(
      `INSERT INTO processed_events (event_id, payload_hash, status)
       VALUES ('evt-1', 'hash-a', 'APPLIED'), ('evt-1', 'hash-b', 'IGNORED')`,
      '23505',
    );
  });

  it('checks outbox status and keeps the claim indexes', async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE indexname IN (
         'outbox_events_operation_id_key',
         'outbox_events_status_next_attempt_idx',
         'outbox_events_due_idx',
         'outbox_events_lease_idx'
       )`,
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('outbox_events_operation_id_key')).toContain('UNIQUE');
    expect(byName.get('outbox_events_status_next_attempt_idx')).toContain(
      '(status, next_attempt_at)',
    );
    expect(byName.get('outbox_events_status_next_attempt_idx')).not.toContain('WHERE');
    expect(byName.get('outbox_events_due_idx')).toContain('(next_attempt_at, id)');
    expect(byName.get('outbox_events_due_idx')).toContain('PENDING');
    expect(byName.get('outbox_events_due_idx')).toContain('RETRY');
    expect(byName.get('outbox_events_lease_idx')).toContain('(lease_until)');
    expect(byName.get('outbox_events_lease_idx')).toContain('IN_FLIGHT');

    for (const status of ['BLOCKED', 'SUPERSEDED']) {
      await expectSqlState(
        `INSERT INTO outbox_events (
           operation_id, entity_type, entity_id, event_type, changed_fields, base_versions, status
         ) VALUES (
           gen_random_uuid(), 'customer', gen_random_uuid(), 'created', '{}'::jsonb, '{}'::jsonb, '${status}'
         )`,
        '23514',
      );
    }

    await client.query('BEGIN');
    try {
      for (const status of ['PENDING', 'IN_FLIGHT', 'RETRY', 'COMPLETED', 'DEAD']) {
        const inserted = await client.query(
          `INSERT INTO outbox_events (
             operation_id, entity_type, entity_id, event_type, changed_fields, base_versions, status
           ) VALUES (
             gen_random_uuid(), 'customer', gen_random_uuid(), 'created', '{}'::jsonb, '{}'::jsonb, $1
           )`,
          [status],
        );
        expect(inserted.rowCount).toBe(1);
      }
    } finally {
      await client.query('ROLLBACK');
    }

    await expectSqlState(
      `INSERT INTO outbox_events (
         operation_id, entity_type, entity_id, event_type, changed_fields, base_versions, status
       ) VALUES
         ('00000000-0000-4000-8000-0000000000bb', 'customer', gen_random_uuid(), 'created', '{}'::jsonb, '{}'::jsonb, 'PENDING'),
         ('00000000-0000-4000-8000-0000000000bb', 'customer', gen_random_uuid(), 'updated', '{}'::jsonb, '{}'::jsonb, 'RETRY')`,
      '23505',
    );
  });

  it('uses the field sync composite primary key and checks source', async () => {
    const key = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'field_sync_state'::regclass AND contype = 'p'`,
    );
    expect(key.rows[0]?.definition).toBe('PRIMARY KEY (entity_type, entity_id, field_name)');

    await expectSqlState(
      `INSERT INTO field_sync_state (
         entity_type, entity_id, field_name, source, source_version, source_changed_at, last_applied_at
       ) VALUES (
         'customer', gen_random_uuid(), 'name', 'LOCAL', '1', now(), now()
       )`,
      '23514',
    );
    await expectSqlState(
      `WITH row AS (
         SELECT gen_random_uuid() AS entity_id
       )
       INSERT INTO field_sync_state (
         entity_type, entity_id, field_name, source, source_version, source_changed_at, last_applied_at
       )
       SELECT 'customer', entity_id, 'name', 'PORTAL', '1', now(), now() FROM row
       UNION ALL
       SELECT 'customer', entity_id, 'name', 'SALESFORCE', '2', now(), now() FROM row`,
      '23505',
    );
  });

  it('checks sync operation status and indexes external id with status', async () => {
    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'sync_operations_external_status_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(external_id, status)');

    await expectSqlState(
      `INSERT INTO sync_operations (operation_id, entity_type, entity_id, fields, expected_values, status)
       VALUES (gen_random_uuid(), 'customer', gen_random_uuid(), '[]'::jsonb, '{}'::jsonb, 'DEAD')`,
      '23514',
    );

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO sync_operations (operation_id, entity_type, entity_id, fields, expected_values, status)
         VALUES (gen_random_uuid(), 'contact', gen_random_uuid(), '["email"]'::jsonb, '{"email":null}'::jsonb, 'ACKED')`,
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keys checkpoints by stream name and leaves reconciliation status open', async () => {
    const checkpoint = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'sync_checkpoints'::regclass AND contype = 'p'`,
    );
    expect(checkpoint.rows[0]?.definition).toBe('PRIMARY KEY (stream_name)');

    const checks = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'reconciliation_runs'::regclass AND contype = 'c'`,
    );
    expect(checks.rows).toEqual([]);

    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO reconciliation_runs (status, processed_count) VALUES ('RUNNING', 0)`,
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
