import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mealTimeLabel, sortMealsByAt, isPlannableDate, normDish, mergeAddToExisting,
  clearUnlogged, replaceKeepingLogged, copyPlaceholders, sortPlanned, plannedKcal,
} from '../js/planLogic.js';
import { buildDayDetails } from '../js/summaryModel.js';

test('isPlannableDate: today and today + 6 allowed, + 7 and past rejected', () => {
  assert.equal(isPlannableDate('2026-10-10', '2026-10-10'), true);
  assert.equal(isPlannableDate('2026-10-16', '2026-10-10'), true);
  assert.equal(isPlannableDate('2026-10-17', '2026-10-10'), false);
  assert.equal(isPlannableDate('2026-10-09', '2026-10-10'), false);
  assert.equal(isPlannableDate(undefined, '2026-10-10'), false);
});

test('mealTimeLabel: empty without at, am/pm label with at', () => {
  assert.equal(mealTimeLabel(undefined), '');
  assert.equal(mealTimeLabel(null), '');
  const label = mealTimeLabel(new Date(2026, 9, 10, 8, 45).getTime());
  assert.match(label, /^\d{1,2}[:.]45/);
  assert.doesNotMatch(label, /[AP]M/);
});

test('sortMealsByAt: ascending by at, untimed keep stored order at the end, input untouched', () => {
  const meals = [{ id: 'a' }, { id: 'b', at: 300 }, { id: 'c' }, { id: 'd', at: 100 }];
  assert.deepEqual(sortMealsByAt(meals).map((m) => m.id), ['d', 'b', 'a', 'c']);
  assert.deepEqual(meals.map((m) => m.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortMealsByAt(undefined), []);
});

test('normDish ignores case, punctuation and spacing', () => {
  assert.equal(normDish('  Masala  Dosa! '), 'masala dosa');
  assert.equal(normDish(null), '');
});

test('mergeAddToExisting appends but skips the same slot + dish', () => {
  const existing = [{ id: '1', slot: 'Lunch', dish: 'Rice & dal' }];
  const incoming = [
    { id: '2', slot: 'lunch', dish: 'rice and dal' },
    { id: '3', slot: 'Lunch', dish: 'rice  dal' },
    { id: '4', slot: 'Dinner', dish: 'Rice dal' },
    { id: '5', slot: 'Dinner', dish: 'Rice, dal' },
  ];
  const r = mergeAddToExisting(existing, incoming);
  assert.deepEqual(r.list.map((p) => p.id), ['1', '2', '4']);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 2);
});

test('replaceKeepingLogged drops unlogged placeholders only, then appends', () => {
  const planned = [{ id: 'p1', slot: 'Lunch', dish: 'A' }, { id: 'p2', slot: 'Dinner', dish: 'B' }];
  const meals = [{ id: 'm1', plannedId: 'p2', calories: 400 }];
  assert.deepEqual(clearUnlogged(planned, meals).map((p) => p.id), ['p2']);
  const out = replaceKeepingLogged(planned, meals, [{ id: 'n1' }, { id: 'n2' }]);
  assert.deepEqual(out.map((p) => p.id), ['p2', 'n1', 'n2']);
});

test('copyPlaceholders gives fresh ids; sortPlanned and plannedKcal', () => {
  let n = 0;
  const copy = copyPlaceholders([{ id: 'x', dish: 'A', time: '13:00', kcal: 300 }, { id: 'y', dish: 'B', time: '08:00', kcal: 200 }], () => `new${++n}`);
  assert.deepEqual(copy.map((p) => p.id), ['new1', 'new2']);
  assert.deepEqual(sortPlanned(copy).map((p) => p.dish), ['B', 'A']);
  assert.equal(plannedKcal(copy), 500);
});

test('buildDayDetails: food rows are time-ordered with the time in the title', () => {
  const ch = { steps: [{ id: 'f', name: 'Food', type: 'food', mandatory: true, photo: 'none', number: { label: 'Calories', unit: 'kcal', required: false }, note: 'none' }] };
  const t = new Date(2026, 9, 10, 8, 45).getTime();
  const day = { date: '2026-10-10', steps: { f: { meals: [
    { id: 'm0', dish: 'Old', calories: 100 },
    { id: 'm2', dish: 'Dinner', calories: 300, at: t + 3600000 * 10 },
    { id: 'm1', dish: 'Dosa', calories: 200, at: t },
  ] } } };
  const rows = buildDayDetails(ch, day)[0].rows;
  assert.match(rows[0].title, / · Dosa$/);
  assert.match(rows[1].title, / · Dinner$/);
  assert.equal(rows[2].title, 'Old');
});

test('replaceKeepingLogged skips incoming items for a slot that is already logged', () => {
  const planned = [{ id: 'a', slot: 'Lunch', dish: 'Rice' }, { id: 'b', slot: 'Dinner', dish: 'Roti' }];
  const meals = [{ id: 'm1', plannedId: 'a', calories: 500 }];
  const out = replaceKeepingLogged(planned, meals, [{ id: 'x', slot: 'Lunch', dish: 'Ragi mudde' }, { id: 'y', slot: 'Dinner', dish: 'Dosa' }]);
  assert.deepEqual(out.map((p) => p.id), ['a', 'y']);
});
