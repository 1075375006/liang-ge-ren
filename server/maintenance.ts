import { transaction } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED_SECURITY_BODY = '安全链接已过期，原邮件内容已按保留策略清理。';
export type MaintenanceResult = {
  skipped: boolean;
  reason: 'locked' | 'recent' | null;
  lastCompletedAt: string | null;
  deletedSessions: number;
  deletedOauthStates: number;
  deletedEmailTokens: number;
  deletedPasswordResetTokens: number;
  deletedEmailHistory: number;
  redactedSecurityEmails: number;
};
const emptyResult = (): MaintenanceResult => ({
  skipped: false,
  reason: null,
  lastCompletedAt: null,
  deletedSessions: 0,
  deletedOauthStates: 0,
  deletedEmailTokens: 0,
  deletedPasswordResetTokens: 0,
  deletedEmailHistory: 0,
  redactedSecurityEmails: 0,
});

/**
 * A bounded, transactional daily cleanup. Tasks, schedules, orders, products,
 * point ledgers, wallets, spaces, users, and in-app notifications are never deleted.
 * A failure rolls back both cleanup and the completion marker so the worker can retry.
 */
export async function runMaintenance(
  now: Date = new Date(),
  { batchSize = 5000 }: { batchSize?: number } = {},
): Promise<MaintenanceResult> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Maintenance time is invalid');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new RangeError('Maintenance batch size must be between 1 and 5000');
  }
  const sessionCutoff = new Date(now.getTime() - DAY);
  const securityCutoff = new Date(now.getTime() - 7 * DAY);
  const historyCutoff = new Date(now.getTime() - 90 * DAY);
  return transaction(async (client) => {
    const result = emptyResult();
    const {
      rows: [lock],
    } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(726031941) AS acquired',
    );
    if (!lock.acquired) return { ...result, skipped: true, reason: 'locked' };
    const {
      rows: [last],
    } = await client.query<{ last_completed_at: Date }>(
      "SELECT last_completed_at FROM maintenance_runs WHERE name='retention'",
    );
    if (last && last.last_completed_at.getTime() > now.getTime() - DAY) {
      return {
        ...result,
        skipped: true,
        reason: 'recent',
        lastCompletedAt: last.last_completed_at.toISOString(),
      };
    }
    result.deletedSessions =
      (
        await client.query(
          `DELETE FROM sessions WHERE token_hash IN (
         SELECT token_hash FROM sessions WHERE expires_at<$1 ORDER BY expires_at,token_hash
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )`,
          [sessionCutoff, batchSize],
        )
      ).rowCount ?? 0;
    result.deletedOauthStates =
      (
        await client.query(
          `DELETE FROM oauth_states WHERE id IN (
         SELECT id FROM oauth_states WHERE expires_at<$1 ORDER BY expires_at,id
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )`,
          [securityCutoff, batchSize],
        )
      ).rowCount ?? 0;
    // A delayed delivery keeps its history for 90 days after sending, not just enqueueing.
    result.deletedEmailHistory =
      (
        await client.query(
          `DELETE FROM email_outbox WHERE id IN (
         SELECT id FROM email_outbox WHERE status IN ('SENT','FAILED')
           AND coalesce(sent_at,created_at)<$1 ORDER BY coalesce(sent_at,created_at),id
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )`,
          [historyCutoff, batchSize],
        )
      ).rowCount ?? 0;
    // Pending or leased messages stay intact. Only terminal security messages lose their links.
    result.redactedSecurityEmails =
      (
        await client.query(
          `UPDATE email_outbox SET email_token_id=NULL,password_reset_token_id=NULL,body=$3
       WHERE id IN (
         SELECT mail.id FROM email_outbox AS mail
         WHERE mail.status IN ('SENT','FAILED') AND mail.kind IN ('VERIFY_EMAIL','PASSWORD_RESET')
           AND (
             EXISTS(SELECT 1 FROM email_tokens AS token WHERE token.id=mail.email_token_id AND token.expires_at<$1)
             OR EXISTS(SELECT 1 FROM password_reset_tokens AS token WHERE token.id=mail.password_reset_token_id AND token.expires_at<$1)
             OR (mail.email_token_id IS NULL AND mail.password_reset_token_id IS NULL AND mail.created_at<$1 AND mail.body<>$3)
           )
         ORDER BY mail.created_at,mail.id LIMIT $2 FOR UPDATE OF mail SKIP LOCKED
       )`,
          [securityCutoff, batchSize, EXPIRED_SECURITY_BODY],
        )
      ).rowCount ?? 0;
    // Foreign keys referenced by pending/sending mail are deliberately retained.
    result.deletedEmailTokens =
      (
        await client.query(
          `DELETE FROM email_tokens WHERE id IN (
         SELECT token.id FROM email_tokens AS token WHERE token.expires_at<$1
           AND NOT EXISTS(SELECT 1 FROM email_outbox AS mail WHERE mail.email_token_id=token.id)
         ORDER BY token.expires_at,token.id LIMIT $2 FOR UPDATE OF token SKIP LOCKED
       )`,
          [securityCutoff, batchSize],
        )
      ).rowCount ?? 0;
    result.deletedPasswordResetTokens =
      (
        await client.query(
          `DELETE FROM password_reset_tokens WHERE id IN (
         SELECT token.id FROM password_reset_tokens AS token WHERE token.expires_at<$1
           AND NOT EXISTS(SELECT 1 FROM email_outbox AS mail WHERE mail.password_reset_token_id=token.id)
         ORDER BY token.expires_at,token.id LIMIT $2 FOR UPDATE OF token SKIP LOCKED
       )`,
          [securityCutoff, batchSize],
        )
      ).rowCount ?? 0;
    await client.query(
      `INSERT INTO maintenance_runs(name,last_completed_at) VALUES('retention',$1)
       ON CONFLICT(name) DO UPDATE SET last_completed_at=EXCLUDED.last_completed_at`,
      [now],
    );
    result.lastCompletedAt = now.toISOString();
    return result;
  });
}
