import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';

const databaseName = `couple_account_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let jobs: typeof import('../server/jobs.js');
let security: typeof import('../server/security.js');
let created = false;
let smtp: SMTPServer;
const received: string[] = [];
const resetMessages = () => received.filter((message) => message.includes('reset-password'));
const originalPassword = 'Private!Together2026';
const newPassword = 'NewPrivate!Together2026';
let ipCounter = 1;
type Account = { id: string; email: string; cookie: string };

before(async () => {
  assert.match(databaseName, /^couple_account_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const connection = new URL(adminUrl);
  connection.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = connection.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.COOKIE_SECURE = 'false';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.BEICHEN_APP_ID = '';
  process.env.BEICHEN_APP_SECRET = '';
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, _session, callback) {
      let message = '';
      stream.on('data', (chunk: Buffer) => {
        message += chunk.toString();
      });
      stream.on('end', () => {
        received.push(message);
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(0, '127.0.0.1', resolve);
  });
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String((smtp.server.address() as AddressInfo).port);
  process.env.SMTP_FROM = '两个人 <hello@example.test>';
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';
  database = await import('../server/db.js');
  await database.migrate();
  security = await import('../server/security.js');
  jobs = await import('../server/jobs.js');
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  if (smtp) await new Promise<void>((resolve) => smtp.close(resolve));
  if (database) await database.closePool();
  if (created) await dropTestDatabase(admin, databaseName);
  await admin.end();
});

async function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: unknown,
  account?: Account,
  remoteAddress?: string,
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    headers: { origin: 'http://localhost:33442', ...(account ? { cookie: account.cookie } : {}) },
    remoteAddress:
      remoteAddress ?? `127.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
function cookieFrom(headers: Record<string, unknown>): string {
  const value = headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof first, 'string');
  return String(first).split(';')[0];
}
async function register(suffix: string): Promise<Account> {
  const email = `${suffix}@example.test`;
  const result = await api('POST', '/auth/register', {
    name: suffix,
    email,
    password: originalPassword,
    termsAccepted: true,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { id: result.body.user.id, email, cookie: cookieFrom(result.headers) };
}
async function login(account: Account, password = originalPassword): Promise<Account> {
  const result = await api('POST', '/auth/login', { email: account.email, password });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { ...account, cookie: cookieFrom(result.headers) };
}
async function forgot(account: Account) {
  const result = await api('POST', '/auth/password/forgot', { email: account.email });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const {
    rows: [mail],
  } = await database.query(
    "SELECT * FROM email_outbox WHERE user_id=$1 AND kind='PASSWORD_RESET' ORDER BY created_at DESC,id DESC LIMIT 1",
    [account.id],
  );
  assert.ok(mail);
  const token = (mail.body as string).match(/#reset-password=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  return { token, mail, result };
}

test('密码恢复通过本地 SMTP 真实投递，令牌摘要、通用响应和微信账号边界', async () => {
  const account = await register('recover-a');
  const { token, mail, result } = await forgot(account);
  const unknown = await api('POST', '/auth/password/forgot', { email: 'nobody@example.test' });
  assert.equal(unknown.status, result.status);
  assert.deepEqual(unknown.body, result.body);
  const {
    rows: [record],
  } = await database.query('SELECT * FROM password_reset_tokens WHERE user_id=$1', [account.id]);
  assert.equal(record.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(record.token_hash, token);
  assert.ok(new Date(record.expires_at).getTime() - Date.now() <= 30 * 60 * 1000);
  assert.equal(mail.to_email, account.email);
  assert.ok(!mail.body.includes('?reset'));
  const before = resetMessages().length;
  await jobs.runMailBatch();
  assert.equal(resetMessages().length, before + 1);
  assert.match(resetMessages().at(-1)!, /recover-a@example\.test/);
  assert.match(resetMessages().at(-1)!, /reset-password/);
  assert.equal(
    (await database.query('SELECT status FROM email_outbox WHERE id=$1', [mail.id])).rows[0].status,
    'SENT',
  );
  // Password recovery is a security message and works before email verification or opting in.
  const user = (
    await database.query('SELECT email_verified,notify_email FROM users WHERE id=$1', [account.id])
  ).rows[0];
  assert.equal(user.email_verified, false);
  assert.equal(user.notify_email, false);
});

test('重置只能完成一次，撤销所有旧会话及微信绑定授权，再用新密码登录', async () => {
  const account = await register('recover-b');
  const second = await login(account);
  const { token } = await forgot(account);
  await database.query(
    `INSERT INTO oauth_states(state_hash,browser_hash,intent,user_id,session_hash,app_id,expires_at) VALUES($1,$2,'bind',$3,$4,'test-app',now()+interval '10 minutes')`,
    [
      security.digest(randomUUID()),
      security.digest(randomUUID()),
      account.id,
      security.digest(account.cookie.split('=')[1]),
    ],
  );
  const results = await Promise.all([
    api('POST', '/auth/password/reset', { token, password: newPassword }),
    api('POST', '/auth/password/reset', { token, password: newPassword }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await api('GET', '/bootstrap', undefined, account)).body.user, null);
  assert.equal((await api('GET', '/bootstrap', undefined, second)).body.user, null);
  assert.equal(
    (await database.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [account.id]))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await database.query('SELECT count(*)::int AS n FROM oauth_states WHERE user_id=$1', [
        account.id,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await api('POST', '/auth/login', { email: account.email, password: originalPassword })).status,
    401,
  );
  const fresh = await login(account, newPassword);
  assert.equal((await api('GET', '/bootstrap', undefined, fresh)).body.user.emailVerified, true);
  assert.equal(
    (await api('POST', '/auth/password/reset', { token, password: 'AnotherPass!2026' })).status,
    400,
  );
});

test('过期及无效重置链接拒绝，过期队列不会投递', async () => {
  const account = await register('expired');
  const { token, mail } = await forgot(account);
  await database.query(
    "UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [account.id],
  );
  assert.equal(
    (await api('POST', '/auth/password/reset', { token, password: newPassword })).status,
    400,
  );
  assert.equal(
    (await api('POST', '/auth/password/reset', { token: 'x', password: newPassword })).status,
    400,
  );
  assert.equal(
    (await api('POST', '/auth/password/reset', { token: '0'.repeat(64), password: newPassword }))
      .status,
    400,
  );
  const before = resetMessages().length;
  await jobs.runMailBatch();
  assert.equal(resetMessages().length, before);
  assert.equal(
    (await database.query('SELECT status FROM email_outbox WHERE id=$1', [mail.id])).rows[0].status,
    'FAILED',
  );
  await login(account);
});

test('再次申请使旧链接失效，并发申请与跨 IP 骚扰仍受邮箱冷却限制', async () => {
  const account = await register('replacement');
  const first = await forgot(account);
  const duplicate = await api('POST', '/auth/password/forgot', { email: account.email });
  assert.deepEqual(duplicate.body, first.result.body);
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1',
        [account.id],
      )
    ).rows[0].n,
    1,
  );
  await database.query(
    "UPDATE password_reset_tokens SET created_at=now()-interval '2 minutes' WHERE user_id=$1",
    [account.id],
  );
  await Promise.all([
    api('POST', '/auth/password/forgot', { email: account.email }),
    api('POST', '/auth/password/forgot', { email: account.email }),
  ]);
  const { rows: tokens } = await database.query(
    'SELECT * FROM password_reset_tokens WHERE user_id=$1 ORDER BY created_at',
    [account.id],
  );
  assert.equal(tokens.length, 2);
  assert.ok(tokens[0].used_at);
  assert.equal(tokens[1].used_at, null);
  assert.equal(
    (await api('POST', '/auth/password/reset', { token: first.token, password: newPassword }))
      .status,
    400,
  );
  const before = resetMessages().length;
  await jobs.runMailBatch();
  assert.equal(resetMessages().length, before + 1);
  assert.equal(
    (await database.query('SELECT status FROM email_outbox WHERE id=$1', [first.mail.id])).rows[0]
      .status,
    'FAILED',
  );
});

test('找回密码按 IP 限速，邮箱每小时最多三封安全邮件', async () => {
  const statuses: number[] = [];
  for (let n = 0; n < 6; n++)
    statuses.push(
      (
        await api(
          'POST',
          '/auth/password/forgot',
          { email: `absent-${n}@example.test` },
          undefined,
          '198.51.100.25',
        )
      ).status,
    );
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  const account = await register('hourly-limit');
  for (let n = 0; n < 5; n++) {
    await api('POST', '/auth/password/forgot', { email: account.email });
    await database.query(
      "UPDATE password_reset_tokens SET created_at=now()-interval '2 minutes' WHERE user_id=$1",
      [account.id],
    );
  }
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1',
        [account.id],
      )
    ).rows[0].n,
    3,
  );
});

test('修改密码校验当前密码、轮换本机会话、注销其他设备并废止重置链接', async () => {
  const account = await register('change-password');
  const second = await login(account);
  const { token } = await forgot(account);
  assert.equal(
    (
      await api('POST', '/account/password', {
        currentPassword: originalPassword,
        password: newPassword,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await api(
        'POST',
        '/account/password',
        { currentPassword: 'incorrect', password: newPassword },
        account,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        'POST',
        '/account/password',
        { currentPassword: originalPassword, password: originalPassword },
        account,
      )
    ).status,
    400,
  );
  const changed = await api(
    'POST',
    '/account/password',
    { currentPassword: originalPassword, password: newPassword },
    account,
  );
  assert.equal(changed.status, 200);
  const current = { ...account, cookie: cookieFrom(changed.headers) };
  assert.notEqual(current.cookie, account.cookie);
  assert.equal((await api('GET', '/bootstrap', undefined, account)).body.user, null);
  assert.equal((await api('GET', '/bootstrap', undefined, second)).body.user, null);
  assert.equal((await api('GET', '/bootstrap', undefined, current)).body.user.id, account.id);
  assert.equal(
    (await api('POST', '/auth/password/reset', { token, password: 'DifferentPassword123' })).status,
    400,
  );
  await login(account, newPassword);
});

test('昵称修改验证长度、空白及不可见字符，且只修改本人', async () => {
  const account = await register('nickname');
  const other = await register('nickname-other');
  assert.equal((await api('PATCH', '/account/profile', { name: '小熊' })).status, 401);
  for (const name of ['', '   ', '熊'.repeat(41), '小\u0000熊', '小\u200b熊']) {
    assert.equal((await api('PATCH', '/account/profile', { name }, account)).status, 400);
  }
  const result = await api(
    'PATCH',
    '/account/profile',
    { name: '  小熊 🧸  ', id: other.id },
    account,
  );
  assert.equal(result.status, 200);
  assert.equal((await api('GET', '/bootstrap', undefined, account)).body.user.name, '小熊 🧸');
  assert.equal((await api('GET', '/bootstrap', undefined, other)).body.user.name, 'nickname-other');
});

test('仅微信登录账号不能通过补充邮箱或伪造令牌获得密码登录', async () => {
  const account = await register('wechat-only');
  await database.query('UPDATE users SET password_hash=NULL,email_verified=true WHERE id=$1', [
    account.id,
  ]);
  const known = await api('POST', '/auth/password/forgot', { email: account.email });
  const unknown = await api('POST', '/auth/password/forgot', {
    email: 'unknown-wechat@example.test',
  });
  assert.deepEqual(known.body, unknown.body);
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1',
        [account.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await api(
        'POST',
        '/account/password',
        { currentPassword: originalPassword, password: newPassword },
        account,
      )
    ).status,
    409,
  );
  const token = '1'.repeat(64);
  await database.query(
    "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
    [account.id, security.digest(token)],
  );
  assert.equal(
    (await api('POST', '/auth/password/reset', { token, password: newPassword })).status,
    400,
  );
  assert.equal(
    (await api('POST', '/auth/login', { email: account.email, password: newPassword })).status,
    401,
  );
});

test('已注销账号不能通过恢复链接复活，跨站找回与改密请求被拒绝', async () => {
  const account = await register('deleted-account');
  const { token } = await forgot(account);
  await database.query('UPDATE users SET deleted_at=now() WHERE id=$1', [account.id]);
  assert.equal(
    (await api('POST', '/auth/password/reset', { token, password: newPassword })).status,
    400,
  );
  const result = await api('POST', '/auth/password/forgot', { email: account.email });
  assert.equal(result.status, 200);
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1',
        [account.id],
      )
    ).rows[0].n,
    1,
  );
  const crossSite = await app.inject({
    method: 'POST',
    url: '/api/auth/password/forgot',
    headers: { origin: 'https://evil.example' },
    payload: { email: account.email },
  });
  assert.equal(crossSite.statusCode, 403);
});

test('邮件服务未配置时明确提示且不消耗重置令牌', async () => {
  const account = await register('smtp-missing');
  const previous = process.env.SMTP_HOST;
  process.env.SMTP_HOST = '';
  try {
    const result = await api('POST', '/auth/password/forgot', { email: account.email });
    assert.equal(result.status, 503);
    assert.equal(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1',
          [account.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    process.env.SMTP_HOST = previous;
  }
});

test('重置与旧密码登录并发时，旧密码不能在会话撤销后创建有效登录', async () => {
  const account = await register('login-reset-race');
  const { token } = await forgot(account);
  const blocker = await database.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [account.id]);
  const pendingReset = api('POST', '/auth/password/reset', { token, password: newPassword });
  // Queue reset ahead of login at the user row lock, without relying on password-hash timing.
  async function waitForBlocked(count: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const {
        rows: [row],
      } = await database.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      if (row.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`expected ${count} account operations to wait on the row lock`);
  }
  let pendingLogin: ReturnType<typeof api> | undefined;
  try {
    await waitForBlocked(1);
    pendingLogin = api('POST', '/auth/login', { email: account.email, password: originalPassword });
    await waitForBlocked(2);
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const reset = await pendingReset;
  assert.equal(reset.status, 200);
  assert.ok(pendingLogin);
  const login = await pendingLogin;
  assert.equal(login.status, 401);
  assert.equal(
    (await database.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [account.id]))
      .rows[0].n,
    0,
  );
});
