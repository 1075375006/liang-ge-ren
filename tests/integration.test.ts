import { dropTestDatabase } from './database-fixture.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';

const databaseName = `couple_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let jobs: typeof import('../server/jobs.js');
let smtp: SMTPServer | undefined;
let created = false;
const received: string[] = [];
const password = 'CoupleTest!2026';
type Account = { id: string; cookie: string };
let a: Account, b: Account, c: Account, d: Account;

before(async () => {
  assert.match(databaseName, /^couple_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.COOKIE_SECURE = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  database = await import('../server/db.js');
  await database.migrate();
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
  url: string,
  account?: Account,
  payload?: unknown,
) {
  const response = await app.inject({
    method,
    url: `/api${url}`,
    headers: {
      ...(account ? { cookie: account.cookie } : {}),
      origin: 'http://localhost:33442',
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
function ok(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
}
function denied(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
}
async function register(name: string): Promise<Account> {
  const response = await api('POST', '/auth/register', undefined, {
    name,
    email: `${name}@example.test`,
    password,
  });
  ok(response);
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)?.split(';')[0];
  assert.ok(cookie);
  assert.ok(!JSON.stringify(response.body).includes('password'));
  return { id: response.body.user.id, cookie };
}
async function newTask(mode = 'RACE', reward = 100, creator = a) {
  const response = await api('POST', '/tasks', creator, {
    title: '一起认真生活',
    description: '把约定变成行动',
    mode,
    reward,
  });
  ok(response);
  return response.body.task;
}
async function balance(account: Account) {
  const response = await api('GET', '/ledger', account);
  ok(response);
  return response.body.balance as number;
}
async function newProduct(price = 30, stock = 2, creator = b) {
  const response = await api('POST', '/products', creator, {
    title: '一杯亲手做的拿铁',
    description: '包括一颗爱心',
    emoji: '☕',
    price,
    stock,
  });
  ok(response);
  return response.body.product;
}

test('账号、邀请和空间权限', async (t) => {
  await t.test('未登录引导可以读取，业务接口拒绝匿名访问', async () => {
    const bootstrap = await api('GET', '/bootstrap');
    ok(bootstrap);
    assert.equal(bootstrap.body.user, null);
    assert.equal((await api('GET', '/tasks')).status, 401);
  });
  await t.test('注册四个账号且重复邮箱不被接纳', async () => {
    a = await register('alice');
    b = await register('bob');
    c = await register('carol');
    d = await register('dave');
    denied(
      await api('POST', '/auth/register', undefined, {
        name: '冒名',
        email: 'ALICE@example.test',
        password,
      }),
    );
    const hashes = await database.query('SELECT password_hash FROM users');
    assert.ok(hashes.rows.every((row) => row.password_hash !== password));
  });
  await t.test('创建、配对、第三人及重复配对保护', async () => {
    ok(await api('POST', '/spaces', a, { name: '我们的生活' }));
    denied(await newTaskBeforePair());
    const first = await api('GET', '/bootstrap', a);
    const code = first.body.space.inviteCode;
    assert.ok(code);
    ok(await api('POST', '/spaces/join', b, { code }));
    ok(await api('POST', '/contract/accept', a, {}));
    ok(await api('POST', '/contract/accept', b, {}));
    denied(await api('POST', '/spaces/join', c, { code }));
    denied(await api('POST', '/spaces', a, { name: '又一个空间' }));
    ok(await api('POST', '/spaces', c, { name: '另一个空间' }));
    const other = await api('GET', '/bootstrap', c);
    ok(await api('POST', '/spaces/join', d, { code: other.body.space.inviteCode }));
    assert.equal((await api('GET', '/bootstrap', a)).body.partner.id, b.id);
    assert.equal(
      (
        await database.query(
          'SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM memberships GROUP BY space_id) s',
        )
      ).rows[0].n,
      '2',
    );
  });
  await t.test('跨站写请求拒绝执行', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: a.cookie, origin: 'https://evil.example' },
      payload: { title: '非法请求', reward: 1, mode: 'RACE' },
    });
    assert.equal(response.statusCode, 403);
  });
});
function newTaskBeforePair() {
  return api('POST', '/tasks', a, { title: '未配对任务', reward: 1, mode: 'RACE' });
}

test('任务领取、审核与积分一致性', async (t) => {
  await t.test('两人并发抢单只有一个成功，非领取者不能提交', async () => {
    const task = await newTask();
    const results = await Promise.all([
      api('POST', `/tasks/${task.id}/claim`, a, {}),
      api('POST', `/tasks/${task.id}/claim`, b, {}),
    ]);
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 1);
    const winner = results[0].status === 200 ? a : b;
    const loser = winner === a ? b : a;
    denied(await api('POST', `/tasks/${task.id}/submit`, loser, { submission: '我也完成了' }));
    ok(await api('POST', `/tasks/${task.id}/release`, winner, {}));
    // Publishing member can also claim a RACE task; the partner must review it.
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    ok(await api('POST', `/tasks/${task.id}/submit`, a, { submission: '约定已经完成' }));
    denied(await api('POST', `/tasks/${task.id}/review`, a, { approve: true }));
    const initial = await balance(a);
    const reviews = await Promise.all([
      api('POST', `/tasks/${task.id}/review`, b, { approve: true }),
      api('POST', `/tasks/${task.id}/review`, b, { approve: true }),
    ]);
    assert.ok(reviews.some((result) => result.status === 200));
    assert.equal(await balance(a), initial + 100);
    const entries = await database.query('SELECT * FROM point_ledger WHERE task_id=$1', [task.id]);
    assert.equal(entries.rowCount, 1);
  });
  await t.test('指定任务只给伴侣；退回后重交；跨空间无法操作', async () => {
    const task = await newTask('ASSIGNED', 80, b);
    denied(await api('POST', `/tasks/${task.id}/claim`, b, {}));
    denied(await api('POST', `/tasks/${task.id}/claim`, c, {}));
    const outsider = await api('GET', '/tasks', c);
    assert.ok(!outsider.body.tasks.some((item: { id: string }) => item.id === task.id));
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    denied(await api('POST', `/tasks/${task.id}/cancel`, b, {}));
    ok(await api('POST', `/tasks/${task.id}/submit`, a, { submission: '第一遍' }));
    denied(await api('POST', `/tasks/${task.id}/review`, b, { approve: false, note: '' }));
    ok(await api('POST', `/tasks/${task.id}/review`, b, { approve: false, note: '还差最后一步' }));
    ok(await api('POST', `/tasks/${task.id}/submit`, a, { submission: '这次全部完成' }));
    ok(await api('POST', `/tasks/${task.id}/review`, b, { approve: true }));
    assert.equal(await balance(a), 180);
  });
  await t.test('截止后已提交可审核，未提交会过期', async () => {
    const task = await newTask('RACE', 20);
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    ok(await api('POST', `/tasks/${task.id}/submit`, a, { submission: '及时提交' }));
    const unfinished = await newTask('RACE', 1);
    await database.query(
      "UPDATE tasks SET due_at=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [[task.id, unfinished.id]],
    );
    await jobs.runScheduler();
    ok(await api('POST', `/tasks/${task.id}/review`, b, { approve: true }));
    assert.equal(await balance(a), 200);
    denied(await api('POST', `/tasks/${unfinished.id}/claim`, b, {}));
    assert.equal(
      (await database.query('SELECT status FROM tasks WHERE id=$1', [unfinished.id])).rows[0]
        .status,
      'EXPIRED',
    );
  });
});

test('商品、订单和扣款退款并发', async (t) => {
  await t.test('不能兑换别的空间商品，不能超支', async () => {
    const product = await newProduct(30);
    denied(
      await api('POST', `/products/${product.id}/redeem`, c, { idempotencyKey: randomUUID() }),
    );
    const expensive = await newProduct(9999, 1);
    denied(
      await api('POST', `/products/${expensive.id}/redeem`, a, { idempotencyKey: randomUUID() }),
    );
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [expensive.id])).rows[0]
        .stock,
      1,
    );
    assert.equal(await balance(a), 200);
  });
  await t.test('最后一件商品并发兑换只扣一次，并发取消只退一次', async () => {
    const product = await newProduct(40, 1);
    const results = await Promise.all([
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: randomUUID() }),
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: randomUUID() }),
    ]);
    assert.equal(results.filter((result) => result.status < 300).length, 1);
    const order = results.find((result) => result.status < 300)!.body.order;
    assert.equal(await balance(a), 160);
    await Promise.all([
      api('POST', `/orders/${order.id}/action`, a, { action: 'cancel' }),
      api('POST', `/orders/${order.id}/action`, b, { action: 'cancel' }),
    ]);
    assert.equal(await balance(a), 200);
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock,
      1,
    );
    assert.equal(
      (
        await database.query(
          'SELECT COUNT(*) AS n FROM point_ledger WHERE order_id=$1 AND delta>0',
          [order.id],
        )
      ).rows[0].n,
      '1',
    );
  });
  await t.test('同一个幂等键并发重试返回同单，价格快照及履约角色正确', async () => {
    const product = await newProduct(30, 5);
    const key = randomUUID();
    const results = await Promise.all([
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: key }),
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: key }),
    ]);
    results.forEach(ok);
    assert.equal(results[0].body.order.id, results[1].body.order.id);
    const order = results[0].body.order;
    assert.equal(await balance(a), 170);
    ok(await api('PATCH', `/products/${product.id}`, b, { price: 80, active: false }));
    const stored = await database.query('SELECT price FROM orders WHERE id=$1', [order.id]);
    assert.equal(stored.rows[0].price, 30);
    denied(await api('POST', `/orders/${order.id}/action`, a, { action: 'fulfill' }));
    ok(await api('POST', `/orders/${order.id}/action`, b, { action: 'fulfill' }));
    denied(await api('POST', `/orders/${order.id}/action`, a, { action: 'cancel' }));
    denied(await api('POST', `/orders/${order.id}/action`, b, { action: 'complete' }));
    ok(await api('POST', `/orders/${order.id}/action`, a, { action: 'complete' }));
  });
  await t.test('不同商品同时兑换不能透支，所有积分与流水对平', async () => {
    const first = await newProduct(120, 1),
      second = await newProduct(120, 1);
    const results = await Promise.all([
      api('POST', `/products/${first.id}/redeem`, a, { idempotencyKey: randomUUID() }),
      api('POST', `/products/${second.id}/redeem`, a, { idempotencyKey: randomUUID() }),
    ]);
    assert.equal(results.filter((result) => result.status < 300).length, 1);
    assert.equal(await balance(a), 50);
    const mismatch = await database.query(
      'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON l.user_id=w.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
    );
    assert.equal(mismatch.rowCount, 0);
  });
});

test('计划调度防重、停机补偿和暂停', async (t) => {
  await t.test('一次性任务多个worker并发仅创建一份', async () => {
    const plan = await api('POST', '/schedules', a, {
      title: '定时惊喜',
      description: '',
      mode: 'RACE',
      reward: 10,
      kind: 'ONCE',
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      durationHours: 2,
    });
    ok(plan);
    const id = plan.body.schedule.id;
    await database.query(
      "UPDATE schedules SET run_at=now()-interval '1 minute',next_run_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    await Promise.all([jobs.runScheduler(), jobs.runScheduler()]);
    await jobs.runScheduler();
    assert.equal(
      (await database.query('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id=$1', [id])).rows[0]
        .n,
      '1',
    );
    assert.equal(
      (await database.query('SELECT active FROM schedules WHERE id=$1', [id])).rows[0].active,
      false,
    );
  });
  await t.test('过期一次计划跳过，暂停计划不会生成；恢复从未来开始', async () => {
    const response = await api('POST', '/schedules', a, {
      title: '每日拥抱',
      mode: 'ASSIGNED',
      reward: 5,
      kind: 'DAILY',
      time: '08:00',
      durationHours: 24,
    });
    ok(response);
    const id = response.body.schedule.id;
    denied(await api('PATCH', `/schedules/${id}`, b, { active: false }));
    ok(await api('PATCH', `/schedules/${id}`, a, { active: false }));
    await database.query("UPDATE schedules SET next_run_at=now()-interval '3 days' WHERE id=$1", [
      id,
    ]);
    await jobs.runScheduler();
    assert.equal(
      (await database.query('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id=$1', [id])).rows[0]
        .n,
      '0',
    );
    ok(await api('PATCH', `/schedules/${id}`, a, { active: true }));
    assert.ok(
      new Date(
        (await database.query('SELECT next_run_at FROM schedules WHERE id=$1', [id])).rows[0]
          .next_run_at,
      ).getTime() > Date.now(),
    );
    const expired = await api('POST', '/schedules', a, {
      title: '过期的惊喜',
      mode: 'RACE',
      reward: 5,
      kind: 'ONCE',
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      durationHours: 1,
    });
    ok(expired);
    await database.query(
      "UPDATE schedules SET run_at=now()-interval '2 days',next_run_at=now()-interval '2 days' WHERE id=$1",
      [expired.body.schedule.id],
    );
    await jobs.runScheduler();
    assert.equal(
      (
        await database.query('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id=$1', [
          expired.body.schedule.id,
        ])
      ).rows[0].n,
      '0',
    );
  });
  await t.test('停机多日只补最近有效一期', async () => {
    const response = await api('POST', '/schedules', a, {
      title: '每日散步',
      mode: 'RACE',
      reward: 5,
      kind: 'DAILY',
      time: '08:00',
      durationHours: 24,
    });
    ok(response);
    const id = response.body.schedule.id;
    await database.query("UPDATE schedules SET next_run_at=now()-interval '10 days' WHERE id=$1", [
      id,
    ]);
    await jobs.runScheduler();
    await jobs.runScheduler();
    const rows = await database.query('SELECT * FROM tasks WHERE schedule_id=$1', [id]);
    assert.equal(rows.rowCount, 1);
    assert.ok(new Date(rows.rows[0].due_at).getTime() > Date.now());
  });
});

test('邮件验证、本地SMTP、重试和站内通知', async (t) => {
  await t.test('无SMTP时业务正常且worker不消耗邮件', async () => {
    const result = await jobs.runMailBatch();
    assert.equal(result.skipped, true);
    const notices = await api('GET', '/notifications', b);
    ok(notices);
    assert.ok(notices.body.notifications.length > 0);
    ok(await api('POST', '/notifications/read', b, {}));
    assert.ok(
      (await api('GET', '/notifications', b)).body.notifications.every(
        (item: { readAt: string }) => item.readAt,
      ),
    );
  });
  await t.test('验证邮件经本地SMTP发送，token仅可使用一次', async () => {
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, _session, callback) {
        let raw = '';
        stream.on('data', (chunk) => {
          raw += chunk.toString();
        });
        stream.on('end', () => {
          received.push(raw);
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp!.listen(0, '127.0.0.1', resolve));
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String((smtp.server.address() as AddressInfo).port);
    process.env.SMTP_FROM = '两个人 <notice@example.test>';
    process.env.SMTP_SECURE = 'false';
    ok(await api('POST', '/auth/verification', b, {}));
    const row = (
      await database.query(
        'SELECT * FROM email_outbox WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [b.id],
      )
    ).rows[0];
    assert.ok(row);
    const token = /[?&]verify=([A-Za-z0-9_-]+)/.exec(row.body)?.[1];
    assert.ok(token);
    const result = await jobs.runMailBatch();
    assert.equal(result.sent, 1);
    assert.equal(received.length, 1);
    ok(await api('POST', '/auth/verify', b, { token }));
    denied(await api('POST', '/auth/verify', b, { token }));
    ok(await api('PATCH', '/settings', b, { notifyEmail: true }));
  });
  await t.test('通知邮件并发worker不会重复发送同一队列记录', async () => {
    await newTask('ASSIGNED', 5);
    const beforeCount = received.length;
    await Promise.all([jobs.runMailBatch(), jobs.runMailBatch()]);
    assert.equal(received.length, beforeCount + 1);
    assert.ok(received.at(-1)!.includes('Message-ID: <couple-'));
  });
  await t.test('SMTP失败不影响业务，失败后能重试成功', async () => {
    const actualPort = process.env.SMTP_PORT;
    process.env.SMTP_PORT = '1';
    const task = await newTask('ASSIGNED', 5);
    assert.ok(task.id);
    const failed = await jobs.runMailBatch();
    assert.equal(failed.failed, 1);
    const pending = (
      await database.query(
        "SELECT * FROM email_outbox WHERE status='PENDING' AND attempts>0 ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    assert.ok(pending);
    assert.equal(pending.attempts, 1);
    process.env.SMTP_PORT = actualPort;
    const recovered = await jobs.runMailBatch(new Date(pending.next_attempt_at));
    assert.equal(recovered.sent, 1);
  });
  await t.test('worker心跳和数据库健康检查可读取，退出使会话失效', async () => {
    await jobs.tick();
    ok(await api('GET', '/health'));
    ok(await api('GET', '/status', a));
    ok(await api('POST', '/auth/logout', d, {}));
    assert.equal((await api('GET', '/tasks', d)).status, 401);
  });
});

test('邮件偏好变更、失效验证链接和租约恢复边界', async (t) => {
  assert.equal(process.env.SMTP_HOST, '127.0.0.1');
  assert.ok(smtp);
  const spaceId = (await api('GET', '/bootstrap', b)).body.space.id as string;
  let expiredVerificationId: string;
  let exhaustedId: string;

  await t.test('已经排队的业务邮件在关闭提醒后不再发送', async () => {
    ok(await api('PATCH', '/settings', b, { notifyEmail: true }));
    await newTask('ASSIGNED', 5);
    const queued = (
      await database.query(
        "SELECT * FROM email_outbox WHERE user_id=$1 AND status='PENDING' ORDER BY created_at DESC LIMIT 1",
        [b.id],
      )
    ).rows[0];
    assert.ok(queued);
    const beforeCount = received.length;
    try {
      ok(await api('PATCH', '/settings', b, { notifyEmail: false }));
      const result = await jobs.runMailBatch();
      assert.equal(result.sent, 0);
      assert.equal(received.length, beforeCount);
      const stored = (
        await database.query('SELECT status,attempts,last_error FROM email_outbox WHERE id=$1', [
          queued.id,
        ])
      ).rows[0];
      assert.equal(stored.status, 'FAILED');
      assert.equal(stored.attempts, 0);
      assert.match(stored.last_error, /邮件提醒已关闭/);
    } finally {
      ok(await api('PATCH', '/settings', b, { notifyEmail: true }));
    }
  });

  await t.test('排队期间过期的邮箱验证链接不会发出', async () => {
    assert.equal((await api('GET', '/bootstrap', a)).body.user.emailVerified, false);
    ok(await api('POST', '/auth/verification', a, {}));
    const queued = (
      await database.query(
        "SELECT * FROM email_outbox WHERE user_id=$1 AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1",
        [a.id],
      )
    ).rows[0];
    assert.ok(queued.email_token_id);
    expiredVerificationId = queued.id;
    await database.query(
      "UPDATE email_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [queued.email_token_id],
    );
    const beforeCount = received.length;
    await jobs.runMailBatch();
    assert.equal(received.length, beforeCount);
    const stored = (
      await database.query('SELECT status,attempts,last_error FROM email_outbox WHERE id=$1', [
        expiredVerificationId,
      ])
    ).rows[0];
    assert.equal(stored.status, 'FAILED');
    assert.equal(stored.attempts, 0);
    assert.match(stored.last_error, /验证链接已过期或失效/);
  });

  await t.test('并发worker回收旧租约仅发送一次，第五次中断会终止', async () => {
    async function abandonedMail(attempts: number) {
      const result = await database.query(
        `INSERT INTO email_outbox
        (user_id,space_id,to_email,subject,body,status,attempts,locked_at,lease_until,lease_token)
        SELECT id,$2,email,$3,'Local SMTP lease recovery test','SENDING',$4,
          now()-interval '10 minutes',now()-interval '5 minutes',$5 FROM users WHERE id=$1
        RETURNING id`,
        [b.id, spaceId, `Lease recovery ${randomUUID()}`, attempts, randomUUID()],
      );
      return result.rows[0].id as string;
    }
    const recoverableId = await abandonedMail(1);
    exhaustedId = await abandonedMail(5);
    const beforeCount = received.length;
    await Promise.all([jobs.runMailBatch(), jobs.runMailBatch()]);
    assert.equal(received.length, beforeCount + 1);
    const recovered = (
      await database.query(
        'SELECT status,attempts,lease_token,lease_until FROM email_outbox WHERE id=$1',
        [recoverableId],
      )
    ).rows[0];
    assert.equal(recovered.status, 'SENT');
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.lease_token, null);
    assert.equal(recovered.lease_until, null);
    const exhausted = (
      await database.query(
        'SELECT status,attempts,lease_token,last_error FROM email_outbox WHERE id=$1',
        [exhaustedId],
      )
    ).rows[0];
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.attempts, 5);
    assert.equal(exhausted.lease_token, null);
    assert.match(exhausted.last_error, /最大尝试次数/);
  });

  await t.test('用户手动重试只重置本人失败邮件，并可重新发送成功', async () => {
    const beforeCount = received.length;
    const failedBefore = (await api('GET', '/mail/status', b)).body.counts.failed as number;
    assert.ok(failedBefore >= 2);
    const retried = await api('POST', '/mail/retry', b, {});
    ok(retried);
    assert.equal(retried.body.retried, failedBefore);
    const reset = (
      await database.query(
        'SELECT status,attempts,last_error,lease_token FROM email_outbox WHERE id=$1',
        [exhaustedId],
      )
    ).rows[0];
    assert.equal(reset.status, 'PENDING');
    assert.equal(reset.attempts, 0);
    assert.equal(reset.last_error, null);
    assert.equal(reset.lease_token, null);
    assert.equal(
      (await database.query('SELECT status FROM email_outbox WHERE id=$1', [expiredVerificationId]))
        .rows[0].status,
      'FAILED',
    );
    const result = await jobs.runMailBatch();
    assert.equal(result.failed, 0);
    assert.equal(result.sent, failedBefore);
    assert.equal(received.length, beforeCount + failedBefore);
    const sent = (
      await database.query('SELECT status,attempts FROM email_outbox WHERE id=$1', [exhaustedId])
    ).rows[0];
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.attempts, 1);
    assert.equal((await api('GET', '/mail/status', b)).body.counts.failed, 0);
  });
});

test('库存补货、取消兑现竞争与重新领取回归', async (t) => {
  await t.test('补至手动库存上限后旧订单仍可退款', async () => {
    const beforeBalance = await balance(a);
    const product = await newProduct(5, 1);
    const redeemed = await api('POST', `/products/${product.id}/redeem`, a, {
      idempotencyKey: randomUUID(),
    });
    ok(redeemed);
    ok(await api('PATCH', `/products/${product.id}`, b, { stock: 100000 }));
    ok(await api('POST', `/orders/${redeemed.body.order.id}/action`, a, { action: 'cancel' }));
    assert.equal(await balance(a), beforeBalance);
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock,
      100001,
    );
  });
  await t.test('不同商品不能复用幂等键；取消与兑现竞争只有一个结果', async () => {
    const beforeBalance = await balance(a);
    const first = await newProduct(5, 2),
      second = await newProduct(5, 2),
      key = randomUUID();
    const redeemed = await api('POST', `/products/${first.id}/redeem`, a, { idempotencyKey: key });
    ok(redeemed);
    const reused = await api('POST', `/products/${second.id}/redeem`, a, { idempotencyKey: key });
    assert.equal(reused.status, 409);
    const id = redeemed.body.order.id;
    const actions = await Promise.all([
      api('POST', `/orders/${id}/action`, a, { action: 'cancel' }),
      api('POST', `/orders/${id}/action`, b, { action: 'fulfill' }),
    ]);
    assert.equal(actions.filter((result) => result.status < 300).length, 1);
    const status = (await database.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0]
      .status;
    assert.ok(['CANCELLED', 'FULFILLED'].includes(status));
    assert.equal(await balance(a), beforeBalance - (status === 'CANCELLED' ? 0 : 5));
  });
  await t.test('退回后放弃可由原验收者抢单并交给另一人验收', async () => {
    const task = await newTask('RACE', 5);
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    ok(await api('POST', `/tasks/${task.id}/submit`, a, { submission: '第一遍完成' }));
    ok(await api('POST', `/tasks/${task.id}/review`, b, { approve: false, note: '调整一下做法' }));
    ok(await api('POST', `/tasks/${task.id}/release`, a, {}));
    ok(await api('POST', `/tasks/${task.id}/claim`, b, {}));
    ok(await api('POST', `/tasks/${task.id}/submit`, b, { submission: '我来完成这件小事' }));
    const initial = await balance(b);
    ok(await api('POST', `/tasks/${task.id}/review`, a, { approve: true }));
    assert.equal(await balance(b), initial + 5);
    assert.equal(
      (
        await database.query(
          'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON w.user_id=l.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
        )
      ).rowCount,
      0,
    );
  });
});

test('自己的心愿、完整邮件通知与个人模板偏好', async (t) => {
  // Use the existing local SMTP receiver; no message leaves this test process.
  assert.equal(process.env.SMTP_HOST, '127.0.0.1');
  ok(await api('POST', '/auth/verification', a, {}));
  const verification = (
    await database.query(
      "SELECT body FROM email_outbox WHERE user_id=$1 AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1",
      [a.id],
    )
  ).rows[0];
  const token = /[?&]verify=([A-Za-z0-9_-]+)/.exec(verification.body)?.[1];
  assert.ok(token);
  ok(await api('POST', '/auth/verify', a, { token }));
  for (const account of [a, b]) ok(await api('PATCH', '/settings', account, { notifyEmail: true }));
  async function mails(id: string) {
    return (
      await database.query('SELECT * FROM email_outbox WHERE body LIKE $1 ORDER BY created_at,id', [
        `%${id}%`,
      ])
    ).rows;
  }

  await t.test('模板选择分别保存，不更改通知开关或另一人的偏好；连续主题按天数解锁', async () => {
    assert.equal((await api('GET', '/mail/templates')).status, 401);
    const catalogue = await api('GET', '/mail/templates', a);
    ok(catalogue);
    assert.equal(catalogue.body.templates.length, 11);
    assert.equal(new Set(catalogue.body.templates.map((item: { id: string }) => item.id)).size, 11);
    assert.ok(
      catalogue.body.templates.every((item: { html: string }) => item.html.includes('<table')),
    );
    const otherTheme = (await api('GET', '/bootstrap', b)).body.user.emailTheme;
    const available = catalogue.body.templates.filter(
      (item: { unlockDays?: number }) => (item.unlockDays ?? 0) === 0,
    );
    const locked = catalogue.body.templates.filter(
      (item: { unlockDays?: number }) => (item.unlockDays ?? 0) > 0,
    );
    assert.equal(available.length, 6);
    assert.deepEqual(
      locked.map((item: { id: string; unlockDays: number }) => [item.id, item.unlockDays]),
      [
        ['line-puppy', 2],
        ['lulu', 7],
        ['nailong', 14],
        ['yibubu', 21],
        ['tom-jerry', 30],
      ],
    );
    for (const template of available) {
      ok(await api('PATCH', '/settings', a, { emailTheme: template.id }));
      const state = (await api('GET', '/bootstrap', a)).body;
      assert.equal(state.user.emailTheme, template.id);
      assert.equal(state.user.notifyEmail, true);
    }
    for (const template of locked) {
      assert.equal((await api('PATCH', '/settings', a, { emailTheme: template.id })).status, 409);
    }
    assert.equal((await api('GET', '/bootstrap', b)).body.user.emailTheme, otherTheme);
    assert.equal((await api('PATCH', '/settings', a, { emailTheme: 'unknown' })).status, 400);
    assert.equal((await api('PATCH', '/settings', a, {})).status, 400);
  });

  await t.test('双方连续完成两天后可以领取主题，领取状态按账号保留', async () => {
    const spaceId = (await api('GET', '/bootstrap', a)).body.space.id as string;
    const now = DateTime.now().setZone('Asia/Shanghai');
    const approvedAt = [
      now.minus({ days: 1, minutes: 20 }).toUTC().toJSDate(),
      now.minus({ minutes: 10 }).toUTC().toJSDate(),
    ];
    for (const [index, timestamp] of approvedAt.entries()) {
      for (const claimant of [a, b]) {
        const creator = claimant.id === a.id ? b : a;
        await database.query(
          `INSERT INTO tasks(space_id,creator_id,claimant_id,title,reward,mode,status,approved_at,created_at)
           VALUES($1,$2,$3,$4,1,'RACE','APPROVED',$5,$5)`,
          [spaceId, creator.id, claimant.id, `连续完成测试 ${index}`, timestamp],
        );
      }
    }
    const streak = await api('GET', '/mail/streak', a);
    ok(streak);
    assert.equal(streak.body.streak.current, 2);
    assert.equal(streak.body.nextMilestone.templateId, 'lulu');
    const claim = await api('POST', '/mail/templates/line-puppy/claim', a, {});
    ok(claim);
    assert.equal(claim.body.streakDays, 2);
    assert.equal((await api('GET', '/bootstrap', a)).body.user.emailTheme, 'line-puppy');
    assert.equal((await api('POST', '/mail/templates/line-puppy/claim', b, {})).status, 200);
    const after = await api('GET', '/mail/streak', a);
    assert.equal(
      after.body.milestones.find((item: { templateId: string }) => item.templateId === 'line-puppy')
        .claimed,
      true,
    );
  });

  await t.test('发布、领取、提交和验收都通知正确的人，重复领取/审核不重复入队', async () => {
    for (const mode of ['ASSIGNED', 'RACE']) {
      const task = await newTask(mode, 7, a);
      const claimant = mode === 'ASSIGNED' ? b : a;
      const reviewer = mode === 'ASSIGNED' ? a : b;
      let queued = await mails(task.id);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].kind, 'TASK_CREATED');
      assert.equal(queued[0].user_id, b.id);
      assert.match(queued[0].body, /alice.*一起认真生活/);
      assert.ok(queued[0].body.includes(`?page=tasks&task=${task.id}`));
      ok(await api('POST', `/tasks/${task.id}/claim`, claimant, {}));
      ok(await api('POST', `/tasks/${task.id}/claim`, claimant, {}));
      queued = await mails(task.id);
      assert.equal(queued.filter((mail) => mail.kind === 'TASK_CLAIMED').length, 1);
      assert.equal(queued.find((mail) => mail.kind === 'TASK_CLAIMED')!.user_id, reviewer.id);
      const submitted = await api('POST', `/tasks/${task.id}/submit`, claimant, {
        submission: '  已经完成啦 <3  ',
      });
      ok(submitted);
      assert.equal(submitted.body.task.submission, '已经完成啦 <3');
      assert.equal(
        (await database.query('SELECT submission FROM tasks WHERE id=$1', [task.id])).rows[0]
          .submission,
        '已经完成啦 <3',
      );
      ok(
        await api('POST', `/tasks/${task.id}/review`, reviewer, {
          approve: true,
          note: '谢谢你的用心',
        }),
      );
      ok(await api('POST', `/tasks/${task.id}/review`, reviewer, { approve: true }));
      queued = await mails(task.id);
      assert.equal(queued.length, 4);
      const submittedMail = queued.find((mail) => mail.kind === 'TASK_SUBMITTED')!;
      assert.equal(submittedMail.user_id, reviewer.id);
      assert.match(submittedMail.body, /完成说明：已经完成啦 <3/);
      assert.match(
        (
          await database.query('SELECT body FROM notifications WHERE id=$1', [
            submittedMail.notification_id,
          ])
        ).rows[0].body,
        /完成说明：已经完成啦 <3/,
      );
      const approved = queued.find((mail) => mail.kind === 'TASK_APPROVED')!;
      assert.equal(approved.user_id, claimant.id);
      assert.match(approved.body, /7 积分已到账/);
    }
  });

  await t.test('完成说明可省略或留空，通知自然且仍须另一人验收才入账', async () => {
    for (const payload of [undefined, {}, { submission: '' }, { submission: ' \n\t ' }]) {
      const initial = await balance(a);
      const task = await newTask('RACE', 7, a);
      ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
      const submitted = await api('POST', `/tasks/${task.id}/submit`, a, payload);
      ok(submitted);
      assert.equal(submitted.body.task.status, 'SUBMITTED');
      assert.equal(submitted.body.task.submission, null);
      assert.ok(submitted.body.task.submittedAt);
      assert.equal(
        (await database.query('SELECT submission FROM tasks WHERE id=$1', [task.id])).rows[0]
          .submission,
        null,
      );
      assert.equal(await balance(a), initial);
      assert.equal(
        (await api('POST', `/tasks/${task.id}/review`, a, { approve: true })).status,
        403,
      );
      assert.equal((await api('POST', `/tasks/${task.id}/submit`, a, {})).status, 409);
      const notices = (await mails(task.id)).filter((mail) => mail.kind === 'TASK_SUBMITTED');
      assert.equal(notices.length, 1);
      assert.equal(notices[0].user_id, b.id);
      const inApp = (
        await database.query('SELECT body,user_id FROM notifications WHERE id=$1', [
          notices[0].notification_id,
        ])
      ).rows[0];
      assert.equal(inApp.user_id, b.id);
      for (const body of [notices[0].body, inApp.body]) {
        assert.match(body, /已完成并提交「一起认真生活」/);
        assert.match(body, /通过验收后，7 积分/);
        assert.doesNotMatch(body, /完成说明|undefined|null/);
      }
      ok(await api('POST', `/tasks/${task.id}/review`, b, { approve: true }));
      assert.equal(await balance(a), initial + 7);
    }
  });

  await t.test('可选完成说明仍拒绝非字符串和超长内容，3000 字符可提交', async () => {
    const task = await newTask('RACE', 7, a);
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    for (const submission of [null, false, 1, [], {}, '好'.repeat(3001), ' '.repeat(3001)]) {
      assert.equal((await api('POST', `/tasks/${task.id}/submit`, a, { submission })).status, 400);
    }
    assert.equal(
      (await database.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0].status,
      'CLAIMED',
    );
    assert.equal((await mails(task.id)).filter((mail) => mail.kind === 'TASK_SUBMITTED').length, 0);
    const submitted = await api('POST', `/tasks/${task.id}/submit`, a, {
      submission: '好'.repeat(3000),
    });
    ok(submitted);
    assert.equal(submitted.body.task.submission, '好'.repeat(3000));
  });

  await t.test('省略完成说明不能绕过领取者、空间和截止时间限制', async () => {
    const task = await newTask('RACE', 7, a);
    ok(await api('POST', `/tasks/${task.id}/claim`, a, {}));
    assert.equal((await api('POST', `/tasks/${task.id}/submit`, b, {})).status, 403);
    assert.equal((await api('POST', `/tasks/${task.id}/submit`, c, {})).status, 409);
    await database.query("UPDATE tasks SET due_at=now()-interval '1 minute' WHERE id=$1", [
      task.id,
    ]);
    assert.equal((await api('POST', `/tasks/${task.id}/submit`, a, {})).status, 409);
    const stored = (
      await database.query('SELECT status,submission,submitted_at FROM tasks WHERE id=$1', [
        task.id,
      ])
    ).rows[0];
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(stored.submission, null);
    assert.equal(stored.submitted_at, null);
    assert.equal((await mails(task.id)).filter((mail) => mail.kind === 'TASK_SUBMITTED').length, 0);
  });

  await t.test('自己发布的心愿可以兑换，由另一半兑现，退款和重复请求仍防重', async () => {
    const product = await newProduct(5, 2, a);
    const initial = await balance(a);
    const otherBalance = await balance(b);
    const key = randomUUID();
    const results = await Promise.all([
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: key }),
      api('POST', `/products/${product.id}/redeem`, a, { idempotencyKey: key }),
    ]);
    results.forEach(ok);
    const order = results[0].body.order;
    assert.equal(order.id, results[1].body.order.id);
    assert.equal(order.buyerId, a.id);
    assert.equal(order.sellerId, b.id);
    assert.equal(await balance(a), initial - 5);
    assert.equal(await balance(b), otherBalance);
    const notice = await mails(order.id);
    assert.equal(notice.length, 1);
    assert.equal(notice[0].user_id, b.id);
    assert.equal(notice[0].kind, 'ORDER_CREATED');
    assert.match(notice[0].body, /alice.*5 积分.*一杯亲手做的拿铁/);
    denied(await api('POST', `/orders/${order.id}/action`, a, { action: 'fulfill' }));
    ok(await api('POST', `/orders/${order.id}/action`, b, { action: 'fulfill' }));
    denied(await api('POST', `/orders/${order.id}/action`, b, { action: 'complete' }));
    ok(await api('POST', `/orders/${order.id}/action`, a, { action: 'complete' }));
    const second = await api('POST', `/products/${product.id}/redeem`, a, {
      idempotencyKey: randomUUID(),
    });
    ok(second);
    const refunds = await Promise.all([
      api('POST', `/orders/${second.body.order.id}/action`, a, { action: 'cancel' }),
      api('POST', `/orders/${second.body.order.id}/action`, b, { action: 'cancel' }),
    ]);
    refunds.forEach(ok);
    assert.equal(await balance(a), initial - 5);
    assert.equal(
      (await database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock,
      1,
    );
    assert.equal(
      (await mails(second.body.order.id)).filter((mail) => mail.kind === 'ORDER_CANCELLED').length,
      1,
    );
  });

  await t.test('定时发布同样给对方发领取提醒且调度不会重复入队', async () => {
    const at = new Date(Date.now() + 60000);
    const plan = await api('POST', '/schedules', a, {
      title: '定时邮件小约定',
      description: '到点来领取',
      mode: 'RACE',
      reward: 8,
      kind: 'ONCE',
      runAt: at.toISOString(),
      durationHours: 1,
    });
    ok(plan);
    await jobs.runScheduler(new Date(at.getTime() + 1000));
    await jobs.runScheduler(new Date(at.getTime() + 1000));
    const task = (
      await database.query('SELECT id FROM tasks WHERE schedule_id=$1', [plan.body.schedule.id])
    ).rows[0];
    const queued = await mails(task.id);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].user_id, b.id);
    assert.equal(queued[0].kind, 'TASK_CREATED');
    assert.match(queued[0].body, /alice.*定时邮件小约定.*领取/);
  });

  await t.test('SMTP实际发出纯文字和HTML，使用收件人最新选择的模板', async () => {
    // Drain unrelated local test mail before checking one specific new notification.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!(await jobs.runMailBatch()).processed) break;
    }
    const task = await newTask('ASSIGNED', 3, a);
    ok(await api('PATCH', '/settings', b, { emailTheme: 'night' }));
    const queued = (await mails(task.id))[0];
    const beforeCount = received.length;
    assert.equal((await jobs.runMailBatch()).sent, 1);
    assert.equal(received.length, beforeCount + 1);
    const raw = received.at(-1)!;
    assert.match(raw, /Content-Type: multipart\/alternative/i);
    assert.match(raw, /Content-Type: text\/plain/i);
    assert.match(raw, /Content-Type: text\/html/i);
    assert.ok(raw.includes(`couple-${queued.id}`));
    // Nodemailer quotes equals and folds long UTF-8 HTML lines for SMTP.
    const unfolded = raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
    assert.ok(unfolded.includes('data-email-theme="night"'));
    assert.ok(unfolded.includes(task.id));
    assert.equal(
      (await database.query('SELECT status FROM email_outbox WHERE id=$1', [queued.id])).rows[0]
        .status,
      'SENT',
    );
    const mismatch = await database.query(
      'SELECT w.user_id FROM wallets w LEFT JOIN point_ledger l ON w.user_id=l.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.delta),0)',
    );
    assert.equal(mismatch.rowCount, 0);
  });
});
