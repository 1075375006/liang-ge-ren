import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query, transaction } from './db.js';
import { smtpConfigured } from './notify.js';
import {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  digest,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from './security.js';

const emailField = z.string().trim().toLowerCase().email('请输入正确的邮箱').max(254);
const passwordField = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
const resetMessage = '如果这个邮箱已注册密码账号，我们会发送重置链接。请查收收件箱和垃圾邮件。';
const invalidReset = '重置链接已失效，请重新申请';
type Fail = (statusCode: number, message: string) => never;

/** Account security routes share the app's session, origin checks, and error handler. */
export function registerAccountRoutes(app: FastifyInstance, { fail }: { fail: Fail }): void {
  function userId(request: FastifyRequest): string {
    const user = request.currentUser;
    if (!user) return fail(401, '请先登录');
    return user.id;
  }

  app.post(
    '/api/auth/password/forgot',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          keyGenerator: (request: FastifyRequest) => request.ip,
        },
      },
    },
    async (request) => {
      const { email } = z.object({ email: emailField }).parse(request.body);
      if (!smtpConfigured()) fail(503, '邮件服务暂未启用，请稍后再试');
      await transaction(async (client) => {
        const {
          rows: [user],
        } = await client.query(
          'SELECT id,email,password_hash FROM users WHERE email=$1 AND deleted_at IS NULL FOR UPDATE',
          [email],
        );
        // A notification address on a WeChat account must never become a password login.
        if (!user?.password_hash) return;
        const {
          rows: [recent],
        } = await client.query<{ count: number; cooling_down: boolean }>(
          `SELECT count(*)::int AS count,coalesce(bool_or(created_at>now()-interval '1 minute'),false) AS cooling_down
           FROM password_reset_tokens WHERE user_id=$1 AND created_at>now()-interval '1 hour'`,
          [user.id],
        );
        // Enforce a recipient limit as well as an IP limit, without revealing account existence.
        if (recent.cooling_down || recent.count >= 3) return;
        const token = randomBytes(32).toString('hex');
        const link = new URL(process.env.APP_URL?.trim() || 'http://localhost:33442');
        link.search = '';
        link.hash = `reset-password=${token}`;
        await client.query(
          'UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [user.id],
        );
        const {
          rows: [record],
        } = await client.query(
          `INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
           VALUES($1,$2,now()+interval '30 minutes') RETURNING id`,
          [user.id, digest(token)],
        );
        await client.query(
          `INSERT INTO email_outbox(user_id,to_email,subject,body,kind,password_reset_token_id,next_attempt_at)
           VALUES($1,$2,$3,$4,'PASSWORD_RESET',$5,$6)`,
          [
            user.id,
            user.email,
            '两个人 · 重置登录密码',
            `请打开以下链接设置新密码，链接 30 分钟内有效，且只能使用一次：\n${link.toString()}\n\n重置后，所有设备都需要重新登录。如果不是你的操作，请忽略此邮件，你的密码不会改变。`,
            record.id,
            new Date(),
          ],
        );
      });
      return { ok: true, message: resetMessage };
    },
  );

  app.post(
    '/api/auth/password/reset',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request: FastifyRequest) => request.ip,
        },
      },
    },
    async (request, reply) => {
      const { token, password } = z
        .object({
          token: z.string().regex(/^[a-f0-9]{64}$/, invalidReset),
          password: passwordField,
        })
        .parse(request.body);
      // Expensive hashing runs only after a valid token has been found and locked.
      await transaction(async (client) => {
        const {
          rows: [candidate],
        } = await client.query('SELECT user_id FROM password_reset_tokens WHERE token_hash=$1', [
          digest(token),
        ]);
        if (!candidate) fail(400, invalidReset);
        const {
          rows: [user],
        } = await client.query(
          'SELECT id,password_hash,email FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
          [candidate.user_id],
        );
        if (!user?.password_hash || !user.email) fail(400, invalidReset);
        const {
          rows: [record],
        } = await client.query(
          `SELECT id FROM password_reset_tokens WHERE token_hash=$1 AND user_id=$2
           AND used_at IS NULL AND expires_at>now() FOR UPDATE`,
          [digest(token), user.id],
        );
        if (!record) fail(400, invalidReset);
        const hash = await hashPassword(password);
        // Possession of the link proves control of the account's existing email address.
        await client.query('UPDATE users SET password_hash=$2,email_verified=true WHERE id=$1', [
          user.id,
          hash,
        ]);
        await client.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
        await client.query('DELETE FROM oauth_states WHERE user_id=$1', [user.id]);
        await client.query(
          'UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [user.id],
        );
        await client.query(
          'UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [user.id],
        );
      });
      reply.clearCookie(SESSION_COOKIE, cookieOptions(request));
      reply.clearCookie('couple_wechat_nonce', {
        ...cookieOptions(request),
        path: '/api/auth/wechat',
      });
      return { ok: true, message: '密码已更新，请用新密码登录' };
    },
  );

  app.post(
    '/api/account/password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const id = userId(request);
      const { currentPassword, password } = z
        .object({
          currentPassword: z.string().min(1, '请填写当前密码').max(128),
          password: passwordField,
        })
        .parse(request.body);
      const session = await transaction(async (client) => {
        const {
          rows: [user],
        } = await client.query(
          'SELECT id,password_hash FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        );
        if (!user?.password_hash) fail(409, '这个账号使用微信登录，无需设置登录密码');
        // Recheck the session after acquiring the user lock; a concurrent reset may revoke it.
        const active = await client.query(
          'SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()',
          [id, digest(request.cookies[SESSION_COOKIE] ?? '')],
        );
        if (!active.rowCount) fail(401, '登录已过期，请重新登录');
        if (!(await verifyPassword(currentPassword, user.password_hash)))
          fail(400, '当前密码不正确');
        if (currentPassword === password) fail(400, '新密码需要与当前密码不同');
        await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
          id,
          await hashPassword(password),
        ]);
        await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        await client.query('DELETE FROM oauth_states WHERE user_id=$1', [id]);
        await client.query(
          'UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [id],
        );
        return createSession(client, id);
      });
      setSessionCookie(reply, session);
      reply.clearCookie('couple_wechat_nonce', {
        ...cookieOptions(request),
        path: '/api/auth/wechat',
      });
      return { ok: true, message: '密码已更新，其他设备已退出登录' };
    },
  );

  app.patch(
    '/api/account/profile',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const id = userId(request);
      const { name } = z
        .object({
          name: z
            .string()
            .trim()
            .min(1, '请填写昵称')
            .max(40, '昵称最多 40 字')
            .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), '昵称不能包含不可见字符'),
        })
        .parse(request.body);
      await query('UPDATE users SET name=$2 WHERE id=$1 AND deleted_at IS NULL', [id, name]);
      return { ok: true, name };
    },
  );
}
