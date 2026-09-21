import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';

export const SESSION_COOKIE = 'couple_session';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, salt, hex] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(hex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
  };
}
export async function createSession(
  client: PoolClient,
  userId: string,
): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await client.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [
    digest(token),
    userId,
    expires,
  ]);
  return { token, expires };
}
export function setSessionCookie(
  reply: FastifyReply,
  session: { token: string; expires: Date },
): void {
  reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions(), expires: session.expires });
}
