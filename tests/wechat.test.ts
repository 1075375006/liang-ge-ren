import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';

const databaseName = `couple_wechat_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let created = false;
const password = 'WechatTest!2026';

type CookieHeader = string | string[] | undefined;
type ResponseData = {
  status: number;
  body: any;
  headers: Record<string, any>;
};

const calls: Array<{ act: string; params: URLSearchParams }> = [];
const profiles = new Map<string, string>();
const callbackResponses = new Map<string, Record<string, unknown>>();
let authorizationResponse: Record<string, unknown> | undefined;
let callbackHook: (() => Promise<void>) | undefined;
let requestAddress = 0;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const providerFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, 'https://u.beichenwl.cn');
  assert.equal(url.pathname, '/connect.php');
  assert.equal(init?.redirect, 'error');
  const params = url.searchParams;
  assert.equal(params.get('appid'), 'test-app');
  assert.equal(params.get('appkey'), 'private-test-key');
  calls.push({ act: params.get('act') ?? '', params });
  if (params.get('act') === 'login') {
    // The authorization URL is intentionally a provider-owned HTTPS URL. The
    // callback redirect is captured from this request and used below.
    return Promise.resolve(
      new Response(
        JSON.stringify(
          authorizationResponse ?? {
            code: 0,
            type: 'wx',
            url: 'https://u.beichenwl.cn/mock-login',
          },
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  if (params.get('act') === 'callback') {
    if (callbackHook) await callbackHook();
    const response = callbackResponses.get(params.get('code') ?? '');
    if (response) return Response.json(response);
    const uid = profiles.get(params.get('code') ?? '');
    if (!uid) {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 2, type: 'wx' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ code: 0, type: 'wx', social_uid: uid, nickname: `微信-${uid}` }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
};

before(async () => {
  assert.match(databaseName, /^couple_wechat_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.COOKIE_SECURE = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  process.env.WECHAT_LOGIN_ENABLED = 'true';
  process.env.BEICHEN_APP_ID = 'test-app';
  process.env.BEICHEN_APP_KEY = 'private-test-key';
  database = await import('../server/db.js');
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp({ wechatFetch: providerFetch });
});

after(async () => {
  if (app) await app.close();
  if (database) await database.pool.end();
  if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

function bodyOf(response: { body: string }): any {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

async function api(
  method: 'GET' | 'POST',
  url: string,
  cookie?: string,
  payload?: unknown,
): Promise<ResponseData> {
  const response = await app.inject({
    method,
    url,
    remoteAddress: `127.1.${Math.floor(++requestAddress / 250)}.${(requestAddress % 250) + 1}`,
    headers: {
      origin: 'http://localhost:33442',
      ...(cookie ? { cookie } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: bodyOf(response), headers: response.headers };
}

function cookieValue(headers: Record<string, any>, name: string): string | undefined {
  const raw = headers['set-cookie'] as CookieHeader;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(';', 1)[0];
}

function sessionCookie(headers: Record<string, any>): string {
  const cookie = cookieValue(headers, 'couple_session');
  assert.ok(cookie, `missing session cookie: ${JSON.stringify(headers['set-cookie'])}`);
  return cookie;
}

function nonceCookie(headers: Record<string, any>): string {
  const cookie = cookieValue(headers, 'couple_wechat_nonce');
  assert.ok(cookie, `missing nonce cookie: ${JSON.stringify(headers['set-cookie'])}`);
  return cookie;
}

function stateFromLastLogin(): { state: string; redirectUri: string } {
  const call = calls.at(-1);
  assert.ok(call && call.act === 'login');
  const redirectUri = call.params.get('redirect_uri');
  assert.ok(redirectUri);
  const parsed = new URL(redirectUri);
  const state = parsed.pathname.split('/').at(-1) ?? '';
  assert.match(state, /^[a-f0-9]{64}$/);
  return { state, redirectUri };
}

async function start(intent: 'login' | 'bind', cookie?: string) {
  const response = await api('POST', '/api/auth/wechat/start', cookie, { intent });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.url, 'https://u.beichenwl.cn/mock-login');
  assert.ok(!JSON.stringify(response.body).includes('private-test-key'));
  const nonce = nonceCookie(response.headers);
  const { state, redirectUri } = stateFromLastLogin();
  return { state, redirectUri, nonce, cookie: cookie ? `${cookie}; ${nonce}` : nonce };
}

async function callback(state: string, code: string, cookie: string, type = 'wx') {
  return api('GET', `/api/auth/wechat/callback/${state}?type=${type}&code=${code}`, cookie);
}

async function register(name: string): Promise<{ id: string; cookie: string }> {
  const response = await api('POST', '/api/auth/register', undefined, {
    name,
    email: `${name}@example.test`,
    password,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { id: response.body.user.id, cookie: sessionCookie(response.headers) };
}

async function counts() {
  return (
    await database.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM sessions) AS sessions,
    (SELECT COUNT(*)::int FROM auth_identities) AS identities`)
  ).rows[0];
}

function expectFailure(response: ResponseData, reason: string) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/?wechat=error&reason=${reason}`);
  assert.equal(cookieValue(response.headers, 'couple_session'), undefined);
  assert.ok(!JSON.stringify(response).includes('private-test-key'));
}

async function wechatAccount(uid: string = randomUUID()) {
  const code = randomUUID();
  profiles.set(code, uid);
  const flow = await start('login');
  const response = await callback(flow.state, code, flow.nonce);
  assert.equal(response.headers.location, '/?wechat=logged_in');
  const cookie = sessionCookie(response.headers);
  const bootstrap = await api('GET', '/api/bootstrap', cookie);
  return { id: bootstrap.body.user.id as string, cookie, uid };
}

test('微信配置关闭时登录入口不可用且不泄露凭据', async () => {
  process.env.WECHAT_LOGIN_ENABLED = 'false';
  const response = await api('POST', '/api/auth/wechat/start', undefined, { intent: 'login' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, '微信登录暂未启用');
  assert.ok(!JSON.stringify(response.body).includes('private-test-key'));
  const bootstrap = await api('GET', '/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.wechatEnabled, false);
  process.env.WECHAT_LOGIN_ENABLED = 'true';
});

test('缺少平台密钥时隐藏入口，登录与绑定用途要求正确会话', async () => {
  const key = process.env.BEICHEN_APP_KEY;
  try {
    delete process.env.BEICHEN_APP_KEY;
    const beforeCalls = calls.length;
    assert.equal(
      (await api('POST', '/api/auth/wechat/start', undefined, { intent: 'login' })).status,
      503,
    );
    assert.equal((await api('GET', '/api/bootstrap')).body.wechatEnabled, false);
    assert.equal(calls.length, beforeCalls);
  } finally {
    process.env.BEICHEN_APP_KEY = key;
  }
  assert.equal(
    (await api('POST', '/api/auth/wechat/start', undefined, { intent: 'bind' })).status,
    401,
  );
  const account = await register('purpose-owner');
  assert.equal(
    (await api('POST', '/api/auth/wechat/start', account.cookie, { intent: 'login' })).status,
    409,
  );
});

test('新微信登录创建零余额无邮箱账号，重复身份复用同一用户', async () => {
  const initial = await counts();
  profiles.set('first-code', 'wx-user-1');
  const flow = await start('login');
  assert.equal(new URL(flow.redirectUri).searchParams.get('appkey'), null);
  assert.ok(!flow.redirectUri.includes('private-test-key'));
  const first = await callback(flow.state, 'first-code', flow.nonce);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/?wechat=logged_in');
  const firstCookie = sessionCookie(first.headers);
  const firstBootstrap = await api('GET', '/api/bootstrap', firstCookie);
  assert.equal(firstBootstrap.body.user.email, null);
  assert.equal(firstBootstrap.body.user.wechatBound, true);
  const firstId = firstBootstrap.body.user.id;
  const row = (
    await database.query('SELECT id,email,password_hash FROM users WHERE id=$1', [firstId])
  ).rows[0];
  assert.equal(row.email, null);
  assert.equal(row.password_hash, null);
  assert.equal(
    (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [firstId])).rows[0]
      .balance,
    0,
  );

  const again = await start('login');
  const replay = await callback(again.state, 'first-code', again.nonce);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.location, '/?wechat=logged_in');
  const secondBootstrap = await api('GET', '/api/bootstrap', sessionCookie(replay.headers));
  assert.equal(secondBootstrap.body.user.id, firstId);
  assert.equal((await counts()).users, initial.users + 1);
  assert.equal(
    (
      await database.query(
        "SELECT COUNT(*)::int AS n FROM auth_identities WHERE provider='beichen-wx' AND provider_uid='wx-user-1'",
      )
    ).rows[0].n,
    1,
  );
});

test('微信绑定保留已有账号的空间和积分', async () => {
  const account = await register('bind-owner');
  const space = (
    await database.query(
      "INSERT INTO spaces(name,invite_code) VALUES('保留空间','KEEP-SPACE') RETURNING id",
    )
  ).rows[0].id as string;
  await database.query('INSERT INTO memberships(user_id,space_id,slot) VALUES($1,$2,1)', [
    account.id,
    space,
  ]);
  await database.query('UPDATE wallets SET balance=42 WHERE user_id=$1', [account.id]);

  profiles.set('bind-code', 'wx-bound-owner');
  const flow = await start('bind', account.cookie);
  const result = await callback(flow.state, 'bind-code', `${account.cookie}; ${flow.nonce}`);
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, '/?wechat=bound');
  const identity = (
    await database.query(
      "SELECT user_id FROM auth_identities WHERE provider='beichen-wx' AND provider_uid='wx-bound-owner'",
    )
  ).rows[0];
  assert.equal(identity.user_id, account.id);
  assert.equal(
    (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [account.id])).rows[0]
      .balance,
    42,
  );
  assert.equal(
    (await database.query('SELECT space_id FROM memberships WHERE user_id=$1', [account.id]))
      .rows[0].space_id,
    space,
  );
  const boundBootstrap = await api('GET', '/api/bootstrap', sessionCookie(result.headers));
  assert.equal(boundBootstrap.body.user.id, account.id);
  assert.equal(boundBootstrap.body.balance, 42);
  assert.equal(boundBootstrap.body.space.id, space);
});

test('状态、Cookie 和回调消费保护可防重放与会话变更', async () => {
  profiles.set('state-code', 'wx-state-user');
  const flow = await start('login');
  const initial = await counts();
  const wrongCookie = `${flow.nonce.slice(0, -1)}${flow.nonce.endsWith('0') ? '1' : '0'}`;
  const wrong = await callback(flow.state, 'state-code', wrongCookie);
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.location, '/?wechat=error&reason=invalid_state');
  assert.deepEqual(await counts(), initial);

  const valid = await callback(flow.state, 'state-code', flow.nonce);
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.location, '/?wechat=logged_in');
  const replay = await callback(flow.state, 'state-code', flow.nonce);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.location, '/?wechat=error&reason=invalid_state');

  const account = await register('session-owner');
  profiles.set('session-code', 'wx-session-user');
  const bind = await start('bind', account.cookie);
  const changedAccount = await register('changed-session');
  const changed = await callback(
    bind.state,
    'session-code',
    `${changedAccount.cookie}; ${bind.nonce}`,
  );
  assert.equal(changed.status, 303);
  assert.equal(changed.headers.location, '/?wechat=error&reason=session_changed');
  assert.equal(
    (
      await database.query(
        "SELECT COUNT(*)::int AS n FROM auth_identities WHERE provider='beichen-wx' AND provider_uid='wx-session-user'",
      )
    ).rows[0].n,
    0,
  );
});

test('绑定冲突不会合并账号，两个并发新登录只产生一个微信用户', async () => {
  const owner = await wechatAccount('wx-conflict-owner');
  profiles.set('conflict-code', owner.uid);
  const conflicting = await register('conflicting-owner');
  const flow = await start('bind', conflicting.cookie);
  const conflict = await callback(
    flow.state,
    'conflict-code',
    `${conflicting.cookie}; ${flow.nonce}`,
  );
  assert.equal(conflict.status, 303);
  assert.equal(conflict.headers.location, '/?wechat=error&reason=identity_conflict');
  assert.equal(
    (
      await database.query('SELECT COUNT(*)::int AS n FROM auth_identities WHERE provider_uid=$1', [
        owner.uid,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await database.query('SELECT COUNT(*)::int AS n FROM users WHERE id=$1', [conflicting.id]))
      .rows[0].n,
    1,
  );

  profiles.set('parallel-code', 'wx-parallel-user');
  const initial = await counts();
  const first = await start('login');
  const second = await start('login');
  const results = await Promise.all([
    callback(first.state, 'parallel-code', first.nonce),
    callback(second.state, 'parallel-code', second.nonce),
  ]);
  results.forEach((result) => {
    assert.equal(result.status, 303);
    assert.equal(result.headers.location, '/?wechat=logged_in');
  });
  const parallelUsers = (
    await database.query(
      "SELECT user_id FROM auth_identities WHERE provider='beichen-wx' AND provider_uid='wx-parallel-user'",
    )
  ).rows;
  assert.equal(parallelUsers.length, 1);
  results.forEach((result) => sessionCookie(result.headers));
  assert.equal((await counts()).users, initial.users + 1);
  assert.equal(
    (
      await database.query('SELECT COUNT(*)::int AS n FROM users WHERE id=$1', [
        parallelUsers[0].user_id,
      ])
    ).rows[0].n,
    1,
  );
});

test('退出后重送旧会话、过期会话和授权期间撤销会话均不能完成绑定', async (t) => {
  for (const scenario of ['logout', 'expired', 'during-exchange']) {
    await t.test(scenario, async () => {
      const account = await register(`revoke-${scenario}`);
      const code = randomUUID();
      profiles.set(code, `wx-${scenario}`);
      const flow = await start('bind', account.cookie);
      if (scenario === 'logout') {
        assert.equal((await api('POST', '/api/auth/logout', account.cookie, {})).status, 200);
      } else if (scenario === 'expired') {
        await database.query(
          "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
          [account.id],
        );
      }
      const initial = await counts();
      const callbackCalls = calls.filter((call) => call.act === 'callback').length;
      if (scenario === 'during-exchange') {
        callbackHook = async () => {
          await database.query('DELETE FROM sessions WHERE user_id=$1', [account.id]);
        };
      }
      try {
        expectFailure(await callback(flow.state, code, flow.cookie), 'session_changed');
      } finally {
        callbackHook = undefined;
      }
      const current = await counts();
      assert.equal(current.identities, initial.identities);
      assert.equal(current.users, initial.users);
      assert.equal(current.sessions, initial.sessions - (scenario === 'during-exchange' ? 1 : 0));
      if (scenario !== 'during-exchange') {
        assert.equal(calls.filter((call) => call.act === 'callback').length, callbackCalls);
      }
      assert.equal(
        (
          await database.query('SELECT COUNT(*)::int AS n FROM auth_identities WHERE user_id=$1', [
            account.id,
          ])
        ).rows[0].n,
        0,
      );
    });
  }
});

test('过期状态、缺失 Cookie 和伪造状态不会向平台交换身份', async (t) => {
  for (const scenario of ['expired', 'missing-cookie', 'wrong-state']) {
    await t.test(scenario, async () => {
      const flow = await start('login');
      if (scenario === 'expired') {
        await database.query(
          "UPDATE oauth_states SET expires_at=now()-interval '1 minute' WHERE state_hash=$1",
          [digest(flow.state)],
        );
      }
      const initial = await counts();
      const beforeCalls = calls.length;
      const state = scenario === 'wrong-state' ? 'f'.repeat(64) : flow.state;
      const nonce = scenario === 'missing-cookie' ? '' : flow.nonce;
      expectFailure(await callback(state, 'unused-code', nonce), 'invalid_state');
      assert.deepEqual(await counts(), initial);
      assert.equal(calls.length, beforeCalls);
    });
  }
});

test('同一状态并发回调只交换一次身份和生成一次会话', async () => {
  const code = randomUUID();
  profiles.set(code, 'wx-same-state');
  const flow = await start('login');
  const initial = await counts();
  const beforeCalls = calls.length;
  const responses = await Promise.all([
    callback(flow.state, code, flow.nonce),
    callback(flow.state, code, flow.nonce),
  ]);
  assert.equal(
    responses.filter((response) => response.headers.location === '/?wechat=logged_in').length,
    1,
  );
  assert.equal(
    responses.filter(
      (response) => response.headers.location === '/?wechat=error&reason=invalid_state',
    ).length,
    1,
  );
  assert.equal(calls.length, beforeCalls + 1);
  const current = await counts();
  assert.equal(current.users, initial.users + 1);
  assert.equal(current.sessions, initial.sessions + 1);
  assert.equal(current.identities, initial.identities + 1);
  const stored = (
    await database.query('SELECT * FROM oauth_states WHERE state_hash=$1', [digest(flow.state)])
  ).rows[0];
  assert.ok(stored.consumed_at);
  assert.notEqual(stored.state_hash, flow.state);
  assert.notEqual(stored.browser_hash, flow.nonce.split('=')[1]);
});

test('平台错误、尚未授权及错误类型或空身份都不会创建账号', async (t) => {
  const cases = [
    {
      name: 'error',
      body: { code: 1, type: 'wx', social_uid: 'untrusted' },
      reason: 'provider_error',
    },
    { name: 'pending', body: { code: 2, type: 'wx' }, reason: 'cancelled' },
    {
      name: 'wrong-type',
      body: { code: 0, type: 'qq', social_uid: 'untrusted' },
      reason: 'provider_error',
    },
    {
      name: 'empty-identity',
      body: { code: 0, type: 'wx', social_uid: '' },
      reason: 'provider_error',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const code = randomUUID();
      callbackResponses.set(code, item.body);
      const flow = await start('login');
      const initial = await counts();
      expectFailure(await callback(flow.state, code, flow.nonce), item.reason);
      assert.deepEqual(await counts(), initial);
      expectFailure(await callback(flow.state, code, flow.nonce), 'invalid_state');
    });
  }
  const flow = await start('login');
  const initial = await counts();
  const beforeCalls = calls.length;
  expectFailure(await callback(flow.state, 'type-code', flow.nonce, 'qq'), 'cancelled');
  assert.deepEqual(await counts(), initial);
  assert.equal(calls.length, beforeCalls);
});

test('平台给出的不安全授权地址和泄密地址被拒绝', async (t) => {
  const unsafeUrls = [
    'http://u.beichenwl.cn/login',
    'javascript:alert(1)',
    'https://evil.example/login',
    'https://u.beichenwl.cn.evil.example/login',
    'https://u.beichenwl.cn:444/login',
    'https://name:password@u.beichenwl.cn/login',
    'https://u.beichenwl.cn/login?appkey=anything',
    'https://u.beichenwl.cn/private-test-key',
    'https://u.beichenwl.cn/login?other=private-test-key',
  ];
  for (const url of unsafeUrls) {
    await t.test(url, async () => {
      authorizationResponse = { code: 0, type: 'wx', url };
      try {
        const initial = await counts();
        const response = await api('POST', '/api/auth/wechat/start', undefined, {
          intent: 'login',
        });
        assert.equal(response.status, 503);
        assert.equal(cookieValue(response.headers, 'couple_wechat_nonce'), undefined);
        assert.ok(!JSON.stringify(response).includes('private-test-key'));
        assert.deepEqual(await counts(), initial);
      } finally {
        authorizationResponse = undefined;
      }
    });
  }
});

test('微信用户补邮箱需要 SMTP，冲突邮箱不会合并，验证后仍不可密码登录', async () => {
  const account = await wechatAccount('wx-email-owner');
  const occupied = await register('email-occupied');
  const email = 'wechat-added@example.test';
  const originalHost = process.env.SMTP_HOST;
  const originalFrom = process.env.SMTP_FROM;
  try {
    process.env.SMTP_HOST = '';
    process.env.SMTP_FROM = '';
    assert.equal((await api('POST', '/api/auth/email', account.cookie, { email })).status, 503);
    assert.equal(
      (await database.query('SELECT email FROM users WHERE id=$1', [account.id])).rows[0].email,
      null,
    );

    // Configuring the queue does not send mail; this suite never starts a mail worker.
    process.env.SMTP_HOST = 'smtp.example.invalid';
    process.env.SMTP_FROM = 'notice@example.test';
    const noEmailVerification = await api('POST', '/api/auth/verification', account.cookie, {});
    assert.equal(noEmailVerification.status, 409);
    const initial = await counts();
    assert.equal(
      (
        await api('POST', '/api/auth/email', account.cookie, {
          email: 'EMAIL-OCCUPIED@example.test',
        })
      ).status,
      409,
    );
    assert.deepEqual(await counts(), initial);
    assert.equal(
      (await database.query('SELECT email FROM users WHERE id=$1', [account.id])).rows[0].email,
      null,
    );
    assert.equal(
      (await database.query('SELECT email FROM users WHERE id=$1', [occupied.id])).rows[0].email,
      'email-occupied@example.test',
    );

    assert.equal((await api('POST', '/api/auth/email', account.cookie, { email })).status, 200);
    const stored = (
      await database.query('SELECT email,email_verified,password_hash FROM users WHERE id=$1', [
        account.id,
      ])
    ).rows[0];
    assert.equal(stored.email, email);
    assert.equal(stored.email_verified, false);
    assert.equal(stored.password_hash, null);
    assert.equal(
      (await api('POST', '/api/auth/email', account.cookie, { email: 'replacement@example.test' }))
        .status,
      409,
    );
    const queued = (
      await database.query(
        "SELECT to_email,body FROM email_outbox WHERE user_id=$1 AND kind='VERIFY_EMAIL'",
        [account.id],
      )
    ).rows;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].to_email, email);
    const token = /[?&]verify=([a-f0-9]{64})/.exec(queued[0].body)?.[1];
    assert.ok(token);
    assert.equal((await api('POST', '/api/auth/verify', account.cookie, { token })).status, 200);
    assert.equal(
      (await database.query('SELECT email_verified FROM users WHERE id=$1', [account.id])).rows[0]
        .email_verified,
      true,
    );
    assert.equal((await api('POST', '/api/auth/verify', account.cookie, { token })).status, 400);
    assert.equal(
      (await api('POST', '/api/auth/login', undefined, { email, password })).status,
      401,
    );
  } finally {
    process.env.SMTP_HOST = originalHost;
    process.env.SMTP_FROM = originalFrom;
  }
});
