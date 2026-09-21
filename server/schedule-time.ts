import { DateTime } from 'luxon';

export const SCHEDULE_ZONE = 'Asia/Shanghai';

export type ScheduleTiming = {
  kind: 'ONCE' | 'DAILY' | 'WEEKLY';
  runAt?: string | Date | null;
  run_at?: string | Date | null;
  time?: string | null;
  timing?: string | null;
  weekday?: number | null;
};

function referenceTime(value: Date): DateTime {
  const result = DateTime.fromJSDate(value, { zone: SCHEDULE_ZONE });
  if (!result.isValid) throw new RangeError('计划计算时间无效');
  return result;
}

function onceTime(schedule: ScheduleTiming): DateTime {
  const value = schedule.runAt ?? schedule.run_at;
  const result =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: SCHEDULE_ZONE })
      : DateTime.fromISO(value ?? '', { zone: SCHEDULE_ZONE });
  if (!result.isValid) throw new RangeError('一次性计划缺少有效的发布时间');
  return result;
}

function localTime(schedule: ScheduleTiming, reference: DateTime): DateTime {
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.time ?? schedule.timing ?? '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new RangeError('计划时间必须为有效的 HH:mm');
  }
  if (
    schedule.kind === 'WEEKLY' &&
    (!Number.isInteger(schedule.weekday) ||
      Number(schedule.weekday) < 1 ||
      Number(schedule.weekday) > 7)
  ) {
    throw new RangeError('每周计划必须指定星期一至星期日');
  }
  return reference.set({
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: 0,
    millisecond: 0,
  });
}

/** The next occurrence is strictly after `after`, including when resuming a paused plan. */
export function nextOccurrence(schedule: ScheduleTiming, after: Date = new Date()): Date | null {
  const reference = referenceTime(after);
  if (schedule.kind === 'ONCE') {
    const occurrence = onceTime(schedule);
    return occurrence.toMillis() > reference.toMillis() ? occurrence.toJSDate() : null;
  }
  let occurrence = localTime(schedule, reference);
  if (schedule.kind === 'WEEKLY') {
    occurrence = occurrence.plus({ days: (Number(schedule.weekday) - reference.weekday + 7) % 7 });
  }
  if (occurrence.toMillis() <= reference.toMillis()) {
    occurrence = occurrence.plus({ days: schedule.kind === 'WEEKLY' ? 7 : 1 });
  }
  return occurrence.toJSDate();
}

/** Find only the latest due occurrence, without replaying all dates missed during downtime. */
export function latestOccurrence(schedule: ScheduleTiming, at: Date = new Date()): Date | null {
  const reference = referenceTime(at);
  if (schedule.kind === 'ONCE') {
    const occurrence = onceTime(schedule);
    return occurrence.toMillis() <= reference.toMillis() ? occurrence.toJSDate() : null;
  }
  let occurrence = localTime(schedule, reference);
  if (schedule.kind === 'WEEKLY') {
    occurrence = occurrence.minus({ days: (reference.weekday - Number(schedule.weekday) + 7) % 7 });
  }
  if (occurrence.toMillis() > reference.toMillis()) {
    occurrence = occurrence.minus({ days: schedule.kind === 'WEEKLY' ? 7 : 1 });
  }
  return occurrence.toJSDate();
}

export function recoverableOccurrence(
  schedule: ScheduleTiming & { next_run_at: Date | string; duration_hours: number },
  now: Date,
): { scheduledFor: Date; dueAt: Date } | null {
  const scheduledFor = latestOccurrence(schedule, now);
  if (!scheduledFor || scheduledFor.getTime() < new Date(schedule.next_run_at).getTime())
    return null;
  const dueAt = new Date(scheduledFor.getTime() + schedule.duration_hours * 60 * 60 * 1000);
  return dueAt.getTime() > now.getTime() ? { scheduledFor, dueAt } : null;
}
