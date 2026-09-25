import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { EMAIL_THEMES } from './mail-template.js';

export const STREAK_ZONE = 'Asia/Shanghai';

/**
 * Unlock days are kept here as a compatibility fallback for installations
 * whose compiled mail-template module predates the unlockDays field.
 */
export const STREAK_THEME_DAYS: Record<string, number> = {
  strawberry: 0,
  cream: 0,
  mint: 0,
  sky: 0,
  lavender: 0,
  night: 0,
  'line-puppy': 2,
  lulu: 7,
  nailong: 14,
  yibubu: 21,
  'tom-jerry': 30,
};

type Executor = Pick<PoolClient, 'query'>;
type ThemeLike = { id: string; unlockDays?: unknown };

export type StreakSummary = {
  current: number;
  best: number;
  lastCompletedDate: string | null;
  todayComplete: boolean;
  completedDates: string[];
};

export type StreakMilestone = {
  days: number;
  templateId: string;
  unlocked: boolean;
  claimed: boolean;
  unlockedAt: string | null;
};

function localDate(value: Date): string {
  return DateTime.fromJSDate(value).setZone(STREAK_ZONE).toISODate()!;
}

function previousDate(value: string): string {
  return DateTime.fromISO(value, { zone: STREAK_ZONE }).minus({ days: 1 }).toISODate()!;
}

/** Pure streak calculation, exported so date-boundary behavior stays testable. */
export function calculateStreak(completedDates: string[], now = new Date()): StreakSummary {
  const dates = [...new Set(completedDates)].sort().reverse();
  const today = localDate(now);
  const yesterday = previousDate(today);
  const todayComplete = dates.includes(today);
  let current = 0;
  if (dates[0] === today || dates[0] === yesterday) {
    let expected = dates[0];
    for (const date of dates) {
      if (date !== expected) break;
      current += 1;
      expected = previousDate(expected);
    }
  }
  let best = 0;
  let run = 0;
  let expected: string | null = null;
  for (const date of [...dates].sort()) {
    if (expected && date === expected) run += 1;
    else run = 1;
    best = Math.max(best, run);
    expected = DateTime.fromISO(date, { zone: STREAK_ZONE }).plus({ days: 1 }).toISODate()!;
  }
  return {
    current,
    best,
    lastCompletedDate: dates[0] ?? null,
    todayComplete,
    completedDates: dates,
  };
}

/**
 * Return a date for which both members have at least one approved task. A
 * task can only count for its claimant, which prevents a single shared task
 * from accidentally satisfying both sides of the couple's streak.
 */
export async function readSpaceStreak(
  executor: Executor,
  spaceId: string,
  now = new Date(),
): Promise<StreakSummary> {
  const { rows } = await executor.query<{ day: string }>(
    `SELECT (t.approved_at AT TIME ZONE $2)::date::text AS day
     FROM tasks AS t
     WHERE t.space_id=$1 AND t.status='APPROVED' AND t.approved_at IS NOT NULL
       AND t.claimant_id IN (SELECT user_id FROM memberships WHERE space_id=$1)
     GROUP BY (t.approved_at AT TIME ZONE $2)::date
     HAVING count(DISTINCT t.claimant_id)=2
     ORDER BY day DESC`,
    [spaceId, STREAK_ZONE],
  );
  return calculateStreak(
    rows.map((row) => row.day),
    now,
  );
}

export function templateUnlockDays(templateId: string): number | null {
  const theme = EMAIL_THEMES.find((item) => item.id === templateId) as ThemeLike | undefined;
  if (!theme) return null;
  const declared = theme.unlockDays;
  if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) return declared;
  return STREAK_THEME_DAYS[templateId] ?? null;
}

export function streakThemes(): Array<{ id: string; days: number }> {
  return EMAIL_THEMES.map((theme) => ({
    id: theme.id,
    days: templateUnlockDays(theme.id) ?? 0,
  }));
}

/** Grant earned styles to both members. INSERT makes this safe to retry. */
export async function syncTemplateUnlocks(
  executor: Executor,
  spaceId: string,
  currentStreak: number,
  now = new Date(),
): Promise<void> {
  for (const theme of streakThemes()) {
    if (theme.days <= 0 || theme.days > currentStreak) continue;
    await executor.query(
      `INSERT INTO email_template_unlocks(user_id,space_id,template_id,streak_days,unlocked_at)
       SELECT m.user_id,$1,$2,$3,$4 FROM memberships AS m WHERE m.space_id=$1
       ON CONFLICT (user_id,template_id) DO NOTHING`,
      [spaceId, theme.id, theme.days, now],
    );
  }
}

export async function readMilestones(
  executor: Executor,
  spaceId: string,
  currentStreak: number,
  userId: string,
): Promise<StreakMilestone[]> {
  const { rows } = await executor.query<{
    template_id: string;
    unlocked_at: Date;
    claimed_at: Date | null;
  }>(
    `SELECT template_id,unlocked_at,claimed_at
     FROM email_template_unlocks WHERE user_id=$1`,
    [userId],
  );
  const persisted = new Map(rows.map((row) => [row.template_id, row]));
  return streakThemes()
    .filter((theme) => theme.days > 0)
    .sort((a, b) => a.days - b.days)
    .map((theme) => {
      const saved = persisted.get(theme.id);
      return {
        days: theme.days,
        templateId: theme.id,
        unlocked: Boolean(saved) || currentStreak >= theme.days,
        claimed: Boolean(saved?.claimed_at),
        unlockedAt: saved?.unlocked_at?.toISOString() ?? null,
      };
    });
}

export async function themeIsUnlocked(
  executor: Executor,
  userId: string,
  spaceId: string,
  templateId: string,
  currentStreak?: number,
): Promise<boolean> {
  const days = templateUnlockDays(templateId);
  if (days === null) return false;
  if (days <= 0) return true;
  const { rowCount } = await executor.query(
    'SELECT 1 FROM email_template_unlocks WHERE user_id=$1 AND template_id=$2',
    [userId, templateId],
  );
  if (rowCount) return true;
  if (currentStreak === undefined)
    currentStreak = (await readSpaceStreak(executor, spaceId)).current;
  return currentStreak >= days;
}

export function nextStreakMilestone(currentStreak: number, milestones: StreakMilestone[]) {
  return (
    milestones.find((milestone) => !milestone.unlocked && milestone.days > currentStreak) ?? null
  );
}
