import test from 'node:test';
import assert from 'node:assert/strict';
import { validateV2, toV2 } from '../js/backup.js';

function validStep(overrides = {}) {
  return {
    id: 'body', name: 'Body check-in', mandatory: true, photo: 'required',
    number: { label: 'Weight', unit: 'kg', required: true }, note: 'none',
    ...overrides,
  };
}

function validChallenge(overrides = {}) {
  return {
    id: 'c-main', name: '100 Days', totalDays: 100, weeklyTarget: 5,
    steps: [validStep(), validStep({ id: 'read', name: 'Read', mandatory: false, photo: 'none', number: null, note: 'optional' })],
    createdAt: 0,
    ...overrides,
  };
}

function validBackup(overrides = {}) {
  return {
    version: 2,
    challenges: [validChallenge()],
    attempts: [{ id: 'a1', challengeId: 'c-main', startDate: '2026-09-16', status: 'active', greenWeeks: 0 }],
    days: [
      { key: 'c-main|2026-09-16', challengeId: 'c-main', date: '2026-09-16', mandatoryStepIds: ['body'], steps: { body: { done: true, photoId: 'p1', value: 78 } } },
    ],
    photos: [],
    ...overrides,
  };
}

test('validateV2: a well-formed v2 backup passes', () => {
  assert.doesNotThrow(() => validateV2(validBackup()));
});

test('validateV2: an HTML string in totalDays is rejected', () => {
  const b = validBackup({ challenges: [validChallenge({ totalDays: '<img src=x onerror=alert(1)>' })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: totalDays: 1e9 is rejected (would hang evaluateAttempt)', () => {
  const b = validBackup({ challenges: [validChallenge({ totalDays: 1e9 })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: steps: [null] is rejected (would crash loadAll)', () => {
  const b = validBackup({ challenges: [validChallenge({ steps: [null] })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: a bad photo enum value is rejected', () => {
  const b = validBackup({ challenges: [validChallenge({ steps: [validStep({ photo: 'sometimes' })] })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: weeklyTarget out of range (8) is rejected', () => {
  const b = validBackup({ challenges: [validChallenge({ weeklyTarget: 8 })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: a day whose steps is null is rejected', () => {
  const b = validBackup({ days: [{ key: 'c-main|2026-09-16', challengeId: 'c-main', date: '2026-09-16', mandatoryStepIds: null, steps: null }] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: a day whose steps is an array is rejected', () => {
  const b = validBackup({ days: [{ key: 'c-main|2026-09-16', challengeId: 'c-main', date: '2026-09-16', mandatoryStepIds: null, steps: [] }] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: a negative attempt.greenWeeks is rejected', () => {
  const b = validBackup({ attempts: [{ id: 'a1', challengeId: 'c-main', startDate: '2026-09-16', status: 'active', greenWeeks: -1 }] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

test('validateV2: a step missing note is rejected (both migrate.js and the step editor always set it)', () => {
  const step = validStep();
  delete step.note;
  const b = validBackup({ challenges: [validChallenge({ steps: [step] })] });
  assert.throws(() => validateV2(b), /Invalid backup file/);
});

// --- v1 -> v2 conversion still passes validation ---

const v1Backup = {
  version: 1,
  config: [{
    id: 'main', name: '100 Days', totalDays: 14, weeklyTarget: 5,
    steps: [
      { id: 'gym', name: 'Gym', mandatory: true, requiresPhoto: true, allowsNote: false },
      { id: 'journal', name: 'Journal', mandatory: false, requiresPhoto: false, allowsNote: true },
    ],
  }],
  attempts: [{ id: 'a1', startDate: '2026-09-16', status: 'active', greenWeeks: 0 }],
  days: [
    { date: '2026-09-16', mandatoryStepIds: ['body', 'gym'], weight: 80, bodyPhotoId: 'pb1', steps: { gym: { done: true, photoId: 'pg1' } } },
    { date: '2026-09-17', mandatoryStepIds: ['body', 'gym'], weight: 79.5, steps: { gym: { done: true, photoId: 'pg2' } } },
  ],
  photos: [],
};

test('toV2: a v1-shaped backup converts to a v2 shape that passes validateV2', () => {
  const v2 = toV2(v1Backup);
  assert.equal(v2.version, 2);
  assert.doesNotThrow(() => validateV2(v2));
});

test('toV2: a v2 backup passes through unchanged', () => {
  const b = validBackup();
  assert.equal(toV2(b), b);
});

test('toV2: an unrecognisable backup shape throws', () => {
  assert.throws(() => toV2({ foo: 'bar' }), /Invalid backup file/);
});
