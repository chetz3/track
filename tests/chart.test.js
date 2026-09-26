import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNumberSeries, trendDomain, ringStats } from '../js/chartMath.js';

const ch = {
  totalDays: 30, weeklyTarget: 5,
  steps: [
    { id: 'body', name: 'Body', mandatory: true, photo: 'required', number: { label: 'Weight', unit: 'kg', required: true }, note: 'none' },
    { id: 'read', name: 'Read', mandatory: true, photo: 'none', number: null, note: 'none' },
  ],
};

test('collectNumberSeries: one series per number step, sorted, finite only', () => {
  const days = {
    '2026-09-26': { date: '2026-09-26', steps: { body: { value: 79 } } },
    '2026-09-25': { date: '2026-09-25', steps: { body: { value: 80 } } },
    '2026-09-27': { date: '2026-09-27', steps: { body: { value: NaN } } },
  };
  const s = collectNumberSeries(ch, days);
  assert.equal(s.length, 1);
  assert.equal(s[0].step.id, 'body');
  assert.deepEqual(s[0].points, [{ date: '2026-09-25', value: 80 }, { date: '2026-09-26', value: 79 }]);
});

test('trendDomain handles 0, 1 and many values without NaN', () => {
  assert.deepEqual(trendDomain([]), [0, 1]);
  assert.deepEqual(trendDomain([80]), [76, 84]);
  assert.deepEqual(trendDomain([0]), [-1, 1]);
  const [lo, hi] = trendDomain([70, 80]);
  assert.equal(lo, 68.5); assert.equal(hi, 81.5);
});

test('ringStats derives streak and weeks', () => {
  const evaluation = { currentDayNumber: 9, weeks: [{ status: 'green' }, { status: 'pending' }] };
  assert.deepEqual(ringStats(ch, evaluation, { startDate: '2026-09-17' }, '2026-09-25'),
    { day: 9, totalDays: 30, weeksPassed: 1, totalWeeks: 5, streakDays: 9 });
  assert.equal(ringStats(ch, evaluation, { startDate: '2026-09-30' }, '2026-09-25').streakDays, 0);
});
