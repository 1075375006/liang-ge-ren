import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { dropTestDatabase } from './database-fixture.js';

const databaseName = `couple_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const adminDb = new pg.Pool({ connectionString: adminUrl });
let database: typeof import('../server/db.js');
let app: FastifyInstance;
let created = false;
const password = 'AdminPrivate!2026';
const userPassword = 'UserPrivate!2026';
let userCookie = '';

before(async () => {
  await adminDb.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.NODE_ENV = 'test';
  process.env.COOKIE_SECURE = 'false';
  process.env.ADMIN_BOOTSTRAP_TOKEN = 'one-time-admin-bootstrap';
  process.env.ADMIN_SECRET_KEY = randomBytes(32).toString('base64');
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  process.env.BEICHEN_APP_ID = '';
  process.env.BEICHEN_APP_KEY = '';
  database = await import('../server/db.js');
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  if (database) await database.closePool();
  if (created) await dropTestDatabase(adminDb, databaseName);
  await adminDb.end();
});

function cookieFrom(headers: Record<string, unknown>): string {
  const value = headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof first, 'string');
  return String(first).split(';')[0];
}

async function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: unknown,
  cookie?: string,
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    headers: { origin: 'http://localhost:33442', ...(cookie ? { cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() as any, headers: response.headers };
}

test('后台首次初始化、独立会话和设置密文', async () => {
  const denied = await api('GET', '/admin/session');
  assert.equal(denied.status, 401);
  const setup = await api('POST', '/admin/setup', {
    username: 'owner',
    password,
    bootstrapToken: 'one-time-admin-bootstrap',
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const adminCookie = cookieFrom(setup.headers);
  assert.equal(
    (await api('GET', '/admin/session', undefined, adminCookie)).body.admin.username,
    'owner',
  );
  assert.equal(
    (
      await api('POST', '/admin/setup', {
        username: 'other',
        password,
        bootstrapToken: 'one-time-admin-bootstrap',
      })
    ).status,
    409,
  );

  const email = await api(
    'PATCH',
    '/admin/settings/email',
    {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTls: true,
      user: 'mailer@example.test',
      pass: 'secret-mail-password',
      from: 'hello@example.test',
    },
    adminCookie,
  );
  assert.equal(email.status, 200, JSON.stringify(email.body));
  assert.equal(email.body.settings.hasPassword, true);
  assert.equal(JSON.stringify(email.body).includes('secret-mail-password'), false);
  const emailView = await api('GET', '/admin/settings/email', undefined, adminCookie);
  assert.equal(emailView.body.settings.host, 'smtp.example.test');
  assert.equal(emailView.body.settings.hasPassword, true);
  assert.equal(JSON.stringify(emailView.body).includes('secret-mail-password'), false);

  const wechat = await api(
    'PATCH',
    '/admin/settings/wechat',
    {
      enabled: true,
      appId: 'app-id',
      appKey: 'secret-wechat-key',
    },
    adminCookie,
  );
  assert.equal(wechat.status, 200);
  assert.equal(wechat.body.settings.configured, true);
  assert.equal(JSON.stringify(wechat.body).includes('secret-wechat-key'), false);
  const stored = await database.query<{ value_encrypted: string }>(
    'SELECT value_encrypted FROM admin_settings ORDER BY key',
  );
  assert.equal(stored.rowCount, 2);
  assert.ok(stored.rows.every((row) => !row.value_encrypted.includes('secret')));

  const logout = await api('POST', '/admin/logout', undefined, adminCookie);
  assert.equal(logout.status, 200);
  assert.equal((await api('GET', '/admin/session', undefined, adminCookie)).status, 401);
});

test('后台概览、用户游标和暂停会撤销普通会话', async () => {
  const login = await api('POST', '/admin/login', { username: 'owner', password });
  assert.equal(login.status, 200);
  const adminCookie = cookieFrom(login.headers);
  const registration = await api('POST', '/auth/register', {
    name: '后台测试用户',
    email: `admin-user-${randomUUID()}@example.test`,
    password: userPassword,
  });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  userCookie = cookieFrom(registration.headers);
  const userId = registration.body.user.id as string;

  const overview = await api('GET', '/admin/overview', undefined, adminCookie);
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.ok(Number(overview.body.overview.users) >= 1);
  assert.equal(typeof overview.body.mail.configured, 'boolean');
  assert.equal(typeof overview.body.database.healthy, 'boolean');

  const list = await api('GET', '/admin/users?search=后台测试用户&limit=1', undefined, adminCookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.users.length, 1);
  assert.equal(list.body.users[0].id, userId);
  assert.equal(list.body.users[0].hasPassword, true);
  const suspend = await api(
    'PATCH',
    `/admin/users/${userId}/suspend`,
    { suspended: true, reason: '测试暂停' },
    adminCookie,
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
  assert.equal(suspend.body.user.suspendReason, '测试暂停');
  assert.equal((await api('GET', '/bootstrap', undefined, userCookie)).body.user, null);
  const restore = await api(
    'PATCH',
    `/admin/users/${userId}/suspend`,
    { suspended: false },
    adminCookie,
  );
  assert.equal(restore.status, 200);
});
