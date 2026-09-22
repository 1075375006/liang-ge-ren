import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { query, transaction } from './db.js';
import { notify, smtpConfigured } from './notify.js';
import { renderMail } from './mail-template.js';
import { runMaintenance } from './maintenance.js';
import { applyAdminRuntimeSettings } from './admin.js';
import {
  nextOccurrence,
  recoverableOccurrence,
  SCHEDULE_ZONE,
  type ScheduleTiming,
} from './schedule-time.js';

export { nextOccurrence } from './schedule-time.js';

type ScheduleRow = ScheduleTiming & {
  id: string;
  space_id: string;
  creator_id: string;
  assigned_to: string | null;
  title: string;
  description: string;
  reward: number;
  mode: 'ASSIGNED' | 'RACE';
  duration_hours: number;
  next_run_at: Date;
};

type OutboxRow = {
  id: string;
  user_id: string;
  to_email: string;
  subject: string;
  body: string;
  kind: string;
  attempts: number;
  lease_token: string;
};

// Recheck eligibility at delivery time: settings and verification tokens can change after enqueueing.
const mailIneligibleReason = `CASE
  WHEN recipient.deleted_at IS NOT NULL THEN '账号已注销，此邮件不再发送'
  WHEN recipient.email IS NULL OR lower(recipient.email)<>lower(mail.to_email) THEN '收件邮箱已变更，此邮件不再发送'
  WHEN mail.kind='VERIFY_EMAIL' AND recipient.email_verified THEN '邮箱已验证，无需再发送验证邮件'
  WHEN mail.kind='VERIFY_EMAIL' AND NOT EXISTS (
    SELECT 1 FROM email_tokens AS token
    WHERE token.id=mail.email_token_id AND token.user_id=mail.user_id
      AND token.used_at IS NULL AND token.expires_at>$1
  ) THEN '验证链接已过期或失效，请重新申请验证邮件'
  WHEN mail.kind='PASSWORD_RESET' AND NOT EXISTS (
    SELECT 1 FROM password_reset_tokens AS token
    WHERE token.id=mail.password_reset_token_id AND token.user_id=mail.user_id
      AND token.used_at IS NULL AND token.expires_at>$1
  ) THEN '重置链接已过期或失效，请重新申请'
  WHEN mail.kind NOT IN ('VERIFY_EMAIL','PASSWORD_RESET') AND NOT recipient.email_verified THEN '邮箱尚未验证，业务邮件不再发送'
  WHEN mail.kind NOT IN ('VERIFY_EMAIL','PASSWORD_RESET') AND NOT recipient.notify_email THEN '邮件提醒已关闭，此邮件不再发送'
  ELSE NULL END`;

/** Each plan is locked before generating its one latest, still-valid occurrence. */
export async function runScheduler(now: Date = new Date()) {
  return transaction(async (client) => {
    // Lock affected spaces before plans, matching account archival's lock order.
    const { rows: lockedSpaces } = await client.query(
      `SELECT id FROM spaces WHERE archived_at IS NULL AND id IN (
      SELECT space_id FROM schedules WHERE active AND next_run_at <= $1 ORDER BY next_run_at,id LIMIT 50
    ) ORDER BY id FOR SHARE`,
      [now],
    );
    const { rows: schedules } = await client.query<ScheduleRow>(
      `
      SELECT * FROM schedules
      WHERE active AND next_run_at <= $1 AND space_id=ANY($2::uuid[]) AND EXISTS (SELECT 1 FROM spaces WHERE id=schedules.space_id AND archived_at IS NULL)
      ORDER BY next_run_at, id
      LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [now, lockedSpaces.map((space) => space.id)],
    );
    let created = 0;
    let skipped = 0;
    for (const schedule of schedules) {
      const occurrence = recoverableOccurrence(schedule, now);
      if (occurrence) {
        const result = await client.query(
          `
          INSERT INTO tasks (space_id,creator_id,assigned_to,title,description,reward,mode,schedule_id,scheduled_for,due_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (schedule_id,scheduled_for) DO NOTHING RETURNING id`,
          [
            schedule.space_id,
            schedule.creator_id,
            schedule.assigned_to,
            schedule.title,
            schedule.description,
            schedule.reward,
            schedule.mode,
            schedule.id,
            occurrence.scheduledFor,
            occurrence.dueAt,
          ],
        );
        if (result.rowCount) {
          created++;
          const { rows: recipients } = await client.query<{
            user_id: string;
            creator_name: string;
          }>(
            'SELECT m.user_id,u.name AS creator_name FROM memberships m JOIN users u ON u.id=$2 WHERE m.space_id=$1 AND m.user_id<>$2',
            [schedule.space_id, schedule.creator_id],
          );
          const dueLabel = DateTime.fromJSDate(occurrence.dueAt, { zone: SCHEDULE_ZONE }).toFormat(
            'MM月dd日 HH:mm',
          );
          for (const recipient of recipients) {
            await notify(client, {
              userId: recipient.user_id,
              spaceId: schedule.space_id,
              title: schedule.mode === 'RACE' ? '新的抢单任务' : '有一份新的约定',
              body: `${recipient.creator_name} 的定时约定「${schedule.title}」已发布，快来领取吧！完成并通过验收可获得 ${schedule.reward} 积分。请在北京时间 ${dueLabel} 前提交。${schedule.description ? `\n约定内容：${schedule.description}` : ''}`,
              kind: 'TASK_CREATED',
              actionPath: `/?page=tasks&task=${result.rows[0].id}`,
            });
          }
        }
      } else {
        skipped++;
      }
      const next = nextOccurrence(schedule, now);
      await client.query('UPDATE schedules SET next_run_at=$2, active=$3 WHERE id=$1', [
        schedule.id,
        next,
        next !== null,
      ]);
    }

    // Submitted work remains reviewable after its deadline; only unfinished work expires.
    const expired = await client.query(
      `
      UPDATE tasks SET status='EXPIRED'
      WHERE status IN ('OPEN','CLAIMED') AND due_at <= $1`,
      [now],
    );
    return { processed: schedules.length, created, skipped, expired: expired.rowCount ?? 0 };
  });
}

function mailError(error: unknown): string {
  const smtpError = error as { code?: unknown; responseCode?: unknown };
  const code =
    typeof smtpError?.code === 'string' && /^[A-Z0-9_]+$/.test(smtpError.code)
      ? smtpError.code
      : 'SEND_FAILED';
  const responseCode =
    typeof smtpError?.responseCode === 'number' ? `，${smtpError.responseCode}` : '';
  return `邮件发送失败（${code}${responseCode}）`;
}

function messageDomain(): string {
  try {
    const hostname = new URL(process.env.APP_URL ?? 'http://localhost:33442').hostname;
    return /^[a-z0-9.-]+$/i.test(hostname) ? hostname : 'localhost';
  } catch {
    return 'localhost';
  }
}

/** Mail is leased in the database; SMTP calls always happen outside transactions. */
export async function runMailBatch(now: Date = new Date()) {
  if (!smtpConfigured()) return { processed: 0, sent: 0, failed: 0, skipped: true };

  const leaseToken = randomUUID();
  const leased = await transaction(async (client) => {
    // Discard stale queued notifications in bulk so they cannot delay valid, current mail.
    await client.query(
      `WITH invalid AS (
        SELECT mail.id,${mailIneligibleReason} AS reason
        FROM email_outbox AS mail JOIN users AS recipient ON recipient.id=mail.user_id
        WHERE mail.status='PENDING'
          OR (mail.status='SENDING' AND (mail.lease_until IS NULL OR mail.lease_until <= $1))
      )
      UPDATE email_outbox AS mail
      SET status='FAILED',last_error=invalid.reason,lease_until=NULL,lease_token=NULL,locked_at=NULL
      FROM invalid WHERE mail.id=invalid.id AND invalid.reason IS NOT NULL AND (
        mail.status='PENDING'
        OR (mail.status='SENDING' AND (mail.lease_until IS NULL OR mail.lease_until <= $1))
      )`,
      [now],
    );
    // A process may have died during its final allowed attempt. Do not leave it SENDING forever.
    await client.query(
      `UPDATE email_outbox
      SET status='FAILED',lease_until=NULL,lease_token=NULL,locked_at=NULL,
          last_error=COALESCE(last_error,'邮件发送中断，已达到最大尝试次数')
      WHERE attempts>=5 AND (
        (status='SENDING' AND (lease_until IS NULL OR lease_until <= $1))
        OR (status='PENDING' AND next_attempt_at <= $1)
      )`,
      [now],
    );
    const { rows } = await client.query<OutboxRow>(
      `
      WITH candidates AS (
        SELECT id FROM email_outbox
        WHERE attempts<5 AND (
          (status='PENDING' AND next_attempt_at <= $1)
          OR (status='SENDING' AND (lease_until IS NULL OR lease_until <= $1))
        )
        ORDER BY next_attempt_at,id
        LIMIT 5 FOR UPDATE SKIP LOCKED
      )
      UPDATE email_outbox AS mail
      SET status='SENDING',attempts=mail.attempts+1,locked_at=$1,
          lease_until=$1::timestamptz + interval '5 minutes',lease_token=$2
      FROM candidates WHERE mail.id=candidates.id
      RETURNING mail.*`,
      [now, leaseToken],
    );
    return rows;
  });

  if (leased.length === 0) return { processed: 0, sent: 0, failed: 0, skipped: false };
  const port = Number(process.env.SMTP_PORT ?? 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure:
      process.env.SMTP_SECURE === undefined
        ? port === 465
        : /^(true|1)$/i.test(process.env.SMTP_SECURE),
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  let sent = 0;
  let failed = 0;
  try {
    const outcomes = await Promise.allSettled(
      leased.map(async (mail) => {
        const {
          rows: [eligibility],
        } = await query<{ reason: string | null; email_theme: string; name: string }>(
          `
        SELECT ${mailIneligibleReason} AS reason,recipient.email_theme,recipient.name
        FROM email_outbox AS mail JOIN users AS recipient ON recipient.id=mail.user_id
        WHERE mail.id=$2 AND mail.lease_token=$3 AND mail.status='SENDING'`,
          [now, mail.id, mail.lease_token],
        );
        if (!eligibility) return;
        if (eligibility.reason) {
          await query(
            `UPDATE email_outbox
          SET status='FAILED',last_error=$3,lease_until=NULL,lease_token=NULL,locked_at=NULL
          WHERE id=$1 AND lease_token=$2 AND status='SENDING'`,
            [mail.id, mail.lease_token, eligibility.reason],
          );
          return;
        }
        try {
          const content = renderMail({
            subject: mail.subject,
            body: mail.body,
            kind: mail.kind,
            theme: eligibility.email_theme,
            recipientName: eligibility.name,
            appUrl: process.env.APP_URL ?? 'http://localhost:33442',
          });
          await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: mail.to_email,
            subject: mail.subject,
            text: content.text,
            html: content.html,
            messageId: `<couple-${mail.id}@${messageDomain()}>`,
          });
        } catch (error) {
          const exhausted = mail.attempts >= 5;
          const retryAt = new Date(
            now.getTime() + Math.min(60 * 60 * 1000, 60_000 * 2 ** (mail.attempts - 1)),
          );
          await query(
            `UPDATE email_outbox
          SET status=$3,next_attempt_at=$4,last_error=$5,lease_until=NULL,lease_token=NULL,locked_at=NULL
          WHERE id=$1 AND lease_token=$2 AND status='SENDING'`,
            [
              mail.id,
              mail.lease_token,
              exhausted ? 'FAILED' : 'PENDING',
              retryAt,
              mailError(error),
            ],
          );
          failed++;
          return;
        }
        // A stale worker cannot overwrite the result of a newer lease holder.
        const result = await query(
          `UPDATE email_outbox
        SET status='SENT',sent_at=$3,last_error=NULL,lease_until=NULL,lease_token=NULL,locked_at=NULL
        WHERE id=$1 AND lease_token=$2 AND status='SENDING'`,
          [mail.id, mail.lease_token, now],
        );
        if (result.rowCount) sent++;
      }),
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  } finally {
    transporter.close();
  }
  return { processed: leased.length, sent, failed, skipped: false };
}

export async function tick(now: Date = new Date()) {
  try {
    await applyAdminRuntimeSettings();
    const scheduler = await runScheduler(now);
    const mail = await runMailBatch(now);
    const maintenance = await runMaintenance(now).catch(() => {
      console.error('[worker] 过期数据清理失败；业务调度已完成，下次轮询重试');
      return { failed: true };
    });
    await query(
      `INSERT INTO worker_heartbeat (name,last_seen_at,last_error) VALUES ('main',$1,$2)
      ON CONFLICT (name) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,last_error=EXCLUDED.last_error`,
      [
        now,
        'failed' in maintenance
          ? '过期数据清理失败，请检查后台日志'
          : mail.failed > 0
            ? `本轮 ${mail.failed} 封邮件发送失败，请查看邮件队列`
            : null,
      ],
    );
    return { scheduler, mail, maintenance };
  } catch (error) {
    await query(
      `INSERT INTO worker_heartbeat (name,last_seen_at,last_error) VALUES ('main',$1,$2)
      ON CONFLICT (name) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,last_error=EXCLUDED.last_error`,
      [now, '后台任务执行失败，下次轮询将重试'],
    ).catch(() => undefined);
    throw error;
  }
}
