import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';

const databaseName = `couple_policy_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
const origin = 'https://policy.example.test';
const password = 'PolicyTest!2026';
const originalEnvironment = { ...process.env };
const managedKeys = new Set<string>();
const received: { to: string[]; body: string }[] = [];
let app: FastifyInstance;
let smtp: SMTPServer | undefined;
let database: typeof import('../server/db.js');
let jobs: typeof import('../server/jobs.js');
let created = false;
type Account = { id: string; email: string; cookie: string; ip: string };
let a: Account;
let b: Account;

function setEnvironment(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    managedKeys.add(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  setEnvironment(values);
  try {
    return await operation();
  } finally {
    setEnvironment(previous);
  }
}

before(async () => {
  assert.match(databaseName, /^couple_policy_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  setEnvironment({
    DATABASE_URL: url.toString(),
    APP_URL: origin,
    NODE_ENV: 'production',
    COOKIE_SECURE: 'true',
    REQUIRE_VERIFIED_EMAIL: 'true',
    REGISTRATION_OPEN: 'true',
    TRUST_PROXY: '',
    SUPPORT_EMAIL: 'support@example.test',
    SMTP_HOST: '127.0.0.1',
    SMTP_FROM: 'policy-test@example.test',
    SMTP_SECURE: 'false',
    SMTP_USER: '',
    SMTP_PASS: '',
    BEICHEN_APP_ID: '',
    BEICHEN_APP_SECRET: '',
  });
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          to: session.envelope.rcptTo.map((recipient) => recipient.address),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    smtp!.once('error', reject);
    smtp!.listen(0, '127.0.0.1', resolve);
  });
  setEnvironment({ SMTP_PORT: String((smtp.server.address() as AddressInfo).port) });
  database = await import('../server/db.js');
  await database.migrate();
  jobs = await import('../server/jobs.js');
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
});

after(async () => {
  try {
    if (app) await app.close();
    if (smtp) await new Promise<void>((resolve) => smtp!.close(resolve));
    if (database) await database.closePool();
    if (created) await dropTestDatabase(admin, databaseName);
    await admin.end();
  } finally {
    for (const key of managedKeys) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
  }
});

async function api(
  method: 'GET' | 'POST',
  path: string,
  account?: Account,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    remoteAddress: account?.ip ?? '192.0.2.200',
    headers: {
      host: new URL(process.env.APP_URL || origin).host,
      'x-forwarded-proto': new URL(process.env.APP_URL || origin).protocol.replace(':', ''),
      origin: process.env.APP_URL || origin,
      ...(account ? { cookie: account.cookie } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
function ok(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
}
function status(response: { status: number; body: unknown }, expected: number) {
  assert.equal(response.status, expected, JSON.stringify(response));
}
function cookieHeader(headers: Record<string, unknown>) {
  const value = headers['set-cookie'];
  const cookie = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof cookie, 'string');
  return cookie as string;
}
async function register(index: number): Promise<Account> {
  const email = `policy-${index}@example.test`;
  const response = await api('POST', '/auth/register', undefined, {
    name: `运营验证${index}`,
    email,
    password,
    acceptTerms: true,
  });
  ok(response);
  const cookie = cookieHeader(response.headers);
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; SameSite=Lax/i);
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /; Path=\//i);
  return { id: response.body.user.id, email, cookie: cookie.split(';')[0], ip: `192.0.2.${index}` };
}
async function verification(account: Account) {
  const {
    rows: [mail],
  } = await database.query(
    "SELECT * FROM email_outbox WHERE user_id=$1 AND kind='VERIFY_EMAIL' ORDER BY created_at DESC,id DESC LIMIT 1",
    [account.id],
  );
  assert.ok(mail);
  const token = /[?&]verify=([a-f0-9]{64})/.exec(mail.body)?.[1];
  assert.ok(token);
  assert.equal(mail.to_email, account.email);
  const record = (
    await database.query('SELECT token_hash,used_at FROM email_tokens WHERE id=$1', [
      mail.email_token_id,
    ])
  ).rows[0];
  assert.equal(record.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(record.used_at, null);
  return { token, mail };
}

test('生产注册必须同意条款，自动发送邮箱验证，验证前不能创建或加入空间', async (t) => {
  await t.test('未接受条款不会建立账号，成功注册保存同意时间和安全Cookie', async () => {
    for (const acceptTerms of [undefined, false]) {
      status(
        await api('POST', '/auth/register', undefined, {
          name: '没有同意条款',
          email: 'no-consent@example.test',
          password,
          ...(acceptTerms === undefined ? {} : { acceptTerms }),
        }),
        400,
      );
    }
    assert.equal(
      (await database.query('SELECT 1 FROM users WHERE email=$1', ['no-consent@example.test']))
        .rowCount,
      0,
    );
    [a, b] = await Promise.all([register(1), register(2)]);
    const users = await database.query(
      'SELECT terms_accepted_at,email_verified FROM users WHERE id=ANY($1::uuid[])',
      [[a.id, b.id]],
    );
    assert.ok(users.rows.every((user) => user.terms_accepted_at && !user.email_verified));
    for (const account of [a, b]) {
      const state = await api('GET', '/bootstrap', account);
      assert.equal(state.body.requireVerifiedEmail, true);
      assert.equal(state.body.user.emailVerified, false);
      status(await api('POST', '/spaces', account, { name: '验证前不能创建' }), 403);
      status(await api('POST', '/spaces/join', account, { code: 'UNKNOWNCODE' }), 403);
    }
  });

  await t.test('注册自动产生两封本地SMTP邮件，验证单独生效后可成功配对', async () => {
    const [first, second] = await Promise.all([verification(a), verification(b)]);
    assert.ok(first.mail.body.includes(`${origin}/?verify=`));
    assert.ok(second.mail.body.includes(`${origin}/?verify=`));
    const batch = await jobs.runMailBatch();
    assert.equal(batch.sent, 2);
    assert.equal(batch.failed, 0);
    assert.equal(received.length, 2);
    assert.deepEqual(received.flatMap((mail) => mail.to).sort(), [a.email, b.email].sort());
    for (const mail of received) {
      assert.match(mail.body, /Content-Type: multipart\/alternative/i);
      assert.match(mail.body, /Content-Type: text\/html/i);
    }
    ok(await api('POST', '/auth/verify', a, { token: first.token }));
    const created = await api('POST', '/spaces', a, { name: '验证之后的两个人' });
    ok(created);
    status(await api('POST', '/spaces/join', b, { code: created.body.space.inviteCode }), 403);
    assert.equal((await api('GET', '/bootstrap', b)).body.user.emailVerified, false);
    ok(await api('POST', '/auth/verify', b, { token: second.token }));
    ok(await api('POST', '/spaces/join', b, { code: created.body.space.inviteCode }));
    ok(await api('POST', '/contract/accept', a, {}));
    ok(await api('POST', '/contract/accept', b, {}));
    assert.equal((await api('GET', '/bootstrap', a)).body.partner.id, b.id);
    ok(await api('POST', '/tasks', a, { title: '生产门槛通过后可用', reward: 1, mode: 'RACE' }));
    status(await api('POST', '/auth/verify', b, { token: second.token }), 400);
  });

  await t.test('关闭注册拒绝新邮箱账号，但已有用户仍能登录使用', async () => {
    await withEnvironment({ REGISTRATION_OPEN: 'false' }, async () => {
      status(
        await api('POST', '/auth/register', undefined, {
          name: '临时关闭',
          email: 'closed@example.test',
          password,
          acceptTerms: true,
        }),
        503,
      );
      assert.equal(
        (await database.query('SELECT 1 FROM users WHERE email=$1', ['closed@example.test']))
          .rowCount,
        0,
      );
      assert.equal((await api('GET', '/bootstrap')).body.registrationOpen, false);
      const logged = await api('POST', '/auth/login', undefined, { email: a.email, password });
      ok(logged);
      assert.equal(logged.body.user.id, a.id);
      assert.match(cookieHeader(logged.headers), /; Secure/i);
      ok(await api('GET', '/tasks', a));
    });
    assert.equal(process.env.REGISTRATION_OPEN, 'true');
  });

  await t.test('强制邮箱验证但邮件配置缺失时拒绝注册且不留下半成品账号', async () => {
    await withEnvironment({ SMTP_HOST: '' }, async () => {
      status(
        await api('POST', '/auth/register', undefined, {
          name: '缺邮件服务',
          email: 'smtp-missing@example.test',
          password,
          acceptTerms: true,
        }),
        503,
      );
      assert.equal(
        (await database.query('SELECT 1 FROM users WHERE email=$1', ['smtp-missing@example.test']))
          .rowCount,
        0,
      );
    });
    assert.equal(process.env.SMTP_HOST, '127.0.0.1');
  });
});

test('生产安全头、跨站写入保护与退出Cookie', async () => {
  const health = await api('GET', '/health');
  ok(health);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.equal(health.headers['referrer-policy'], 'no-referrer');
  assert.equal(health.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
  const policy = String(health.headers['content-security-policy']);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  for (const headers of [
    { origin: 'https://attacker.example.test' },
    { 'sec-fetch-site': 'cross-site' },
  ] as Record<string, string>[]) {
    const rejected = await api(
      'POST',
      '/tasks',
      a,
      { title: '跨站不应写入', reward: 1, mode: 'RACE' },
      headers,
    );
    status(rejected, 403);
    assert.equal(rejected.body.error, '请求来源不被允许');
  }
  status(
    await api('POST', '/tasks', a, { title: 'a'.repeat(40_000), reward: 1, mode: 'RACE' }),
    413,
  );
  const loggedOut = await api('POST', '/auth/logout', a, {});
  ok(loggedOut);
  const cleared = cookieHeader(loggedOut.headers);
  assert.match(cleared, /; HttpOnly/i);
  assert.match(cleared, /; SameSite=Lax/i);
  assert.match(cleared, /; Secure/i);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);
  status(await api('GET', '/tasks', a), 401);
});

async function limitedRequest(target: FastifyInstance, address: string, forwarded: string) {
  return target.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: address,
    headers: { origin, 'x-forwarded-for': forwarded },
    payload: {},
  });
}
async function exhaust(
  target: FastifyInstance,
  address: string,
  forwarded: string | ((index: number) => string),
) {
  for (let index = 0; index < 20; index++) {
    const response = await limitedRequest(
      target,
      address,
      typeof forwarded === 'string' ? forwarded : forwarded(index),
    );
    assert.equal(response.statusCode, 400, response.body);
  }
  const response = await limitedRequest(
    target,
    address,
    typeof forwarded === 'string' ? forwarded : forwarded(20),
  );
  assert.equal(response.statusCode, 429, response.body);
  assert.equal(response.json().error, '操作太频繁，请稍后再试');
  assert.ok(response.headers['retry-after']);
  assert.ok(!response.body.includes('500'));
}

test('仅明确可信的loopback代理可以按转发客户端IP分开限流', async () => {
  await withEnvironment({ TRUST_PROXY: 'loopback' }, async () => {
    const { buildApp } = await import('../server/app.js');
    const trusted = await buildApp();
    try {
      await exhaust(trusted, '127.0.0.1', '198.51.100.10');
      const differentClient = await limitedRequest(trusted, '127.0.0.1', '198.51.100.11');
      assert.equal(differentClient.statusCode, 400, differentClient.body);
      const limitedAgain = await limitedRequest(trusted, '127.0.0.1', '198.51.100.10');
      assert.equal(limitedAgain.statusCode, 429, limitedAgain.body);
      // A public peer is outside the configured trusted network, even if it adds XFF.
      await exhaust(trusted, '203.0.113.10', (index) => `198.51.100.${index + 30}`);
    } finally {
      await trusted.close();
    }
  });
  assert.equal(process.env.TRUST_PROXY, '');
});

test('未启用可信代理时伪造XFF不能绕过限流，过限返回真实429', async () => {
  const { buildApp } = await import('../server/app.js');
  await withEnvironment({ TRUST_PROXY: '' }, async () => {
    const untrusted = await buildApp();
    try {
      await exhaust(untrusted, '127.0.0.1', (index) => `198.51.100.${index + 100}`);
      const otherPeer = await limitedRequest(untrusted, '192.0.2.201', '198.51.100.100');
      assert.equal(otherPeer.statusCode, 400, otherPeer.body);
    } finally {
      await untrusted.close();
    }
  });
});

test('生产配置拒绝不安全或缺失的必填项，正确配置无需连接任何公网服务即可通过', async (t) => {
  const { validateProductionConfig } = await import('../server/config.js');
  const baseline = {
    NODE_ENV: 'production',
    APP_URL: origin,
    COOKIE_SECURE: 'true',
    DATABASE_URL: 'postgresql://policy:V7q2m8X4r9N6c3H5s1K0z8J2@database.invalid:5432/couple',
    REQUIRE_VERIFIED_EMAIL: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_FROM: 'policy-test@example.test',
    SUPPORT_EMAIL: 'support@example.test',
  };
  const actualDatabaseUrl = process.env.DATABASE_URL;
  await withEnvironment(baseline, async () => {
    await t.test('完整HTTPS、随机数据库密码、安全Cookie和邮件支持邮箱通过', () => {
      // validateProductionConfig is synchronous; it parses values without opening sockets.
      assert.doesNotThrow(validateProductionConfig);
    });
    for (const [name, values, message] of [
      ['非法地址', { APP_URL: 'not-a-url' }, /地址格式/],
      ['站点路径', { APP_URL: `${origin}/subpath` }, /无路径/],
      ['站点凭据', { APP_URL: 'https://name:password@policy.example.test' }, /地址/],
      [
        '短数据库密码',
        { DATABASE_URL: 'postgresql://policy:short@database.invalid/couple' },
        /24 位/,
      ],
      [
        '占位数据库密码',
        {
          DATABASE_URL:
            'postgresql://policy:replace-with-long-password-please@database.invalid/couple',
        },
        /随机数据库密码/,
      ],
      ['缺少数据库连接', { DATABASE_URL: undefined }, /DATABASE_URL/],
      ['未启用安全Cookie', { COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
      ['错误支持邮箱', { SUPPORT_EMAIL: 'not-an-email' }, /SUPPORT_EMAIL/],
    ] as const) {
      await t.test(name, async () => {
        await withEnvironment(values, () => assert.throws(validateProductionConfig, message));
        assert.doesNotThrow(
          validateProductionConfig,
          'The temporary invalid environment must be restored',
        );
      });
    }
    await t.test('未要求邮箱验证时可明确关闭SMTP，非生产环境不强制生产门槛', async () => {
      await withEnvironment({ REQUIRE_VERIFIED_EMAIL: 'false', SMTP_HOST: '', SMTP_FROM: '' }, () =>
        assert.doesNotThrow(validateProductionConfig),
      );
      await withEnvironment(
        { NODE_ENV: 'test', APP_URL: '', COOKIE_SECURE: 'false', DATABASE_URL: '' },
        () => assert.doesNotThrow(validateProductionConfig),
      );
      assert.equal(process.env.NODE_ENV, 'production');
    });
  });
  assert.equal(process.env.DATABASE_URL, actualDatabaseUrl);
  assert.equal(process.env.NODE_ENV, 'production');
});
