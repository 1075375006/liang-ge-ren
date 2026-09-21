import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://couple:couple@localhost:5432/couple',
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) => pool.query<T>(text, values);

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8').catch(() =>
    readFile(resolve('server/schema.sql'), 'utf8'),
  );
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(726031940)');
    await client.query(sql);
  });
}
