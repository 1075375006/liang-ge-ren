import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

const databaseName = `couple_privacy_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
const password = 'PrivacyTest!2026';
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let security: typeof import('../server/security.js');
let created = false;
let sequence = 0;
type Account = { id: string; email: string; cookie: string; ip: string };

before(async () => {
  assert.match(databaseName, /^couple_privacy_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.REGISTRATION_OPEN = 'true';
  process.env.TRUST_PROXY = '';
  process.env.COOKIE_SECURE = 'false';
  // This suite inspects queued messages only. It never starts an SMTP worker.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_FROM = 'privacy-test@example.test';
  database = await import('../server/db.js');
  security = await import('../server/security.js');
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

async function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  account?: Account,
  payload?: unknown,
  remoteAddress = account?.ip ?? '192.0.2.240',
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    remoteAddress,
    headers: { origin: 'http://localhost:33442', ...(account ? { cookie: account.cookie } : {}) },
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
async function register(): Promise<Account> {
  const number = ++sequence;
  const email = `privacy-${number}@example.test`;
  const response = await api(
    'POST',
    '/auth/register',
    undefined,
    {
      email,
      name: `隐私测试${number}`,
      password,
    },
    `192.0.2.${number}`,
  );
  ok(response);
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)?.split(';')[0];
  assert.ok(cookie);
  return { id: response.body.user.id, email, cookie, ip: `192.0.2.${number}` };
}
async function pair(a: Account, b: Account) {
  const created = await api('POST', '/spaces', a, { name: '共享生活' });
  ok(created);
  ok(await api('POST', '/spaces/join', b, { code: created.body.space.inviteCode }));
  ok(await api('POST', '/contract/accept', a, {}));
  ok(await api('POST', '/contract/accept', b, {}));
  return created.body.space.id as string;
}
async function earn(creator: Account, claimant: Account) {
  const task = await api('POST', '/tasks', creator, {
    title: '一起完成的小事',
    reward: 200,
    mode: 'ASSIGNED',
  });
  ok(task);
  const id = task.body.task.id;
  ok(await api('POST', `/tasks/${id}/claim`, claimant, {}));
  ok(await api('POST', `/tasks/${id}/submit`, claimant, {}));
  ok(await api('POST', `/tasks/${id}/review`, creator, { approve: true }));
}
async function redeem(productId: string, account: Account) {
  const response = await api('POST', `/products/${productId}/redeem`, account, {
    idempotencyKey: randomUUID(),
  });
  ok(response);
  return response.body.order.id as string;
}

test('账号导出、注销与归档空间退出保持隐私和资金一致性', async (t) => {
  const [a, b, c, d] = await Promise.all(Array.from({ length: 4 }, register));
  const [spaceId, otherSpaceId] = await Promise.all([pair(a, b), pair(c, d)]);
  await Promise.all([earn(b, a), earn(a, b)]);
  const product = await api('POST', '/products', b, { title: '一次认真约会', price: 40, stock: 5 });
  ok(product);
  const productId = product.body.product.id;
  const pendingA = await redeem(productId, a);
  const pendingB = await redeem(productId, b);
  const fulfilled = await redeem(productId, a);
  ok(await api('POST', `/orders/${fulfilled}/action`, b, { action: 'fulfill' }));
  const openTask = await api('POST', '/tasks', a, {
    title: '未完成的事',
    reward: 10,
    mode: 'RACE',
  });
  ok(openTask);
  const plan = await api('POST', '/schedules', a, {
    title: '之后的约定',
    reward: 10,
    mode: 'RACE',
    kind: 'ONCE',
    runAt: new Date(Date.now() + 3_600_000).toISOString(),
    durationHours: 24,
  });
  ok(plan);
  await api('POST', '/auth/verification', a, {});
  ok(await api('POST', '/auth/password/forgot', undefined, { email: a.email }));
  await database.query(
    "INSERT INTO auth_identities(provider,app_id,provider_uid,user_id,nickname) VALUES('beichen-wx','privacy-app','privacy-uid',$1,'私人微信昵称')",
    [a.id],
  );
  await database.query(
    "INSERT INTO oauth_states(state_hash,browser_hash,intent,user_id,session_hash,app_id,expires_at) VALUES($1,$2,'bind',$3,$4,'privacy-app',now()+interval '10 minutes')",
    [
      security.digest('privacy-state'),
      security.digest('privacy-browser'),
      a.id,
      security.digest(a.cookie.split('=')[1]),
    ],
  );
  const extraSession = await database.transaction((client) => security.createSession(client, a.id));

  await t.test('导出完整共享历史和本人资料，不包含另一半邮箱、凭据或其他空间', async () => {
    status(await api('GET', '/account/export'), 401);
    const exported = await api('GET', '/account/export', a);
    ok(exported);
    assert.equal(
      exported.headers['content-disposition'],
      'attachment; filename="liang-ge-ren-data.json"',
    );
    assert.equal(exported.body.account.id, a.id);
    assert.equal(exported.body.account.email, a.email);
    assert.equal(exported.body.partner.id, b.id);
    assert.equal(exported.body.space.id, spaceId);
    assert.equal(exported.body.tasks.length, 3);
    assert.equal(exported.body.schedules.length, 1);
    assert.equal(exported.body.orders.length, 3);
    const raw = JSON.stringify(exported.body);
    for (const excluded of [
      b.email,
      c.email,
      d.email,
      otherSpaceId,
      password,
      a.cookie,
      extraSession.token,
      'passwordHash',
      'tokenHash',
      'inviteCode',
      'providerUid',
      '私人微信昵称',
    ]) {
      assert.ok(!raw.includes(excluded), `Export exposed ${excluded}`);
    }
    const ledger = await database.query('SELECT id FROM point_ledger WHERE user_id=$1', [a.id]);
    assert.deepEqual(
      exported.body.ledger.map((row: { id: string }) => row.id).sort(),
      ledger.rows.map((row) => row.id).sort(),
    );
  });

  await t.test('缺少明确确认或错误密码不能注销，正常空间不能直接退出', async () => {
    status(await api('POST', '/account/delete', a, { password }), 400);
    status(
      await api('POST', '/account/delete', a, {
        confirmation: '注销账号',
        password: 'wrong-password',
      }),
      400,
    );
    status(await api('POST', '/spaces/leave-archived', b, { confirmation: '离开空间' }), 409);
    assert.equal((await api('GET', '/bootstrap', a)).body.user.id, a.id);
  });

  await t.test('注销关闭空间、退款待兑现订单，已兑现订单保持原结果', async () => {
    const deleted = await api('POST', '/account/delete', a, { confirmation: '注销账号', password });
    ok(deleted);
    assert.equal(deleted.body.spaceArchived, true);
    const stored = (await database.query('SELECT * FROM users WHERE id=$1', [a.id])).rows[0];
    assert.equal(stored.name, '已注销用户');
    assert.equal(stored.email, null);
    assert.equal(stored.password_hash, null);
    assert.equal(stored.email_verified, false);
    assert.equal(stored.notify_email, false);
    assert.ok(stored.deleted_at);
    for (const table of [
      'sessions',
      'auth_identities',
      'oauth_states',
      'email_tokens',
      'password_reset_tokens',
      'email_outbox',
      'notifications',
    ]) {
      assert.equal(
        (await database.query(`SELECT 1 FROM ${table} WHERE user_id=$1`, [a.id])).rowCount,
        0,
        table,
      );
    }
    const space = (await database.query('SELECT * FROM spaces WHERE id=$1', [spaceId])).rows[0];
    assert.ok(space.archived_at);
    assert.equal(space.invite_code, null);
    assert.equal(
      (await database.query('SELECT active FROM schedules WHERE id=$1', [plan.body.schedule.id]))
        .rows[0].active,
      false,
    );
    assert.equal(
      (await database.query('SELECT status FROM tasks WHERE id=$1', [openTask.body.task.id]))
        .rows[0].status,
      'CANCELLED',
    );
    const orders = (
      await database.query('SELECT id,status FROM orders WHERE space_id=$1', [spaceId])
    ).rows;
    assert.equal(orders.find((row) => row.id === pendingA)!.status, 'CANCELLED');
    assert.equal(orders.find((row) => row.id === pendingB)!.status, 'CANCELLED');
    assert.equal(orders.find((row) => row.id === fulfilled)!.status, 'FULFILLED');
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock,
      4,
    );
    assert.equal(
      (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [a.id])).rows[0]
        .balance,
      160,
    );
    assert.equal(
      (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [b.id])).rows[0]
        .balance,
      200,
    );
    const refunds = await database.query(
      "SELECT order_id FROM point_ledger WHERE source_key LIKE 'REFUND:%'",
    );
    assert.equal(refunds.rowCount, 2);
  });

  await t.test('已注销用户的所有会话失效，另一半可导出历史，其他空间正常', async () => {
    status(await api('GET', '/tasks', a), 401);
    status(
      await api('GET', '/bootstrap', { ...a, cookie: `couple_session=${extraSession.token}` }),
      200,
    );
    assert.equal((await api('GET', '/bootstrap', a)).body.user, null);
    status(await api('POST', '/auth/login', undefined, { email: a.email, password }), 401);
    const exported = await api('GET', '/account/export', b);
    ok(exported);
    assert.equal(exported.body.partner.name, '已注销用户');
    assert.equal(exported.body.orders.length, 3);
    assert.ok(exported.body.space.archivedAt);
    assert.ok(
      (await api('POST', '/tasks', b, { title: '不能继续写归档空间', reward: 1, mode: 'RACE' }))
        .status >= 400,
    );
    assert.ok(
      (await api('POST', `/products/${productId}/redeem`, b, { idempotencyKey: randomUUID() }))
        .status >= 400,
    );
    ok(await api('POST', '/tasks', c, { title: '别的空间不受影响', reward: 1, mode: 'RACE' }));
  });

  await t.test('剩余用户离开归档空间时清零旧积分且保留审计，能创建新空间', async () => {
    status(await api('POST', '/spaces/leave-archived', b, { confirmation: '随便写' }), 400);
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        api('POST', '/spaces/leave-archived', b, { confirmation: '离开空间' }),
      ),
    );
    assert.equal(results.filter((response) => response.status === 200).length, 1);
    assert.equal(results.filter((response) => response.status === 409).length, 1);
    assert.equal(
      (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [b.id])).rows[0]
        .balance,
      0,
    );
    assert.equal(
      (await database.query('SELECT 1 FROM memberships WHERE user_id=$1', [b.id])).rowCount,
      0,
    );
    const settlement = await database.query(
      'SELECT delta,balance_after FROM point_ledger WHERE source_key=$1',
      [`SPACE_CLOSE:${spaceId}:${b.id}`],
    );
    assert.equal(settlement.rowCount, 1);
    assert.equal(settlement.rows[0].delta, -200);
    assert.equal(settlement.rows[0].balance_after, 0);
    const state = await api('GET', '/bootstrap', b);
    assert.equal(state.body.space, null);
    assert.equal(state.body.balance, 0);
    ok(await api('POST', '/spaces', b, { name: '重新开始' }));
    const fresh = await api('GET', '/bootstrap', b);
    assert.notEqual(fresh.body.space.id, spaceId);
    assert.equal(fresh.body.balance, 0);
    const mismatch = await database.query(
      'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON w.user_id=l.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
    );
    assert.equal(mismatch.rowCount, 0);
  });
});

test('未配对账号可以注销，微信账号必须刚刚重新登录', async (t) => {
  await t.test('尚未配对也能删除账户，并释放邮箱重新注册', async () => {
    const account = await register();
    const result = await api('POST', '/account/delete', account, {
      confirmation: '注销账号',
      password,
    });
    ok(result);
    assert.equal(result.body.spaceArchived, false);
    const replacement = await api('POST', '/auth/register', undefined, {
      name: '新账号',
      email: account.email,
      password,
    });
    ok(replacement);
    assert.notEqual(replacement.body.user.id, account.id);
  });
  await t.test('微信-only长期会话拒绝注销，重新认证后的短期会话可注销', async () => {
    const account = await register();
    // A passwordless account and its session reproduce the persisted state after
    // successful provider authentication; no external provider request is made.
    await database.query('UPDATE users SET email=NULL,password_hash=NULL WHERE id=$1', [
      account.id,
    ]);
    await database.query(
      "UPDATE sessions SET created_at=now()-interval '11 minutes' WHERE user_id=$1",
      [account.id],
    );
    status(await api('POST', '/account/delete', account, { confirmation: '注销账号' }), 409);
    const freshSession = await database.transaction((client) =>
      security.createSession(client, account.id),
    );
    account.cookie = `couple_session=${freshSession.token}`;
    ok(await api('POST', '/account/delete', account, { confirmation: '注销账号' }));
    assert.equal(
      (await database.query('SELECT 1 FROM sessions WHERE user_id=$1', [account.id])).rowCount,
      0,
    );
  });
});

test('注销与同时兑换、发布任务、后台调度竞争时不会产生关闭后的业务或死锁', async () => {
  const [a, b] = await Promise.all([register(), register()]);
  const spaceId = await pair(a, b);
  await earn(b, a);
  const product = await api('POST', '/products', b, {
    title: '关闭前的心愿',
    price: 10,
    stock: 40,
  });
  ok(product);
  const productId = product.body.product.id;
  const plan = await api('POST', '/schedules', b, {
    title: '关闭前的计划',
    reward: 10,
    mode: 'RACE',
    kind: 'ONCE',
    runAt: new Date(Date.now() + 3_600_000).toISOString(),
    durationHours: 24,
  });
  ok(plan);
  await database.query(
    "UPDATE schedules SET run_at=now()-interval '1 minute',next_run_at=now()-interval '1 minute' WHERE id=$1",
    [plan.body.schedule.id],
  );
  const jobs = await import('../server/jobs.js');
  const operations = await Promise.all([
    api('POST', '/account/delete', a, { confirmation: '注销账号', password }),
    ...Array.from({ length: 12 }, () =>
      api('POST', `/products/${productId}/redeem`, a, {
        idempotencyKey: randomUUID(),
      }),
    ),
    ...Array.from({ length: 4 }, () =>
      api('POST', '/tasks', b, {
        title: '并发发布',
        reward: 5,
        mode: 'RACE',
      }),
    ),
    ...Array.from({ length: 4 }, () =>
      api('POST', '/schedules', b, {
        title: '并发计划',
        reward: 5,
        mode: 'RACE',
        kind: 'ONCE',
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        durationHours: 24,
      }),
    ),
    ...Array.from({ length: 4 }, () =>
      api('POST', '/products', b, {
        title: '并发心愿',
        price: 5,
        stock: 1,
      }),
    ),
    jobs.runScheduler().then(() => ({ status: 200, body: {} })),
  ]);
  ok(operations[0]);
  for (const response of operations) {
    assert.ok([200, 401, 403, 409].includes(response.status), JSON.stringify(response));
  }
  assert.equal(
    (await database.query("SELECT 1 FROM orders WHERE space_id=$1 AND status='PENDING'", [spaceId]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await database.query(
        "SELECT 1 FROM tasks WHERE space_id=$1 AND status IN ('OPEN','CLAIMED','SUBMITTED')",
        [spaceId],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await database.query('SELECT 1 FROM schedules WHERE space_id=$1 AND active', [spaceId]))
      .rowCount,
    0,
  );
  assert.equal(
    (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [a.id])).rows[0].balance,
    200,
  );
  assert.equal(
    (await database.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock,
    40,
  );
  assert.equal((await jobs.runScheduler()).created, 0);
  const mismatch = await database.query(
    'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON w.user_id=l.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
  );
  assert.equal(mismatch.rowCount, 0);
});

test('并发 worker 跳过已锁计划时不会越过已加锁的空间集合', async () => {
  const [a, b, c, d] = await Promise.all(Array.from({ length: 4 }, register));
  const [firstSpace, nextSpace] = await Promise.all([pair(a, b), pair(c, d)]);
  // First worker's batch contains fifty earlier plans in the first space. A
  // second worker must not skip them into a different, unprotected space.
  await database.query(
    `INSERT INTO schedules(space_id,creator_id,title,reward,mode,kind,run_at,duration_hours,next_run_at)
     SELECT $1,$2,'首批计划 '||n,1,'RACE','ONCE',now()-interval '2 minutes',24,now()-interval '2 minutes'
     FROM generate_series(1,50) AS n`,
    [firstSpace, a.id],
  );
  const {
    rows: [nextPlan],
  } = await database.query(
    `INSERT INTO schedules(space_id,creator_id,title,reward,mode,kind,run_at,duration_hours,next_run_at)
     VALUES($1,$2,'下一空间的计划',1,'RACE','ONCE',now()-interval '1 minute',24,now()-interval '1 minute') RETURNING id`,
    [nextSpace, c.id],
  );
  const blocker = await database.pool.connect();
  const jobs = await import('../server/jobs.js');
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM schedules WHERE space_id=$1 FOR UPDATE', [firstSpace]);
    const skipped = await jobs.runScheduler();
    assert.equal(skipped.created, 0, 'A worker must only process plans whose space it has locked');
    assert.equal(
      (await database.query('SELECT 1 FROM tasks WHERE schedule_id=$1', [nextPlan.id])).rowCount,
      0,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.equal((await jobs.runScheduler()).created, 50);
  assert.equal((await jobs.runScheduler()).created, 1);
  assert.equal((await jobs.runScheduler()).created, 0);
  assert.equal(
    (await database.query('SELECT 1 FROM tasks WHERE schedule_id=$1', [nextPlan.id])).rowCount,
    1,
  );
});

test('注销前已通过会话检查的创建/加入空间请求，在事务内再次拒绝已失效账号', async () => {
  const { buildApp } = await import('../server/app.js');
  const racingApp = await buildApp();
  let entered: (() => void) | undefined;
  let resume: Promise<void> | undefined;
  racingApp.addHook('preHandler', async (request) => {
    if (request.headers['x-privacy-race'] !== 'pause') return;
    assert.ok(request.currentUser, 'The request must pass authentication before account deletion');
    entered!();
    await resume;
  });
  try {
    const owner = await register();
    const created = await api('POST', '/spaces', owner, { name: '等候伴侣的空间' });
    ok(created);
    for (const path of ['/spaces', '/spaces/join']) {
      const account = await register();
      let release!: () => void;
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = racingApp.inject({
        method: 'POST',
        url: `/api${path}`,
        remoteAddress: account.ip,
        headers: {
          origin: 'http://localhost:33442',
          cookie: account.cookie,
          'x-privacy-race': 'pause',
        },
        payload:
          path === '/spaces' ? { name: '不该被创建' } : { code: created.body.space.inviteCode },
      });
      await paused;
      try {
        ok(await api('POST', '/account/delete', account, { confirmation: '注销账号', password }));
      } finally {
        release();
      }
      const result = await pending;
      assert.equal(result.statusCode, 401, result.body);
      assert.equal(
        (await database.query('SELECT 1 FROM memberships WHERE user_id=$1', [account.id])).rowCount,
        0,
      );
    }
    assert.equal(
      (await database.query('SELECT 1 FROM memberships WHERE space_id=$1', [created.body.space.id]))
        .rowCount,
      1,
    );
  } finally {
    await racingApp.close();
  }
});

test('双方可以关闭共同空间而保留账号，退款防重后分别重新配对且不继承旧积分', async (t) => {
  const [a, b, c, d, unpaired] = await Promise.all(Array.from({ length: 5 }, register));
  const [spaceId, otherSpaceId] = await Promise.all([pair(a, b), pair(c, d)]);
  await Promise.all([earn(b, a), earn(a, b)]);
  const product = await api('POST', '/products', b, { title: '关闭前的约定', price: 35, stock: 5 });
  ok(product);
  const productId = product.body.product.id;
  const pendingA = await redeem(productId, a);
  const pendingB = await redeem(productId, b);
  const fulfilled = await redeem(productId, a);
  ok(await api('POST', `/orders/${fulfilled}/action`, b, { action: 'fulfill' }));
  for (const stage of ['OPEN', 'CLAIMED', 'SUBMITTED']) {
    const task = await api('POST', '/tasks', a, {
      title: `关闭前-${stage}`,
      reward: 5,
      mode: 'RACE',
    });
    ok(task);
    if (stage !== 'OPEN') ok(await api('POST', `/tasks/${task.body.task.id}/claim`, b, {}));
    if (stage === 'SUBMITTED') ok(await api('POST', `/tasks/${task.body.task.id}/submit`, b, {}));
  }
  const plan = await api('POST', '/schedules', b, {
    title: '停止之后的计划',
    reward: 1,
    mode: 'RACE',
    kind: 'ONCE',
    runAt: new Date(Date.now() + 3_600_000).toISOString(),
    durationHours: 24,
  });
  ok(plan);
  await database.query('UPDATE users SET email_verified=true,notify_email=true WHERE id=$1', [
    b.id,
  ]);
  await database.query(
    "INSERT INTO auth_identities(provider,app_id,provider_uid,user_id,nickname) VALUES('beichen-wx','archive-app','archive-uid',$1,'保留的身份')",
    [a.id],
  );
  const originalUsers = (
    await database.query(
      'SELECT id,name,email,password_hash,deleted_at FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[a.id, b.id]],
    )
  ).rows;
  const originalSessions = (
    await database.query(
      'SELECT token_hash FROM sessions WHERE user_id=ANY($1::uuid[]) ORDER BY token_hash',
      [[a.id, b.id]],
    )
  ).rows;

  await t.test('只接受当前成员明确确认与正确密码，不能指定他人的空间', async () => {
    status(
      await api('POST', '/spaces/archive', undefined, { confirmation: '关闭空间', password }),
      401,
    );
    status(
      await api('POST', '/spaces/archive', unpaired, { confirmation: '关闭空间', password }),
      409,
    );
    status(await api('POST', '/spaces/archive', a, { password }), 400);
    status(
      await api('POST', '/spaces/archive', a, {
        confirmation: '关闭空间',
        password: 'wrong-password',
      }),
      400,
    );
    status(
      await api('POST', '/spaces/archive', a, {
        confirmation: '关闭空间',
        password,
        spaceId: otherSpaceId,
      }),
      400,
    );
    assert.equal(
      (await database.query('SELECT archived_at FROM spaces WHERE id=$1', [spaceId])).rows[0]
        .archived_at,
      null,
    );
    assert.equal(
      (await database.query('SELECT archived_at FROM spaces WHERE id=$1', [otherSpaceId])).rows[0]
        .archived_at,
      null,
    );
  });

  await t.test('关闭不注销任何账号，重复操作只退款和通知一次', async () => {
    ok(await api('POST', '/spaces/archive', a, { confirmation: '关闭空间', password }));
    const firstArchived = (
      await database.query('SELECT archived_at FROM spaces WHERE id=$1', [spaceId])
    ).rows[0].archived_at.toISOString();
    const repeated = await Promise.all(
      [a, b, b].map((account) =>
        api('POST', '/spaces/archive', account, { confirmation: '关闭空间', password }),
      ),
    );
    repeated.forEach(ok);
    assert.equal(
      (
        await database.query('SELECT archived_at FROM spaces WHERE id=$1', [spaceId])
      ).rows[0].archived_at.toISOString(),
      firstArchived,
    );
    assert.deepEqual(
      (
        await database.query(
          'SELECT id,name,email,password_hash,deleted_at FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[a.id, b.id]],
        )
      ).rows,
      originalUsers,
    );
    assert.deepEqual(
      (
        await database.query(
          'SELECT token_hash FROM sessions WHERE user_id=ANY($1::uuid[]) ORDER BY token_hash',
          [[a.id, b.id]],
        )
      ).rows,
      originalSessions,
    );
    assert.equal(
      (await database.query('SELECT 1 FROM auth_identities WHERE user_id=$1', [a.id])).rowCount,
      1,
    );
    assert.equal(
      (await database.query('SELECT 1 FROM memberships WHERE space_id=$1', [spaceId])).rowCount,
      2,
    );
    const refunds = await database.query(
      "SELECT order_id FROM point_ledger WHERE space_id=$1 AND source_key LIKE 'REFUND:%'",
      [spaceId],
    );
    assert.deepEqual(refunds.rows.map((row) => row.order_id).sort(), [pendingA, pendingB].sort());
    assert.equal(
      (await database.query('SELECT status FROM orders WHERE id=$1', [fulfilled])).rows[0].status,
      'FULFILLED',
    );
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [productId])).rows[0].stock,
      4,
    );
    assert.equal(
      (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [a.id])).rows[0]
        .balance,
      165,
    );
    assert.equal(
      (await database.query('SELECT balance FROM wallets WHERE user_id=$1', [b.id])).rows[0]
        .balance,
      200,
    );
    assert.equal(
      (
        await database.query(
          "SELECT 1 FROM tasks WHERE space_id=$1 AND status IN ('OPEN','CLAIMED','SUBMITTED')",
          [spaceId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await database.query("SELECT 1 FROM tasks WHERE space_id=$1 AND status='CANCELLED'", [
          spaceId,
        ])
      ).rowCount,
      3,
    );
    assert.equal(
      (await database.query('SELECT active FROM schedules WHERE id=$1', [plan.body.schedule.id]))
        .rows[0].active,
      false,
    );
    const notices = await database.query(
      "SELECT user_id,body FROM notifications WHERE space_id=$1 AND kind='SPACE_ARCHIVED'",
      [spaceId],
    );
    assert.equal(notices.rowCount, 1);
    assert.equal(notices.rows[0].user_id, b.id);
    assert.match(notices.rows[0].body, /无法恢复/);
    const emails = await database.query(
      "SELECT user_id FROM email_outbox WHERE space_id=$1 AND kind='SPACE_ARCHIVED'",
      [spaceId],
    );
    assert.equal(emails.rowCount, 1);
    assert.equal(emails.rows[0].user_id, b.id);
    for (const account of [a, b]) {
      const state = await api('GET', '/bootstrap', account);
      assert.equal(state.body.user.id, account.id);
      assert.ok(state.body.space.archivedAt);
      ok(await api('GET', '/account/export', account));
      status(
        await api('POST', '/tasks', account, { title: '不能再写入', reward: 1, mode: 'RACE' }),
        409,
      );
    }
    ok(await api('POST', '/tasks', c, { title: '其他空间继续使用', reward: 1, mode: 'RACE' }));
  });

  await t.test('两人各自离开后账号保持可用，各自新配对从零积分开始', async () => {
    const exits = await Promise.all(
      [a, b].map((account) =>
        api('POST', '/spaces/leave-archived', account, { confirmation: '离开空间' }),
      ),
    );
    exits.forEach(ok);
    for (const account of [a, b]) {
      const state = await api('GET', '/bootstrap', account);
      assert.equal(state.body.user.id, account.id);
      assert.equal(state.body.space, null);
      assert.equal(state.body.balance, 0);
    }
    const settlements = await database.query(
      "SELECT delta,balance_after FROM point_ledger WHERE space_id=$1 AND source_key LIKE 'SPACE_CLOSE:%' ORDER BY delta",
      [spaceId],
    );
    assert.deepEqual(settlements.rows, [
      { delta: -200, balance_after: 0 },
      { delta: -165, balance_after: 0 },
    ]);
    // The next partner is a fresh account; no old partner's points cross spaces.
    const [newPartnerA, newPartnerB] = await Promise.all([register(), register()]);
    const [newA, newB] = await Promise.all([pair(a, newPartnerA), pair(b, newPartnerB)]);
    assert.notEqual(newA, newB);
    assert.notEqual(newA, spaceId);
    assert.notEqual(newB, spaceId);
    for (const account of [a, b, newPartnerA, newPartnerB]) {
      const ledger = await api('GET', '/ledger', account);
      ok(ledger);
      assert.equal(ledger.body.balance, 0);
      assert.deepEqual(ledger.body.entries, []);
    }
    const mismatch = await database.query(
      'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON w.user_id=l.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
    );
    assert.equal(mismatch.rowCount, 0);
  });
});

test('微信账号关闭空间要求最近十分钟登录并保留微信身份', async () => {
  const [a, b] = await Promise.all([register(), register()]);
  const spaceId = await pair(a, b);
  await database.query('UPDATE users SET email=NULL,password_hash=NULL WHERE id=$1', [a.id]);
  await database.query(
    "INSERT INTO auth_identities(provider,app_id,provider_uid,user_id) VALUES('beichen-wx','archive-wx','archive-wx-uid',$1)",
    [a.id],
  );
  await database.query(
    "UPDATE sessions SET created_at=now()-interval '11 minutes' WHERE user_id=$1",
    [a.id],
  );
  status(await api('POST', '/spaces/archive', a, { confirmation: '关闭空间' }), 409);
  const fresh = await database.transaction((client) => security.createSession(client, a.id));
  a.cookie = `couple_session=${fresh.token}`;
  ok(await api('POST', '/spaces/archive', a, { confirmation: '关闭空间' }));
  assert.ok(
    (await database.query('SELECT archived_at FROM spaces WHERE id=$1', [spaceId])).rows[0]
      .archived_at,
  );
  assert.equal(
    (await database.query('SELECT deleted_at FROM users WHERE id=$1', [a.id])).rows[0].deleted_at,
    null,
  );
  assert.equal(
    (await database.query('SELECT 1 FROM auth_identities WHERE user_id=$1', [a.id])).rowCount,
    1,
  );
  assert.equal((await api('GET', '/bootstrap', a)).body.user.id, a.id);
});
