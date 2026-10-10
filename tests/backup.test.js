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

// --- Plateau Coach fields (R2): kept when well-formed, dropped when not ---

const PROFILE = { sex: 'male', age: 40, heightCm: 180, startWeightKg: 90, targetWeightKg: 80 };
const HEALTH = {
  conditions: ['pcos', 'hypothyroid'], meds_flags: ['steroids'], sensitivities: 'dairy', meds: 'thyroxine',
  waistCm: 98, waistDate: '2026-10-01', labs: { hba1c: 5.9, tsh: 3.1, date: '2026-09-20' }, shareWithAi: true,
};
const REVIEW = {
  date: '2026-10-10', verdict: 'real_plateau', summary: 's', maintenance: { action: 'diet_break', new_kcal: 2000, duration_days: 10, why: 'w' },
  useInSuggestions: true, applied: { action: 'diet_break', field: 'kcal', from: 1700, to: 2000, date: '2026-10-10', untilDate: '2026-10-20' },
};

function coachBackup(challengeExtra = {}, foodEntry = {}) {
  return validBackup({
    challenges: [validChallenge({ category: 'fitness', profile: { ...PROFILE }, ...challengeExtra })],
    days: [{
      key: 'c-main|2026-09-16', challengeId: 'c-main', date: '2026-09-16', mandatoryStepIds: ['body'],
      steps: { body: { done: true, value: 78 }, food: { meals: [], ...foodEntry } },
    }],
  });
}

function roundTrip(b) {
  const copy = toV2(JSON.parse(JSON.stringify(b)));
  validateV2(copy);
  return copy;
}

test('backup: profile.health, plateauReview, mealPlanHistory and entry.feel survive a round trip', () => {
  const history = [{ date: '2026-10-09', dishes: ['Idli', 'Dosa'] }];
  const out = roundTrip(coachBackup(
    { plateauReview: REVIEW, mealPlanHistory: history, profile: { ...PROFILE, health: HEALTH } },
    { feel: ['bloated', 'cravings'] },
  ));
  const c = out.challenges[0];
  assert.deepEqual(c.profile.health, HEALTH);
  assert.deepEqual(c.plateauReview, REVIEW);
  assert.deepEqual(c.mealPlanHistory, history);
  assert.deepEqual(out.days[0].steps.food.feel, ['bloated', 'cravings']);
});

test('backup: wrong-typed coach fields are dropped without rejecting the backup', () => {
  const out = roundTrip(coachBackup(
    { plateauReview: 'oops', mealPlanHistory: { a: 1 }, profile: { ...PROFILE, health: 'sick' } },
    { feel: 'bloated' },
  ));
  const c = out.challenges[0];
  assert.equal('health' in c.profile, false);
  assert.equal('plateauReview' in c, false);
  assert.equal('mealPlanHistory' in c, false);
  assert.equal('feel' in out.days[0].steps.food, false);
});

test('backup: a malformed plateauReview.applied is reset to null, bad feel items are filtered', () => {
  const out = roundTrip(coachBackup({ plateauReview: { ...REVIEW, applied: 5 } }, { feel: ['bloated', 7, null] }));
  assert.equal(out.challenges[0].plateauReview.applied, null);
  assert.deepEqual(out.days[0].steps.food.feel, ['bloated']);
});

test('backup: junk inside profile.health is cleaned (unknown tags, non-numeric labs)', () => {
  const out = roundTrip(coachBackup({
    profile: { ...PROFILE, health: { conditions: ['pcos', '<img>'], labs: { hba1c: 'x', tsh: 3 }, waistCm: 'big', shareWithAi: 'yes' } },
  }));
  assert.deepEqual(out.challenges[0].profile.health, { conditions: ['pcos'], labs: { tsh: 3 } });
});
