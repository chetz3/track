import test from 'node:test';
import assert from 'node:assert/strict';
import { FOOD_NUMBER, makeFoodStep, isFoodStep, mealsTotal, parseCalorieResult, buildFoodPatch, mealsMacros } from '../js/foodLogic.js';
import { validateV2 } from '../js/backup.js';

// --- mealsTotal ---

test('mealsTotal: empty list is 0', () => {
  assert.equal(mealsTotal([]), 0);
});

test('mealsTotal: missing list is 0', () => {
  assert.equal(mealsTotal(undefined), 0);
  assert.equal(mealsTotal(null), 0);
});

test('mealsTotal: sums and rounds', () => {
  assert.equal(mealsTotal([{ calories: 120.4 }, { calories: 99.7 }]), 220);
});

// --- isFoodStep ---

test('isFoodStep: true only for type food', () => {
  assert.equal(isFoodStep({ type: 'food' }), true);
  assert.equal(isFoodStep({ type: 'regular' }), false);
  assert.equal(isFoodStep({}), false);
  assert.equal(isFoodStep(null), false);
  assert.equal(isFoodStep(undefined), false);
});

// --- makeFoodStep ---

test('makeFoodStep: returns the fixed shape', () => {
  const step = makeFoodStep({ id: 's1', name: 'Lunch', mandatory: true });
  assert.equal(step.id, 's1');
  assert.equal(step.name, 'Lunch');
  assert.equal(step.mandatory, true);
  assert.equal(step.type, 'food');
  assert.equal(step.photo, 'none');
  assert.equal(step.note, 'none');
  assert.deepEqual(step.number, FOOD_NUMBER);
});

test('makeFoodStep output passes the existing backup step validation', () => {
  const foodStep = makeFoodStep({ id: 'food', name: 'Meals', mandatory: true });
  const backup = {
    version: 2,
    challenges: [{ id: 'c1', name: 'Test', totalDays: 10, weeklyTarget: 5, steps: [foodStep] }],
    attempts: [],
    days: [],
    photos: [],
  };
  assert.doesNotThrow(() => validateV2(backup));
});

// --- parseCalorieResult ---

test('parseCalorieResult: valid input sums item calories into total', () => {
  const result = parseCalorieResult({
    is_food: true, dish: 'Chicken rice', total_calories: 999, confidence: 'high',
    items: [{ name: 'Rice', portion: '1 cup', calories: 200 }, { name: 'Chicken', portion: '150g', calories: 300 }],
  });
  assert.equal(result.isFood, true);
  assert.equal(result.dish, 'Chicken rice');
  assert.equal(result.total, 500);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], { name: 'Rice', portion: '1 cup', calories: 200, macros: { protein: 0, carbs: 0, fat: 0, fiber: 0 } });
});

test('parseCalorieResult: clamps negative and huge item calories to 0-5000', () => {
  const result = parseCalorieResult({
    is_food: true, dish: 'Weird', total_calories: 0, confidence: 'low',
    items: [{ name: 'A', portion: '1', calories: -50 }, { name: 'B', portion: '1', calories: 999999 }],
  });
  assert.equal(result.items[0].calories, 0);
  assert.equal(result.items[1].calories, 5000);
  assert.equal(result.total, 5000);
});

test('parseCalorieResult: no items falls back to a clamped total_calories', () => {
  const result = parseCalorieResult({ is_food: true, dish: 'Snack', total_calories: 250, confidence: 'medium', items: [] });
  assert.equal(result.total, 250);
  const clamped = parseCalorieResult({ is_food: true, dish: 'Huge', total_calories: 999999, confidence: 'low', items: [] });
  assert.equal(clamped.total, 5000);
});

test('parseCalorieResult: sums per-item macros into the meal total', () => {
  const result = parseCalorieResult({
    is_food: true, dish: 'Chicken rice', total_calories: 500, confidence: 'high',
    items: [
      { name: 'Rice', portion: '1 cup', calories: 200, protein_g: 4, carbs_g: 45, fat_g: 1, fiber_g: 2 },
      { name: 'Chicken', portion: '150g', calories: 300, protein_g: 35, carbs_g: 0, fat_g: 10, fiber_g: 0 },
    ],
  });
  assert.deepEqual(result.items[0].macros, { protein: 4, carbs: 45, fat: 1, fiber: 2 });
  assert.deepEqual(result.macros, { protein: 39, carbs: 45, fat: 11, fiber: 2 });
});

test('parseCalorieResult: an older response with no macro fields at all becomes 0s, not a throw', () => {
  const result = parseCalorieResult({
    is_food: true, dish: 'Snack', total_calories: 250, confidence: 'medium',
    items: [{ name: 'Bar', portion: '1', calories: 250 }],
  });
  assert.deepEqual(result.items[0].macros, { protein: 0, carbs: 0, fat: 0, fiber: 0 });
  assert.deepEqual(result.macros, { protein: 0, carbs: 0, fat: 0, fiber: 0 });
});

test('parseCalorieResult: no items falls back to the top-level total_*_g fields, clamped 0-500', () => {
  const result = parseCalorieResult({
    is_food: true, dish: 'Shake', total_calories: 400, confidence: 'low', items: [],
    total_protein_g: 30, total_carbs_g: 9999, total_fat_g: -5, total_fiber_g: 8,
  });
  assert.deepEqual(result.macros, { protein: 30, carbs: 500, fat: 0, fiber: 8 });
});

test('parseCalorieResult: the no-food case', () => {
  const result = parseCalorieResult({ is_food: false, dish: '', total_calories: 0, confidence: 'low', items: [] });
  assert.equal(result.isFood, false);
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
});

test('parseCalorieResult: throws on a bad shape', () => {
  assert.throws(() => parseCalorieResult(null), /Unexpected response from Gemini/);
  assert.throws(() => parseCalorieResult({}), /Unexpected response from Gemini/);
  assert.throws(() => parseCalorieResult({ is_food: 'yes', items: [] }), /Unexpected response from Gemini/);
  assert.throws(() => parseCalorieResult({ is_food: true, items: 'nope' }), /Unexpected response from Gemini/);
  assert.throws(() => parseCalorieResult({ is_food: true, items: [{ name: 'A' }] }), /Unexpected response from Gemini/);
});

// --- mealsMacros ---

test('mealsMacros: empty/missing list is all zeros', () => {
  const zero = { protein: 0, carbs: 0, fat: 0, fiber: 0 };
  assert.deepEqual(mealsMacros([]), zero);
  assert.deepEqual(mealsMacros(undefined), zero);
  assert.deepEqual(mealsMacros(null), zero);
});

test('mealsMacros: sums each key across meals', () => {
  const meals = [
    { macros: { protein: 30, carbs: 40, fat: 10, fiber: 5 } },
    { macros: { protein: 20, carbs: 10, fat: 5, fiber: 3 } },
  ];
  assert.deepEqual(mealsMacros(meals), { protein: 50, carbs: 50, fat: 15, fiber: 8 });
});

test('mealsMacros: an old meal without macros counts as 0, not an error', () => {
  const meals = [{ calories: 300 }, { macros: { protein: 20, carbs: 10, fat: 5, fiber: 3 } }];
  assert.deepEqual(mealsMacros(meals), { protein: 20, carbs: 10, fat: 5, fiber: 3 });
});

// --- buildFoodPatch ---

test('buildFoodPatch: done is true only when there are meals', () => {
  const empty = buildFoodPatch({}, []);
  assert.equal(empty.done, false);
  assert.equal(empty.value, 0);
  assert.deepEqual(empty.meals, []);
  assert.deepEqual(empty.macros, { protein: 0, carbs: 0, fat: 0, fiber: 0 });

  const withMeals = buildFoodPatch({}, [{ calories: 300, macros: { protein: 30, carbs: 40, fat: 10, fiber: 5 } }]);
  assert.equal(withMeals.done, true);
  assert.equal(withMeals.value, 300);
  assert.deepEqual(withMeals.macros, { protein: 30, carbs: 40, fat: 10, fiber: 5 });
});

// --- backup validation for step.macros ---

test('validateV2: a food step with macro targets passes; an invalid one is rejected', () => {
  const stepWithMacros = { ...makeFoodStep({ id: 'food', name: 'Meals', mandatory: true }), macros: { protein: { target: 144, dir: 'atLeast' }, carbs: { target: 186, dir: 'atMost' } } };
  const backup = (steps) => ({
    version: 2,
    challenges: [{ id: 'c1', name: 'Test', totalDays: 10, weeklyTarget: 5, steps }],
    attempts: [],
    days: [],
    photos: [],
  });
  assert.doesNotThrow(() => validateV2(backup([stepWithMacros])));
  assert.doesNotThrow(() => validateV2(backup([{ ...stepWithMacros, macros: null }])));

  const badKey = { ...stepWithMacros, macros: { sugar: { target: 10, dir: 'atLeast' } } };
  assert.throws(() => validateV2(backup([badKey])), /Invalid backup file/);

  const badDir = { ...stepWithMacros, macros: { protein: { target: 10, dir: 'sideways' } } };
  assert.throws(() => validateV2(backup([badDir])), /Invalid backup file/);
});

// --- feel tags survive meal add/delete (R2) ---

test('feel survives meal add and delete (buildFoodPatch never carries it, applyStepPatch merges)', async () => {
  const { applyStepPatch } = await import('../js/storeLogic.js');
  const step = makeFoodStep({ id: 'food', name: 'Meals', mandatory: true });
  const m = { id: 'm1', dish: 'Idli', calories: 300, macros: { protein: 10, carbs: 50, fat: 5, fiber: 3 } };
  let entry = applyStepPatch(step, undefined, { feel: ['bloated', 'cravings'] });
  entry = applyStepPatch(step, entry, buildFoodPatch(entry, [m]));
  assert.deepEqual(entry.feel, ['bloated', 'cravings']);
  assert.equal(entry.meals.length, 1);
  entry = applyStepPatch(step, entry, buildFoodPatch(entry, []));
  assert.deepEqual(entry.feel, ['bloated', 'cravings']);
  assert.equal(entry.meals.length, 0);
});
