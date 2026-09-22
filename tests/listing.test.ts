import { dropTestDatabase } from './database-fixture.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

const databaseName = `couple_listing_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let app: FastifyInstance;
let database: typeof import('../server/db.js');
let created = false;
let ip = 1;
type Account = { id: string; cookie: string; spaceId: string };
let a: Account, b: Account, c: Account, d: Account;
let productId: string;
const timestamp = "'2026-01-01 12:34:56.123451+00'::timestamptz + (n%5)*interval '1 microsecond'";

before(async () => {
  assert.match(databaseName, /^couple_listing_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const connection = new URL(adminUrl);
  connection.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = connection.toString();
  process.env.APP_URL = 'http://localhost:33442';
  process.env.COOKIE_SECURE = 'false';
  process.env.REQUIRE_VERIFIED_EMAIL = 'false';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';
  database = await import('../server/db.js');
  await database.migrate();
  const { buildApp } = await import('../server/app.js');
  app = await buildApp();
  [a, b, c, d] = await Promise.all(['paging-a', 'paging-b', 'paging-c', 'paging-d'].map(register));
  await pair(a, b);
  await pair(c, d);
  await database.query(
    `INSERT INTO tasks(space_id,creator_id,title,description,reward,mode,created_at) SELECT $1,$2,'分页约定 '||n,'保留微秒排序',1,'RACE',${timestamp} FROM generate_series(1,237) n`,
    [a.spaceId, a.id],
  );
  await database.query(
    "INSERT INTO tasks(space_id,creator_id,title,reward,mode) VALUES($1,$2,'另一组的秘密',1,'RACE')",
    [c.spaceId, c.id],
  );
  await database.query(
    `INSERT INTO schedules(space_id,creator_id,title,reward,mode,kind,time,duration_hours,created_at) SELECT $1,$2,'分页计划 '||n,1,'RACE','DAILY','12:00',24,${timestamp} FROM generate_series(1,205) n`,
    [a.spaceId, a.id],
  );
  await database.query(
    `INSERT INTO products(space_id,creator_id,title,price,stock,created_at) SELECT $1,$2,'分页心愿 '||n,1,1,${timestamp} FROM generate_series(1,205) n`,
    [a.spaceId, a.id],
  );
  productId = (
    await database.query('SELECT id FROM products WHERE space_id=$1 LIMIT 1', [a.spaceId])
  ).rows[0].id;
  await database.query(
    "INSERT INTO products(space_id,creator_id,title,price,stock,active) VALUES($1,$2,'对方已下架心愿',1,1,false),($1,$3,'本人已下架心愿',1,1,false),($4,$5,'另一个空间心愿',1,1,true)",
    [a.spaceId, b.id, a.id, c.spaceId, c.id],
  );
  await database.query(
    `INSERT INTO orders(space_id,buyer_id,seller_id,product_id,title,description,price,status,idempotency_key,created_at) SELECT $1,$2,$3,$4,'分页兑换 '||n,'保留历史',1,(ARRAY['PENDING','FULFILLED','COMPLETED','CANCELLED'])[n%4+1],'paging-'||n,${timestamp} FROM generate_series(1,205) n`,
    [a.spaceId, a.id, b.id, productId],
  );
  await database.query(
    `INSERT INTO point_ledger(user_id,space_id,delta,balance_after,reason,source_key,created_at) SELECT $1,$2,1,n,'分页积分 '||n,'paging-'||n,${timestamp} FROM generate_series(1,205) n`,
    [a.id, a.spaceId],
  );
  await database.query('UPDATE wallets SET balance=205 WHERE user_id=$1', [a.id]);
  await database.query(
    `INSERT INTO notifications(user_id,space_id,title,body,read_at,created_at) SELECT $1,$2,'分页消息 '||n,'保留完整通知',CASE WHEN n<=3 THEN now() ELSE NULL END,${timestamp} FROM generate_series(1,205) n`,
    [a.id, a.spaceId],
  );
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
    remoteAddress: `127.2.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    headers: { origin: 'http://localhost:33442', ...(account ? { cookie: account.cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}
async function register(name: string): Promise<Account> {
  const response = await api('POST', '/auth/register', undefined, {
    name,
    email: `${name}@example.test`,
    password: 'Paging!Together2026',
    termsAccepted: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  assert.ok(cookie);
  return { id: response.body.user.id, cookie, spaceId: '' };
}
async function pair(first: Account, second: Account) {
  assert.equal((await api('POST', '/spaces', first, { name: '分页验收空间' })).status, 200);
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
async function collect(path: string, key: string, account = a, limit = 37) {
  const items: Array<{ id: string; [key: string]: unknown }> = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response = await api(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      account,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body[key].length <= limit);
    items.push(...response.body[key]);
    cursor = response.body.nextCursor;
    assert.ok(cursor === null || typeof cursor === 'string');
    if (cursor) {
      assert.ok(!seen.has(cursor), 'cursor must make progress');
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(
    new Set(items.map((item) => item.id)).size,
    items.length,
    'no repeated row between pages',
  );
  assert.ok(
    items.every((item) => !('cursorCreatedAt' in item)),
    'internal microsecond cursor field stays private',
  );
  return items;
}

test('任务跨 200 条完整分页，同一时间和微秒时间不漏不重', async () => {
  const initial = await api('GET', '/tasks', a);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.tasks.length, 60);
  assert.equal(initial.body.schedules.length, 60);
  assert.ok(initial.body.nextCursor);
  assert.ok(initial.body.schedulesNextCursor);
  const cursor = JSON.parse(Buffer.from(initial.body.nextCursor, 'base64url').toString());
  assert.match(cursor.createdAt, /\.\d{6}[+-]\d{2}:\d{2}$/);
  const expected = (
    await database.query(
      'SELECT id FROM tasks WHERE space_id=$1 ORDER BY created_at DESC,id DESC',
      [a.spaceId],
    )
  ).rows.map((row) => row.id);
  const actual = await collect('/tasks', 'tasks');
  assert.equal(actual.length, 237);
  assert.deepEqual(
    actual.map((row) => row.id),
    expected,
  );
  const schedules = await api(
    'GET',
    `/schedules?limit=60&cursor=${initial.body.schedulesNextCursor}`,
    a,
  );
  assert.equal(schedules.status, 200);
  assert.equal(schedules.body.schedules.length, 60);
});

test('心愿、计划、订单、积分、通知均能访问 200 条以外历史', async () => {
  const specs = [
    {
      path: '/products',
      key: 'products',
      table: 'products',
      where: 'space_id=$1 AND (active OR creator_id=$2)',
      values: [a.spaceId, a.id],
    },
    {
      path: '/schedules',
      key: 'schedules',
      table: 'schedules',
      where: 'space_id=$1',
      values: [a.spaceId],
    },
    { path: '/orders', key: 'orders', table: 'orders', where: 'space_id=$1', values: [a.spaceId] },
    {
      path: '/ledger',
      key: 'entries',
      table: 'point_ledger',
      where: 'user_id=$1 AND space_id=$2',
      values: [a.id, a.spaceId],
    },
    {
      path: '/notifications',
      key: 'notifications',
      table: 'notifications',
      where: 'user_id=$1',
      values: [a.id],
    },
  ];
  for (const spec of specs) {
    const actual = await collect(spec.path, spec.key);
    const expected = (
      await database.query(
        `SELECT id FROM ${spec.table} WHERE ${spec.where} ORDER BY created_at DESC,id DESC`,
        spec.values,
      )
    ).rows.map((row) => row.id);
    assert.ok(actual.length > 200, spec.path);
    assert.deepEqual(
      actual.map((row) => row.id),
      expected,
      spec.path,
    );
  }
  const hidden = await collect('/products', 'products');
  assert.ok(hidden.some((item) => item.title === '本人已下架心愿'));
  assert.ok(
    hidden.every((item) => item.title !== '对方已下架心愿' && item.title !== '另一个空间心愿'),
  );
  assert.equal((await api('GET', '/ledger?limit=1', a)).body.balance, 205);
  const notices = await api('GET', '/notifications?limit=1', a);
  const expectedUnread = (
    await database.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL',
      [a.id],
    )
  ).rows[0].n;
  assert.equal(notices.body.unreadCount, expectedUnread);
  assert.ok(notices.body.unreadCount > notices.body.notifications.length);
});

test('游标拒绝非法输入、另一用户或空间及不同筛选条件，权限不能被查询参数绕过', async () => {
  const first = await api('GET', '/tasks?limit=1', a);
  const cursor = first.body.nextCursor;
  for (const path of [
    '/tasks?limit=0',
    '/tasks?limit=201',
    '/tasks?limit=wat',
    '/tasks?cursor=garbage',
    '/tasks?cursor=%21',
    '/tasks?view=unknown',
  ])
    assert.equal((await api('GET', path, a)).status, 400, path);
  assert.equal((await api('GET', `/tasks?cursor=${cursor}`, c)).status, 400);
  assert.equal((await api('GET', `/tasks?cursor=${cursor}`, b)).status, 400);
  assert.equal((await api('GET', `/tasks?view=current&cursor=${cursor}`, a)).status, 400);
  assert.equal((await api('GET', `/orders?cursor=${cursor}`, a)).status, 400);
  assert.equal((await api('GET', '/tasks')).status, 401);
  const other = await api('GET', `/tasks?spaceId=${a.spaceId}`, c);
  assert.equal(other.status, 200);
  assert.equal(other.body.tasks.length, 1);
  assert.equal(other.body.tasks[0].title, '另一组的秘密');
  const forged = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  forged.createdAt = '2026-02-31T00:00:00.000001+00:00';
  assert.equal(
    (
      await api(
        'GET',
        `/tasks?cursor=${Buffer.from(JSON.stringify(forged)).toString('base64url')}`,
        a,
      )
    ).status,
    400,
  );
});

test('任务筛选与搜索在服务端执行，通配符按文字搜索', async () => {
  await database.query(
    "INSERT INTO tasks(space_id,creator_id,claimant_id,title,reward,mode,status) VALUES($1,$2,$3,'筛选待验收',1,'RACE','SUBMITTED'),($1,$2,$2,'筛选我提交',1,'RACE','SUBMITTED'),($1,$2,$3,'筛选已完成',1,'RACE','APPROVED'),($1,$2,NULL,'100%_真的',1,'RACE','OPEN')",
    [a.spaceId, a.id, b.id],
  );
  const review = await collect('/tasks?view=review', 'tasks');
  assert.equal(review.length, 1);
  assert.equal(review[0].title, '筛选待验收');
  const mine = await collect('/tasks?view=mine', 'tasks');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, '筛选我提交');
  const history = await collect('/tasks?view=history', 'tasks');
  assert.equal(history.length, 1);
  assert.equal(history[0].title, '筛选已完成');
  const current = await collect('/tasks?view=current', 'tasks');
  assert.ok(current.every((item) => item.status !== 'APPROVED'));
  const literal = await collect('/tasks?q=%25_', 'tasks');
  assert.equal(literal.length, 1);
  assert.equal(literal[0].title, '100%_真的');
  const description = await collect('/tasks?q=' + encodeURIComponent('保留微秒'), 'tasks');
  assert.equal(description.length, 237);
});

test('待处理订单按本人角色筛选，旧约定和旧订单深链接不依赖首屏', async () => {
  const buyerActions = await collect('/orders?view=actionable', 'orders');
  assert.ok(buyerActions.every((item) => item.status === 'FULFILLED' && item.buyerId === a.id));
  const sellerActions = await collect('/orders?view=actionable', 'orders', b);
  assert.ok(sellerActions.every((item) => item.status === 'PENDING' && item.sellerId === b.id));
  assert.ok(buyerActions.length > 0 && sellerActions.length > 0);
  for (const [table, path, key] of [
    ['tasks', '/tasks', 'task'],
    ['orders', '/orders', 'order'],
  ]) {
    const oldest = (
      await database.query(
        `SELECT id FROM ${table} WHERE space_id=$1 ORDER BY created_at,id LIMIT 1`,
        [a.spaceId],
      )
    ).rows[0].id;
    assert.equal((await api('GET', `${path}/${oldest}`, a)).body[key].id, oldest);
    assert.equal((await api('GET', `${path}/${oldest}`, c)).status, 404);
    assert.equal((await api('GET', `${path}/${randomUUID()}`, a)).status, 404);
    assert.equal((await api('GET', `${path}/invalid`, a)).status, 400);
  }
});

test('翻页期间新增记录不会导致旧页重复，也不会遗漏已有记录', async () => {
  const expected = (
    await database.query(
      'SELECT id FROM tasks WHERE space_id=$1 ORDER BY created_at DESC,id DESC',
      [a.spaceId],
    )
  ).rows.map((row) => row.id);
  const first = await api('GET', '/tasks?limit=200', a);
  await database.query(
    "INSERT INTO tasks(space_id,creator_id,title,reward,mode) VALUES($1,$2,'翻页中刚发布',1,'RACE')",
    [a.spaceId, a.id],
  );
  const second = await api('GET', `/tasks?limit=200&cursor=${first.body.nextCursor}`, a);
  const ids = [...first.body.tasks, ...second.body.tasks].map((row: { id: string }) => row.id);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual(ids, expected);
});
