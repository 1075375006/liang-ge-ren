import { dropTestDatabase } from './database-fixture.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseName = `couple_maintenance_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_ADMIN ??
  'postgresql://couple:couple_local_only@127.0.0.1:55432/postgres';
const admin = new pg.Pool({ connectionString: adminUrl });
let database: typeof import('../server/db.js');
let runMaintenance: typeof import('../server/maintenance.js').runMaintenance;
let created = false;
let userId: string;
let businessBefore: string;
const now = new Date('2026-09-22T00:00:00.000Z');
const days = (offset: number) => new Date(now.getTime() + offset * 86400000);
const tables = [
  'users',
  'spaces',
  'memberships',
  'wallets',
  'schedules',
  'tasks',
  'products',
  'orders',
  'point_ledger',
  'notifications',
];

async function businessSnapshot() {
  return JSON.stringify(
    await Promise.all(
      tables.map(async (table) => ({
        table,
        rows: (await database.query(`SELECT * FROM ${table}`)).rows.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      })),
    ),
  );
}

before(async () => {
  assert.match(databaseName, /^couple_maintenance_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const connection = new URL(adminUrl);
  connection.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = connection.toString();
  database = await import('../server/db.js');
  await database.migrate();
  await database.migrate();
  ({ runMaintenance } = await import('../server/maintenance.js'));
  const user = (
    await database.query(
      "INSERT INTO users(name,email) VALUES('清理测试甲','maintenance-a@example.test') RETURNING id",
    )
  ).rows[0];
  userId = user.id;
  const partner = (
    await database.query(
      "INSERT INTO users(name,email) VALUES('清理测试乙','maintenance-b@example.test') RETURNING id",
    )
  ).rows[0];
  const space = (
    await database.query(
      "INSERT INTO spaces(name,created_at) VALUES('永久保留的情侣空间',$1) RETURNING id",
      [days(-400)],
    )
  ).rows[0];
  await database.query('INSERT INTO memberships(user_id,space_id,slot) VALUES($1,$2,1),($3,$2,2)', [
    userId,
    space.id,
    partner.id,
  ]);
  await database.query('INSERT INTO wallets(user_id,balance) VALUES($1,7),($2,0)', [
    userId,
    partner.id,
  ]);
  await database.query(
    "INSERT INTO schedules(space_id,creator_id,title,reward,mode,kind,time,duration_hours,created_at) VALUES($1,$2,'一年前的计划',10,'RACE','DAILY','08:00',24,$3)",
    [space.id, userId, days(-400)],
  );
  const task = (
    await database.query(
      "INSERT INTO tasks(space_id,creator_id,claimant_id,reviewed_by,title,reward,mode,status,created_at) VALUES($1,$2,$3,$2,'旧约定也保留',10,'RACE','APPROVED',$4) RETURNING id",
      [space.id, partner.id, userId, days(-400)],
    )
  ).rows[0];
  const product = (
    await database.query(
      "INSERT INTO products(space_id,creator_id,title,price,stock,created_at) VALUES($1,$2,'旧心愿也保留',3,4,$3) RETURNING id",
      [space.id, partner.id, days(-400)],
    )
  ).rows[0];
  const order = (
    await database.query(
      "INSERT INTO orders(space_id,buyer_id,seller_id,product_id,title,description,price,idempotency_key,created_at) VALUES($1,$2,$3,$4,'旧兑换也保留','保留商业记录',3,'maintenance-order',$5) RETURNING id",
      [space.id, userId, partner.id, product.id, days(-400)],
    )
  ).rows[0];
  await database.query(
    "INSERT INTO point_ledger(user_id,space_id,delta,balance_after,reason,source_key,task_id,created_at) VALUES($1,$2,10,10,'任务奖励','maintenance-task',$3,$4)",
    [userId, space.id, task.id, days(-400)],
  );
  await database.query(
    "INSERT INTO point_ledger(user_id,space_id,delta,balance_after,reason,source_key,order_id,created_at) VALUES($1,$2,-3,7,'心愿兑换','maintenance-order',$3,$4)",
    [userId, space.id, order.id, days(-399)],
  );
  await database.query(
    "INSERT INTO notifications(user_id,space_id,title,body,created_at) VALUES($1,$2,'旧通知也保留','包含伴侣的用心',$3)",
    [userId, space.id, days(-400)],
  );
  businessBefore = await businessSnapshot();
});
beforeEach(async () => {
  await database.query('DELETE FROM maintenance_runs');
});
after(async () => {
  if (database) await database.closePool();
  if (created) await dropTestDatabase(admin, databaseName);
  await admin.end();
});
async function token(kind: 'email_tokens' | 'password_reset_tokens', expiration: Date) {
  return (
    await database.query(
      `INSERT INTO ${kind}(user_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4) RETURNING id`,
      [userId, randomUUID(), expiration, days(-10)],
    )
  ).rows[0].id as string;
}
async function mail({
  kind = 'GENERAL',
  status = 'SENT',
  createdAt = days(-10),
  sentAt = null,
  emailToken = null,
  resetToken = null,
}: {
  kind?: string;
  status?: string;
  createdAt?: Date;
  sentAt?: Date | null;
  emailToken?: string | null;
  resetToken?: string | null;
} = {}) {
  return (
    await database.query(
      'INSERT INTO email_outbox(user_id,to_email,subject,body,kind,status,created_at,sent_at,email_token_id,password_reset_token_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [
        userId,
        'maintenance-a@example.test',
        '测试保留期',
        '包含敏感令牌的旧链接 https://example.test/#reset-password=secret',
        kind,
        status,
        createdAt,
        sentAt,
        emailToken,
        resetToken,
      ],
    )
  ).rows[0].id as string;
}
async function exists(table: string, id: string) {
  return Boolean((await database.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount);
}

test('保留有效及近期会话/授权，清理超过保留期的过期记录', async () => {
  const oldSession = randomUUID(),
    recentSession = randomUUID(),
    validSession = randomUUID();
  await database.query(
    'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$4,$5),($2,$4,$6),($3,$4,$7)',
    [oldSession, recentSession, validSession, userId, days(-2), days(-0.5), days(10)],
  );
  const oldState = randomUUID(),
    recentState = randomUUID(),
    validState = randomUUID();
  for (const [id, expiration] of [
    [oldState, days(-8)],
    [recentState, days(-1)],
    [validState, days(10)],
  ] as const)
    await database.query(
      "INSERT INTO oauth_states(id,state_hash,browser_hash,intent,app_id,expires_at) VALUES($1,$2,$3,'login','test-app',$4)",
      [id, randomUUID(), randomUUID(), expiration],
    );
  const result = await runMaintenance(now);
  assert.equal(result.skipped, false);
  assert.equal(result.deletedSessions, 1);
  assert.equal(result.deletedOauthStates, 1);
  assert.equal(
    (await database.query('SELECT 1 FROM sessions WHERE token_hash=$1', [oldSession])).rowCount,
    0,
  );
  for (const id of [recentSession, validSession])
    assert.equal(
      (await database.query('SELECT 1 FROM sessions WHERE token_hash=$1', [id])).rowCount,
      1,
    );
  assert.equal(await exists('oauth_states', oldState), false);
  assert.equal(await exists('oauth_states', recentState), true);
  assert.equal(await exists('oauth_states', validState), true);
});

test('终态安全邮件脱敏并解除 FK，过期令牌可删除，有效和在途令牌完整保留', async () => {
  const oldEmail = await token('email_tokens', days(-8));
  const oldReset = await token('password_reset_tokens', days(-8));
  const orphanEmail = await token('email_tokens', days(-8));
  const orphanReset = await token('password_reset_tokens', days(-8));
  const recentToken = await token('email_tokens', days(-1));
  const validToken = await token('password_reset_tokens', days(10));
  const pendingToken = await token('email_tokens', days(-100));
  const sendingToken = await token('password_reset_tokens', days(-100));
  const scrubbed = [
    await mail({ kind: 'VERIFY_EMAIL', emailToken: oldEmail }),
    await mail({ kind: 'PASSWORD_RESET', status: 'FAILED', resetToken: oldReset }),
    await mail({ kind: 'PASSWORD_RESET' }),
  ];
  const recentMail = await mail({ kind: 'VERIFY_EMAIL', emailToken: recentToken });
  const validMail = await mail({ kind: 'PASSWORD_RESET', resetToken: validToken });
  const pendingMail = await mail({
    kind: 'VERIFY_EMAIL',
    status: 'PENDING',
    emailToken: pendingToken,
    createdAt: days(-100),
  });
  const sendingMail = await mail({
    kind: 'PASSWORD_RESET',
    status: 'SENDING',
    resetToken: sendingToken,
    createdAt: days(-100),
  });
  const result = await runMaintenance(now);
  assert.equal(result.redactedSecurityEmails, 3);
  assert.equal(result.deletedEmailTokens, 2);
  assert.equal(result.deletedPasswordResetTokens, 2);
  for (const id of scrubbed) {
    const row = (
      await database.query(
        'SELECT body,email_token_id,password_reset_token_id FROM email_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.match(row.body, /安全链接已过期/);
    assert.doesNotMatch(row.body, /secret|https:/);
    assert.equal(row.email_token_id, null);
    assert.equal(row.password_reset_token_id, null);
  }
  for (const [table, id] of [
    ['email_tokens', oldEmail],
    ['email_tokens', orphanEmail],
    ['password_reset_tokens', oldReset],
    ['password_reset_tokens', orphanReset],
  ])
    assert.equal(await exists(table, id), false);
  for (const [table, id] of [
    ['email_tokens', recentToken],
    ['password_reset_tokens', validToken],
    ['email_tokens', pendingToken],
    ['password_reset_tokens', sendingToken],
  ])
    assert.equal(await exists(table, id), true);
  for (const id of [recentMail, validMail, pendingMail, sendingMail])
    assert.match(
      (await database.query('SELECT body FROM email_outbox WHERE id=$1', [id])).rows[0].body,
      /secret/,
    );
  assert.equal(await businessSnapshot(), businessBefore);
});

test('90 天前的已投递/失败历史可清，近期投递与所有待发送/发送中历史保留', async () => {
  const deleted = [
    await mail({ createdAt: days(-100), sentAt: days(-95) }),
    await mail({ status: 'FAILED', createdAt: days(-100) }),
  ];
  const kept = [
    await mail({ createdAt: days(-100), sentAt: days(-2) }),
    await mail({ createdAt: days(-30) }),
    await mail({ status: 'PENDING', createdAt: days(-200) }),
    await mail({ status: 'SENDING', createdAt: days(-200) }),
  ];
  const result = await runMaintenance(now);
  assert.equal(result.deletedEmailHistory, 2);
  for (const id of deleted) assert.equal(await exists('email_outbox', id), false);
  for (const id of kept) assert.equal(await exists('email_outbox', id), true);
});

test('分布式锁防重复运行，同一 24 小时内只完成一次', async () => {
  const blocker = await database.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(726031941)');
  try {
    const locked = await runMaintenance(now);
    assert.equal(locked.skipped, true);
    assert.equal(locked.reason, 'locked');
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const results = await Promise.all([
    runMaintenance(now),
    runMaintenance(now),
    runMaintenance(now),
  ]);
  assert.equal(results.filter((result) => !result.skipped).length, 1);
  assert.ok(
    results
      .filter((result) => result.skipped)
      .every((result) => result.reason === 'locked' || result.reason === 'recent'),
  );
  const recent = await runMaintenance(new Date(now.getTime() + 86400000 - 1));
  assert.equal(recent.reason, 'recent');
  const nextDay = await runMaintenance(days(1));
  assert.equal(nextDay.skipped, false);
  assert.equal(nextDay.lastCompletedAt, days(1).toISOString());
});

test('每类清理有批量上限，大批过期记录逐日消化', async () => {
  const prefix = randomUUID();
  await database.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) SELECT $1||'-'||n,$2,$3 FROM generate_series(1,6) n",
    [prefix, userId, days(-20)],
  );
  const result = await runMaintenance(now, { batchSize: 2 });
  assert.equal(result.deletedSessions, 2);
  assert.equal(
    (
      await database.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash LIKE $1', [
        `${prefix}-%`,
      ])
    ).rows[0].n,
    4,
  );
  assert.equal((await runMaintenance(now, { batchSize: 2 })).skipped, true);
  assert.equal((await runMaintenance(days(1), { batchSize: 2 })).deletedSessions, 2);
  assert.equal(
    (
      await database.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash LIKE $1', [
        `${prefix}-%`,
      ])
    ).rows[0].n,
    2,
  );
});

test('失败回滚已经执行的清理与完成标记，修复后可立即重试', async () => {
  const oldSession = randomUUID();
  await database.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [
    oldSession,
    userId,
    days(-20),
  ]);
  const failingToken = await token('email_tokens', days(-10));
  await database.query(
    `CREATE FUNCTION maintenance_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${failingToken}'::uuid THEN RAISE EXCEPTION 'intentional maintenance failure'; END IF; RETURN OLD; END $$`,
  );
  await database.query(
    'CREATE TRIGGER maintenance_test_failure BEFORE DELETE ON email_tokens FOR EACH ROW EXECUTE FUNCTION maintenance_test_failure()',
  );
  try {
    await assert.rejects(runMaintenance(now), /intentional maintenance failure/);
    assert.equal(
      (await database.query('SELECT 1 FROM sessions WHERE token_hash=$1', [oldSession])).rowCount,
      1,
    );
    assert.equal((await database.query('SELECT * FROM maintenance_runs')).rowCount, 0);
    assert.equal(await exists('email_tokens', failingToken), true);
  } finally {
    await database.query('DROP TRIGGER maintenance_test_failure ON email_tokens');
    await database.query('DROP FUNCTION maintenance_test_failure()');
  }
  assert.equal((await runMaintenance(now)).skipped, false);
  assert.equal(
    (await database.query('SELECT 1 FROM sessions WHERE token_hash=$1', [oldSession])).rowCount,
    0,
  );
  assert.equal(await exists('email_tokens', failingToken), false);
  assert.equal(await businessSnapshot(), businessBefore);
});

test('维护参数拒绝无效日期与超过上限的批量，不产生完成记录', async () => {
  for (const batchSize of [0, -1, 5001, 1.5, NaN])
    await assert.rejects(runMaintenance(now, { batchSize }), RangeError);
  await assert.rejects(runMaintenance(new Date('invalid')), RangeError);
  assert.equal((await database.query('SELECT * FROM maintenance_runs')).rowCount, 0);
  assert.equal(await businessSnapshot(), businessBefore);
});
