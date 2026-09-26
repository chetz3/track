import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDaySummary } from '../js/summaryModel.js';

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
