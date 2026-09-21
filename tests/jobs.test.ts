import assert from 'node:assert/strict';
import test from 'node:test';
import {
  latestOccurrence,
  nextOccurrence,
  recoverableOccurrence,
} from '../server/schedule-time.js';

test('daily plans use Beijing time and return strictly future occurrences', () => {
  const plan = { kind: 'DAILY' as const, time: '08:00' };
  assert.equal(
    nextOccurrence(plan, new Date('2026-09-21T23:59:59Z'))?.toISOString(),
    '2026-09-22T00:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(plan, new Date('2026-09-22T00:00:00Z'))?.toISOString(),
    '2026-09-23T00:00:00.000Z',
  );
  assert.equal(
    latestOccurrence(plan, new Date('2026-09-22T00:00:00Z'))?.toISOString(),
    '2026-09-22T00:00:00.000Z',
  );
});

test('weekly plans use ISO weekdays and cross weeks and years correctly', () => {
  const plan = { kind: 'WEEKLY' as const, time: '08:00', weekday: 1 };
  assert.equal(
    nextOccurrence(plan, new Date('2026-09-20T16:00:00Z'))?.toISOString(),
    '2026-09-21T00:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(plan, new Date('2026-09-21T00:00:00Z'))?.toISOString(),
    '2026-09-28T00:00:00.000Z',
  );
  assert.equal(
    latestOccurrence(plan, new Date('2026-09-20T16:00:00Z'))?.toISOString(),
    '2026-09-14T00:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(plan, new Date('2026-12-31T12:00:00Z'))?.toISOString(),
    '2027-01-04T00:00:00.000Z',
  );
});

test('one-time plans have no next occurrence after their scheduled instant', () => {
  const plan = { kind: 'ONCE' as const, runAt: '2026-09-21T09:00:00+08:00' };
  assert.equal(
    nextOccurrence(plan, new Date('2026-09-21T00:59:59Z'))?.toISOString(),
    '2026-09-21T01:00:00.000Z',
  );
  assert.equal(nextOccurrence(plan, new Date('2026-09-21T01:00:00Z')), null);
  assert.equal(latestOccurrence(plan, new Date('2026-09-21T00:59:59Z')), null);
});

test('downtime recovers only the latest unexpired daily occurrence', () => {
  const plan = {
    kind: 'DAILY' as const,
    time: '08:00',
    next_run_at: '2026-09-01T00:00:00Z',
    duration_hours: 12,
  };
  const recovered = recoverableOccurrence(plan, new Date('2026-09-21T04:00:00Z'));
  assert.equal(recovered?.scheduledFor.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(recovered?.dueAt.toISOString(), '2026-09-21T12:00:00.000Z');
  assert.equal(recoverableOccurrence(plan, new Date('2026-09-21T12:00:00Z')), null);
});

test('resuming a paused schedule does not generate previous occurrences', () => {
  const plan = {
    kind: 'DAILY' as const,
    time: '08:00',
    next_run_at: '2026-09-22T00:00:00Z',
    duration_hours: 168,
  };
  assert.equal(recoverableOccurrence(plan, new Date('2026-09-21T04:00:00Z')), null);
});

test('expired one-time schedules are skipped after downtime', () => {
  const plan = {
    kind: 'ONCE' as const,
    run_at: new Date('2026-09-21T00:00:00Z'),
    next_run_at: '2026-09-21T00:00:00Z',
    duration_hours: 1,
  };
  assert.equal(recoverableOccurrence(plan, new Date('2026-09-21T01:00:00Z')), null);
});

test('invalid schedule times are rejected instead of silently drifting', () => {
  assert.throws(() => nextOccurrence({ kind: 'DAILY', time: '24:00' }), RangeError);
  assert.throws(() => nextOccurrence({ kind: 'WEEKLY', time: '08:00', weekday: 0 }), RangeError);
  assert.throws(() => nextOccurrence({ kind: 'ONCE', runAt: 'not-a-date' }), RangeError);
});
