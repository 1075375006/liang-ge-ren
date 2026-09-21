import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { PoolClient, QueryResultRow } from 'pg';
import { query, transaction } from './db.js';
import { notify, smtpConfigured } from './notify.js';
import { EMAIL_THEMES, buildMailPreview } from './mail-template.js';
import { nextOccurrence } from './schedule-time.js';
import {
  appId,
  authorizationUrl,
  callbackPath,
  exchangeCode,
  newSecret,
  wechatEnabled,
} from './wechat.js';
import {
  SESSION_COOKIE,
  digest,
  hashPassword,
  verifyPassword,
  cookieOptions,
  createSession,
  setSessionCookie,
} from './security.js';

type User = {
  id: string;
  name: string;
  email: string | null;
  password_hash?: string | null;
  email_verified: boolean;
  notify_email: boolean;
  email_theme: string;
  wechat_bound: boolean;
};
declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null;
  }
}

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(statusCode: number, message: string): never {
  throw new ApiError(statusCode, message);
}
function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.email_verified,
    notifyEmail: user.notify_email,
    emailTheme: user.email_theme ?? 'strawberry',
    wechatBound: user.wechat_bound,
  };
}
function camel(value: unknown): any {
  if (value === null || value instanceof Date || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(camel);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      camel(item),
    ]),
  );
}
function loggedIn(request: FastifyRequest): User {
  if (!request.currentUser) fail(401, '请先登录');
  return request.currentUser;
}
async function spaceContext(request: FastifyRequest, requirePair = true) {
  const user = loggedIn(request);
  const {
    rows: [space],
  } = await query(
    `SELECT s.* FROM memberships m JOIN spaces s ON s.id=m.space_id WHERE m.user_id=$1`,
    [user.id],
  );
  if (!space) fail(403, '请先创建或加入两个人的空间');
  const {
    rows: [partner],
  } = await query(
    `SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.space_id=$1 AND m.user_id<>$2`,
    [space.id, user.id],
  );
  if (requirePair && !partner) fail(409, '邀请伴侣加入后就可以使用这个功能');
  return { user, space, partner: partner ?? null };
}
const idParam = (request: FastifyRequest) =>
  z.object({ id: z.string().uuid('无效的记录编号') }).parse(request.params).id;
const titleField = z.string().trim().min(1, '请填写名称').max(100, '名称最多 100 字');
const descriptionField = z.string().trim().max(3000, '说明最多 3000 字').default('');
const emailField = z.string().trim().toLowerCase().email('请输入正确的邮箱').max(254);
const passwordField = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
const taskFields = {
  title: titleField,
  description: descriptionField,
  reward: z.number().int().min(1).max(10000),
  mode: z.enum(['ASSIGNED', 'RACE']),
};
const dueDate = z.string().datetime({ offset: true, message: '请填写有效日期时间' });
const productFields = {
  title: titleField,
  description: descriptionField,
  emoji: z.string().trim().min(1).max(20).default('🎁'),
  price: z.number().int().min(1).max(100000),
  stock: z.number().int().min(0).max(100000),
};
function invitation() {
  return randomBytes(9).toString('hex').toUpperCase();
}
async function lockTask(client: PoolClient, id: string, spaceId: string): Promise<QueryResultRow> {
  const {
    rows: [task],
  } = await client.query('SELECT * FROM tasks WHERE id=$1 AND space_id=$2 FOR UPDATE', [
    id,
    spaceId,
  ]);
  if (!task) fail(404, '任务不存在');
  return task;
}
function overdue(task: QueryResultRow): boolean {
  return task.due_at !== null && new Date(task.due_at).getTime() <= Date.now();
}
async function addPoints(
  client: PoolClient,
  data: {
    userId: string;
    spaceId: string;
    delta: number;
    reason: string;
    sourceKey: string;
    taskId?: string;
    orderId?: string;
  },
) {
  const {
    rows: [wallet],
  } = await client.query(
    `UPDATE wallets SET balance=balance+$2,updated_at=now() WHERE user_id=$1 AND balance+$2>=0 RETURNING balance`,
    [data.userId, data.delta],
  );
  if (!wallet) fail(409, '积分不足，先完成一些任务吧');
  await client.query(
    `INSERT INTO point_ledger (user_id,space_id,delta,balance_after,reason,source_key,task_id,order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      data.userId,
      data.spaceId,
      data.delta,
      wallet.balance,
      data.reason,
      data.sourceKey,
      data.taskId ?? null,
      data.orderId ?? null,
    ],
  );
  return wallet.balance;
}

export async function buildApp(options: { wechatFetch?: typeof fetch } = {}) {
  const wechatFetch = options.wechatFetch ?? fetch;
  const app = Fastify({
    logger: process.env.LOG_LEVEL
      ? {
          level: process.env.LOG_LEVEL,
          redact: ['req.headers.cookie', 'req.headers.authorization'],
          serializers: {
            req(request) {
              const path = request.url?.split('?')[0] ?? '';
              return {
                method: request.method,
                url: path.startsWith('/api/auth/wechat/callback/')
                  ? '/api/auth/wechat/callback/[redacted]'
                  : path,
              };
            },
          },
        }
      : false,
    bodyLimit: 32 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ error: '操作太频繁，请稍后再试' }),
  });
  app.decorateRequest('currentUser', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, '请求来源不被允许');
      if (origin) {
        let valid = false;
        try {
          valid =
            new URL(origin).origin ===
            new URL(process.env.APP_URL ?? 'http://localhost:33442').origin;
        } catch {
          /* invalid origin */
        }
        if (!valid) fail(403, '请求来源不被允许');
      }
    }
  });
  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 128) return;
    const {
      rows: [user],
    } = await query<User>(
      `SELECT u.id,u.name,u.email,u.email_verified,u.notify_email,u.email_theme,
        EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider='beichen-wx' AND ai.app_id=$2) AS wechat_bound
       FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [digest(token), process.env.BEICHEN_APP_ID ?? ''],
    );
    request.currentUser = user ?? null;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message ?? '输入不符合要求' });
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: '操作太频繁，请稍后再试' });
    if (status === 400 || status === 413)
      return reply
        .code(status)
        .send({ error: status === 413 ? '提交的内容过长' : '请求格式不正确' });
    if ((error as { code?: string }).code === '23505')
      return reply.code(409).send({ error: '记录已存在，请刷新后重试' });
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: '暂时无法完成，请稍后重试' });
  });

  app.get('/api/health', async () => {
    await query('SELECT 1');
    return { ok: true };
  });
  app.get('/api/status', async (request) => {
    loggedIn(request);
    const {
      rows: [worker],
    } = await query('SELECT * FROM worker_heartbeat WHERE name=$1', ['main']);
    return { worker: worker ? camel(worker) : null, smtpConfigured: smtpConfigured() };
  });
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({
          name: z.string().trim().min(1, '请填写昵称').max(40),
          email: emailField,
          password: passwordField,
        })
        .parse(request.body);
      const hash = await hashPassword(input.password);
      const result = await transaction(async (client) => {
        const {
          rows: [user],
        } = await client.query<User>(
          `INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,email_verified,notify_email,email_theme,false AS wechat_bound`,
          [input.name, input.email, hash],
        );
        await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);
        const session = await createSession(client, user.id);
        return { user, session };
      });
      setSessionCookie(reply, result.session);
      return { user: publicUser(result.user) };
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z.object({ email: emailField, password: passwordField }).parse(request.body);
      const {
        rows: [user],
      } = await query<User & { password_hash: string | null }>(
        `SELECT u.*,
        EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider='beichen-wx' AND ai.app_id=$2) AS wechat_bound
        FROM users u WHERE email=$1`,
        [input.email, process.env.BEICHEN_APP_ID ?? ''],
      );
      // Perform the same expensive derivation for unknown users to reduce account probing.
      const hash =
        user?.password_hash ?? 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);
      const passwordMatches = await verifyPassword(input.password, hash);
      if (!user?.password_hash || !passwordMatches) fail(401, '邮箱或密码不正确');
      const session = await transaction((client) => createSession(client, user.id));
      setSessionCookie(reply, session);
      return { user: publicUser(user) };
    },
  );
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  });

  app.post(
    '/api/auth/wechat/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!wechatEnabled()) fail(503, '微信登录暂未启用');
      const intent = z.object({ intent: z.enum(['login', 'bind']) }).parse(request.body).intent;
      const current = request.currentUser;
      if (intent === 'login' && current) fail(409, '你已经登录，请在账户设置中绑定微信');
      if (intent === 'bind' && !current) fail(401, '请先登录原账号再绑定微信');
      const browserSecret = newSecret(32);
      const state = newSecret(32);
      const redirectUri = new URL(
        callbackPath(state),
        process.env.APP_URL ?? 'http://localhost:33442',
      ).toString();
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO oauth_states(state_hash,browser_hash,intent,user_id,session_hash,app_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            digest(state),
            digest(browserSecret),
            intent,
            current?.id ?? null,
            request.cookies[SESSION_COOKIE] ? digest(request.cookies[SESSION_COOKIE]) : null,
            appId(),
            new Date(Date.now() + 10 * 60 * 1000),
          ],
        );
      });
      try {
        const url = await authorizationUrl(wechatFetch, redirectUri);
        reply.setCookie('couple_wechat_nonce', browserSecret, {
          ...cookieOptions(),
          path: '/api/auth/wechat',
          maxAge: 600,
        });
        return { url };
      } catch {
        await query('DELETE FROM oauth_states WHERE state_hash=$1', [digest(state)]).catch(
          () => undefined,
        );
        fail(503, '微信登录服务暂时不可用');
      }
    },
  );

  app.get('/api/auth/wechat/callback/:state', async (request, reply) => {
    const failRedirect = (reason: string) =>
      reply.redirect(`/?wechat=error&reason=${encodeURIComponent(reason)}`, 303);
    if (!wechatEnabled()) return failRedirect('disabled');
    const state = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .safeParse((request.params as { state?: string }).state);
    const queryInput = z
      .object({ type: z.string().optional(), code: z.string().min(1).max(512).optional() })
      .safeParse(request.query);
    if (
      !state.success ||
      !queryInput.success ||
      queryInput.data.type !== 'wx' ||
      !queryInput.data.code
    )
      return failRedirect('cancelled');
    const nonce = request.cookies.couple_wechat_nonce;
    if (!nonce || nonce.length !== 64) return failRedirect('invalid_state');
    let stateRow: QueryResultRow;
    try {
      const consumed = await transaction(async (client) => {
        const {
          rows: [row],
        } = await client.query(
          `UPDATE oauth_states SET consumed_at=now()
          WHERE state_hash=$1 AND browser_hash=$2 AND app_id=$3 AND expires_at>now() AND consumed_at IS NULL
          RETURNING *`,
          [digest(state.data), digest(nonce), appId()],
        );
        if (!row) return null;
        if (row.intent === 'bind') {
          const token = request.cookies[SESSION_COOKIE];
          if (
            !token ||
            !row.user_id ||
            request.currentUser?.id !== row.user_id ||
            row.session_hash !== digest(token)
          )
            return { reason: 'session_changed' };
        } else if (request.currentUser) return { reason: 'session_changed' };
        return row;
      });
      if (!consumed) return failRedirect('invalid_state');
      if ('reason' in consumed) return failRedirect(consumed.reason as string);
      stateRow = consumed;
    } catch {
      return failRedirect('invalid_state');
    }
    let profile;
    try {
      profile = await exchangeCode(wechatFetch, queryInput.data.code);
    } catch (error) {
      return failRedirect(
        error instanceof Error && error.message === 'provider_pending'
          ? 'cancelled'
          : 'provider_error',
      );
    }
    try {
      const result = await transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `wechat:${appId()}:${profile.social_uid}`,
        ]);
        const {
          rows: [identity],
        } = await client.query(
          'SELECT * FROM auth_identities WHERE provider=$1 AND app_id=$2 AND provider_uid=$3 FOR UPDATE',
          ['beichen-wx', appId(), profile.social_uid],
        );
        if (stateRow.intent === 'bind') {
          // Recheck after the external request; logout may have revoked the session meanwhile.
          const activeSession = await client.query(
            'SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE',
            [stateRow.session_hash, stateRow.user_id],
          );
          if (!activeSession.rowCount) return { reason: 'session_changed' as const };
          await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [stateRow.user_id]);
          if (identity && identity.user_id !== stateRow.user_id) return { conflict: true };
          const existingBinding = await client.query(
            'SELECT provider_uid FROM auth_identities WHERE provider=$1 AND app_id=$2 AND user_id=$3',
            ['beichen-wx', appId(), stateRow.user_id],
          );
          if (existingBinding.rows.some((row) => row.provider_uid !== profile.social_uid))
            return { conflict: true };
          if (!identity)
            await client.query(
              `INSERT INTO auth_identities(provider,app_id,provider_uid,user_id,nickname,avatar_url) VALUES('beichen-wx',$1,$2,$3,$4,$5)`,
              [
                appId(),
                profile.social_uid,
                stateRow.user_id,
                profile.nickname,
                profile.faceimg ?? null,
              ],
            );
          await client.query('DELETE FROM sessions WHERE token_hash=$1', [stateRow.session_hash]);
          const session = await createSession(client, stateRow.user_id);
          return { session, intent: 'bind' as const };
        }
        let userId = identity?.user_id as string | undefined;
        if (!userId) {
          const {
            rows: [created],
          } = await client.query(
            `INSERT INTO users(name,email,password_hash) VALUES($1,NULL,NULL) RETURNING id`,
            [profile.nickname],
          );
          userId = created.id;
          await client.query('INSERT INTO wallets(user_id) VALUES($1)', [userId]);
          await client.query(
            `INSERT INTO auth_identities(provider,app_id,provider_uid,user_id,nickname,avatar_url) VALUES('beichen-wx',$1,$2,$3,$4,$5)`,
            [appId(), profile.social_uid, userId, profile.nickname, profile.faceimg ?? null],
          );
        }
        const session = await createSession(client, userId!);
        return { session, intent: 'login' as const };
      });
      if ('reason' in result && result.reason) return failRedirect(result.reason);
      if ('conflict' in result && result.conflict) return failRedirect('identity_conflict');
      setSessionCookie(reply, result.session!);
      reply.clearCookie('couple_wechat_nonce', { ...cookieOptions(), path: '/api/auth/wechat' });
      return reply.redirect(`/?wechat=${result.intent === 'bind' ? 'bound' : 'logged_in'}`, 303);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return failRedirect('identity_conflict');
      return failRedirect('provider_error');
    }
  });

  app.post('/api/auth/email', async (request) => {
    const user = loggedIn(request);
    if (user.email) fail(409, '这个账号已经有邮箱');
    if (!smtpConfigured()) fail(503, '邮件服务尚未配置，暂时不能验证邮箱');
    const email = z.object({ email: emailField }).parse(request.body).email;
    const token = randomBytes(32).toString('hex');
    const url = new URL(process.env.APP_URL ?? 'http://localhost:33442');
    url.searchParams.set('verify', token);
    await transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const {
        rows: [existing],
      } = await client.query('SELECT id FROM users WHERE email=$1', [email]);
      if (existing) fail(409, '这个邮箱已经被其他账号使用');
      const {
        rows: [updated],
      } = await client.query(
        'UPDATE users SET email=$2 WHERE id=$1 AND email IS NULL RETURNING id',
        [user.id, email],
      );
      if (!updated) fail(409, '账号邮箱状态已变化，请刷新后重试');
      await client.query(
        'UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
        [user.id],
      );
      const {
        rows: [emailToken],
      } = await client.query(
        `INSERT INTO email_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id`,
        [user.id, digest(token)],
      );
      await client.query(
        `INSERT INTO email_outbox(user_id,to_email,subject,body,kind,email_token_id,next_attempt_at) VALUES($1,$2,$3,$4,'VERIFY_EMAIL',$5,$6)`,
        [
          user.id,
          email,
          '两个人 · 验证邮箱',
          `请打开以下链接验证邮箱，链接一小时内有效：\n${url.toString()}`,
          emailToken.id,
          new Date(),
        ],
      );
    });
    return { ok: true, message: '验证邮件已加入发送队列' };
  });
  app.get('/api/bootstrap', async (request) => {
    const user = request.currentUser;
    const result = {
      user: user ? publicUser(user) : null,
      space: null as any,
      partner: null as any,
      balance: 0,
      stats: { open: 0, claimed: 0, review: 0, completed: 0 },
      smtpConfigured: smtpConfigured(),
      wechatEnabled: wechatEnabled(),
    };
    if (!user) return result;
    const {
      rows: [wallet],
    } = await query('SELECT balance FROM wallets WHERE user_id=$1', [user.id]);
    result.balance = wallet?.balance ?? 0;
    const {
      rows: [space],
    } = await query(
      'SELECT s.* FROM spaces s JOIN memberships m ON m.space_id=s.id WHERE m.user_id=$1',
      [user.id],
    );
    if (!space) return result;
    result.space = camel(space);
    const {
      rows: [partner],
    } = await query(
      'SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.space_id=$1 AND m.user_id<>$2',
      [space.id, user.id],
    );
    result.partner = partner ?? null;
    const {
      rows: [stats],
    } = await query(
      `SELECT
      count(*) FILTER (WHERE status='OPEN' AND (mode='RACE' OR assigned_to=$2) AND (due_at IS NULL OR due_at>now()))::int AS open,
      count(*) FILTER (WHERE status='CLAIMED' AND claimant_id=$2 AND (due_at IS NULL OR due_at>now()))::int AS claimed,
      count(*) FILTER (WHERE status='SUBMITTED' AND claimant_id<>$2)::int AS review,
      count(*) FILTER (WHERE status='APPROVED' AND claimant_id=$2)::int AS completed
      FROM tasks WHERE space_id=$1`,
      [space.id, user.id],
    );
    result.stats = stats as typeof result.stats;
    return result;
  });
  app.post('/api/spaces', async (request) => {
    const user = loggedIn(request);
    const input = z.object({ name: z.string().trim().min(1).max(60) }).parse(request.body);
    const space = await transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if ((await client.query('SELECT 1 FROM memberships WHERE user_id=$1', [user.id])).rowCount)
        fail(409, '你已经有一个空间了');
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO spaces(name,invite_code,invite_expires_at) VALUES($1,$2,now()+interval '48 hours') RETURNING *`,
        [input.name, invitation()],
      );
      await client.query('INSERT INTO memberships(user_id,space_id,slot) VALUES($1,$2,1)', [
        user.id,
        created.id,
      ]);
      return created;
    });
    return { space: camel(space) };
  });
  app.post(
    '/api/spaces/join',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const user = loggedIn(request);
      const { code } = z
        .object({ code: z.string().trim().toUpperCase().min(6).max(64) })
        .parse(request.body);
      const space = await transaction(async (client) => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        if ((await client.query('SELECT 1 FROM memberships WHERE user_id=$1', [user.id])).rowCount)
          fail(409, '你已经加入了一个空间');
        const {
          rows: [found],
        } = await client.query(
          'SELECT * FROM spaces WHERE invite_code=$1 AND invite_expires_at>now() FOR UPDATE',
          [code],
        );
        if (!found) fail(409, '邀请码不存在、已过期或已被使用');
        const { rows: members } = await client.query(
          'SELECT user_id FROM memberships WHERE space_id=$1 ORDER BY slot',
          [found.id],
        );
        if (members.length !== 1) fail(409, '这个空间已经满员');
        await client.query('INSERT INTO memberships(user_id,space_id,slot) VALUES($1,$2,2)', [
          user.id,
          found.id,
        ]);
        const {
          rows: [updated],
        } = await client.query(
          'UPDATE spaces SET invite_code=NULL,invite_expires_at=NULL WHERE id=$1 RETURNING *',
          [found.id],
        );
        await notify(client, {
          userId: members[0].user_id,
          spaceId: found.id,
          title: '两个人到齐啦',
          body: `${user.name} 加入了你的空间，一起约定第一件小事吧。`,
          kind: 'PAIRED',
        });
        return updated;
      });
      return { space: camel(space) };
    },
  );
  app.post('/api/spaces/invite', async (request) => {
    const { space } = await spaceContext(request, false);
    const updated = await transaction(async (client) => {
      await client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [space.id]);
      const members = await client.query('SELECT 1 FROM memberships WHERE space_id=$1', [space.id]);
      if (members.rowCount !== 1) fail(409, '伴侣已加入，无需邀请');
      const {
        rows: [found],
      } = await client.query(
        `UPDATE spaces SET invite_code=$2,invite_expires_at=now()+interval '48 hours' WHERE id=$1 RETURNING *`,
        [space.id, invitation()],
      );
      return found;
    });
    return { space: camel(updated) };
  });
  app.patch('/api/settings', async (request) => {
    const user = loggedIn(request);
    const { notifyEmail, emailTheme } = z
      .object({
        notifyEmail: z.boolean().optional(),
        emailTheme: z.enum(['strawberry', 'cream', 'mint', 'sky', 'lavender', 'night']).optional(),
      })
      .refine(
        (input) => input.notifyEmail !== undefined || input.emailTheme !== undefined,
        '请选择需要修改的设置',
      )
      .parse(request.body);
    if (notifyEmail && !user.email_verified) fail(409, '请先验证邮箱再开启邮件提醒');
    const {
      rows: [updated],
    } = await query<User>(
      `UPDATE users SET notify_email=COALESCE($2,notify_email),email_theme=COALESCE($3,email_theme) WHERE id=$1 RETURNING id,name,email,email_verified,notify_email,email_theme,
       EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=users.id AND ai.provider='beichen-wx' AND ai.app_id=$4) AS wechat_bound`,
      [user.id, notifyEmail ?? null, emailTheme ?? null, process.env.BEICHEN_APP_ID ?? ''],
    );
    return { user: publicUser(updated) };
  });
  app.get('/api/mail/templates', async (request) => {
    loggedIn(request);
    return {
      templates: EMAIL_THEMES.map((theme) => ({ ...theme, html: buildMailPreview(theme.id) })),
    };
  });
  app.post(
    '/api/auth/verification',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request) => {
      const user = loggedIn(request);
      if (user.email_verified) return { ok: true, message: '邮箱已经验证' };
      if (!user.email) fail(409, '请先补充邮箱');
      if (!smtpConfigured()) fail(409, '邮件服务尚未配置，请联系部署者配置 SMTP');
      const token = randomBytes(32).toString('hex');
      const url = new URL(process.env.APP_URL ?? 'http://localhost:33442');
      url.searchParams.set('verify', token);
      await transaction(async (client) => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        await client.query(
          'UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [user.id],
        );
        const {
          rows: [emailToken],
        } = await client.query(
          `INSERT INTO email_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id`,
          [user.id, digest(token)],
        );
        await client.query(
          `INSERT INTO email_outbox(user_id,to_email,subject,body,kind,email_token_id,next_attempt_at) VALUES($1,$2,$3,$4,'VERIFY_EMAIL',$5,$6)`,
          [
            user.id,
            user.email,
            '两个人 · 验证邮箱',
            `请打开以下链接验证邮箱，链接一小时内有效：\n${url.toString()}\n\n验证后，可在设置中开启任务邮件提醒。若不是你的操作，请忽略此邮件。`,
            emailToken.id,
            new Date(),
          ],
        );
      });
      return { ok: true, message: '验证邮件已加入发送队列' };
    },
  );
  app.post(
    '/api/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/, '验证链接无效') })
        .parse(request.body);
      await transaction(async (client) => {
        // Match the user -> token lock order used when creating a new verification token.
        const {
          rows: [candidate],
        } = await client.query('SELECT user_id FROM email_tokens WHERE token_hash=$1', [
          digest(token),
        ]);
        if (!candidate) fail(400, '验证链接不存在或已经过期');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [candidate.user_id]);
        const {
          rows: [record],
        } = await client.query(
          'SELECT * FROM email_tokens WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL FOR UPDATE',
          [digest(token)],
        );
        if (!record) fail(400, '验证链接不存在、已使用或已经过期');
        const { rowCount } = await client.query(
          'UPDATE users SET email_verified=true WHERE id=$1 AND email IS NOT NULL',
          [record.user_id],
        );
        if (!rowCount) fail(400, '邮箱验证链接无效');
        await client.query('UPDATE email_tokens SET used_at=now() WHERE id=$1', [record.id]);
      });
      return { ok: true };
    },
  );

  app.get('/api/tasks', async (request) => {
    const { space } = await spaceContext(request, false);
    const [tasks, schedules] = await Promise.all([
      query('SELECT * FROM tasks WHERE space_id=$1 ORDER BY created_at DESC LIMIT 200', [space.id]),
      query('SELECT * FROM schedules WHERE space_id=$1 ORDER BY created_at DESC LIMIT 200', [
        space.id,
      ]),
    ]);
    return { tasks: camel(tasks.rows), schedules: camel(schedules.rows) };
  });
  app.post('/api/tasks', async (request) => {
    const { user, space, partner } = await spaceContext(request);
    const input = z.object({ ...taskFields, dueAt: dueDate.nullish() }).parse(request.body);
    if (input.dueAt && new Date(input.dueAt).getTime() <= Date.now())
      fail(400, '截止时间需要晚于现在');
    const task = await transaction(async (client) => {
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO tasks(space_id,creator_id,assigned_to,title,description,reward,mode,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          space.id,
          user.id,
          input.mode === 'ASSIGNED' ? partner.id : null,
          input.title,
          input.description,
          input.reward,
          input.mode,
          input.dueAt ?? null,
        ],
      );
      await notify(client, {
        userId: partner.id,
        spaceId: space.id,
        title: input.mode === 'RACE' ? '有一件可以抢的小事' : '收到一个新约定',
        body: `${user.name} 发布了「${input.title}」，快来领取吧！完成并通过验收可获得 ${input.reward} 积分。${input.description ? `\n约定内容：${input.description}` : ''}`,
        kind: 'TASK_CREATED',
        actionPath: `/?page=tasks&task=${created.id}`,
      });
      return created;
    });
    return { task: camel(task) };
  });
  app.post('/api/tasks/:id/claim', async (request) => {
    const { user, space, partner } = await spaceContext(request);
    const task = await transaction(async (client) => {
      const existing = await lockTask(client, idParam(request), space.id);
      if (existing.mode === 'ASSIGNED' && existing.assigned_to !== user.id)
        fail(403, '这个任务指定给另一位成员');
      if (existing.status === 'CLAIMED' && existing.claimant_id === user.id && !overdue(existing))
        return existing;
      if (existing.status !== 'OPEN') fail(409, '任务已被领取或已经结束');
      if (overdue(existing)) fail(409, '任务已经截止');
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE tasks SET status='CLAIMED',claimant_id=$2,submission=NULL,review_note=NULL,submitted_at=NULL WHERE id=$1 RETURNING *`,
        [existing.id, user.id],
      );
      await notify(client, {
        userId: partner.id,
        spaceId: space.id,
        title: '小约定被接住啦',
        body: `${user.name} 已领取「${existing.title}」，正在为这份 ${existing.reward} 积分的小约定努力。完成后会再提醒你来验收。`,
        kind: 'TASK_CLAIMED',
        actionPath: `/?page=tasks&task=${existing.id}`,
      });
      return updated;
    });
    return { task: camel(task) };
  });
  app.post('/api/tasks/:id/release', async (request) => {
    const { user, space } = await spaceContext(request);
    const task = await transaction(async (client) => {
      const existing = await lockTask(client, idParam(request), space.id);
      if (existing.claimant_id !== user.id) fail(403, '只有领取人可以放弃任务');
      if (existing.status !== 'CLAIMED') fail(409, '当前任务不能放弃');
      const status = overdue(existing) ? 'EXPIRED' : 'OPEN';
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE tasks SET status=$2,claimant_id=NULL,submission=NULL,review_note=NULL,reviewed_by=NULL,submitted_at=NULL WHERE id=$1 RETURNING *`,
        [existing.id, status],
      );
      return updated;
    });
    return { task: camel(task) };
  });
  app.post('/api/tasks/:id/submit', async (request) => {
    const { user, space, partner } = await spaceContext(request);
    const { submission } = z
      .object({
        submission: z
          .string()
          .max(3000)
          .trim()
          .optional()
          .transform((value) => value || null),
      })
      .parse(request.body ?? {});
    const task = await transaction(async (client) => {
      const existing = await lockTask(client, idParam(request), space.id);
      if (existing.claimant_id !== user.id) fail(403, '只有领取人可以提交');
      if (existing.status !== 'CLAIMED') fail(409, '当前任务不能提交');
      if (overdue(existing)) fail(409, '任务已经截止，无法提交');
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE tasks SET status='SUBMITTED',submission=$2,submitted_at=now(),review_note=NULL,reviewed_by=NULL WHERE id=$1 RETURNING *`,
        [existing.id, submission],
      );
      await notify(client, {
        userId: partner.id,
        spaceId: space.id,
        title: '有一件小事等你验收',
        body: `${user.name} 已完成并提交「${existing.title}」，请来验收这份用心。${submission ? `\n完成说明：${submission}` : ''}\n通过验收后，${existing.reward} 积分将奖励给对方。`,
        kind: 'TASK_SUBMITTED',
        actionPath: `/?page=tasks&task=${existing.id}`,
      });
      return updated;
    });
    return { task: camel(task) };
  });
  app.post('/api/tasks/:id/review', async (request) => {
    const { user, space } = await spaceContext(request);
    const input = z
      .object({ approve: z.boolean(), note: z.string().trim().max(2000).optional() })
      .parse(request.body);
    if (!input.approve && !input.note) fail(400, '请填写退回原因');
    const task = await transaction(async (client) => {
      const existing = await lockTask(client, idParam(request), space.id);
      if (existing.claimant_id === user.id) fail(403, '不能验收自己完成的任务');
      if (existing.status === 'APPROVED' && input.approve) return existing;
      if (existing.status !== 'SUBMITTED') fail(409, '任务尚未提交或已被处理');
      const status = input.approve ? 'APPROVED' : overdue(existing) ? 'EXPIRED' : 'CLAIMED';
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE tasks SET status=$2,review_note=$3,reviewed_by=$4,approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
        [existing.id, status, input.note ?? null, user.id],
      );
      if (input.approve)
        await addPoints(client, {
          userId: existing.claimant_id,
          spaceId: space.id,
          delta: existing.reward,
          reason: `完成任务 · ${existing.title}`,
          sourceKey: `TASK:${existing.id}`,
          taskId: existing.id,
        });
      await notify(client, {
        userId: existing.claimant_id,
        spaceId: space.id,
        title: input.approve ? '付出被看见啦' : '约定需要再完善一下',
        body: input.approve
          ? `${user.name} 已通过「${existing.title}」的验收，${existing.reward} 积分已到账。${input.note ? `\n对方的话：${input.note}` : ''}`
          : `${user.name} 退回了「${existing.title}」：${input.note}${status === 'EXPIRED' ? '。任务已截止。' : ''}`,
        kind: input.approve ? 'TASK_APPROVED' : 'TASK_REJECTED',
        actionPath: `/?page=tasks&task=${existing.id}`,
      });
      return updated;
    });
    return { task: camel(task) };
  });
  app.post('/api/tasks/:id/cancel', async (request) => {
    const { user, space } = await spaceContext(request);
    const task = await transaction(async (client) => {
      const existing = await lockTask(client, idParam(request), space.id);
      if (existing.creator_id !== user.id) fail(403, '只有发布者可以取消任务');
      if (existing.status === 'CANCELLED') return existing;
      if (existing.status !== 'OPEN') fail(409, '只能取消尚未领取的任务');
      const {
        rows: [updated],
      } = await client.query(`UPDATE tasks SET status='CANCELLED' WHERE id=$1 RETURNING *`, [
        existing.id,
      ]);
      return updated;
    });
    return { task: camel(task) };
  });
  app.post('/api/schedules', async (request) => {
    const { user, space, partner } = await spaceContext(request);
    const input = z
      .object({
        ...taskFields,
        kind: z.enum(['ONCE', 'DAILY', 'WEEKLY']),
        runAt: dueDate.optional(),
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm')
          .optional(),
        weekday: z.number().int().min(1).max(7).optional(),
        durationHours: z.number().int().min(1).max(168),
      })
      .parse(request.body);
    if (input.kind === 'ONCE' && !input.runAt) fail(400, '请选择定时发布时间');
    if (input.kind !== 'ONCE' && !input.time) fail(400, '请选择每天的发布时间');
    if (input.kind === 'WEEKLY' && !input.weekday) fail(400, '请选择星期');
    const next = nextOccurrence(input, new Date());
    if (!next) fail(400, '发布时间需要晚于现在');
    const {
      rows: [schedule],
    } = await query(
      `INSERT INTO schedules(space_id,creator_id,assigned_to,title,description,reward,mode,kind,run_at,time,weekday,duration_hours,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        space.id,
        user.id,
        input.mode === 'ASSIGNED' ? partner.id : null,
        input.title,
        input.description,
        input.reward,
        input.mode,
        input.kind,
        input.runAt ?? null,
        input.time ?? null,
        input.weekday ?? null,
        input.durationHours,
        next,
      ],
    );
    return { schedule: camel(schedule) };
  });
  app.patch('/api/schedules/:id', async (request) => {
    const { user, space } = await spaceContext(request);
    const { active } = z.object({ active: z.boolean() }).parse(request.body);
    const schedule = await transaction(async (client) => {
      const {
        rows: [existing],
      } = await client.query('SELECT * FROM schedules WHERE id=$1 AND space_id=$2 FOR UPDATE', [
        idParam(request),
        space.id,
      ]);
      if (!existing) fail(404, '计划不存在');
      if (existing.creator_id !== user.id) fail(403, '只有发布者可以管理这个计划');
      if (existing.active === active) return existing;
      const next = active ? nextOccurrence(existing, new Date()) : null;
      if (active && !next) fail(409, '这个一次性计划已经过时，请新建计划');
      const {
        rows: [updated],
      } = await client.query(
        'UPDATE schedules SET active=$2,next_run_at=$3 WHERE id=$1 RETURNING *',
        [existing.id, active, next],
      );
      return updated;
    });
    return { schedule: camel(schedule) };
  });

  app.get('/api/products', async (request) => {
    const { space } = await spaceContext(request, false);
    const { rows } = await query(
      'SELECT * FROM products WHERE space_id=$1 ORDER BY created_at DESC LIMIT 200',
      [space.id],
    );
    return { products: camel(rows) };
  });
  app.post('/api/products', async (request) => {
    const { user, space } = await spaceContext(request);
    const input = z.object(productFields).parse(request.body);
    const {
      rows: [product],
    } = await query(
      'INSERT INTO products(space_id,creator_id,title,description,emoji,price,stock) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [space.id, user.id, input.title, input.description, input.emoji, input.price, input.stock],
    );
    return { product: camel(product) };
  });
  app.patch('/api/products/:id', async (request) => {
    const { user, space } = await spaceContext(request);
    const input = z
      .object({ ...productFields, active: z.boolean() })
      .partial()
      .parse(request.body);
    if (!Object.keys(input).length) fail(400, '请填写要更新的商品信息');
    const product = await transaction(async (client) => {
      const {
        rows: [existing],
      } = await client.query('SELECT * FROM products WHERE id=$1 AND space_id=$2 FOR UPDATE', [
        idParam(request),
        space.id,
      ]);
      if (!existing) fail(404, '商品不存在');
      if (existing.creator_id !== user.id) fail(403, '只有上架者可以编辑这个商品');
      const values: unknown[] = [existing.id];
      const sets = Object.entries(input).map(([key, value]) => {
        values.push(value);
        return `${key}=$${values.length}`;
      });
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE products SET ${sets.join(',')} WHERE id=$1 RETURNING *`,
        values,
      );
      return updated;
    });
    return { product: camel(product) };
  });
  app.post('/api/products/:id/redeem', async (request) => {
    const { user, space, partner } = await spaceContext(request);
    const productId = idParam(request);
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string().trim().min(8, '请使用有效的兑换请求编号').max(128) })
      .parse(request.body);
    const order = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `redeem:${user.id}:${idempotencyKey}`,
      ]);
      const {
        rows: [previous],
      } = await client.query(
        'SELECT * FROM orders WHERE buyer_id=$1 AND idempotency_key=$2 AND space_id=$3',
        [user.id, idempotencyKey, space.id],
      );
      if (previous) {
        if (previous.product_id !== productId)
          fail(409, '这个兑换编号已经用于其他商品，请重新操作');
        return previous;
      }
      const {
        rows: [product],
      } = await client.query('SELECT * FROM products WHERE id=$1 AND space_id=$2 FOR UPDATE', [
        productId,
        space.id,
      ]);
      if (!product) fail(404, '商品不存在');
      if (!product.active) fail(409, '商品已经下架');
      if (product.stock < 1) fail(409, '商品已经兑完啦');
      await client.query('UPDATE products SET stock=stock-1 WHERE id=$1', [product.id]);
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO orders(space_id,buyer_id,seller_id,product_id,title,description,price,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          space.id,
          user.id,
          partner.id,
          product.id,
          product.title,
          product.description,
          product.price,
          idempotencyKey,
        ],
      );
      await addPoints(client, {
        userId: user.id,
        spaceId: space.id,
        delta: -product.price,
        reason: `兑换心意 · ${product.title}`,
        sourceKey: `REDEEM:${created.id}`,
        orderId: created.id,
      });
      await notify(client, {
        userId: partner.id,
        spaceId: space.id,
        title: '收到一份心愿兑换',
        body: `${user.name} 用 ${product.price} 积分兑换了「${product.title}」，这份小期待交给你来兑现啦。${product.description ? `\n心愿内容：${product.description}` : ''}`,
        kind: 'ORDER_CREATED',
        actionPath: `/?page=shop&tab=orders&order=${created.id}`,
      });
      return created;
    });
    return { order: camel(order) };
  });
  app.get('/api/orders', async (request) => {
    const { space } = await spaceContext(request, false);
    const { rows } = await query(
      'SELECT * FROM orders WHERE space_id=$1 ORDER BY created_at DESC LIMIT 200',
      [space.id],
    );
    return { orders: camel(rows) };
  });
  app.post('/api/orders/:id/action', async (request) => {
    const { user, space } = await spaceContext(request);
    const { action } = z
      .object({ action: z.enum(['fulfill', 'complete', 'cancel']) })
      .parse(request.body);
    const order = await transaction(async (client) => {
      const {
        rows: [existing],
      } = await client.query('SELECT * FROM orders WHERE id=$1 AND space_id=$2 FOR UPDATE', [
        idParam(request),
        space.id,
      ]);
      if (!existing) fail(404, '兑换记录不存在');
      if (action === 'fulfill' && existing.seller_id !== user.id)
        fail(403, '只有负责兑现的另一半可以标记兑现');
      if (action === 'complete' && existing.buyer_id !== user.id)
        fail(403, '只有兑换者可以确认完成');
      if (![existing.buyer_id, existing.seller_id].includes(user.id)) fail(403, '无权操作这笔兑换');
      if (action === 'cancel' && existing.status === 'CANCELLED') return existing;
      if (action === 'complete' && existing.status === 'COMPLETED') return existing;
      if (action === 'fulfill' && ['FULFILLED', 'COMPLETED'].includes(existing.status))
        return existing;
      const expected = action === 'complete' ? 'FULFILLED' : 'PENDING';
      if (existing.status !== expected)
        fail(
          409,
          action === 'cancel' ? '已兑现或已完成的心意不能单方取消' : '这笔兑换目前不能执行该操作',
        );
      const status =
        action === 'fulfill' ? 'FULFILLED' : action === 'complete' ? 'COMPLETED' : 'CANCELLED';
      const timestamp =
        action === 'fulfill'
          ? 'fulfilled_at'
          : action === 'complete'
            ? 'completed_at'
            : 'cancelled_at';
      if (action === 'cancel') {
        await client.query('SELECT id FROM products WHERE id=$1 AND space_id=$2 FOR UPDATE', [
          existing.product_id,
          space.id,
        ]);
        await client.query('UPDATE products SET stock=stock+1 WHERE id=$1', [existing.product_id]);
        await addPoints(client, {
          userId: existing.buyer_id,
          spaceId: space.id,
          delta: existing.price,
          reason: `兑换退还 · ${existing.title}`,
          sourceKey: `REFUND:${existing.id}`,
          orderId: existing.id,
        });
      }
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE orders SET status=$2,${timestamp}=now() WHERE id=$1 RETURNING *`,
        [existing.id, status],
      );
      const recipient = user.id === existing.buyer_id ? existing.seller_id : existing.buyer_id;
      await notify(client, {
        userId: recipient,
        spaceId: space.id,
        title:
          action === 'fulfill'
            ? '心意已经兑现啦'
            : action === 'complete'
              ? '心意已被确认收下'
              : '兑换已经取消',
        body:
          action === 'cancel'
            ? `「${existing.title}」的兑换已取消，${existing.price} 积分已退还。`
            : `「${existing.title}」${action === 'fulfill' ? '已标记兑现，请兑换者确认。' : '已确认完成，感谢彼此的用心。'}`,
        kind: `ORDER_${status}`,
        actionPath: `/?page=shop&tab=orders&order=${existing.id}`,
      });
      return updated;
    });
    return { order: camel(order) };
  });
  app.get('/api/ledger', async (request) => {
    const { user, space } = await spaceContext(request, false);
    const [wallet, entries] = await Promise.all([
      query('SELECT balance FROM wallets WHERE user_id=$1', [user.id]),
      query(
        'SELECT id,delta,balance_after,reason,created_at FROM point_ledger WHERE user_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 200',
        [user.id, space.id],
      ),
    ]);
    return { balance: wallet.rows[0]?.balance ?? 0, entries: camel(entries.rows) };
  });
  app.get('/api/notifications', async (request) => {
    const user = loggedIn(request);
    const { rows } = await query(
      'SELECT id,title,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [user.id],
    );
    return { notifications: camel(rows) };
  });
  app.post('/api/notifications/read', async (request) => {
    const user = loggedIn(request);
    await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [
      user.id,
    ]);
    return { ok: true };
  });
  app.get('/api/mail/status', async (request) => {
    const user = loggedIn(request);
    const {
      rows: [counts],
    } = await query(
      `SELECT count(*) FILTER(WHERE status IN ('PENDING','SENDING'))::int AS pending,count(*) FILTER(WHERE status='SENT')::int AS sent,count(*) FILTER(WHERE status='FAILED')::int AS failed FROM email_outbox WHERE user_id=$1`,
      [user.id],
    );
    return { configured: smtpConfigured(), counts };
  });
  app.post(
    '/api/mail/retry',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const user = loggedIn(request);
      if (!smtpConfigured()) fail(409, '邮件服务尚未配置');
      const result = await query(
        `UPDATE email_outbox SET status='PENDING',attempts=0,next_attempt_at=$2,locked_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE user_id=$1 AND status='FAILED'`,
        [user.id, new Date()],
      );
      return { ok: true, retried: result.rowCount };
    },
  );

  const webRoot = resolve(process.cwd(), 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || !['GET', 'HEAD'].includes(request.method))
        return reply.code(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: '页面或接口不存在' }),
    );
  }
  return app;
}
