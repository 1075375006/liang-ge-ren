import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from './db.js';
import { notify } from './notify.js';
import { publicOrigin } from './public-url.js';
import { SESSION_COOKIE, cookieOptions, digest, verifyPassword } from './security.js';

type Fail = (statusCode: number, message: string) => never;
const camel = (rows: Record<string, unknown>[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    ),
  );

/** Caller holds the space row lock, excluding concurrent business writes. */
async function archiveSpace(client: PoolClient, spaceId: string): Promise<boolean> {
  const archived = await client.query(
    `UPDATE spaces SET archived_at=now(),invite_code=NULL,invite_expires_at=NULL
     WHERE id=$1 AND archived_at IS NULL RETURNING id`,
    [spaceId],
  );
  if (!archived.rowCount) return false;
  await client.query('UPDATE schedules SET active=false,next_run_at=NULL WHERE space_id=$1', [
    spaceId,
  ]);
  await client.query(
    "UPDATE tasks SET status='CANCELLED' WHERE space_id=$1 AND status IN ('OPEN','CLAIMED','SUBMITTED')",
    [spaceId],
  );
  const { rows: pending } = await client.query(
    "SELECT id,buyer_id,product_id,price,title FROM orders WHERE space_id=$1 AND status='PENDING' ORDER BY id FOR UPDATE",
    [spaceId],
  );
  for (const order of pending) {
    await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [order.product_id]);
    await client.query('UPDATE products SET stock=stock+1 WHERE id=$1', [order.product_id]);
    const {
      rows: [wallet],
    } = await client.query(
      'UPDATE wallets SET balance=balance+$2,updated_at=now() WHERE user_id=$1 RETURNING balance',
      [order.buyer_id, order.price],
    );
    await client.query(
      `INSERT INTO point_ledger(user_id,space_id,delta,balance_after,reason,source_key,order_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        order.buyer_id,
        spaceId,
        order.price,
        wallet.balance,
        `空间关闭退还 · ${order.title}`,
        `REFUND:${order.id}`,
        order.id,
      ],
    );
    await client.query("UPDATE orders SET status='CANCELLED',cancelled_at=now() WHERE id=$1", [
      order.id,
    ]);
  }
  return true;
}

/** Personal exports omit all credentials and the other member's private profile. */
export function registerPrivacyRoutes(app: FastifyInstance, { fail }: { fail: Fail }): void {
  function userId(request: FastifyRequest): string {
    const user = request.currentUser;
    if (!user) return fail(401, '请先登录');
    return user.id;
  }

  async function authorizeSensitiveAction(
    client: PoolClient,
    request: FastifyRequest,
    id: string,
    password: string | undefined,
    action: '注销账号' | '关闭空间',
  ) {
    const {
      rows: [account],
    } = await client.query(
      'SELECT id,name,password_hash FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    if (!account) fail(401, '账号已注销，请重新登录');
    const active = await client.query(
      `SELECT created_at>now()-interval '10 minutes' AS recent
       FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()`,
      [id, digest(request.cookies[SESSION_COOKIE] ?? '')],
    );
    if (!active.rowCount) fail(401, '登录已过期，请重新登录');
    if (
      account.password_hash &&
      (!password || !(await verifyPassword(password, account.password_hash)))
    ) {
      fail(400, '请输入正确的登录密码');
    }
    if (!account.password_hash && !active.rows[0].recent) {
      fail(409, `为了保护账号，请先退出并重新使用微信登录，再${action}`);
    }
    return account;
  }

  app.get(
    '/api/account/export',
    {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const id = userId(request);
      const exported = await transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const {
          rows: [account],
        } = await client.query(
          `SELECT id,name,email,email_verified,notify_email,email_theme,terms_accepted_at,created_at
         FROM users WHERE id=$1 AND deleted_at IS NULL`,
          [id],
        );
        if (!account) fail(401, '账号已注销，请重新登录');
        const {
          rows: [space],
        } = await client.query(
          `SELECT s.id,s.name,s.created_at,s.archived_at FROM spaces s
         JOIN memberships m ON m.space_id=s.id WHERE m.user_id=$1`,
          [id],
        );
        const partner = space
          ? (
              await client.query(
                `SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.space_id=$1 AND m.user_id<>$2`,
                [space.id, id],
              )
            ).rows
          : [];
        const shared: Record<string, unknown[]> = {};
        // These are shared records already visible to both members. The export has
        // no page limit, so a long-lived space can retrieve its complete history.
        for (const table of ['tasks', 'schedules', 'products', 'orders'] as const) {
          shared[table] = space
            ? camel(
                (
                  await client.query(
                    `SELECT * FROM ${table} WHERE space_id=$1 ORDER BY created_at,id`,
                    [space.id],
                  )
                ).rows,
              )
            : [];
        }
        const { rows: ledger } = await client.query(
          `SELECT id,space_id,delta,balance_after,reason,task_id,order_id,created_at
         FROM point_ledger WHERE user_id=$1 ORDER BY created_at,id`,
          [id],
        );
        const { rows: notifications } = await client.query(
          `SELECT id,space_id,title,body,kind,read_at,created_at
         FROM notifications WHERE user_id=$1 ORDER BY created_at,id`,
          [id],
        );
        const {
          rows: [wallet],
        } = await client.query('SELECT balance FROM wallets WHERE user_id=$1', [id]);
        return {
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          account: camel([account])[0],
          balance: wallet?.balance ?? 0,
          space: space ? camel([space])[0] : null,
          partner: partner[0] ?? null,
          ...shared,
          ledger: camel(ledger),
          notifications: camel(notifications),
        };
      });
      reply.header('Content-Disposition', 'attachment; filename="liang-ge-ren-data.json"');
      return exported;
    },
  );

  app.post(
    '/api/account/delete',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const id = userId(request);
      const input = z
        .object({
          confirmation: z.literal('注销账号', {
            errorMap: () => ({ message: '请输入「注销账号」确认' }),
          }),
          password: z.string().max(128).optional(),
        })
        .parse(request.body);
      const result = await transaction(async (client) => {
        const {
          rows: [membership],
        } = await client.query('SELECT space_id FROM memberships WHERE user_id=$1', [id]);
        const space = membership
          ? (
              await client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
                membership.space_id,
              ])
            ).rows[0]
          : null;
        await authorizeSensitiveAction(client, request, id, input.password, '注销账号');
        const {
          rows: [currentMembership],
        } = await client.query('SELECT space_id FROM memberships WHERE user_id=$1', [id]);
        if ((currentMembership?.space_id ?? null) !== (membership?.space_id ?? null)) {
          fail(409, '空间状态已经变化，请刷新后重试');
        }
        if (space) await archiveSpace(client, space.id);
        await client.query(
          'DELETE FROM oauth_states WHERE user_id=$1 OR session_hash IN (SELECT token_hash FROM sessions WHERE user_id=$1)',
          [id],
        );
        await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        await client.query('DELETE FROM auth_identities WHERE user_id=$1', [id]);
        // Remove recipient PII and revoke queued verification/recovery links before
        // deleting their token rows. A message already handed to SMTP is irreversible.
        await client.query('DELETE FROM email_outbox WHERE user_id=$1', [id]);
        await client.query('DELETE FROM email_tokens WHERE user_id=$1', [id]);
        await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [id]);
        await client.query('DELETE FROM notifications WHERE user_id=$1', [id]);
        await client.query(
          `UPDATE users SET name='已注销用户',email=NULL,password_hash=NULL,email_verified=false,
         notify_email=false,email_theme='strawberry',deleted_at=now() WHERE id=$1`,
          [id],
        );
        return { ok: true, spaceArchived: Boolean(space) };
      });
      reply.clearCookie(SESSION_COOKIE, cookieOptions(request));
      reply.clearCookie('couple_wechat_nonce', {
        ...cookieOptions(request),
        path: '/api/auth/wechat',
      });
      return result;
    },
  );

  app.post(
    '/api/spaces/archive',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request) => {
      const id = userId(request);
      const input = z
        .object({
          confirmation: z.literal('关闭空间', {
            errorMap: () => ({ message: '请输入「关闭空间」确认' }),
          }),
          password: z.string().max(128).optional(),
        })
        .strict()
        .parse(request.body);
      return transaction(async (client) => {
        const {
          rows: [membership],
        } = await client.query('SELECT space_id FROM memberships WHERE user_id=$1', [id]);
        if (!membership) fail(409, '你还没有加入空间');
        const {
          rows: [space],
        } = await client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
          membership.space_id,
        ]);
        if (!space) fail(409, '空间状态已经变化，请刷新后重试');
        const account = await authorizeSensitiveAction(
          client,
          request,
          id,
          input.password,
          '关闭空间',
        );
        const current = await client.query(
          'SELECT 1 FROM memberships WHERE user_id=$1 AND space_id=$2',
          [id, space.id],
        );
        if (!current.rowCount) fail(409, '空间状态已经变化，请刷新后重试');
        if (await archiveSpace(client, space.id)) {
          const { rows: partners } = await client.query(
            `SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
             WHERE m.space_id=$1 AND m.user_id<>$2 AND u.deleted_at IS NULL`,
            [space.id, id],
          );
          for (const partner of partners) {
            await notify(client, {
              userId: partner.user_id,
              spaceId: space.id,
              origin: publicOrigin(request),
              kind: 'SPACE_ARCHIVED',
              title: '共同空间已关闭',
              body: `${account.name} 已关闭共同空间，此操作无法恢复。待兑现的兑换已退还积分，已兑现的记录保留原结果。双方账号继续保留，你可以先导出共同历史，再离开旧空间重新开始。`,
              actionPath: '/?page=settings',
            });
          }
        }
        return { ok: true, spaceArchived: true };
      });
    },
  );

  app.post(
    '/api/spaces/leave-archived',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request) => {
      const id = userId(request);
      z.object({
        confirmation: z.literal('离开空间', {
          errorMap: () => ({ message: '请输入「离开空间」确认' }),
        }),
      }).parse(request.body);
      return transaction(async (client) => {
        const {
          rows: [membership],
        } = await client.query('SELECT space_id FROM memberships WHERE user_id=$1', [id]);
        if (!membership) fail(409, '你已经离开这个空间');
        const {
          rows: [space],
        } = await client.query('SELECT id,archived_at FROM spaces WHERE id=$1 FOR UPDATE', [
          membership.space_id,
        ]);
        if (!space?.archived_at) fail(409, '只能离开已经关闭的空间');
        const user = await client.query(
          'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        );
        if (!user.rowCount) fail(401, '账号已注销，请重新登录');
        const active = await client.query(
          'SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()',
          [id, digest(request.cookies[SESSION_COOKIE] ?? '')],
        );
        if (!active.rowCount) fail(401, '登录已过期，请重新登录');
        const current = await client.query(
          'SELECT 1 FROM memberships WHERE user_id=$1 AND space_id=$2',
          [id, space.id],
        );
        if (!current.rowCount) fail(409, '空间状态已经变化，请刷新后重试');
        const {
          rows: [wallet],
        } = await client.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [id]);
        if (wallet.balance > 0) {
          await client.query('UPDATE wallets SET balance=0,updated_at=now() WHERE user_id=$1', [
            id,
          ]);
          await client.query(
            `INSERT INTO point_ledger(user_id,space_id,delta,balance_after,reason,source_key)
           VALUES($1,$2,$3,0,'离开关闭空间 · 积分结算',$4)`,
            [id, space.id, -wallet.balance, `SPACE_CLOSE:${space.id}:${id}`],
          );
        }
        await client.query('DELETE FROM memberships WHERE user_id=$1 AND space_id=$2', [
          id,
          space.id,
        ]);
        return { ok: true };
      });
    },
  );
}
