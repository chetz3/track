import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDaySummary, buildPhotoProgress } from '../js/summaryModel.js';

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
