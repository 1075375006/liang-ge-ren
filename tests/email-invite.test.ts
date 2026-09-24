import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { dropTestDatabase } from './database-fixture.js';

const databaseName = `couple_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let database: typeof import('../server/db.js');
let app: FastifyInstance;
let created = false;
type Account = { cookie: string; email: string };

before(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = '';
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.COOKIE_SECURE = 'false';
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_FROM = 'notice@example.test';
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

async function api(method: 'GET' | 'POST', path: string, account?: Account, payload?: unknown) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    headers: {
      origin: 'http://localhost:33442',
      host: 'localhost:33442',
      'x-forwarded-proto': 'http',
      ...(account ? { cookie: account.cookie } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() as any, headers: response.headers };
}

function cookie(headers: Record<string, unknown>): string {
  const value = headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof first, 'string');
  return String(first).split(';')[0];
}

async function register(name: string, email: string): Promise<Account> {
  const response = await api('POST', '/auth/register', undefined, {
    name,
    email,
    password: 'InviteTest!2026',
    acceptTerms: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { email, cookie: cookie(response.headers) };
}

test('邮箱邀请可注册后绑定契约，并支持共同完成约定', async () => {
  const owner = await register('邀请发起人', 'owner@example.test');
  const createdSpace = await api('POST', '/spaces', owner, { name: '邮箱邀请空间' });
  assert.equal(createdSpace.status, 200);
  const sent = await api('POST', '/spaces/email-invite', owner, {
    email: 'partner@example.test',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const invite = (
    await database.query<{ token_hash: string; invite_email: string }>(
      'SELECT token_hash,invite_email FROM partner_invites ORDER BY created_at DESC LIMIT 1',
    )
  ).rows[0];
  assert.equal(invite.invite_email, 'partner@example.test');
  const outbox = (
    await database.query<{ body: string }>(
      "SELECT body FROM email_outbox WHERE kind='PARTNER_INVITE' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  const token = /[?&]invite=([a-f0-9]{64})/.exec(outbox.body)?.[1];
  assert.ok(token);
  assert.match(outbox.body, /http:\/\/localhost:33442\/\?invite=/);
  const partner = await register('受邀伴侣', 'partner@example.test');
  assert.equal((await api('POST', '/spaces/email-invite/accept', partner, { token })).status, 200);
  assert.equal((await api('GET', '/bootstrap', owner)).body.partner.name, '受邀伴侣');
  await api('POST', '/contract/accept', owner, {});
  await api('POST', '/contract/accept', partner, {});
  const together = await api('POST', '/tasks', owner, {
    title: '一起散步',
    description: '两个人一起完成',
    reward: 10,
    mode: 'TOGETHER',
  });
  assert.equal(together.status, 200, JSON.stringify(together.body));
  assert.equal(together.body.task.mode, 'TOGETHER');
});

test('强制邮箱验证时，邮箱邀请仍可让新账号直接进入契约确认', async () => {
  process.env.REQUIRE_VERIFIED_EMAIL = 'true';
  const owner = await register('验证邀请发起人', 'verified-owner@example.test');
  await database.query('UPDATE users SET email_verified=true WHERE email=$1', [owner.email]);
  const partner = await register('验证受邀伴侣', 'verified-partner@example.test');
  assert.equal((await api('POST', '/spaces', owner, { name: '验证邀请空间' })).status, 200);
  assert.equal(
    (await api('POST', '/spaces/email-invite', owner, { email: partner.email })).status,
    200,
  );
  const outbox = (
    await database.query<{ body: string }>(
      "SELECT body FROM email_outbox WHERE kind='PARTNER_INVITE' AND to_email=$1 ORDER BY created_at DESC LIMIT 1",
      [partner.email],
    )
  ).rows[0];
  const token = /[?&]invite=([a-f0-9]{64})/.exec(outbox.body)?.[1];
  assert.ok(token);
  const accepted = await api('POST', '/spaces/email-invite/accept', partner, { token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const bootstrap = await api('GET', '/bootstrap', partner);
  assert.equal(bootstrap.body.partner.name, '验证邀请发起人');
  assert.equal(bootstrap.body.user.emailVerified, false);
  assert.equal((await api('POST', '/contract/accept', partner, {})).status, 200);
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
});
