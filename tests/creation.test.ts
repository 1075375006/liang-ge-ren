import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

const databaseName = `couple_creation_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
const password = 'Creation!Together2026';
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let created = false;
let ip = 1;
type Account = { id: string; cookie: string; spaceId: string };
let a: Account, b: Account, c: Account, d: Account;

before(async () => {
  assert.match(databaseName, /^couple_creation_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const connection = new URL(adminUrl);
  connection.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = connection.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.COOKIE_SECURE = 'false';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.REGISTRATION_OPEN = 'true';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  database = await import('../server/db.js');
  await database.migrate();
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
  [a, b, c, d] = await Promise.all(['create-a', 'create-b', 'create-c', 'create-d'].map(register));
  await pair(a, b);
  await pair(c, d);
  await database.query('UPDATE users SET email_verified=true,notify_email=true');
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
) {
  const response = await app.inject({
    method,
    url: `/api${path}`,
    remoteAddress: `127.3.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    headers: { origin: 'http://localhost:33442', ...(account ? { cookie: account.cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
async function register(name: string): Promise<Account> {
  const response = await api('POST', '/auth/register', undefined, {
    name,
    email: `${name}@example.test`,
    password,
    acceptTerms: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  assert.ok(cookie);
  return { id: response.body.user.id, cookie, spaceId: '' };
}
async function pair(first: Account, second: Account) {
  assert.equal((await api('POST', '/spaces', first, { name: '可靠的新建空间' })).status, 200);
  const state = await api('GET', '/bootstrap', first);
  first.spaceId = state.body.space.id;
  second.spaceId = first.spaceId;
  assert.equal(
    (await api('POST', '/spaces/join', second, { code: state.body.space.inviteCode })).status,
    200,
  );
  assert.equal((await api('POST', '/contract/accept', first, {})).status, 200);
  assert.equal((await api('POST', '/contract/accept', second, {})).status, 200);
}
const taskBody = (requestKey?: string) => ({
  title: '幂等约定',
  mode: 'RACE',
  reward: 12,
  ...(requestKey ? { requestKey } : {}),
});
const scheduleBody = (requestKey?: string) => ({
  ...taskBody(requestKey),
  title: '幂等计划',
  kind: 'DAILY',
  time: '08:15',
  durationHours: 24,
});
const productBody = (requestKey?: string) => ({
  title: '幂等心愿',
  price: 5,
  stock: 3,
  ...(requestKey ? { requestKey } : {}),
});

test('六个并发相同任务请求只创建一条约定和一份通知/邮件队列', async () => {
  const key = randomUUID();
  const body = { ...taskBody(key), title: '并发重试只有一份' };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => api('POST', '/tasks', a, body)),
  );
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(new Set(results.map((result) => result.body.task.id)).size, 1);
  const taskId = results[0].body.task.id;
  assert.equal(
    (
      await database.query('SELECT count(*)::int AS n FROM tasks WHERE title=$1 AND space_id=$2', [
        body.title,
        a.spaceId,
      ])
    ).rows[0].n,
    1,
  );
  const records = (
    await database.query(
      'SELECT payload_hash,record_id FROM creation_requests WHERE request_key=$1',
      [key],
    )
  ).rows;
  assert.equal(records.length, 1);
  assert.equal(records[0].record_id, taskId);
  assert.match(records[0].payload_hash, /^[a-f0-9]{64}$/);
  const notices = (
    await database.query(
      "SELECT n.id,count(m.id)::int AS mails FROM notifications n LEFT JOIN email_outbox m ON m.notification_id=n.id WHERE n.space_id=$1 AND n.kind='TASK_CREATED' AND n.body LIKE $2 GROUP BY n.id",
      [a.spaceId, `%${body.title}%`],
    )
  ).rows;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].mails, 1);
});

test('计划及心愿的并发重试与普通重复请求都返回同一条记录', async () => {
  for (const [path, kind, body] of [
    ['/schedules', 'schedule', scheduleBody(randomUUID())],
    ['/products', 'product', productBody(randomUUID())],
  ] as const) {
    const results = await Promise.all(Array.from({ length: 4 }, () => api('POST', path, a, body)));
    for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
    const id = results[0].body[kind].id;
    assert.ok(results.every((result) => result.body[kind].id === id));
    const retry = await api('POST', path, a, body);
    assert.equal(retry.status, 200);
    assert.equal(retry.body[kind].id, id);
    assert.equal(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM creation_requests WHERE request_key=$1',
          [body.requestKey],
        )
      ).rows[0].n,
      1,
    );
  }
});

test('相同请求编号的新内容被拒绝，默认值/空白/时区等价输入归一化', async () => {
  const key = randomUUID();
  const deadline = new Date(Date.now() + 86400000).toISOString();
  const original = { ...taskBody(key), dueAt: deadline };
  const first = await api('POST', '/tasks', a, original);
  const normalized = await api('POST', '/tasks', a, {
    reward: 12,
    mode: 'RACE',
    title: '  幂等约定  ',
    description: '  ',
    dueAt: deadline.replace('Z', '+00:00'),
    requestKey: ` ${key} `,
  });
  assert.equal(normalized.status, 200);
  assert.equal(normalized.body.task.id, first.body.task.id);
  assert.equal((await api('POST', '/tasks', a, { ...original, reward: 13 })).status, 409);
  for (const [path, body] of [
    ['/schedules', scheduleBody(randomUUID())],
    ['/products', productBody(randomUUID())],
  ] as const) {
    assert.equal((await api('POST', path, a, body)).status, 200);
    assert.equal((await api('POST', path, a, { ...body, title: '改成不同的内容' })).status, 409);
  }
  const productKey = randomUUID();
  const product = await api('POST', '/products', a, productBody(productKey));
  const equivalent = await api('POST', '/products', a, {
    ...productBody(productKey),
    title: ' 幂等心愿 ',
    description: '',
    emoji: ' 🎁 ',
  });
  assert.equal(equivalent.status, 200);
  assert.equal(equivalent.body.product.id, product.body.product.id);
});

test('已变更状态的记录仍返回现状，不会重建或重复发新建通知', async () => {
  const key = randomUUID();
  const body = { ...taskBody(key), title: '丢失的响应稍后才重试' };
  const first = await api('POST', '/tasks', a, body);
  assert.equal((await api('POST', `/tasks/${first.body.task.id}/claim`, b, {})).status, 200);
  const retry = await api('POST', '/tasks', a, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.task.id, first.body.task.id);
  assert.equal(retry.body.task.status, 'CLAIMED');
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM notifications WHERE kind='TASK_CREATED' AND space_id=$1 AND body LIKE $2",
        [a.spaceId, `%${body.title}%`],
      )
    ).rows[0].n,
    1,
  );
});

test('过了截止/计划发布时间后重试已保存的请求仍成功，新请求继续拒绝过期时间', async (t) => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const taskInput = { ...taskBody(randomUUID()), dueAt: future };
  const scheduleInput = {
    ...taskBody(randomUUID()),
    kind: 'ONCE',
    runAt: future,
    durationHours: 24,
  };
  const task = await api('POST', '/tasks', a, taskInput);
  const schedule = await api('POST', '/schedules', a, scheduleInput);
  assert.equal(task.status, 200);
  assert.equal(schedule.status, 200);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 86400000 });
  try {
    const retriedTask = await api('POST', '/tasks', a, taskInput);
    const retriedSchedule = await api('POST', '/schedules', a, scheduleInput);
    assert.equal(retriedTask.status, 200);
    assert.equal(retriedTask.body.task.id, task.body.task.id);
    assert.equal(retriedSchedule.status, 200);
    assert.equal(retriedSchedule.body.schedule.id, schedule.body.schedule.id);
    assert.equal(
      (await api('POST', '/tasks', a, { ...taskInput, requestKey: randomUUID() })).status,
      400,
    );
    assert.equal(
      (await api('POST', '/schedules', a, { ...scheduleInput, requestKey: randomUUID() })).status,
      400,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test('新建事务失败不保留去重记录，修复后可使用同一编号安全重试', async () => {
  const key = randomUUID();
  const body = { ...taskBody(key), title: '故障后可重试的新建' };
  await database.query(
    "CREATE FUNCTION creation_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional creation notification failure'; END $$",
  );
  await database.query(
    'CREATE TRIGGER creation_test_failure BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION creation_test_failure()',
  );
  try {
    const failed = await api('POST', '/tasks', a, body);
    assert.equal(failed.status, 500);
    assert.equal(
      (await database.query('SELECT count(*)::int AS n FROM tasks WHERE title=$1', [body.title]))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM creation_requests WHERE request_key=$1',
          [key],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await database.query('DROP TRIGGER creation_test_failure ON notifications');
    await database.query('DROP FUNCTION creation_test_failure()');
  }
  const saved = await api('POST', '/tasks', a, body);
  assert.equal(saved.status, 200);
  assert.equal((await api('POST', '/tasks', a, body)).body.task.id, saved.body.task.id);
});

test('旧客户端无编号仍兼容，非法编号拒绝，类型及商品编辑字段保持隔离', async () => {
  const first = await api('POST', '/tasks', a, taskBody());
  const second = await api('POST', '/tasks', a, taskBody());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.task.id, second.body.task.id);
  for (const requestKey of ['', 'short', 'x'.repeat(129), null, 123])
    assert.equal((await api('POST', '/tasks', a, { ...taskBody(), requestKey })).status, 400);
  const sharedKey = randomUUID();
  const task = await api('POST', '/tasks', a, taskBody(sharedKey));
  const schedule = await api('POST', '/schedules', a, scheduleBody(sharedKey));
  const product = await api('POST', '/products', a, productBody(sharedKey));
  assert.equal(
    new Set([task.body.task.id, schedule.body.schedule.id, product.body.product.id]).size,
    3,
  );
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM creation_requests WHERE request_key=$1',
        [sharedKey],
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (await api('PATCH', `/products/${product.body.product.id}`, a, { requestKey: sharedKey }))
      .status,
    400,
  );
});

test('同编号按用户和空间隔离，关闭旧空间后也不能借重试绕过权限', async () => {
  const sharedKey = randomUUID();
  const body = { ...taskBody(sharedKey), title: '每位用户每个空间各自的新建' };
  const first = await api('POST', '/tasks', a, body);
  const partner = await api('POST', '/tasks', b, body);
  const outsider = await api('POST', '/tasks', c, body);
  assert.equal(new Set([first.body.task.id, partner.body.task.id, outsider.body.task.id]).size, 3);
  assert.equal(
    (await api('POST', '/spaces/archive', a, { confirmation: '关闭空间', password })).status,
    200,
  );
  assert.equal((await api('POST', '/tasks', a, body)).status, 409);
  assert.equal(
    (await api('POST', '/spaces/leave-archived', a, { confirmation: '离开空间' })).status,
    200,
  );
  const newPartner = await register('create-e');
  await pair(a, newPartner);
  const newSpace = await api('POST', '/tasks', a, body);
  assert.equal(newSpace.status, 200);
  assert.notEqual(newSpace.body.task.id, first.body.task.id);
  assert.equal(newSpace.body.task.spaceId, a.spaceId);
  assert.equal((await api('GET', `/tasks/${first.body.task.id}`, a)).status, 404);
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int AS n FROM creation_requests WHERE request_key=$1',
        [sharedKey],
      )
    ).rows[0].n,
    4,
  );
});
