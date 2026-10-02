import test from 'node:test';
import assert from 'node:assert/strict';
import { canSuggest, buildSuggestionInput, parseMealPlan, planTotals, kcalWarning, bodyCheckText, defaultSlots, ifSlots, eatingWindow, windowStatus, scheduleOf, placeholderStatus, dayGaps, groceryList, prefOptions, groceryKey } from '../js/mealPlan.js';
import { addDays } from '../js/rules.js';
import { presetSteps } from '../js/fitness.js';

const TODAY = '2026-09-25';

function profile(overrides = {}) {
  return {
    sex: 'male', age: 30, heightCm: 180, startWeightKg: 80, targetWeightKg: 75, activity: 'sedentary', aim: 'lose',
    location: 'Bengaluru, Karnataka', cuisine: 'South Indian', diet: 'veg', avoid: 'peanuts', mealsPerDay: 4,
    ...overrides,
  };
}

function meal(dish, calories, macros = {}) {
  return { id: `m-${dish}`, dish, calories, macros: { protein: 0, carbs: 0, fat: 0, fiber: 0, ...macros } };
}

function dayWithMeals(date, foodStepId, meals) {
  return { date, steps: { [foodStepId]: { meals } } };
}

// --- canSuggest ---

test('canSuggest: false with no meals logged at all', () => {
  assert.equal(canSuggest({}, 'food', TODAY), false);
});

test('canSuggest: false with only 2 meals on any day in range', () => {
  const daysMap = { [TODAY]: dayWithMeals(TODAY, 'food', [meal('A', 100), meal('B', 100)]) };
  assert.equal(canSuggest(daysMap, 'food', TODAY), false);
});

test('canSuggest: true once a day has 3 or more meals', () => {
  const daysMap = { [TODAY]: dayWithMeals(TODAY, 'food', [meal('A', 100), meal('B', 100), meal('C', 100)]) };
  assert.equal(canSuggest(daysMap, 'food', TODAY), true);
});

test('canSuggest: a qualifying day outside the last 7 days does not count', () => {
  const oldDate = addDays(TODAY, -8);
  const daysMap = { [oldDate]: dayWithMeals(oldDate, 'food', [meal('A', 100), meal('B', 100), meal('C', 100)]) };
  assert.equal(canSuggest(daysMap, 'food', TODAY), false);
});

test('canSuggest: a qualifying day exactly 6 days back (the oldest included day) counts', () => {
  const oldestIncluded = addDays(TODAY, -6);
  const daysMap = { [oldestIncluded]: dayWithMeals(oldestIncluded, 'food', [meal('A', 100), meal('B', 100), meal('C', 100)]) };
  assert.equal(canSuggest(daysMap, 'food', TODAY), true);
});

test('canSuggest: false with no food step id', () => {
  const daysMap = { [TODAY]: dayWithMeals(TODAY, 'food', [meal('A', 100), meal('B', 100), meal('C', 100)]) };
  assert.equal(canSuggest(daysMap, null, TODAY), false);
});

// --- buildSuggestionInput ---

function fitnessChallenge(overrides = {}) {
  const p = profile();
  return {
    id: 'c1', name: 'Fit', category: 'fitness', totalDays: 90, weeklyTarget: 7,
    profile: p,
    steps: presetSteps(p),
    ...overrides,
  };
}

test('buildSuggestionInput: profile, targets and a 7-day window ending today', () => {
  const challenge = fitnessChallenge();
  const foodStepId = challenge.steps.find((s) => s.type === 'food').id;
  const meals = [meal('Idli', 200, { protein: 6, carbs: 40, fat: 2, fiber: 3 }), meal('Sambar', 150, { protein: 8, carbs: 20, fat: 3, fiber: 5 })];
  const daysMap = { [TODAY]: dayWithMeals(TODAY, foodStepId, meals) };

  const input = buildSuggestionInput(challenge, daysMap, TODAY);

  assert.equal(input.profile.location, 'Bengaluru, Karnataka');
  assert.equal(input.profile.cuisine, 'South Indian');
  assert.equal(input.profile.diet, 'veg');
  assert.equal(input.profile.avoid, 'peanuts');
  assert.equal(input.profile.schedule.meals, 4);
  assert.equal(input.profile.schedule.slots.length, 4);
  assert.equal(input.profile.currentWeightKg, 80);
  assert.ok(input.targets.kcal > 0);
  assert.ok(input.targets.protein > 0);

  assert.equal(input.last7Days.length, 7);
  assert.equal(input.last7Days[6].date, TODAY);
  assert.equal(input.last7Days[0].date, addDays(TODAY, -6));
  assert.deepEqual(input.last7Days[6].meals, [
    ['Idli', 200, 6, 40, 2, 3],
    ['Sambar', 150, 8, 20, 3, 5],
  ]);
  assert.equal(input.last7Days[6].totalKcal, 350);
  // No meals logged on the other 6 days.
  assert.deepEqual(input.last7Days[0].meals, []);
  assert.equal(input.last7Days[0].totalKcal, 0);
});

test('buildSuggestionInput: workout/steps/water/sleep are pulled per day when those steps exist', () => {
  const challenge = fitnessChallenge();
  const workoutStepId = challenge.steps.find((s) => s.type === 'workout').id;
  const stepsStepId = challenge.steps.find((s) => s.type === 'steps').id;
  const waterStepId = challenge.steps.find((s) => s.type === 'water').id;
  const sleepStepId = challenge.steps.find((s) => s.type === 'sleep').id;
  const daysMap = {
    [TODAY]: {
      date: TODAY,
      steps: {
        [workoutStepId]: { value: 30, burn: 200 },
        [stepsStepId]: { value: 9000 },
        [waterStepId]: { value: 2.5 },
        [sleepStepId]: { value: 7 },
      },
    },
  };
  const input = buildSuggestionInput(challenge, daysMap, TODAY);
  const todayRow = input.last7Days[6];
  assert.equal(todayRow.workoutMinutes, 30);
  assert.equal(todayRow.workoutKcal, 200);
  assert.equal(todayRow.steps, 9000);
  assert.equal(todayRow.waterL, 2.5);
  assert.equal(todayRow.sleepH, 7);
});

test('buildSuggestionInput: no food step at all means no targets, but still returns a shape', () => {
  const challenge = { id: 'c2', profile: profile(), steps: [] };
  const input = buildSuggestionInput(challenge, {}, TODAY);
  assert.equal(input.targets, null);
  assert.equal(input.last7Days.length, 7);
});

// --- bodyCheckText ---

test('bodyCheckText: uses the stored bodyCheck verbatim when present', () => {
  const challenge = { profile: profile(), bodyCheck: { date: TODAY, bmi: 24, build: 'average', bellyFat: 'low', note: 'Looking good.', focus: [] } };
  assert.deepEqual(bodyCheckText(challenge, {}), challenge.bodyCheck);
});

test('bodyCheckText: falls back to a BMI-only note when there is no stored bodyCheck', () => {
  const challenge = { profile: profile({ startWeightKg: 80, heightCm: 180 }) };
  const result = bodyCheckText(challenge, {});
  assert.equal(result.bmi, 24.7);
  assert.equal(result.build, null);
  assert.match(result.note, /height and weight only/);
});

test('bodyCheckText: null with no profile at all', () => {
  assert.equal(bodyCheckText({}, {}), null);
});

// --- parseMealPlan ---

test('parseMealPlan: valid input is normalised, clamped and capped at 3 why/tips', () => {
  const json = {
    meals: [
      { slot: 'Breakfast', dish: 'Idli sambar', portion: '3 idlis', kcal: 300, protein_g: 10, carbs_g: 55, fat_g: 5, fiber_g: 6, swap_for: 'Ragi idli' },
      { slot: 'Lunch', dish: 'Rice and dal', portion: '1 plate', kcal: 500, protein_g: 18, carbs_g: 80, fat_g: 10, fiber_g: 8 },
    ],
    why: ['Protein was short on 5 of 7 days.', 'Fibre was consistently low.', 'Dinner was often skipped.', 'A fourth line that should be dropped.'],
    tips: ['Add a glass of milk at breakfast.', 'Snack on nuts.', 'Drink water before meals.', 'Dropped tip.'],
  };
  const plan = parseMealPlan(json);
  assert.equal(plan.meals.length, 2);
  assert.deepEqual(plan.meals[0], { slot: 'Breakfast', dish: 'Idli sambar', portion: '3 idlis', kcal: 300, protein: 10, carbs: 55, fat: 5, fiber: 6, swapFor: 'Ragi idli', ingredients: [] });
  assert.equal(plan.meals[1].swapFor, '');
  assert.equal(plan.why.length, 3);
  assert.equal(plan.tips.length, 3);
});

test('parseMealPlan: clamps out-of-range numbers to a sane range', () => {
  const json = { meals: [{ slot: 'Snack', dish: 'X', portion: '1', kcal: -50, protein_g: 9999, carbs_g: 9999, fat_g: 9999, fiber_g: 9999 }], why: [], tips: [] };
  const plan = parseMealPlan(json);
  assert.equal(plan.meals[0].kcal, 0);
  assert.equal(plan.meals[0].protein, 500);
});

test('parseMealPlan: throws on a bad shape', () => {
  assert.throws(() => parseMealPlan(null), /Unexpected response from Gemini/);
  assert.throws(() => parseMealPlan({}), /Unexpected response from Gemini/);
  assert.throws(() => parseMealPlan({ meals: 'nope' }), /Unexpected response from Gemini/);
  assert.throws(() => parseMealPlan({ meals: [{ slot: 'Lunch' }] }), /Unexpected response from Gemini/);
});

// --- planTotals ---

test('planTotals: sums kcal and macros across meals, rounded', () => {
  const plan = {
    meals: [
      { kcal: 300.4, protein: 10.2, carbs: 55.1, fat: 5.6, fiber: 6.1 },
      { kcal: 499.6, protein: 17.9, carbs: 79.9, fat: 9.4, fiber: 7.9 },
    ],
  };
  assert.deepEqual(planTotals(plan), { kcal: 800, protein: 28, carbs: 135, fat: 15, fiber: 14 });
});

test('planTotals: empty/missing meals is all zeros', () => {
  assert.deepEqual(planTotals({ meals: [] }), { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  assert.deepEqual(planTotals({}), { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
});

// --- kcalWarning ---

test('kcalWarning: null when within +-10% of the target', () => {
  assert.equal(kcalWarning(1500, 1500), null);
  assert.equal(kcalWarning(1640, 1500), null);
  assert.equal(kcalWarning(1360, 1500), null);
});

test('kcalWarning: a message when outside the +-10% band', () => {
  const msg = kcalWarning(1800, 1500);
  assert.match(msg, /1800 kcal/);
  assert.match(msg, /1500 kcal target/);
});

test('kcalWarning: null with no valid target to compare against', () => {
  assert.equal(kcalWarning(1800, null), null);
  assert.equal(kcalWarning(1800, undefined), null);
  assert.equal(kcalWarning(1800, 0), null);
});

// --- defaultSlots (docs §9 Schedule) ---

test('defaultSlots: 3 meals is Breakfast 08:30, Lunch 13:30, Dinner 20:00', () => {
  assert.deepEqual(defaultSlots({ meals: 3 }), [
    { name: 'Breakfast', time: '08:30' },
    { name: 'Lunch', time: '13:30' },
    { name: 'Dinner', time: '20:00' },
  ]);
});

test('defaultSlots: 2 meals is Lunch 12:30, Dinner 19:30', () => {
  assert.deepEqual(defaultSlots({ meals: 2 }), [
    { name: 'Lunch', time: '12:30' },
    { name: 'Dinner', time: '19:30' },
  ]);
});

test('defaultSlots: 4 and 5 meals each return that many named, time-ordered slots', () => {
  const four = defaultSlots({ meals: 4 });
  assert.equal(four.length, 4);
  assert.deepEqual(four.map((s) => s.time), four.map((s) => s.time).slice().sort());
  const five = defaultSlots({ meals: 5 });
  assert.equal(five.length, 5);
  assert.deepEqual(five.map((s) => s.time), five.map((s) => s.time).slice().sort());
});

test('defaultSlots: an unknown/missing meal count falls back to 3', () => {
  assert.equal(defaultSlots({ meals: 9 }).length, 3);
  assert.equal(defaultSlots(null).length, 3);
});

// --- ifSlots ---

test('ifSlots: 16:8 from 12:00 with 2 meals gives 12:00 and 19:30', () => {
  assert.deepEqual(ifSlots('16:8', '12:00', 2), [
    { name: 'Meal 1', time: '12:00' },
    { name: 'Meal 2', time: '19:30' },
  ]);
});

test('ifSlots: spreads more than 2 meals evenly, ending 30 min before the window closes', () => {
  const slots = ifSlots('18:6', '13:00', 3);
  assert.equal(slots.length, 3);
  assert.equal(slots[0].time, '13:00');
  assert.equal(slots[2].time, '18:30'); // 18:6 window closes at 19:00, last meal 30 min before
});

test('ifSlots: OMAD (or an explicit 1 meal) is a single meal at the window start', () => {
  assert.deepEqual(ifSlots('omad', '13:00', 1), [{ name: 'Meal 1', time: '13:00' }]);
  assert.deepEqual(ifSlots('omad', '13:00'), [{ name: 'Meal 1', time: '13:00' }]);
});

// --- eatingWindow ---

test('eatingWindow: computed from windowStart + the fast length, IF only', () => {
  assert.deepEqual(eatingWindow({ pattern: 'if', fast: '16:8', windowStart: '12:00' }), { start: '12:00', end: '20:00' });
  assert.deepEqual(eatingWindow({ pattern: 'if', fast: '20:4', windowStart: '14:00' }), { start: '14:00', end: '18:00' });
});

test('eatingWindow: null for a Regular schedule or no schedule at all', () => {
  assert.equal(eatingWindow({ pattern: 'regular', meals: 3 }), null);
  assert.equal(eatingWindow(null), null);
});

// --- windowStatus ---

test('windowStatus: before the window opens', () => {
  const schedule = { pattern: 'if', fast: '16:8', windowStart: '12:00' };
  assert.equal(windowStatus(schedule, '10:00'), 'Eating window 12:00–20:00 · opens in 2h');
});

test('windowStatus: open, with time left', () => {
  const schedule = { pattern: 'if', fast: '16:8', windowStart: '12:00' };
  assert.equal(windowStatus(schedule, '17:00'), 'Eating window 12:00–20:00 · open · closes in 3h');
});

test('windowStatus: closed once the window has passed for the day', () => {
  const schedule = { pattern: 'if', fast: '16:8', windowStart: '12:00' };
  assert.equal(windowStatus(schedule, '21:30'), 'Eating window 12:00–20:00 · closed');
});

test('windowStatus: empty string for a Regular schedule', () => {
  assert.equal(windowStatus({ pattern: 'regular', meals: 3 }, '10:00'), '');
});

// --- scheduleOf ---

test('scheduleOf: returns profile.schedule verbatim when it already has slots', () => {
  const schedule = { pattern: 'if', fast: '18:6', windowStart: '13:00', meals: 2, slots: ifSlots('18:6', '13:00', 2) };
  assert.deepEqual(scheduleOf({ schedule }), schedule);
});

test('scheduleOf: migrates the legacy mealsPerDay into a Regular schedule', () => {
  const result = scheduleOf({ mealsPerDay: 5 });
  assert.equal(result.pattern, 'regular');
  assert.equal(result.meals, 5);
  assert.equal(result.slots.length, 5);
});

test('scheduleOf: falls back to 4 meals with no profile/mealsPerDay at all', () => {
  assert.equal(scheduleOf(null).meals, 4);
  assert.equal(scheduleOf({}).meals, 4);
});

// --- placeholderStatus ---

test('placeholderStatus: Planned when no logged meal links to it', () => {
  const planned = { id: 'p1', slot: 'Lunch', dish: 'Rice and dal', kcal: 450 };
  assert.deepEqual(placeholderStatus(planned, []), { status: 'planned', label: 'Planned', actualKcal: null });
});

test('placeholderStatus: Logged once a meal has plannedId === planned.id', () => {
  const planned = { id: 'p1', slot: 'Lunch', dish: 'Rice and dal', kcal: 450 };
  const meals = [{ id: 'm1', plannedId: 'p1', calories: 520 }];
  assert.deepEqual(placeholderStatus(planned, meals), { status: 'logged', label: 'Logged', actualKcal: 520 });
});

test('placeholderStatus: ignores a meal linked to a different placeholder', () => {
  const planned = { id: 'p1' };
  const meals = [{ id: 'm1', plannedId: 'p2', calories: 300 }];
  assert.equal(placeholderStatus(planned, meals).status, 'planned');
});

// --- meal suggest v2 ---

test('dayGaps: short / over / ok', () => {
  const step = { macros: { protein: { target: 100, dir: 'atLeast' }, fiber: { target: 30, dir: 'atLeast' }, carbs: { target: 200, dir: 'atMost' }, fat: { target: 60, dir: 'atMost' } } };
  const entry = { meals: [meal('A', 2100, { protein: 70, carbs: 150, fat: 70, fiber: 28 })] };
  const gaps = dayGaps(entry, step, 2000);
  const by = Object.fromEntries(gaps.map((g) => [g.key, g]));
  assert.equal(by.kcal.status, 'over');
  assert.equal(by.protein.status, 'short');
  assert.equal(by.carbs.status, 'ok');
  assert.equal(by.fat.status, 'over');
  assert.equal(by.fiber.status, 'ok'); // 28 >= 90% of 30
  assert.equal(by.protein.actual, 70);
  assert.equal(by.protein.target, 100);
});

test('dayGaps: no targets gives no gaps', () => {
  assert.deepEqual(dayGaps({ meals: [] }, { macros: null }, null), []);
  assert.deepEqual(dayGaps(undefined, null, undefined), []);
});

test('groceryList: sums same item, keeps units separate, fixed category order', () => {
  const meals = [
    { ingredients: [{ name: 'Chicken breast', qty: 150, unit: 'g', category: 'meat_fish_eggs' }, { name: 'Onion', qty: 1, unit: 'pcs', category: 'vegetables' }] },
    { ingredients: [{ name: 'chicken breast', qty: 150, unit: 'g', category: 'meat_fish_eggs' }, { name: 'Onion', qty: 50, unit: 'g', category: 'vegetables' }, { name: 'Rice', qty: 80, unit: 'g', category: 'grains' }] },
  ];
  const list = groceryList(meals);
  assert.deepEqual(list.map((g) => g.category), ['vegetables', 'meat_fish_eggs', 'grains']);
  assert.deepEqual(list[1].items, [{ name: 'Chicken breast', qty: 300, unit: 'g' }]);
  assert.equal(list[0].items.length, 2);
  assert.equal(groceryKey(' Onion ', 'g'), 'onion|g');
  assert.deepEqual(groceryList([{}]), []);
});

test('parseMealPlan: keeps and clamps ingredients, old plans get []', () => {
  const base = { slot: 'Lunch', dish: 'Dal', portion: '1 bowl', kcal: 400, protein_g: 20, carbs_g: 50, fat_g: 8, fiber_g: 9 };
  const plan = parseMealPlan({
    meals: [{ ...base, ingredients: [{ name: 'Toor dal', qty: 60, unit: 'g', category: 'pulses' }, { name: 'Salt', qty: 99999, unit: 'weird', category: 'x' }, { name: '', qty: 1, unit: 'g' }, { name: 'Bad', qty: -1, unit: 'g' }] }, base],
    why: [], tips: [], fixes: ['Protein: 70 → 150 g', 'b', 'c', 'd'],
  });
  assert.deepEqual(plan.meals[0].ingredients[0], { name: 'Toor dal', qty: 60, unit: 'g', category: 'pulses' });
  assert.equal(plan.meals[0].ingredients.length, 2);
  assert.equal(plan.meals[0].ingredients[1].qty, 5000);
  assert.equal(plan.meals[0].ingredients[1].unit, 'pcs');
  assert.equal(plan.meals[0].ingredients[1].category, 'other');
  assert.deepEqual(plan.meals[1].ingredients, []);
  assert.equal(plan.fixes.length, 3);
  assert.deepEqual(parseMealPlan({ meals: [] }).fixes, []);
});

test('prefOptions: choices and default per diet', () => {
  assert.deepEqual(prefOptions('nonveg').options.map((o) => o.value), ['mix', 'nonveg', 'veg']);
  assert.equal(prefOptions('nonveg').default, 'mix');
  assert.deepEqual(prefOptions('eggetarian').options.map((o) => o.value), ['egg', 'veg']);
  assert.equal(prefOptions('eggetarian').default, 'egg');
  assert.equal(prefOptions('veg').fixed, true);
  assert.equal(prefOptions('veg').default, 'veg');
  assert.equal(prefOptions('vegan').default, 'vegan');
  assert.equal(prefOptions('vegan').fixed, true);
});

test('buildSuggestionInput: yesterday gaps/dishes and recentDishes', () => {
  const challenge = fitnessChallenge();
  const foodStepId = challenge.steps.find((s) => s.type === 'food').id;
  const y = addDays(TODAY, -1);
  const daysMap = {
    [y]: dayWithMeals(y, foodStepId, [meal('Idli', 200, { protein: 6, carbs: 40, fat: 2, fiber: 3 })]),
    [TODAY]: dayWithMeals(TODAY, foodStepId, [meal('idli', 200, {}), meal('Dosa', 150, {})]),
  };
  const input = buildSuggestionInput(challenge, daysMap, TODAY, 'veg');
  assert.equal(input.pref, 'veg');
  assert.deepEqual(input.yesterday.dishes, ['Idli']);
  assert.ok(input.yesterday.gaps.find((g) => g.key === 'protein' && g.status === 'short'));
  assert.deepEqual(input.recentDishes, ['Idli', 'Dosa']);
});
