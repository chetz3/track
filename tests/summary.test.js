import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDaySummary, buildDayDetails, buildPhotoProgress } from '../js/summaryModel.js';

const ch = { steps: [
  { id: 'body', name: 'Body', mandatory: true, photo: 'required', number: { label: 'Weight', unit: 'kg', required: true }, note: 'none' },
  { id: 'gym', name: 'Gym', mandatory: true, photo: 'optional', number: { label: 'Minutes', unit: '', required: false }, note: 'optional' },
  { id: 'read', name: 'Read', mandatory: false, photo: 'none', number: null, note: 'none' },
] };

test('buildDaySummary lists photos and every step in order', () => {
  const day = { date: '2026-09-25', mandatoryStepIds: ['body', 'gym'], steps: {
    body: { done: true, photoId: 'p1', value: 78.4 },
    gym: { done: true, photoId: 'p2', value: 45, note: 'legs' },
    ghost: { done: true, photoId: 'p9' },
  } };
  const s = buildDaySummary(ch, day);
  assert.deepEqual(s.photos, [
    { stepId: 'body', stepName: 'Body', photoId: 'p1' },
    { stepId: 'gym', stepName: 'Gym', photoId: 'p2' },
  ]);
  assert.deepEqual(s.items, [
    { stepId: 'body', name: 'Body', mandatory: true, complete: true, value: 'Weight: 78.4 kg', hasPhoto: true },
    { stepId: 'gym', name: 'Gym', mandatory: true, complete: true, value: 'Minutes: 45', note: 'legs', hasPhoto: true },
    { stepId: 'read', name: 'Read', mandatory: false, complete: false, hasPhoto: false },
  ]);
});

test('buildDaySummary with no day record', () => {
  const s = buildDaySummary(ch, undefined);
  assert.deepEqual(s.photos, []);
  assert.equal(s.items.every((i) => i.complete === false), true);
});

const attempt = { startDate: '2026-09-01' };

test('buildPhotoProgress picks days with a photo for the chosen step, oldest first, with a change summary', () => {
  const daysMap = {
    '2026-09-03': { date: '2026-09-03', steps: { body: { done: true, photoId: 'p3', value: 80 } } },
    '2026-09-01': { date: '2026-09-01', steps: { body: { done: true, photoId: 'p1', value: 82 } } },
    '2026-09-02': { date: '2026-09-02', steps: { gym: { done: true, photoId: 'g2' } } }, // no body photo
    '2026-09-05': { date: '2026-09-05', steps: { body: { done: true, photoId: 'p5', value: 78.4 } } },
  };
  const { tiles, change } = buildPhotoProgress(ch, daysMap, attempt, 'body', 'body');
  assert.deepEqual(tiles, [
    { date: '2026-09-01', dayNumber: 1, photoId: 'p1', value: 82, unit: 'kg' },
    { date: '2026-09-03', dayNumber: 3, photoId: 'p3', value: 80, unit: 'kg' },
    { date: '2026-09-05', dayNumber: 5, photoId: 'p5', value: 78.4, unit: 'kg' },
  ]);
  assert.deepEqual(change, { first: 82, latest: 78.4, diff: -3.6, unit: 'kg' });
});

test('buildPhotoProgress with no number step chosen: no value labels, no change summary', () => {
  const daysMap = {
    '2026-09-01': { date: '2026-09-01', steps: { body: { done: true, photoId: 'p1', value: 82 } } },
  };
  const { tiles, change } = buildPhotoProgress(ch, daysMap, attempt, 'body', null);
  assert.deepEqual(tiles, [{ date: '2026-09-01', dayNumber: 1, photoId: 'p1', value: undefined, unit: '' }]);
  assert.equal(change, null);
});

test('buildPhotoProgress: fewer than two values yields no change summary', () => {
  const daysMap = {
    '2026-09-01': { date: '2026-09-01', steps: { body: { done: true, photoId: 'p1', value: 82 } } },
    '2026-09-02': { date: '2026-09-02', steps: { body: { done: true, photoId: 'p2' } } }, // photo, no value
  };
  const { change } = buildPhotoProgress(ch, daysMap, attempt, 'body', 'body');
  assert.equal(change, null);
});

test('buildPhotoProgress with no matching photos returns an empty grid', () => {
  const { tiles, change } = buildPhotoProgress(ch, {}, attempt, 'body', 'body');
  assert.deepEqual(tiles, []);
  assert.equal(change, null);
});

const fch = { steps: [
  { id: 'food', name: 'Food', type: 'food', mandatory: true, photo: 'none', number: { label: 'Calories', unit: 'kcal' }, goal: { target: 2000, dir: 'atMost' } },
  { id: 'workout', name: 'Workout', type: 'workout', mandatory: true, photo: 'none', number: { label: 'Workout', unit: 'min' }, goal: { target: 30, dir: 'atLeast' } },
  { id: 'read', name: 'Read', mandatory: false, photo: 'none', number: null },
] };
const fday = { date: '2026-09-25', steps: {
  food: { done: true, value: 1500, note: 'ok', meals: [
    { id: 'm1', photoId: 'mp1', dish: 'Eggs', calories: 600, macros: { protein: 30, carbs: 5, fat: 40, fiber: 0 } },
    { id: 'm2', dish: '', calories: 900, macros: { protein: 40, carbs: 100, fat: 20, fiber: 8 } },
    { id: 'm3', photoId: 'mp3', dish: 'Soup', calories: 0, macros: null },
  ] },
  workout: { done: true, value: 45, sessions: [{ type: 'Run', minutes: 45, intensity: 'hard', kcal: 400 }] },
} };

test('buildDaySummary appends meal photos with captions', () => {
  const s = buildDaySummary(fch, fday);
  assert.deepEqual(s.photos, [
    { stepId: 'food', stepName: 'Food', photoId: 'mp1', caption: 'Eggs · 600 kcal' },
    { stepId: 'food', stepName: 'Food', photoId: 'mp3', caption: 'Soup · 0 kcal' },
  ]);
});

test('buildDayDetails food lists every meal plus the total', () => {
  const d = buildDayDetails(fch, fday);
  const food = d[0];
  assert.equal(food.headline, '1500 / 2000 kcal');
  assert.equal(food.complete, true);
  assert.equal(food.note, 'ok');
  assert.deepEqual(food.rows.map((r) => r.title), ['Eggs', 'Meal', 'Soup', 'Total']);
  assert.equal(food.rows[0].photoId, 'mp1');
  assert.equal(food.rows[1].photoId, undefined);
  assert.match(food.rows[0].sub, /^600 kcal · /);
  assert.match(food.rows[3].sub, /^1500 kcal · /);
});

test('buildDayDetails workout sessions', () => {
  const w = buildDayDetails(fch, fday)[1];
  assert.deepEqual(w.rows, [{ title: 'Run', sub: '45 min · hard · 400 kcal' }]);
  assert.equal(w.headline, '45 / 30 min');
});

test('buildDayDetails headline with a target and no value; step with no entry', () => {
  const d = buildDayDetails(fch, { date: 'x', steps: {}, targets: { workout: 40 } });
  assert.equal(d[1].headline, 'Target 40 min');
  assert.equal(d[1].complete, false);
  assert.deepEqual(d[2], { stepId: 'read', name: 'Read', mandatory: false, complete: false, headline: '—', rows: [] });
  assert.equal(buildDayDetails(fch, undefined).length, 3);
});
