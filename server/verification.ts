import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest } from './security.js';

/** The caller holds the account row lock (or just inserted the account). */
export async function enqueueVerification(
  client: PoolClient,
  user: { id: string; email: string | null },
) {
  if (!user.email) return;
  const token = randomBytes(32).toString('hex');
  const url = new URL(process.env.APP_URL ?? 'http://localhost:33442');
  url.search = '';
  url.hash = '';
  url.searchParams.set('verify', token);
  await client.query('UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [
    user.id,
  ]);
  const {
    rows: [record],
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
      `请打开以下链接确认邮箱，链接一小时内有效：\n${url.toString()}\n\n验证后即可邀请伴侣。如果不是你的操作，请忽略此邮件。`,
      record.id,
      new Date(),
    ],
  );
}
