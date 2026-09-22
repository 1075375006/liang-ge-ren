import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { dropTestDatabase } from './database-fixture.js';

const databaseName = `couple_contract_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let created = false;
type Account = { cookie: string; email: string };
async function api(method: 'GET' | 'POST', path: string, account?: Account, payload?: unknown) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    remoteAddress: '127.0.0.1',
    headers: { origin: 'http://localhost:33442', ...(account ? { cookie: account.cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
async function register(name: string): Promise<Account> {
  const email = `${name}@example.test`;
  const response = await api('POST', '/auth/register', undefined, {
    name,
    email,
    password: 'ContractTest!2026',
    termsAccepted: true,
  });
  assert.equal(response.status, 200);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  assert.ok(cookie);
  return { cookie, email };
}
before(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = target.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  process.env.COOKIE_SECURE = 'false';
  database = await import('../server/db.js');
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
});
after(async () => {
  if (app) await app.close();
  if (database) await database.closePool();
  if (created) await dropTestDatabase(admin, databaseName);
  await admin.end();
});

test('配对后双方必须确认相处契约，确认后才开放业务', async () => {
  const a = await register('contract-a');
  const b = await register('contract-b');
  const createdSpace = await api('POST', '/spaces', a, { name: '契约空间' });
  assert.equal(createdSpace.status, 200);
  assert.equal(
    (await api('POST', '/spaces/join', b, { code: createdSpace.body.space.inviteCode })).status,
    200,
  );
  const initial = await api('GET', '/bootstrap', a);
  assert.equal(initial.body.contract.ready, false);
  assert.match(initial.body.contract.text, /认真对待/);
  assert.equal(
    (await api('POST', '/tasks', a, { title: '不该提前开放', reward: 1, mode: 'RACE' })).status,
    409,
  );
  assert.equal((await api('POST', '/contract/accept', a)).status, 200);
  assert.equal(
    (await api('POST', '/tasks', a, { title: '仍要等另一半', reward: 1, mode: 'RACE' })).status,
    409,
  );
  assert.equal((await api('POST', '/contract/accept', b)).status, 200);
  const ready = await api('GET', '/bootstrap', a);
  assert.equal(ready.body.contract.ready, true);
  assert.equal(
    (await api('POST', '/tasks', a, { title: '现在可以开始', reward: 1, mode: 'RACE' })).status,
    200,
  );
});
