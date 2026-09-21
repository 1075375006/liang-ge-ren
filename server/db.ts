import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://couple:couple@localhost:5432/couple',
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
});

// pg-pool can resolve end() before its clients' sockets have closed. Keep an
// explicit shutdown barrier for worker/server exits and isolated test teardown.
const connections = new Map<PoolClient, Promise<void>>();
pool.on('connect', (client) => {
  const ended = new Promise<void>((resolve) => {
    client.once('end', () => {
      connections.delete(client);
      resolve();
    });
  });
  connections.set(client, ended);
});
pool.on('error', (error) => {
  const value = (error as Error & { code?: unknown }).code;
  const code = typeof value === 'string' && /^[A-Z0-9_]+$/.test(value) ? value : 'CONNECTION_LOST';
  console.error(`[db] 空闲连接断开（${code}），后续请求将重新连接`);
});

let closing: Promise<void> | undefined;
export function closePool(): Promise<void> {
  return (closing ??= (async () => {
    await pool.end();
    await Promise.all([...connections.values()]);
  })());
}

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) => pool.query<T>(text, values);

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | undefined;
  const onConnectionError = (error: Error) => {
    connectionError = error;
  };
  client.on('error', onConnectionError);
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    if (connectionError) throw connectionError;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onConnectionError);
    client.release(connectionError);
  }
}

export async function migrate(): Promise<void> {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8').catch(() =>
    readFile(resolve('server/schema.sql'), 'utf8'),
  );
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(726031940)');
    await client.query(sql);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = new URL('./migrations/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => /^\d+[-\w]*\.sql$/.test(name)).sort();
    for (const name of names) {
      const migration = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(migration).digest('hex');
      const {
        rows: [applied],
      } = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`已执行的迁移不可修改：${name}`);
        continue;
      }
      await client.query(migration);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        name,
        checksum,
      ]);
    }
  });
}
