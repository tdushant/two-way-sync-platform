import { Client } from 'pg';

export async function pingPostgres(connectionString: string, timeoutMs = 1000): Promise<void> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}
