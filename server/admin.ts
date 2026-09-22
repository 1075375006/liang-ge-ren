import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from './db.js';
import { hashPassword, verifyPassword } from './security.js';

/**
 * The admin console has its own session namespace.  It intentionally does not
 * share the customer session cookie: a stolen customer session must never
 * grant access to the operations console.
 */
export const ADMIN_SESSION_COOKIE = 'couple_admin_session';
const ADMIN_SESSION_HOURS = 12;
const ADMIN_SECRET_FILE =
  process.env.ADMIN_SECRET_FILE || resolve('.local/production/admin.secret');
const ADMIN_BOOTSTRAP_FILE =
  process.env.ADMIN_BOOTSTRAP_FILE || resolve('.local/production/admin.bootstrap');
let encryptionKey: Buffer | undefined;

function secretKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const configured = process.env.ADMIN_SECRET_KEY?.trim();
  if (configured) {
    const decoded = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64');
    if (decoded.length !== 32) throw new Error('ADMIN_SECRET_KEY 必须是 32 字节（hex 或 base64）');
    encryptionKey = decoded;
    return decoded;
  }
  const file = resolve(ADMIN_SECRET_FILE);
  try {
    const value = readFileSync(file, 'utf8').trim();
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32) throw new Error('管理员密钥文件内容无效');
    encryptionKey = decoded;
    return decoded;
  } catch (error) {
    if (existsSync(file)) throw error;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const generated = randomBytes(32);
    try {
      writeFileSync(file, generated.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
      chmodSync(file, 0o600);
      encryptionKey = generated;
      return generated;
    } catch (writeError) {
      // API and worker can bootstrap at the same time. If the other process
      // won the create race, use its key instead of failing startup.
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      const value = readFileSync(file, 'utf8').trim();
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length !== 32) throw new Error('管理员密钥文件内容无效');
      encryptionKey = decoded;
      return decoded;
    }
  }
}

function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decrypt<T>(encoded: string): T {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split('.');
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error('管理员配置密文格式无效');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    secretKey(),
    Buffer.from(ivEncoded, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

export type AdminEmailSettings = {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  pass: string;
  from: string;
};
export type AdminWechatSettings = { enabled: boolean; appId: string; appKey: string };

const defaultEmail: AdminEmailSettings = {
  host: '',
  port: 587,
  secure: false,
  requireTls: true,
  user: '',
  pass: '',
  from: '',
};
const defaultWechat: AdminWechatSettings = { enabled: false, appId: '', appKey: '' };

/** Read settings for the mail worker and WeChat adapter. Secrets stay local to the server. */
export async function readAdminEmailSettings(): Promise<AdminEmailSettings> {
  const row = (
    await query<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM admin_settings WHERE key=$1',
      ['email'],
    )
  ).rows[0];
  return row
    ? { ...defaultEmail, ...decrypt<AdminEmailSettings>(row.value_encrypted) }
    : { ...defaultEmail };
}
export async function readAdminWechatSettings(): Promise<AdminWechatSettings> {
  const row = (
    await query<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM admin_settings WHERE key=$1',
      ['wechat'],
    )
  ).rows[0];
  return row
    ? { ...defaultWechat, ...decrypt<AdminWechatSettings>(row.value_encrypted) }
    : { ...defaultWechat };
}

export async function applyAdminRuntimeSettings(): Promise<void> {
  const emailRow = (
    await query<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM admin_settings WHERE key=$1',
      ['email'],
    )
  ).rows[0];
  const wechatRow = (
    await query<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM admin_settings WHERE key=$1',
      ['wechat'],
    )
  ).rows[0];
  if (emailRow) {
    const email = { ...defaultEmail, ...decrypt<AdminEmailSettings>(emailRow.value_encrypted) };
    process.env.SMTP_HOST = email.host;
    process.env.SMTP_PORT = String(email.port);
    process.env.SMTP_SECURE = String(email.secure);
    process.env.SMTP_REQUIRE_TLS = String(email.requireTls);
    process.env.SMTP_USER = email.user;
    process.env.SMTP_PASS = email.pass;
    process.env.SMTP_FROM = email.from;
  }
  if (wechatRow) {
    const wechat = { ...defaultWechat, ...decrypt<AdminWechatSettings>(wechatRow.value_encrypted) };
    process.env.WECHAT_LOGIN_ENABLED = String(wechat.enabled);
    process.env.BEICHEN_APP_ID = wechat.appId;
    process.env.BEICHEN_APP_KEY = wechat.appKey;
  }
}

export async function readAdminSetting(
  key: 'email' | 'wechat',
): Promise<AdminEmailSettings | AdminWechatSettings> {
  return key === 'email' ? readAdminEmailSettings() : readAdminWechatSettings();
}

type AdminActor = { id: string; username: string };

function adminCookieOptions() {
  return {
    path: '/api/admin',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.COOKIE_SECURE === 'true',
  };
}

function tokenDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function issueAdminSession(client: PoolClient, adminId: string) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
  await client.query(
    'INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,$3)',
    [tokenDigest(token), adminId, expires],
  );
  return { token, expires };
}

function setAdminCookie(reply: FastifyReply, session: { token: string; expires: Date }) {
  reply.setCookie(ADMIN_SESSION_COOKIE, session.token, {
    ...adminCookieOptions(),
    expires: session.expires,
  });
}

async function currentAdmin(request: FastifyRequest): Promise<AdminActor | null> {
  const token = request.cookies[ADMIN_SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const {
    rows: [admin],
  } = await query<AdminActor>(
    `UPDATE admin_sessions s SET last_seen_at=now()
     FROM admin_users a
     WHERE s.admin_id=a.id AND s.token_hash=$1 AND s.expires_at>now()
     RETURNING a.id,a.username`,
    [tokenDigest(token)],
  );
  return admin ?? null;
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: '请先登录管理后台' });
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: '无权访问管理后台' });
}

async function mustAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminActor | null> {
  const admin = await currentAdmin(request);
  if (!admin) {
    unauthorized(reply);
    return null;
  }
  return admin;
}

function localRequest(request: FastifyRequest): boolean {
  const ip = request.ip.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function bootstrapAllowed(request: FastifyRequest, input: { bootstrapToken?: string }): boolean {
  let expected = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
  if (!expected) {
    try {
      expected = readFileSync(ADMIN_BOOTSTRAP_FILE, 'utf8').trim();
    } catch {
      expected = '';
    }
  }
  if (expected) {
    const received =
      input.bootstrapToken ?? String(request.headers['x-admin-bootstrap-token'] ?? '');
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // A deployment with no bootstrap token can still be initialized from the
  // same machine. In production, require an explicit token to avoid exposing
  // an unauthenticated setup endpoint through a reverse proxy.
  return process.env.NODE_ENV !== 'production' && localRequest(request);
}

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, '管理员用户名需为 3-64 位字母、数字或 ._-');
const adminPassword = z.string().min(12, '管理员密码至少 12 位').max(128, '管理员密码最多 128 位');

const emailSettingsInput = z.object({
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  requireTls: z.boolean().optional(),
  requireTLS: z.boolean().optional(),
  user: z.string().max(254).optional(),
  pass: z.string().max(512).optional(),
  password: z.string().max(512).optional(),
  from: z.string().trim().max(320).optional(),
});
const wechatSettingsInput = z.object({
  enabled: z.boolean().optional(),
  appId: z.string().trim().max(200).optional(),
  appKey: z.string().max(512).optional(),
});

async function saveSetting(client: PoolClient, key: 'email' | 'wechat', value: object) {
  await client.query(
    `INSERT INTO admin_settings(key,value_encrypted,updated_at) VALUES($1,$2,now())
     ON CONFLICT(key) DO UPDATE SET value_encrypted=EXCLUDED.value_encrypted,updated_at=now()`,
    [key, encrypt(value)],
  );
}

function publicEmail(value: AdminEmailSettings, updatedAt?: Date | string | null) {
  return {
    host: value.host,
    port: value.port,
    secure: value.secure,
    requireTls: value.requireTls,
    requireTLS: value.requireTls,
    user: value.user,
    from: value.from,
    configured: Boolean(value.host && value.from),
    hasPassword: Boolean(value.pass),
    updatedAt: updatedAt ?? null,
  };
}
function publicWechat(value: AdminWechatSettings, updatedAt?: Date | string | null) {
  return {
    enabled: value.enabled,
    appId: value.appId,
    configured: Boolean(value.enabled && value.appId && value.appKey),
    hasAppKey: Boolean(value.appKey),
    updatedAt: updatedAt ?? null,
  };
}

function cursorEncode(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function cursorDecode(value: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Do not make HTTP startup depend on a healthy database connection. The
  // readiness endpoint still reports the database failure, and the worker/API
  // will apply settings again on its next request or tick. This also keeps the
  // public callback error paths available while the database is restarting.
  await applyAdminRuntimeSettings().catch(() => undefined);
  app.post(
    '/api/admin/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const input = z
        .object({
          username,
          password: adminPassword,
          bootstrapToken: z.string().max(512).optional(),
        })
        .parse(request.body);
      const result = await transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(726031941)');
        const { rows: existing } = await client.query('SELECT id FROM admin_users LIMIT 1');
        if (existing.length) return { reason: 'already_initialized' as const };
        if (!bootstrapAllowed(request, input)) return { reason: 'bootstrap_required' as const };
        const passwordHash = await hashPassword(input.password);
        const {
          rows: [created],
        } = await client.query<{ id: string; username: string }>(
          'INSERT INTO admin_users(username,password_hash) VALUES($1,$2) RETURNING id,username',
          [input.username, passwordHash],
        );
        const session = await issueAdminSession(client, created.id);
        return { created, session };
      });
      if (result.reason === 'already_initialized')
        return reply.code(409).send({ error: '管理后台已经初始化' });
      if (result.reason === 'bootstrap_required') return forbidden(reply);
      setAdminCookie(reply, result.session);
      return reply.code(201).send({ admin: result.created });
    },
  );

  app.post(
    '/api/admin/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = z.object({ username, password: adminPassword }).parse(request.body);
      const {
        rows: [admin],
      } = await query<{ id: string; username: string; password_hash: string }>(
        'SELECT id,username,password_hash FROM admin_users WHERE username=$1',
        [input.username],
      );
      const encoded =
        admin?.password_hash ?? 'scrypt$00000000000000000000000000000000$' + '00'.repeat(128);
      if (!admin || !(await verifyPassword(input.password, encoded)))
        return reply.code(401).send({ error: '管理员用户名或密码不正确' });
      const session = await transaction((client) => issueAdminSession(client, admin.id));
      setAdminCookie(reply, session);
      return { admin: { id: admin.id, username: admin.username } };
    },
  );

  app.post('/api/admin/logout', async (request, reply) => {
    const token = request.cookies[ADMIN_SESSION_COOKIE];
    if (token) await query('DELETE FROM admin_sessions WHERE token_hash=$1', [tokenDigest(token)]);
    reply.clearCookie(ADMIN_SESSION_COOKIE, adminCookieOptions());
    return { ok: true };
  });

  // Lightweight probe used by the /admin page before it decides whether to
  // show setup, login, or the console. It never reveals a setting value.
  app.get('/api/admin/status', async (request) => {
    const admin = await currentAdmin(request);
    const {
      rows: [state],
    } = await query<{ count: number }>('SELECT count(*)::int AS count FROM admin_users');
    return {
      configured: Number(state?.count ?? 0) > 0,
      setupRequired: Number(state?.count ?? 0) === 0,
      authenticated: Boolean(admin),
      adminName: admin?.username ?? null,
      username: admin?.username ?? null,
      version: process.env.APP_VERSION || 'development',
    };
  });

  app.get('/api/admin/session', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    return { admin };
  });

  app.get('/api/admin/overview', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const startedAt = Date.now();
    const [users, spaces, tasks, orders, mail, worker, email, wechat, recentUsers, recentSpaces] =
      await Promise.all([
        query(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
                    count(*) FILTER (WHERE deleted_at IS NULL AND suspended_at IS NULL)::int AS active,
                    count(*) FILTER (WHERE suspended_at IS NOT NULL AND deleted_at IS NULL)::int AS suspended
             FROM users`),
        query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE archived_at IS NULL)::int AS active FROM spaces`,
        ),
        query(`SELECT status,count(*)::int AS count FROM tasks GROUP BY status`),
        query(`SELECT status,count(*)::int AS count FROM orders GROUP BY status`),
        query(`SELECT status,count(*)::int AS count FROM email_outbox GROUP BY status`),
        query(
          `SELECT name,last_seen_at,last_error,last_seen_at>now()-interval '2 minutes' AND last_error IS NULL AS healthy FROM worker_heartbeat WHERE name='main'`,
        ),
        readAdminEmailSettings(),
        readAdminWechatSettings(),
        query(`SELECT u.id,u.name,u.email,u.created_at,m.space_id,s.name AS space_name
             FROM users u LEFT JOIN memberships m ON m.user_id=u.id LEFT JOIN spaces s ON s.id=m.space_id
             ORDER BY u.created_at DESC,u.id DESC LIMIT 6`),
        query(`SELECT s.id,s.name,s.created_at,s.archived_at,count(m.user_id)::int AS members
             FROM spaces s LEFT JOIN memberships m ON m.space_id=s.id
             GROUP BY s.id ORDER BY s.created_at DESC,s.id DESC LIMIT 6`),
      ]);
    await query('SELECT 1');
    const userStats = users.rows[0] ?? { total: 0, active: 0, suspended: 0 };
    const spaceStats = spaces.rows[0] ?? { total: 0, active: 0 };
    const taskCounts = Object.fromEntries(tasks.rows.map((row) => [row.status, Number(row.count)]));
    const orderCounts = Object.fromEntries(
      orders.rows.map((row) => [row.status, Number(row.count)]),
    );
    const mailCounts = Object.fromEntries(mail.rows.map((row) => [row.status, Number(row.count)]));
    const publicMail = publicEmail(email);
    const publicWx = publicWechat(wechat);
    return {
      admin,
      database: { healthy: true, latencyMs: Date.now() - startedAt },
      // Keep a compact shape for the mobile-friendly admin page while the
      // status maps above remain useful to API clients.
      overview: {
        users: Number(userStats.total),
        activeUsers: Number(userStats.active),
        spaces: Number(spaceStats.total),
        activeSpaces: Number(spaceStats.active),
        tasks: Object.values(taskCounts).reduce<number>((sum, value) => sum + Number(value), 0),
        completedTasks: Number(taskCounts.APPROVED ?? 0),
        orders: Object.values(orderCounts).reduce<number>((sum, value) => sum + Number(value), 0),
        completedOrders: Number(orderCounts.COMPLETED ?? 0),
      },
      users: recentUsers.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        createdAt: row.created_at,
        spaceName: row.space_name,
      })),
      spaces: recentSpaces.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        archivedAt: row.archived_at,
        members: Number(row.members),
      })),
      userStats,
      spaceStats,
      tasks: taskCounts,
      orders: orderCounts,
      mail: {
        configured: Boolean(email.host && email.from),
        counts: mailCounts,
      },
      queue: {
        pending: Number(mailCounts.PENDING ?? 0),
        sending: Number(mailCounts.SENDING ?? 0),
        sent: Number(mailCounts.SENT ?? 0),
        failed: Number(mailCounts.FAILED ?? 0),
      },
      smtp: publicMail,
      wechat: {
        enabled: publicWx.enabled,
        appId: publicWx.appId,
        appKeyConfigured: publicWx.hasAppKey,
        configured: publicWx.configured,
      },
      worker: worker.rows[0] ?? { healthy: false, lastSeenAt: null, lastError: null },
    };
  });

  app.get('/api/admin/settings/email', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const {
      rows: [row],
    } = await query<{ updated_at: Date }>('SELECT updated_at FROM admin_settings WHERE key=$1', [
      'email',
    ]);
    return { settings: publicEmail(await readAdminEmailSettings(), row?.updated_at) };
  });
  app.patch('/api/admin/settings/email', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const input = emailSettingsInput.parse(request.body);
    const current = await readAdminEmailSettings();
    const next: AdminEmailSettings = {
      ...current,
      ...input,
      pass: input.pass ?? input.password ?? current.pass,
    };
    delete (next as Partial<AdminEmailSettings> & { password?: string }).password;
    await transaction((client) => saveSetting(client, 'email', next));
    process.env.SMTP_HOST = next.host;
    process.env.SMTP_PORT = String(next.port);
    process.env.SMTP_SECURE = String(next.secure);
    process.env.SMTP_REQUIRE_TLS = String(next.requireTls);
    process.env.SMTP_USER = next.user;
    process.env.SMTP_PASS = next.pass;
    process.env.SMTP_FROM = next.from;
    return { settings: publicEmail(next) };
  });
  app.patch('/api/admin/settings/smtp', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const input = emailSettingsInput.parse(request.body);
    const current = await readAdminEmailSettings();
    const next: AdminEmailSettings = {
      ...current,
      ...input,
      requireTls:
        input.requireTls ?? (input as { requireTLS?: boolean }).requireTLS ?? current.requireTls,
      pass: input.pass ?? input.password ?? current.pass,
    };
    await transaction((client) => saveSetting(client, 'email', next));
    process.env.SMTP_HOST = next.host;
    process.env.SMTP_PORT = String(next.port);
    process.env.SMTP_SECURE = String(next.secure);
    process.env.SMTP_REQUIRE_TLS = String(next.requireTls);
    process.env.SMTP_USER = next.user;
    process.env.SMTP_PASS = next.pass;
    process.env.SMTP_FROM = next.from;
    return { settings: publicEmail(next) };
  });

  app.get('/api/admin/settings/wechat', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const {
      rows: [row],
    } = await query<{ updated_at: Date }>('SELECT updated_at FROM admin_settings WHERE key=$1', [
      'wechat',
    ]);
    return { settings: publicWechat(await readAdminWechatSettings(), row?.updated_at) };
  });
  app.patch('/api/admin/settings/wechat', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const input = wechatSettingsInput.parse(request.body);
    const current = await readAdminWechatSettings();
    const next: AdminWechatSettings = {
      ...current,
      ...input,
      appKey: input.appKey ?? current.appKey,
    };
    await transaction((client) => saveSetting(client, 'wechat', next));
    process.env.WECHAT_LOGIN_ENABLED = String(next.enabled);
    process.env.BEICHEN_APP_ID = next.appId;
    process.env.BEICHEN_APP_KEY = next.appKey;
    return { settings: publicWechat(next) };
  });

  app.post('/api/admin/queue/retry', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const result = await query(
      `UPDATE email_outbox SET status='PENDING',attempts=0,next_attempt_at=now(),locked_at=NULL,
       lease_until=NULL,lease_token=NULL,last_error=NULL WHERE status='FAILED'`,
    );
    return { ok: true, retried: result.rowCount };
  });

  app.get('/api/admin/users', async (request, reply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const input = z
      .object({
        search: z.string().trim().max(100).default(''),
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);
    const cursor = input.cursor ? cursorDecode(input.cursor) : null;
    if (input.cursor && !cursor) return reply.code(400).send({ error: '分页游标无效' });
    const args: unknown[] = [];
    const clauses = ['1=1'];
    if (input.search) {
      args.push(
        `%${input.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
      );
      clauses.push(
        `(u.name ILIKE $${args.length} ESCAPE '\\' OR u.email ILIKE $${args.length} ESCAPE '\\' OR u.id::text=$${args.length})`,
      );
    }
    if (cursor) {
      args.push(cursor.createdAt, cursor.id);
      clauses.push(
        `(u.created_at < $${args.length - 1}::timestamptz OR (u.created_at=$${args.length - 1}::timestamptz AND u.id < $${args.length}::uuid))`,
      );
    }
    args.push(input.limit + 1);
    const result = await query(
      `SELECT u.id,u.name,u.email,u.email_verified,u.created_at,u.deleted_at,u.suspended_at,u.suspend_reason,
              (u.password_hash IS NOT NULL) AS has_password,m.space_id,s.name AS space_name
       FROM users u LEFT JOIN memberships m ON m.user_id=u.id LEFT JOIN spaces s ON s.id=m.space_id
       WHERE ${clauses.join(' AND ')} ORDER BY u.created_at DESC,u.id DESC LIMIT $${args.length}`,
      args,
    );
    const rows = result.rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.email_verified,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      suspendedAt: row.suspended_at,
      suspendReason: row.suspend_reason,
      hasPassword: row.has_password,
      space: row.space_id ? { id: row.space_id, name: row.space_name } : null,
    }));
    const last = rows.at(-1);
    return {
      users: rows,
      nextCursor:
        result.rows.length > input.limit && last
          ? cursorEncode({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })
          : null,
    };
  });

  const suspendUser = async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = await mustAdmin(request, reply);
    if (!admin) return;
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const input = z
      .object({
        suspended: z.boolean().default(true),
        reason: z.string().trim().max(200).optional(),
      })
      .parse(request.body ?? {});
    const result = await transaction(async (client) => {
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE users SET suspended_at=CASE WHEN $2 THEN now() ELSE NULL END,
         suspend_reason=CASE WHEN $2 THEN NULLIF($3,'') ELSE NULL END
         WHERE id=$1 AND deleted_at IS NULL RETURNING id,suspended_at,suspend_reason`,
        [id, input.suspended, input.reason ?? ''],
      );
      if (!updated) return null;
      if (input.suspended) await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      return updated;
    });
    if (!result) return reply.code(404).send({ error: '用户不存在或已注销' });
    return {
      user: {
        id: result.id,
        suspendedAt: result.suspended_at,
        suspendReason: result.suspend_reason,
      },
    };
  };
  app.patch('/api/admin/users/:id/suspend', suspendUser);
  app.post('/api/admin/users/:id/suspend', suspendUser);
}
