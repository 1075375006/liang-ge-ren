import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';

// Exercise real route handlers, transactions and local SMTP concurrently. This is
// a correctness/reliability scenario, not an HTTP throughput or production SLA test.
const databaseName = `couple_multi_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
const password = 'CoupleMulti!2026';
const origin = 'http://localhost:33442';
const samples: number[] = [];
const failures: string[] = [];
const delivered: { to: string[]; body: string }[] = [];
let database: typeof import('../server/db.js');
let jobs: typeof import('../server/jobs.js');
let app: FastifyInstance;
let smtp: SMTPServer | undefined;
let created = false;
let identity = 0;
type Account = { id: string; cookie: string; email: string; ip: string };
type Pair = {
  index: number;
  a: Account;
  b: Account;
  spaceId: string;
  code: string;
  taskA: string;
  taskB: string;
  scheduleId: string;
  productId: string;
  orderId: string;
};
let pairs: Pair[];

before(async () => {
  assert.match(databaseName, /^couple_multi_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = origin;
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.REGISTRATION_OPEN = 'true';
  process.env.TRUST_PROXY = '';
  process.env.COOKIE_SECURE = 'false';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_FROM = 'local-test@example.test';
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        delivered.push({
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
  process.env.SMTP_PORT = String((smtp.server.address() as AddressInfo).port);
  database = await import('../server/db.js');
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
  jobs = await import('../server/jobs.js');
});

after(async () => {
  if (smtp) await new Promise<void>((resolve) => smtp!.close(resolve));
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
  ip = account?.ip ?? '192.0.2.250',
) {
  const start = performance.now();
  const response = await app.inject({
    method,
    url: `/api${path}`,
    remoteAddress: ip,
    headers: { origin, ...(account ? { cookie: account.cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  samples.push(performance.now() - start);
  if (response.statusCode >= 500) failures.push(`${method} ${path}: ${response.statusCode}`);
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
function ok(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
}
function status(response: { status: number; body: unknown }, expected: number) {
  assert.equal(response.status, expected, JSON.stringify(response));
}
async function register(label: string): Promise<Account> {
  const id = ++identity;
  const ip = `192.0.2.${id}`;
  const email = `${label}@example.test`;
  const response = await api(
    'POST',
    '/auth/register',
    undefined,
    { name: label, email, password },
    ip,
  );
  ok(response);
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)?.split(';')[0];
  assert.ok(cookie);
  assert.ok(!JSON.stringify(response.body).includes('password'));
  return { id: response.body.user.id, cookie, email, ip };
}
async function balance(account: Account) {
  const response = await api('GET', '/ledger', account);
  ok(response);
  return response.body.balance as number;
}
async function product(account: Account, title: string, price: number, stock: number) {
  const response = await api('POST', '/products', account, { title, price, stock });
  ok(response);
  return response.body.product.id as string;
}
async function drainMail() {
  for (let round = 0; round < 30; round++) {
    const batches = await Promise.all([jobs.runMailBatch(), jobs.runMailBatch()]);
    assert.equal(
      batches.reduce((sum, batch) => sum + batch.failed, 0),
      0,
    );
    if (batches.every((batch) => batch.processed === 0)) return;
  }
  assert.fail('Local SMTP queue failed to drain');
}

test('20 组情侣独立注册、邮箱验证、配对和完整业务并发验收', async (t) => {
  const started = performance.now();
  await t.test('40 个独立客户端并发注册，密码与会话只保存摘要', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 40 }, (_, index) => register(`multi-${index + 1}`)),
    );
    assert.equal(new Set(accounts.map((account) => account.id)).size, 40);
    assert.equal(new Set(accounts.map((account) => account.cookie)).size, 40);
    const users = await database.query('SELECT password_hash FROM users');
    assert.equal(users.rowCount, 40);
    assert.ok(users.rows.every((row) => row.password_hash.startsWith('scrypt$')));
    const sessions = await database.query('SELECT token_hash FROM sessions');
    assert.equal(sessions.rowCount, 40);
    assert.ok(
      sessions.rows.every((row) =>
        accounts.every((account) => !account.cookie.endsWith(row.token_hash)),
      ),
    );
    pairs = Array.from({ length: 20 }, (_, index) => ({
      index,
      a: accounts[index * 2],
      b: accounts[index * 2 + 1],
      spaceId: '',
      code: '',
      taskA: '',
      taskB: '',
      scheduleId: '',
      productId: '',
      orderId: '',
    }));
    await Promise.all(
      accounts.map(async (account) => {
        const initial = await api('GET', '/bootstrap', account);
        ok(initial);
        assert.equal(initial.body.user.id, account.id);
        assert.equal(initial.body.space, null);
        assert.equal(initial.body.balance, 0);
      }),
    );
  });

  await t.test('同网络 40 人各自取得本地 SMTP 验证邮件，一次性令牌不能重放', async () => {
    const accounts = pairs.flatMap((pair) => [pair.a, pair.b]);
    await Promise.all(
      accounts.map(async (account) => {
        ok(await api('POST', '/auth/verification', account, {}, '198.51.100.250'));
      }),
    );
    await drainMail();
    assert.equal(delivered.length, 40);
    assert.deepEqual(
      delivered.flatMap((mail) => mail.to).sort(),
      accounts.map((account) => account.email).sort(),
    );
    await Promise.all(
      accounts.map(async (account) => {
        const mail = delivered.find((candidate) => candidate.to.includes(account.email));
        assert.ok(mail);
        // Quoted-printable HTML/text may fold the token across physical lines.
        const unfolded = mail.body.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
        const token = /[?&]verify=([a-f0-9]{64})/.exec(unfolded)?.[1];
        assert.ok(token);
        ok(await api('POST', '/auth/verify', account, { token }));
        status(await api('POST', '/auth/verify', account, { token }), 400);
        assert.equal((await api('GET', '/bootstrap', account)).body.user.emailVerified, true);
      }),
    );
  });

  await t.test('20 个空间并发创建、邀请码唯一、配对只接受一位伴侣', async () => {
    await Promise.all(
      pairs.map(async (pair) => {
        const created = await api('POST', '/spaces', pair.a, {
          name: `第 ${pair.index + 1} 对的家`,
        });
        ok(created);
        pair.spaceId = created.body.space.id;
        pair.code = created.body.space.inviteCode;
        status(
          await api('POST', '/tasks', pair.a, { title: '尚未配对', reward: 1, mode: 'RACE' }),
          409,
        );
      }),
    );
    assert.equal(new Set(pairs.map((pair) => pair.code)).size, 20);
    // Uniqueness is enforced by PostgreSQL as well as random generation.
    await assert.rejects(
      database.query('UPDATE spaces SET invite_code=$1 WHERE id=$2', [
        pairs[0].code,
        pairs[1].spaceId,
      ]),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await Promise.all(
      pairs.map(async (pair) => {
        ok(await api('POST', '/spaces/join', pair.b, { code: ` ${pair.code.toLowerCase()} ` }));
        ok(await api('POST', '/contract/accept', pair.a, {}));
        ok(await api('POST', '/contract/accept', pair.b, {}));
        const [a, b] = await Promise.all([
          api('GET', '/bootstrap', pair.a),
          api('GET', '/bootstrap', pair.b),
        ]);
        assert.equal(a.body.partner.id, pair.b.id);
        assert.equal(b.body.partner.id, pair.a.id);
        assert.equal(a.body.space.id, pair.spaceId);
        assert.equal(b.body.space.id, pair.spaceId);
        assert.equal(a.body.space.inviteCode, null);
        status(await api('POST', '/spaces/invite', pair.a, {}), 409);
      }),
    );
    const spaces = await database.query(
      'SELECT space_id,COUNT(*)::int AS count FROM memberships GROUP BY space_id',
    );
    assert.equal(spaces.rowCount, 20);
    assert.ok(spaces.rows.every((row) => row.count === 2));
  });

  await t.test('20 组同时完成任务、重复审核只发一次积分，并创建计划和心愿', async () => {
    await Promise.all(
      pairs.map(async (pair) => {
        for (const [creator, claimant, field] of [
          [pair.a, pair.b, 'taskB'],
          [pair.b, pair.a, 'taskA'],
        ] as const) {
          const task = await api('POST', '/tasks', creator, {
            title: `pair-${pair.index}-认真完成`,
            mode: 'ASSIGNED',
            reward: 200,
          });
          ok(task);
          pair[field] = task.body.task.id;
          ok(await api('POST', `/tasks/${pair[field]}/claim`, claimant, {}));
          ok(await api('POST', `/tasks/${pair[field]}/submit`, claimant, {}));
          status(
            await api('POST', `/tasks/${pair[field]}/review`, claimant, { approve: true }),
            403,
          );
          const reviews = await Promise.all(
            Array.from({ length: 4 }, () =>
              api('POST', `/tasks/${pair[field]}/review`, creator, { approve: true }),
            ),
          );
          reviews.forEach(ok);
          assert.equal(await balance(claimant), 200);
        }
        const schedule = await api('POST', '/schedules', pair.a, {
          title: `pair-${pair.index}-定时拥抱`,
          reward: 5,
          mode: 'RACE',
          kind: 'ONCE',
          runAt: new Date(Date.now() + 3_600_000).toISOString(),
          durationHours: 24,
        });
        ok(schedule);
        pair.scheduleId = schedule.body.schedule.id;
        pair.productId = await product(pair.b, `pair-${pair.index}-约会`, 20, 10);
        const order = await api('POST', `/products/${pair.productId}/redeem`, pair.a, {
          idempotencyKey: randomUUID(),
        });
        ok(order);
        pair.orderId = order.body.order.id;
        assert.equal(await balance(pair.a), 180);
        assert.equal(await balance(pair.b), 200);
      }),
    );
    const rewards = await database.query(
      'SELECT task_id,COUNT(*)::int AS count FROM point_ledger WHERE task_id IS NOT NULL GROUP BY task_id',
    );
    assert.equal(rewards.rowCount, 40);
    assert.ok(rewards.rows.every((row) => row.count === 1));
  });

  await t.test('任务、计划、商品、订单、账本及通知逐组隔离，跨组修改全部拒绝', async () => {
    await Promise.all(
      pairs.map(async (pair, index) => {
        const outsider = pairs[(index + 1) % pairs.length].a;
        const attacks = [
          api('POST', `/tasks/${pair.taskA}/claim`, outsider, {}),
          api('POST', `/tasks/${pair.taskA}/release`, outsider, {}),
          api('POST', `/tasks/${pair.taskA}/submit`, outsider, {}),
          api('POST', `/tasks/${pair.taskA}/review`, outsider, { approve: true }),
          api('POST', `/tasks/${pair.taskA}/cancel`, outsider, {}),
          api('PATCH', `/schedules/${pair.scheduleId}`, outsider, { active: false }),
          api('PATCH', `/products/${pair.productId}`, outsider, { stock: 999 }),
          api('POST', `/products/${pair.productId}/redeem`, outsider, {
            idempotencyKey: randomUUID(),
          }),
          api('POST', `/orders/${pair.orderId}/action`, outsider, { action: 'cancel' }),
        ];
        (await Promise.all(attacks)).forEach((response) => status(response, 404));
        for (const account of [pair.a, pair.b]) {
          const [tasks, products, orders, ledger, notifications] = await Promise.all([
            api('GET', '/tasks', account),
            api('GET', '/products', account),
            api('GET', '/orders', account),
            api('GET', '/ledger', account),
            api('GET', '/notifications', account),
          ]);
          [tasks, products, orders, ledger, notifications].forEach(ok);
          assert.equal(tasks.body.tasks.length, 2);
          assert.equal(tasks.body.schedules.length, 1);
          assert.ok(
            tasks.body.tasks.every((row: { spaceId: string }) => row.spaceId === pair.spaceId),
          );
          assert.ok(
            tasks.body.schedules.every((row: { spaceId: string }) => row.spaceId === pair.spaceId),
          );
          assert.deepEqual(
            products.body.products.map((row: { id: string }) => row.id),
            [pair.productId],
          );
          assert.deepEqual(
            orders.body.orders.map((row: { id: string }) => row.id),
            [pair.orderId],
          );
          const ownLedger = await database.query('SELECT id FROM point_ledger WHERE user_id=$1', [
            account.id,
          ]);
          const ownNotifications = await database.query(
            'SELECT id FROM notifications WHERE user_id=$1',
            [account.id],
          );
          assert.deepEqual(
            ledger.body.entries.map((row: { id: string }) => row.id).sort(),
            ownLedger.rows.map((row) => row.id).sort(),
          );
          assert.deepEqual(
            notifications.body.notifications.map((row: { id: string }) => row.id).sort(),
            ownNotifications.rows.map((row) => row.id).sort(),
          );
          const serialized = JSON.stringify([
            tasks.body,
            products.body,
            orders.body,
            ledger.body,
            notifications.body,
          ]);
          assert.ok(!serialized.includes(outsider.id));
          assert.ok(!serialized.includes(outsider.email));
        }
        status(await api('PATCH', `/schedules/${pair.scheduleId}`, pair.b, { active: false }), 403);
        status(await api('PATCH', `/products/${pair.productId}`, pair.a, { price: 1 }), 403);
      }),
    );
    ok(await api('POST', '/notifications/read', pairs[0].a, {}));
    const unreadOthers = await database.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id<>$1 AND read_at IS NOT NULL',
      [pairs[0].a.id],
    );
    assert.equal(unreadOthers.rows[0].count, 0);
  });

  await t.test('20 组兑现闭环、重复兑换/退款、库存竞争及跨商品并发防透支', async () => {
    await Promise.all(
      pairs.map(async (pair) => {
        status(
          await api('POST', `/orders/${pair.orderId}/action`, pair.a, { action: 'fulfill' }),
          403,
        );
        ok(await api('POST', `/orders/${pair.orderId}/action`, pair.b, { action: 'fulfill' }));
        status(
          await api('POST', `/orders/${pair.orderId}/action`, pair.b, { action: 'complete' }),
          403,
        );
        const complete = await Promise.all(
          Array.from({ length: 3 }, () =>
            api('POST', `/orders/${pair.orderId}/action`, pair.a, { action: 'complete' }),
          ),
        );
        complete.forEach(ok);
        status(
          await api('POST', `/orders/${pair.orderId}/action`, pair.a, { action: 'cancel' }),
          409,
        );
        const key = randomUUID();
        const duplicates = await Promise.all(
          Array.from({ length: 5 }, () =>
            api('POST', `/products/${pair.productId}/redeem`, pair.a, { idempotencyKey: key }),
          ),
        );
        duplicates.forEach(ok);
        const orderId = duplicates[0].body.order.id;
        assert.ok(duplicates.every((result) => result.body.order.id === orderId));
        assert.equal(await balance(pair.a), 160);
        const refunds = await Promise.all(
          [pair.a, pair.b, pair.a, pair.b].map((account) =>
            api('POST', `/orders/${orderId}/action`, account, { action: 'cancel' }),
          ),
        );
        refunds.forEach(ok);
        assert.equal(await balance(pair.a), 180);
        const scarce = await product(pair.b, `pair-${pair.index}-限量`, 10, 1);
        const races = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            api('POST', `/products/${scarce}/redeem`, index % 2 ? pair.a : pair.b, {
              idempotencyKey: randomUUID(),
            }),
          ),
        );
        assert.equal(races.filter((result) => result.status === 200).length, 1);
        assert.equal(races.filter((result) => result.status === 409).length, 5);
        const scarceOrder = races.find((result) => result.status === 200)!.body.order;
        ok(await api('POST', `/orders/${scarceOrder.id}/action`, pair.a, { action: 'cancel' }));
        assert.equal(await balance(pair.a), 180);
        assert.equal(await balance(pair.b), 200);
        const expensive = await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            product(pair.b, `pair-${pair.index}-防透支-${index}`, 130, 1),
          ),
        );
        const overspend = await Promise.all(
          expensive.map((id) =>
            api('POST', `/products/${id}/redeem`, pair.a, { idempotencyKey: randomUUID() }),
          ),
        );
        assert.equal(overspend.filter((result) => result.status === 200).length, 1);
        assert.equal(overspend.filter((result) => result.status === 409).length, 3);
        assert.equal(await balance(pair.a), 50);
        assert.equal(await balance(pair.b), 200);
      }),
    );
    const mismatch = await database.query(
      'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON l.user_id=w.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
    );
    assert.equal(mismatch.rowCount, 0);
    assert.equal((await database.query('SELECT 1 FROM wallets WHERE balance<0')).rowCount, 0);
    assert.equal((await database.query('SELECT 1 FROM products WHERE stock<0')).rowCount, 0);
    assert.equal(
      (
        await database.query(
          'SELECT source_key FROM point_ledger GROUP BY source_key HAVING COUNT(*)>1',
        )
      ).rowCount,
      0,
    );
  });

  await t.test('多 worker 同时生成 20 组计划，不串空间且不重复发布', async () => {
    await database.query(
      "UPDATE schedules SET run_at=now()-interval '1 minute',next_run_at=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [pairs.map((pair) => pair.scheduleId)],
    );
    const workers = await Promise.all(Array.from({ length: 4 }, () => jobs.runScheduler()));
    assert.equal(
      workers.reduce((sum, worker) => sum + worker.created, 0),
      20,
    );
    assert.equal((await jobs.runScheduler()).created, 0);
    const generated = await database.query(
      'SELECT t.space_id,t.schedule_id,t.creator_id,s.space_id AS schedule_space FROM tasks t JOIN schedules s ON s.id=t.schedule_id',
    );
    assert.equal(generated.rowCount, 20);
    assert.ok(generated.rows.every((row) => row.space_id === row.schedule_space));
    assert.equal(new Set(generated.rows.map((row) => row.schedule_id)).size, 20);
  });

  await t.test('并发抢邀请码、过期/刷新邀请码、同用户双空间及重复邮箱保护', async () => {
    const [owner, joinerA, joinerB, secondOwner] = await Promise.all(
      ['owner', 'join-a', 'join-b', 'owner-b'].map((name) => register(`multi-race-${name}`)),
    );
    const created = await Promise.all([
      api('POST', '/spaces', owner, { name: '只保留一个空间' }),
      api('POST', '/spaces', owner, { name: '重复创建' }),
    ]);
    assert.equal(created.filter((result) => result.status === 200).length, 1);
    assert.equal(created.filter((result) => result.status === 409).length, 1);
    const space = created.find((result) => result.status === 200)!.body.space;
    const refreshed = await api('POST', '/spaces/invite', owner, {});
    ok(refreshed);
    assert.notEqual(refreshed.body.space.inviteCode, space.inviteCode);
    status(await api('POST', '/spaces/join', joinerA, { code: space.inviteCode }), 409);
    await database.query(
      "UPDATE spaces SET invite_expires_at=now()-interval '1 second' WHERE id=$1",
      [space.id],
    );
    status(
      await api('POST', '/spaces/join', joinerA, { code: refreshed.body.space.inviteCode }),
      409,
    );
    const renewed = await api('POST', '/spaces/invite', owner, {});
    ok(renewed);
    const race = await Promise.all(
      [joinerA, joinerB].map((account) =>
        api('POST', '/spaces/join', account, { code: renewed.body.space.inviteCode }),
      ),
    );
    assert.equal(race.filter((result) => result.status === 200).length, 1);
    assert.equal(race.filter((result) => result.status === 409).length, 1);
    const loser = race[0].status === 200 ? joinerB : joinerA;
    assert.equal((await api('GET', '/bootstrap', loser)).body.space, null);
    const second = await api('POST', '/spaces', secondOwner, { name: '另外一个空间' });
    ok(second);
    const sameUserRace = await Promise.all([
      api('POST', '/spaces/join', loser, { code: second.body.space.inviteCode }),
      api('POST', '/spaces', loser, { name: '不能同时加入两个' }),
    ]);
    assert.equal(sameUserRace.filter((result) => result.status === 200).length, 1);
    assert.equal(sameUserRace.filter((result) => result.status === 409).length, 1);
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        api(
          'POST',
          '/auth/register',
          undefined,
          { name: 'duplicate', email: 'same-address@example.test', password },
          `198.51.100.${index + 1}`,
        ),
      ),
    );
    assert.equal(duplicates.filter((result) => result.status === 200).length, 1);
    assert.equal(duplicates.filter((result) => result.status === 409).length, 3);
    const invalidMemberships = await database.query(
      'SELECT space_id FROM memberships GROUP BY space_id HAVING COUNT(*)>2',
    );
    assert.equal(invalidMemberships.rowCount, 0);
  });

  await t.test('20 组用户退出、重新登录、错误密码及过期会话不会串号', async () => {
    await Promise.all(
      pairs.map(async (pair) => {
        const old = { ...pair.a };
        ok(await api('POST', '/auth/logout', old, {}));
        status(await api('GET', '/tasks', old), 401);
        assert.equal((await api('GET', '/bootstrap', old)).body.user, null);
        status(
          await api(
            'POST',
            '/auth/login',
            undefined,
            { email: old.email, password: 'incorrect-password' },
            old.ip,
          ),
          401,
        );
        const logged = await api(
          'POST',
          '/auth/login',
          undefined,
          { email: old.email.toUpperCase(), password },
          old.ip,
        );
        ok(logged);
        const cookies = logged.headers['set-cookie'];
        const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)?.split(';')[0];
        assert.ok(cookie);
        assert.notEqual(cookie, old.cookie);
        pair.a.cookie = cookie;
        const bootstrap = await api('GET', '/bootstrap', pair.a);
        assert.equal(bootstrap.body.user.id, old.id);
        assert.equal(bootstrap.body.space.id, pair.spaceId);
        assert.equal(bootstrap.body.partner.id, pair.b.id);
        assert.equal(bootstrap.body.balance, 50);
        assert.equal((await api('GET', '/bootstrap', pair.b)).body.user.id, pair.b.id);
      }),
    );
    await database.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [pairs[0].a.id],
    );
    status(await api('GET', '/tasks', pairs[0].a), 401);
    ok(await api('GET', '/tasks', pairs[0].b));
  });

  assert.deepEqual(failures, []);
  const ordered = [...samples].sort((a, b) => a - b);
  t.diagnostic(
    `Local correctness run: 20 pairs / 40 initial accounts; ${samples.length} API injections; elapsed ${Math.round(performance.now() - started)} ms; p50 ${Math.round(ordered[Math.floor(ordered.length * 0.5)])} ms; p95 ${Math.round(ordered[Math.floor(ordered.length * 0.95)])} ms; ${delivered.length} local SMTP messages; no 5xx. Not a production load benchmark.`,
  );
});
