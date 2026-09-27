import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateV1, migrateStep, dayKey, MIGRATED_CHALLENGE_ID } from '../js/migrate.js';
import { evaluateAttempt, isDayGreen } from '../js/rules.js';

const v1 = {
  config: {
    id: 'main', name: '100 Days', totalDays: 14, weeklyTarget: 5,
    steps: [
      { id: 'gym', name: 'Gym', mandatory: true, requiresPhoto: true, allowsNote: false },
      { id: 'journal', name: 'Journal', mandatory: false, requiresPhoto: false, allowsNote: true },
    ],
  },
  attempts: [{ id: 'a1', startDate: '2026-09-16', status: 'active', greenWeeks: 0 }],
  days: [
    { date: '2026-09-16', mandatoryStepIds: ['body', 'gym'], weight: 80, bodyPhotoId: 'pb1', steps: { gym: { done: true, photoId: 'pg1' } } },
    { date: '2026-09-17', mandatoryStepIds: ['body', 'gym'], weight: 79.5, steps: { gym: { done: true, photoId: 'pg2' } } },
    { date: '2026-09-18', mandatoryStepIds: ['body', 'gym'], steps: { journal: { note: 'hi' } } },
  ],
};

test('dayKey joins challenge id and date', () => {
  assert.equal(dayKey('c1', '2026-09-25'), 'c1|2026-09-25');
});

test('migrateStep maps v1 flags to v2 fields', () => {
  assert.deepEqual(migrateStep(v1.config.steps[0]),
    { id: 'gym', name: 'Gym', mandatory: true, photo: 'required', number: null, note: 'none' });
  assert.deepEqual(migrateStep(v1.config.steps[1]),
    { id: 'journal', name: 'Journal', mandatory: false, photo: 'none', number: null, note: 'optional' });
});

test('migrateV1 builds one challenge with body step first', () => {
  const out = migrateV1(v1);
  assert.equal(out.challenges.length, 1);
  const c = out.challenges[0];
  assert.equal(c.id, MIGRATED_CHALLENGE_ID);
  assert.equal(c.name, '100 Days');
  assert.deepEqual(c.steps.map((s) => s.id), ['body', 'gym', 'journal']);
  assert.deepEqual(c.steps[0].number, { label: 'Weight', unit: 'kg', required: true });
  assert.equal(c.steps[0].photo, 'required');
});

test('migrateV1 moves weight/photo into steps.body and re-keys days', () => {
  const { days } = migrateV1(v1);
  const d16 = days.find((d) => d.date === '2026-09-16');
  assert.equal(d16.key, 'c-main|2026-09-16');
  assert.equal(d16.challengeId, 'c-main');
  assert.deepEqual(d16.steps.body, { done: true, value: 80, photoId: 'pb1' });
  const d17 = days.find((d) => d.date === '2026-09-17');
  assert.deepEqual(d17.steps.body, { done: false, value: 79.5 });
  const d18 = days.find((d) => d.date === '2026-09-18');
  assert.equal(d18.steps.body, undefined);
  assert.deepEqual(d18.steps.journal, { note: 'hi' });
  assert.equal('weight' in d16, false);
});

test('migrateV1 tags attempts with the challenge id', () => {
  const { attempts } = migrateV1(v1);
  assert.deepEqual(attempts, [{ id: 'a1', startDate: '2026-09-16', status: 'active', greenWeeks: 0, challengeId: 'c-main' }]);
});

test('migrateV1 with no config returns empty collections', () => {
  assert.deepEqual(migrateV1({ config: undefined, attempts: [], days: [] }), { challenges: [], attempts: [], days: [] });
});

test('migrated data evaluates identically (green days, outcome, day number)', () => {
  const out = migrateV1(v1);
  const c = out.challenges[0];
  const daysMap = Object.fromEntries(out.days.map((d) => [d.date, d]));
  assert.equal(isDayGreen(daysMap['2026-09-16'], c), true);
  assert.equal(isDayGreen(daysMap['2026-09-17'], c), false);
  assert.equal(isDayGreen(daysMap['2026-09-18'], c), false);
  const r = evaluateAttempt(c, out.attempts[0], daysMap, '2026-09-25');
  assert.equal(r.outcome, 'reset');
  assert.equal(r.resetDate, '2026-09-23');
});
