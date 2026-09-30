import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bmr, tdee, calorieTarget, effectiveWeightKg, goalPlan, meetsGoal, workoutBurnKcal, waterTargetL,
  presetSteps, baseTargets, targetFor, makeTypedStep, dirLabel, latestBodyWeightKg, macroTargets,
  STEP_TYPES, MET, INTENSITY_MULT,
} from '../js/fitness.js';
import { evaluateAttempt, addDays } from '../js/rules.js';
import { validateV2 } from '../js/backup.js';

const TODAY = '2026-09-25';

// --- BMR / TDEE / calorieTarget ---

test('bmr/tdee/calorieTarget: male, lose', () => {
  const profile = { sex: 'male', age: 30, heightCm: 180, startWeightKg: 90, activity: 'sedentary', aim: 'lose' };
  assert.equal(bmr(profile), 1880);
  assert.equal(tdee(profile), 2256);
  assert.deepEqual(calorieTarget(profile), { target: 1760, dir: 'atMost' });
});

test('calorieTarget: female, lose, hits the 1200 floor', () => {
  const profile = { sex: 'female', age: 70, heightCm: 150, startWeightKg: 40, activity: 'sedentary', aim: 'lose' };
  assert.equal(bmr(profile), 826.5);
  assert.deepEqual(calorieTarget(profile), { target: 1200, dir: 'atMost' });
});

test('calorieTarget: maintain uses a near (±10%) direction', () => {
  const profile = { sex: 'female', age: 25, heightCm: 165, startWeightKg: 60, activity: 'light', aim: 'maintain' };
  assert.deepEqual(calorieTarget(profile), { target: 1850, dir: 'near' });
});

test('calorieTarget: gain adds 300 and is at-least', () => {
  const profile = { sex: 'male', age: 22, heightCm: 175, startWeightKg: 65, activity: 'moderate', aim: 'gain' };
  // moderate is capped at the light factor: workouts are counted separately.
  assert.deepEqual(calorieTarget(profile), { target: 2550, dir: 'atLeast' });
});

test('calorieTarget: BMI ≥ 30 uses adjusted weight and a 20% deficit', () => {
  const profile = { sex: 'male', age: 30, heightCm: 180, startWeightKg: 129, activity: 'active', aim: 'lose' };
  assert.equal(Math.round(effectiveWeightKg(profile)), 97);
  assert.deepEqual(calorieTarget(profile), { target: 2140, dir: 'atMost' });
});

test('calorieTarget: male floor is 1500', () => {
  const profile = { sex: 'male', age: 80, heightCm: 160, startWeightKg: 50, activity: 'sedentary', aim: 'lose' };
  const { target, dir } = calorieTarget(profile);
  assert.equal(dir, 'atMost');
  assert.ok(target >= 1500);
});

test('waterTargetL: 35 ml per kg, rounded to 1 decimal', () => {
  assert.equal(waterTargetL(80), 2.8);
  assert.equal(waterTargetL(57), 2);
});

// --- macroTargets ---

test('macroTargets: protein from weight, fat/carbs from calories, fiber floored at 25', () => {
  const profile = { sex: 'male', age: 30, heightCm: 180, startWeightKg: 90, activity: 'sedentary', aim: 'lose' };
  assert.deepEqual(macroTargets(profile, 1760), {
    protein: { target: 144, dir: 'atLeast' },
    fiber: { target: 25, dir: 'atLeast' },
    carbs: { target: 186, dir: 'atMost' },
    fat: { target: 49, dir: 'atMost' },
  });
});

test('macroTargets: fiber scales with calories once above the 25 g floor', () => {
  const profile = { sex: 'female', age: 25, heightCm: 165, startWeightKg: 60, activity: 'light', aim: 'maintain' };
  assert.equal(macroTargets(profile, 3000).fiber.target, 42);
});

// --- meetsGoal ---

test('meetsGoal: atLeast', () => {
  assert.equal(meetsGoal(8500, 8000, 'atLeast'), true);
  assert.equal(meetsGoal(7000, 8000, 'atLeast'), false);
  assert.equal(meetsGoal(8000, 8000, 'atLeast'), true);
});

test('meetsGoal: atMost', () => {
  assert.equal(meetsGoal(1800, 2000, 'atMost'), true);
  assert.equal(meetsGoal(2500, 2000, 'atMost'), false);
  assert.equal(meetsGoal(2000, 2000, 'atMost'), true);
});

test('meetsGoal: near is within ±10%', () => {
  assert.equal(meetsGoal(2050, 2000, 'near'), true);
  assert.equal(meetsGoal(1950, 2000, 'near'), true);
  assert.equal(meetsGoal(2300, 2000, 'near'), false);
});

test('meetsGoal: value must be a finite number greater than 0', () => {
  assert.equal(meetsGoal(0, 10, 'atLeast'), false);
  assert.equal(meetsGoal(-5, 10, 'atLeast'), false);
  assert.equal(meetsGoal(NaN, 10, 'atLeast'), false);
  assert.equal(meetsGoal(undefined, 10, 'atLeast'), false);
});

// --- workout burn (MET) ---

test('workoutBurnKcal: MET x intensity x kg x minutes/60', () => {
  assert.equal(workoutBurnKcal({ type: 'Run', minutes: 30, intensity: 'hard', kg: 70 }), 429);
  assert.equal(workoutBurnKcal({ type: 'Walk', minutes: 60, intensity: 'light', kg: 60 }), 168);
});

test('workoutBurnKcal: unknown type/intensity fall back sanely', () => {
  const known = workoutBurnKcal({ type: 'Other', minutes: 30, intensity: 'moderate', kg: 70 });
  const unknown = workoutBurnKcal({ type: 'Dance', minutes: 30, intensity: 'ultra', kg: 70 });
  assert.equal(unknown, known);
});

test('MET/INTENSITY_MULT cover the spec\'d values', () => {
  assert.deepEqual(MET, { Walk: 3.5, Run: 9.8, Gym: 5, Yoga: 2.5, Cycling: 7.5, Sports: 7, Other: 4 });
  assert.deepEqual(INTENSITY_MULT, { light: 0.8, moderate: 1, hard: 1.25 });
});

// --- latestBodyWeightKg ---

test('latestBodyWeightKg: falls back to profile.startWeightKg with no logged weight', () => {
  const challenge = { steps: [{ id: 'body', type: 'body' }] };
  assert.equal(latestBodyWeightKg(challenge, {}, { startWeightKg: 72 }), 72);
});

test('latestBodyWeightKg: picks the most recent logged value', () => {
  const challenge = { steps: [{ id: 'body', type: 'body' }] };
  const daysMap = {
    '2026-09-20': { steps: { body: { value: 80 } } },
    '2026-09-22': { steps: { body: { value: 78.5 } } },
    '2026-09-21': { steps: { body: { value: 79 } } },
  };
  assert.equal(latestBodyWeightKg(challenge, daysMap, { startWeightKg: 90 }), 78.5);
});

// --- presetSteps / makeTypedStep / baseTargets / targetFor ---

function profile(overrides = {}) {
  return { sex: 'male', age: 30, heightCm: 180, startWeightKg: 80, targetWeightKg: 75, activity: 'sedentary', aim: 'lose', ...overrides };
}

test('presetSteps: returns Food, Workout, Steps, Water, Body, Sleep — mandatory except Body', () => {
  const steps = presetSteps(profile());
  assert.deepEqual(steps.map((s) => s.type), STEP_TYPES);
  assert.deepEqual(steps.map((s) => s.mandatory), [true, true, true, true, false, true]);
  const [food, workout, stepsStep, water, body, sleep] = steps;
  assert.equal(food.number.label, 'Calories');
  assert.equal(food.number.unit, 'kcal');
  assert.ok(food.goal.target > 0);
  assert.deepEqual(food.macros, macroTargets(profile(), food.goal.target));
  assert.deepEqual(workout.goal, { target: 30, dir: 'atLeast' });
  assert.deepEqual(stepsStep.goal, { target: 8000, dir: 'atLeast' });
  assert.equal(water.goal.dir, 'atLeast');
  assert.equal(water.goal.target, waterTargetL(80));
  assert.equal(body.goal, null);
  assert.equal(body.number.showDiff, true);
  assert.deepEqual(sleep.goal, { target: 7.5, dir: 'atLeast' });
  // Every typed step keeps the shape backup/stats already expect.
  // Body is picture + weight: photo optional, weight required to complete.
  for (const s of steps) {
    const isBody = s.type === 'body';
    assert.equal(s.photo, isBody ? 'optional' : 'none');
    assert.equal(s.note, 'none');
    assert.equal(s.number.required, isBody);
  }
});

test('makeTypedStep: unknown type throws', () => {
  assert.throws(() => makeTypedStep('bogus', { id: 'x', name: 'X', mandatory: true, goal: null }));
});

test('dirLabel: maps each direction to its display text', () => {
  assert.equal(dirLabel('atLeast'), 'at least');
  assert.equal(dirLabel('atMost'), 'at most');
  assert.equal(dirLabel('near'), 'within ±10%');
});

test('baseTargets: one entry per goal-bearing step, keyed by step id', () => {
  const steps = presetSteps(profile());
  const targets = baseTargets({ steps });
  assert.equal(Object.keys(targets).length, 5); // every type but Body
  assert.equal(targets.steps, 8000);
  assert.equal('body' in targets, false);
});

test('targetFor: day snapshot wins, else the step\'s base goal, else null', () => {
  const step = { id: 'steps', goal: { target: 8000, dir: 'atLeast' } };
  assert.equal(targetFor({ targets: { steps: 9000 } }, step), 9000);
  assert.equal(targetFor({ targets: {} }, step), 8000);
  assert.equal(targetFor(undefined, step), 8000);
  assert.equal(targetFor(undefined, { id: 'custom', goal: null }), null);
});

// --- hard daily reset (fitness challenges) — see rules.js's evaluateAttempt ---

function fitnessChallenge(overrides = {}) {
  return {
    id: 'c1', name: 'Fit', category: 'fitness', totalDays: 100, weeklyTarget: 7,
    steps: [{ id: 's', name: 'Step', mandatory: true, photo: 'none', number: null, note: 'none' }],
    ...overrides,
  };
}

function customChallenge(overrides = {}) {
  return {
    id: 'c1', name: 'Custom', totalDays: 100, weeklyTarget: 5,
    steps: [{ id: 's', name: 'Step', mandatory: true, photo: 'none', number: null, note: 'none' }],
    ...overrides,
  };
}

function doneDay(date) {
  return { key: `c1|${date}`, challengeId: 'c1', date, mandatoryStepIds: ['s'], steps: { s: { done: true } } };
}

test('fitness: a single locked red day resets immediately, without waiting for the week to end', () => {
  const start = addDays(TODAY, -10);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  // day 1 green, day 2 has no record at all -> red (locked, nothing logged).
  const days = { [addDays(start, 0)]: doneDay(addDays(start, 0)) };
  const result = evaluateAttempt(fitnessChallenge(), attempt, days, TODAY);
  assert.equal(result.outcome, 'reset');
  assert.equal(result.resetDate, addDays(start, 2));
  assert.equal(result.weeks.length, 1);
  assert.deepEqual(result.weeks[0].dayStatuses, ['green', 'red']);
  assert.equal(result.weeks[0].status, 'red');
});

test('fitness 5 of 7: two red days in a week are allowed, the third resets immediately', () => {
  const start = addDays(TODAY, -10);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  // Pattern for days 1-7: G R G R G G G -> week passes with 5 green.
  const days = {};
  for (const i of [0, 2, 4, 5, 6]) days[addDays(start, i)] = doneDay(addDays(start, i));
  const ok = evaluateAttempt(fitnessChallenge({ totalDays: 7, weeklyTarget: 5 }), attempt, days, TODAY);
  assert.equal(ok.outcome, 'complete');
  assert.equal(ok.weeks[0].status, 'green');

  // Day 5 red too -> third red day, reset right there.
  delete days[addDays(start, 4)];
  const bad = evaluateAttempt(fitnessChallenge({ totalDays: 7, weeklyTarget: 5 }), attempt, days, TODAY);
  assert.equal(bad.outcome, 'reset');
  assert.equal(bad.resetDate, addDays(start, 5));
  assert.deepEqual(bad.weeks[0].dayStatuses, ['green', 'red', 'green', 'red', 'red']);
});

test('fitness: yesterday staying incomplete does not count yet (still editable)', () => {
  const start = addDays(TODAY, -1); // day 1 = yesterday, day 2 = today
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const result = evaluateAttempt(fitnessChallenge(), attempt, {}, TODAY);
  assert.equal(result.outcome, 'active');
});

test('fitness: a fully green week completes the challenge (weeks are still grouped for display)', () => {
  const start = addDays(TODAY, -10);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const days = {};
  for (let i = 0; i < 7; i++) days[addDays(start, i)] = doneDay(addDays(start, i));
  // totalDays: 7 so the walk stops at the end of the (fully green) first
  // week instead of hitting an unlogged, already-locked day 8 — which would
  // itself immediately reset the attempt, per the hard-daily rule.
  const result = evaluateAttempt(fitnessChallenge({ totalDays: 7 }), attempt, days, TODAY);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.weeks[0].status, 'green');
  assert.equal(result.weeks[0].dayStatuses.length, 7);
});

test('custom challenges (no fitness category) keep the weekly rule — a mid-week red day does not reset early', () => {
  const start = addDays(TODAY, -3); // day 1 (locked, missed), days 2-4 not all locked yet
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  const result = evaluateAttempt(customChallenge(), attempt, {}, TODAY);
  // The week isn't finished (today/yesterday are still 'pending', not
  // locked), so — unlike a fitness challenge — nothing resets yet even
  // though day 1 is already red.
  assert.equal(result.outcome, 'active');
  assert.equal(result.weeks[0].status, 'pending');
});

test('custom challenges still reset only once a full red week is locked', () => {
  const start = addDays(TODAY, -10);
  const attempt = { id: 'a1', startDate: start, status: 'active' };
  // Only 2 of 7 days green, weeklyTarget 5 -> red week, but only decided
  // once the week's last day is locked (unlike fitness's early exit).
  const days = { [addDays(start, 0)]: doneDay(addDays(start, 0)), [addDays(start, 1)]: doneDay(addDays(start, 1)) };
  const result = evaluateAttempt(customChallenge(), attempt, days, TODAY);
  assert.equal(result.outcome, 'reset');
  assert.equal(result.weeks[0].dayStatuses.length, 7);
  assert.equal(result.resetDate, addDays(start, 7));
});

// --- backup validation for a preset (fitness) challenge ---

test('validateV2: a fitness challenge built from presetSteps passes', () => {
  const p = profile();
  const backup = {
    version: 2,
    challenges: [{
      id: 'c-fit', name: 'Get fit', totalDays: 90, weeklyTarget: 7, category: 'fitness', profile: p,
      steps: presetSteps(p),
    }],
    attempts: [],
    days: [],
    photos: [],
  };
  assert.doesNotThrow(() => validateV2(backup));
});

// --- goalPlan: targets sized to the weight goal and the number of days ---

const bigCut = { sex: 'male', age: 30, heightCm: 180, startWeightKg: 129, targetWeightKg: 90, activity: 'light', aim: 'lose' };

test('goalPlan: too few days caps the deficit at 1000 and reports the minimum days', () => {
  const plan = goalPlan(bigCut, 60);
  assert.equal(plan.dailyDelta, 1000);
  assert.equal(plan.minDays, 301);
  assert.equal(plan.daysOk, false);
  assert.deepEqual(plan.calories, { target: 1670, dir: 'atMost' });
});

test('goalPlan: enough days uses the smaller deficit the goal needs', () => {
  const plan = goalPlan(bigCut, 365);
  assert.equal(plan.daysOk, true);
  assert.equal(plan.dailyDelta, 823);
  assert.equal(calorieTarget(bigCut, 365).target, 1850);
});

test('goalPlan: never plans below the calorie floor', () => {
  const small = { sex: 'female', age: 60, heightCm: 155, startWeightKg: 60, targetWeightKg: 50, activity: 'sedentary', aim: 'lose' };
  assert.ok(goalPlan(small, 30).calories.target >= 1200);
});

test('goalPlan: null for maintain or a target on the wrong side', () => {
  assert.equal(goalPlan({ ...bigCut, aim: 'maintain' }, 100), null);
  assert.equal(goalPlan({ ...bigCut, targetWeightKg: 140 }, 100), null);
});

test('goalPlan: gain caps the surplus at 500', () => {
  const gain = { sex: 'male', age: 22, heightCm: 175, startWeightKg: 60, targetWeightKg: 70, activity: 'light', aim: 'gain' };
  const plan = goalPlan(gain, 30);
  assert.equal(plan.dailyDelta, 500);
  assert.equal(plan.minDays, 154);
  assert.equal(plan.calories.dir, 'atLeast');
});

// --- food under a cap: green only between 50% and 100% of the target ---

test('isStepComplete: food atMost needs 50–100% of the calorie target', async () => {
  const { isStepComplete } = await import('../js/rules.js');
  const food = { id: 'food', type: 'food', goal: { target: 2000, dir: 'atMost' }, number: { unit: 'kcal' } };
  assert.equal(isStepComplete(food, { value: 0 }, 2000), false);
  assert.equal(isStepComplete(food, { value: 900 }, 2000), false);
  assert.equal(isStepComplete(food, { value: 1000 }, 2000), true);
  assert.equal(isStepComplete(food, { value: 2000 }, 2000), true);
  assert.equal(isStepComplete(food, { value: 2100 }, 2000), false);
});
