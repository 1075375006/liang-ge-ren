import type { PoolClient } from 'pg';

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export type NotificationInput = {
  userId: string;
  spaceId: string;
  title: string;
  body: string;
  kind?: string;
  actionPath?: string;
};

export async function notify(client: PoolClient, data: NotificationInput): Promise<void> {
  const {
    rows: [notification],
  } = await client.query(
    'INSERT INTO notifications (user_id,space_id,title,body,kind) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [data.userId, data.spaceId, data.title, data.body, data.kind ?? 'GENERAL'],
  );
  const base = new URL(process.env.APP_URL?.trim() || 'http://localhost:33442');
  const target = new URL(data.actionPath ?? '/', base);
  const link = target.origin === base.origin ? target.toString() : base.toString();
  // Use the same millisecond application clock as the worker's retry/lease checks.
  await client.query(
    `INSERT INTO email_outbox (user_id,space_id,notification_id,to_email,subject,body,kind,next_attempt_at)
    SELECT id,$2,$3,email,$4,$5,$6,$7 FROM users WHERE id=$1 AND email_verified AND notify_email AND email IS NOT NULL`,
    [
      data.userId,
      data.spaceId,
      notification.id,
      `两个人 · ${data.title}`,
      `${data.body}\n\n打开两个人：${link}`,
      data.kind ?? 'GENERAL',
      new Date(),
    ],
  );
}
