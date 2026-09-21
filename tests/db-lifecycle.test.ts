import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { dropTestDatabase } from './database-fixture.js';
const name = `couple_lifecycle_test_${randomUUID().replaceAll('-', '')}`;
const url =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: url });
let database: typeof import('../server/db.js');
let created = false;
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const target = new URL(url);
  target.pathname = `/${name}`;
  process.env.DATABASE_URL = target.toString();
  database = await import('../server/db.js');
});
after(async () => {
  if (database) await database.closePool();
  if (created) await dropTestDatabase(admin, name);
  await admin.end();
});
test('空闲数据库连接被终止后，进程保留并在下一次请求重新连接', async () => {
  const {
    rows: [row],
  } = await database.query('SELECT pg_backend_pid() AS pid');
  const error = new Promise<Error>((resolve) => database.pool.once('error', resolve));
  await admin.query('SELECT pg_terminate_backend($1)', [row.pid]);
  assert.equal(((await error) as Error & { code: string }).code, '57P01');
  const {
    rows: [fresh],
  } = await database.query('SELECT pg_backend_pid() AS pid');
  assert.notEqual(fresh.pid, row.pid);
});
test('事务中的连接断开会拒绝事务并丢弃连接，不让进程崩溃或误报提交', async () => {
  let ready!: (pid: number) => void;
  let resume!: () => void;
  let disconnected!: () => void;
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const continueOperation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const connectionEnded = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const work = database.transaction(async (client) => {
    assert.ok(client.listenerCount('error') > 0, 'checked-out connections need an error handler');
    client.once('error', disconnected);
    await client.query('CREATE TABLE lifecycle_uncommitted(value integer)');
    const {
      rows: [row],
    } = await client.query('SELECT pg_backend_pid() AS pid');
    ready(row.pid);
    await continueOperation;
    return 'not committed';
  });
  const rejected = assert.rejects(
    work,
    /terminating connection|not queryable|Connection terminated/i,
  );
  const pid = await started;
  await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  await connectionEnded;
  resume();
  await rejected;
  const {
    rows: [result],
  } = await database.query("SELECT to_regclass('lifecycle_uncommitted') AS marker");
  assert.equal(result.marker, null);
});

test('关闭连接池等待所有socket结束，再清理测试库且不强制杀连接', async () => {
  const clients = await Promise.all(Array.from({ length: 6 }, () => database.pool.connect()));
  let ended = 0;
  for (const client of clients) client.once('end', () => ended++);
  clients.forEach((client) => client.release());
  await database.closePool();
  assert.equal(ended, 6);
  await database.closePool();
  await dropTestDatabase(admin, name);
  created = false;
});
