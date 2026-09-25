import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateStreak } from '../server/streak.js';

test('连续完成按北京时间计算，今天没有完成时保留昨天的连续天数', () => {
  const now = new Date('2026-09-24T01:00:00.000Z'); // 09-24 09:00 in Beijing
  const result = calculateStreak(['2026-09-23', '2026-09-22', '2026-09-20'], now);
  assert.equal(result.current, 2);
  assert.equal(result.best, 2);
  assert.equal(result.todayComplete, false);
  assert.equal(result.lastCompletedDate, '2026-09-23');
});

test('双方每日各有已验收任务后才形成连续日期，空档会重置当前连续天数', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const result = calculateStreak(['2026-09-24', '2026-09-22', '2026-09-21'], now);
  assert.equal(result.current, 1);
  assert.equal(result.best, 2);
  assert.deepEqual(result.completedDates, ['2026-09-24', '2026-09-22', '2026-09-21']);
});
