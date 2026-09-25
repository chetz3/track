import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_STEP_ID,
  addDays,
  diffDays,
  isEditable,
  isDayGreen,
  dayStatus,
  weekStatus,
  evaluateAttempt,
} from '../js/rules.js';

const TODAY = '2026-09-25';

function config(overrides = {}) {
  return {
    totalDays: 100,
    weeklyTarget: 5,
    steps: [
      { id: 'stepA', name: 'Read', mandatory: true, requiresPhoto: false, allowsNote: false },
      { id: 'stepB', name: 'Meditate', mandatory: false, requiresPhoto: false, allowsNote: true },
      { id: 'stepC', name: 'Gym', mandatory: true, requiresPhoto: true, allowsNote: false },
    ],
    ...overrides,
  };
}

function greenDay(date, overrides = {}) {
  return {
    date,
    mandatoryStepIds: [BODY_STEP_ID, 'stepA', 'stepC'],
    weight: 70,
    bodyPhotoId: 'photo-body',
    steps: {
      stepA: { done: true },
      stepC: { done: true, photoId: 'photo-c' },
    },
    ...overrides,
  };
}

// --- date helpers ---

test('addDays adds and subtracts across month/year boundaries', () => {
  assert.equal(addDays('2026-09-25', 1), '2026-09-26');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-09-25', -1), '2026-09-24');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('diffDays computes whole-day differences without UTC drift', () => {
  assert.equal(diffDays('2026-09-25', '2026-09-25'), 0);
  assert.equal(diffDays('2026-09-25', '2026-09-26'), 1);
  assert.equal(diffDays('2026-09-20', '2026-09-25'), 5);
  assert.equal(diffDays('2026-09-25', '2026-09-20'), -5);
});

// --- isEditable ---

test('isEditable: only today and yesterday are editable', () => {
  assert.equal(isEditable(TODAY, TODAY), true);
  assert.equal(isEditable(addDays(TODAY, -1), TODAY), true);
  assert.equal(isEditable(addDays(TODAY, -2), TODAY), false);
  assert.equal(isEditable(addDays(TODAY, 1), TODAY), false);
});

// --- isDayGreen ---

test('isDayGreen: true when all mandatory steps and body check-in are complete', () => {
  assert.equal(isDayGreen(greenDay(TODAY), config()), true);
});

test('isDayGreen: false when weight is missing', () => {
  const day = greenDay(TODAY, { weight: undefined });
  assert.equal(isDayGreen(day, config()), false);
});

test('isDayGreen: false when body photo is missing', () => {
  const day = greenDay(TODAY, { bodyPhotoId: undefined });
  assert.equal(isDayGreen(day, config()), false);
});

test('isDayGreen: optional (non-mandatory) steps never affect colour', () => {
  const day = greenDay(TODAY); // stepB is optional and never touched
  assert.equal(isDayGreen(day, config()), true);
});

test('isDayGreen: false when a photo-required mandatory step has no photo', () => {
  const day = greenDay(TODAY, { steps: { stepA: { done: true }, stepC: { done: true } } });
  assert.equal(isDayGreen(day, config()), false);
});

test('isDayGreen: false when a mandatory step is not done', () => {
  const day = greenDay(TODAY, { steps: { stepA: { done: false }, stepC: { done: true, photoId: 'x' } } });
  assert.equal(isDayGreen(day, config()), false);
});

test('isDayGreen: false for missing/undefined day', () => {
  assert.equal(isDayGreen(undefined, config()), false);
});

test('isDayGreen: step-change snapshot respected — new mandatory steps added later do not retroactively affect past days', () => {
  const day = greenDay(TODAY); // snapshot only has body, stepA, stepC
  const laterConfig = config({
    steps: [
      ...config().steps,
      { id: 'stepD', name: 'New mandatory step', mandatory: true, requiresPhoto: false, allowsNote: false },
    ],
  });
  assert.equal(isDayGreen(day, laterConfig), true);
});

// --- dayStatus ---

test('dayStatus: future date is "future"', () => {
  const status = dayStatus(addDays(TODAY, 1), undefined, config(), TODAY);
  assert.equal(status, 'future');
});

test('dayStatus: a green day is "green"', () => {
  const status = dayStatus(TODAY, greenDay(TODAY), config(), TODAY);
  assert.equal(status, 'green');
});

test('dayStatus: an incomplete editable day (today) is "pending"', () => {
  const status = dayStatus(TODAY, undefined, config(), TODAY);
  assert.equal(status, 'pending');
});

test('dayStatus: an incomplete locked (old) day is "red"', () => {
  const oldDate = addDays(TODAY, -10);
  const status = dayStatus(oldDate, undefined, config(), TODAY);
  assert.equal(status, 'red');
});

// --- weekStatus ---

test('weekStatus: "pending" when the last day of the week is not yet locked', () => {
  const statuses = ['green', 'green', 'green', 'green', 'green', 'pending', 'future'];
  assert.equal(weekStatus(statuses, 5), 'pending');
});

test('weekStatus: "green" when green day count meets the weekly target exactly', () => {
  const statuses = ['green', 'green', 'green', 'green', 'green', 'red', 'red'];
  assert.equal(weekStatus(statuses, 5), 'green');
});

test('weekStatus: "red" when green day count is one below the weekly target', () => {
  const statuses = ['green', 'green', 'green', 'green', 'red', 'red', 'red'];
  assert.equal(weekStatus(statuses, 5), 'red');
});

test('weekStatus: partial final week uses min(target, daysInWeek) as the threshold', () => {
  // Only 4 days in the final week, target is 5 -> threshold becomes 4.
  const statuses = ['green', 'green', 'green', 'green'];
  assert.equal(weekStatus(statuses, 5), 'green');
  const statusesFail = ['green', 'green', 'green', 'red'];
  assert.equal(weekStatus(statusesFail, 5), 'red');
});

// --- evaluateAttempt ---

test('evaluateAttempt: active attempt still in its first, unfinished week', () => {
  const start = addDays(TODAY, -2); // day 1, 2 (today) logged, day 3 not reached
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const days = {};
  const result = evaluateAttempt(config({ totalDays: 100, weeklyTarget: 5 }), attempt, days, TODAY);
  assert.equal(result.outcome, 'active');
  assert.equal(result.currentDayNumber, 3);
  assert.equal(result.weeks.length, 1);
  assert.equal(result.weeks[0].status, 'pending');
});

test('evaluateAttempt: a red week resets the attempt starting the day after the failed week ended', () => {
  const start = addDays(TODAY, -10); // week 1 (days 1-7) fully in the past and locked
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const days = {};
  // Only 3 green days in week 1 (need 5) -> red week.
  days[addDays(start, 0)] = greenDay(addDays(start, 0));
  days[addDays(start, 1)] = greenDay(addDays(start, 1));
  days[addDays(start, 2)] = greenDay(addDays(start, 2));
  const cfg = config({ totalDays: 100, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, days, TODAY);
  assert.equal(result.outcome, 'reset');
  assert.equal(result.resetDate, addDays(start, 7));
  assert.equal(result.weeks[0].status, 'red');
});

test('evaluateAttempt: a green week continues the attempt', () => {
  const start = addDays(TODAY, -10);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const days = {};
  for (let i = 0; i < 5; i++) days[addDays(start, i)] = greenDay(addDays(start, i));
  const cfg = config({ totalDays: 100, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, days, TODAY);
  assert.equal(result.outcome, 'active');
  assert.equal(result.weeks[0].status, 'green');
});

test('evaluateAttempt: challenge completes when day N is reached with every week green', () => {
  const start = addDays(TODAY, -9); // totalDays 7, so all 7 days are locked (9, 8 days ago etc.)
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const days = {};
  for (let i = 0; i < 7; i++) days[addDays(start, i)] = greenDay(addDays(start, i));
  const cfg = config({ totalDays: 7, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, days, TODAY);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.weeks.length, 1);
  assert.equal(result.currentDayNumber, 7);
});

test('evaluateAttempt: currentDayNumber never exceeds totalDays', () => {
  const start = addDays(TODAY, -50);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const cfg = config({ totalDays: 7, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, {}, TODAY);
  assert.equal(result.currentDayNumber, 7);
});

test('evaluateAttempt: a frozen (already-finalised) week stays green even after weeklyTarget is raised', () => {
  const start = addDays(TODAY, -10);
  // Week 1 is frozen green (attempt.greenWeeks = 1); nothing is logged for it,
  // which would score red under any target if it were re-scored.
  const attempt = { id: 'a1', startDate: start, status: 'active', greenWeeks: 1 };
  const days = {};
  const cfg = config({ totalDays: 100, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, days, TODAY);
  assert.equal(result.weeks[0].status, 'green');
  assert.equal(result.outcome, 'active');
});

test('evaluateAttempt: a later, non-frozen week is still scored against the current weeklyTarget', () => {
  const start = addDays(TODAY, -17); // week 1 and week 2 both fully locked
  const attempt = { id: 'a1', startDate: start, status: 'active', greenWeeks: 1 };
  const days = {};
  // Week 2: only 3 of 7 days green; weeklyTarget is now 5 -> should be red.
  for (let i = 7; i < 10; i++) days[addDays(start, i)] = greenDay(addDays(start, i));
  const cfg = config({ totalDays: 100, weeklyTarget: 5 });
  const result = evaluateAttempt(cfg, attempt, days, TODAY);
  assert.equal(result.weeks[0].status, 'green'); // still frozen
  assert.equal(result.weeks[1].status, 'red');
  assert.equal(result.outcome, 'reset');
});
