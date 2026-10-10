import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EWMA_ALPHA, KCAL_PER_KG, weightSeries, smoothWeights, trendStatus, weekCheck, eatingPatterns, normDish,
} from '../js/trend.js';
import { normDish as planNormDish } from '../js/planLogic.js';
import { addDays } from '../js/rules.js';

const START = '2026-09-01';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`);

function challenge(extra = {}) {
  return {
    id: 'c1', name: 'T', category: 'fitness', totalDays: 100, weeklyTarget: 5,
    profile: { sex: 'male', age: 40, heightCm: 180, startWeightKg: 90, targetWeightKg: 80, activity: 'light', aim: 'lose' },
    steps: [
      { id: 'body', type: 'body', name: 'Body', mandatory: false, photo: 'none', number: { label: 'Weight', unit: 'kg' }, note: 'none' },
      { id: 'food', type: 'food', name: 'Food', mandatory: true, photo: 'none', number: { label: 'Calories', unit: 'kcal' }, goal: { target: 2000, dir: 'atMost' }, note: 'none' },
      { id: 'workout', type: 'workout', name: 'Workout', mandatory: false, photo: 'none', number: { label: 'Workout', unit: 'min' }, note: 'none' },
    ],
    ...extra,
  };
}

function meal(dish, calories, extra = {}) {
  return { id: `m-${dish}-${calories}`, dish, calories, macros: { protein: 20, carbs: 50, fat: 10, fiber: 5 }, items: [], ...extra };
}

// days[i] = { kg, meals } for date START + i (either may be omitted)
function build(n, fn) {
  const map = {};
  for (let i = 0; i < n; i++) {
    const spec = fn(i);
    if (!spec) continue;
    const date = addDays(START, i);
    const meals = spec.meals || [];
    const steps = {};
    if (spec.kg !== undefined) steps.body = { value: spec.kg };
    if (meals.length) steps.food = { meals, value: meals.reduce((s, m) => s + m.calories, 0), done: true };
    if (spec.burn) steps.workout = { value: 30, burn: spec.burn };
    map[date] = { key: `c1|${date}`, challengeId: 'c1', date, mandatoryStepIds: ['food'], targets: { food: 2000 }, steps };
  }
  return map;
}

const day1800 = (kg) => ({ kg, meals: [meal('Idli', 1800)] });
const at = (date, h) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, h, 0).getTime(); };

test('normDish is the planLogic one (not duplicated)', () => {
  assert.equal(normDish, planNormDish);
  assert.equal(normDish('  Curd   Rice! '), 'curd rice');
});

test('weightSeries: sorted, finite only, [] without a body step', () => {
  const days = build(4, (i) => ({ kg: [80, 'x', 79, null][i] }));
  const c = challenge();
  assert.deepEqual(weightSeries(c, days), [{ date: START, kg: 80 }, { date: addDays(START, 2), kg: 79 }]);
  assert.deepEqual(weightSeries({ ...c, steps: c.steps.filter((s) => s.type !== 'body') }, days), []);
});

test('smoothWeights: EWMA with gaps', () => {
  const out = smoothWeights([{ date: START, kg: 100 }, { date: addDays(START, 1), kg: 99 }, { date: addDays(START, 4), kg: 96 }]);
  assert.equal(out[0].trendKg, 100);
  near(out[1].trendKg, 100 + EWMA_ALPHA * -1);
  const a3 = 1 - (1 - EWMA_ALPHA) ** 3;
  near(out[2].trendKg, out[1].trendKg + a3 * (96 - out[1].trendKg));
});

test('trendStatus: -0.5 kg/week is losing', () => {
  const days = build(28, (i) => day1800(90 - (0.5 / 7) * i));
  const s = trendStatus(challenge(), days, addDays(START, 27), { startDate: START });
  assert.equal(s.status, 'losing');
  assert.ok(s.slopeKgPerWeek < -0.4 && s.slopeKgPerWeek > -0.6, String(s.slopeKgPerWeek));
  assert.equal(s.stalledSince, null);
});

test('trendStatus: 129 kg with +-1.5 kg noise is fluctuating', () => {
  const noise = [0, 1.5, -1.5, 1, -1.2, 0.8, -1.5, 1.5, -0.5, 1.2, -1.4, 0.3, -0.9, 1.4];
  const days = build(28, (i) => day1800(129 + noise[i % noise.length]));
  const s = trendStatus(challenge(), days, addDays(START, 27), { startDate: START });
  assert.equal(s.status, 'fluctuating');
  assert.ok(s.rangeKg >= 2.5);
});

test('trendStatus: flat and calm is plateau; stalledSince is the start of the flat run', () => {
  const days = build(28, (i) => day1800(i % 2 ? 90.1 : 90));
  const s = trendStatus(challenge(), days, addDays(START, 27), { startDate: START });
  assert.equal(s.status, 'plateau');
  assert.equal(s.stalledSince, START);
});

test('trendStatus: stalledSince after an earlier loss phase', () => {
  const days = build(70, (i) => day1800(i < 12 ? 100 - i : 89));
  const s = trendStatus(challenge(), days, addDays(START, 69), { startDate: START });
  assert.equal(s.status, 'plateau');
  assert.ok(s.stalledSince > START && s.stalledSince <= addDays(START, 40), s.stalledSince);
});

test('trendStatus: no-data with 3 weigh-ins, or too short a span', () => {
  const c = challenge();
  const few = build(14, (i) => (i % 5 === 0 && i < 12 ? day1800(90) : null));
  assert.equal(trendStatus(c, few, addDays(START, 13), { startDate: START }).status, 'no-data');
  const short = build(8, () => day1800(90));
  assert.equal(trendStatus(c, short, addDays(START, 7), { startDate: START }).status, 'no-data');
});

test('trendStatus: window is clipped to the attempt start', () => {
  const days = build(20, () => day1800(90));
  const s = trendStatus(challenge(), days, addDays(START, 19), { startDate: addDays(START, 10), windowDays: 28 });
  assert.equal(s.weighIns, 10);
});

test('trendStatus: adherence counts flex days', () => {
  const days = build(14, (i) => (i === 8
    ? { kg: 90, meals: [meal('Biryani', 2100)] }
    : day1800(90)));
  const s = trendStatus(challenge(), days, addDays(START, 13), { startDate: START, windowDays: 14 });
  assert.equal(s.greenDays, 14);
  assert.equal(s.adherencePct, 100);
});

test('trendStatus: expected vs actual gap (hand-computed)', () => {
  // 90 kg, male, 40 y, 180 cm, light: bmr = 900 + 1125 - 200 + 5 = 1830,
  // tdee = 1830 * 1.375 = 2516.25. 13 completed days at 1800 kcal:
  // 13 * 716.25 / 7700 = 1.2092 kg expected; the trend didn't move.
  const days = build(14, () => day1800(90));
  const s = trendStatus(challenge(), days, addDays(START, 13), { startDate: START, windowDays: 14 });
  assert.equal(s.loggedFoodDays, 13);
  assert.equal(s.avgKcal, 1800);
  assert.equal(s.targetKcal, 2000);
  near(s.expectedLossKg, 1.21, 0.005);
  assert.equal(s.actualLossKg, 0);
  near(s.gapKg, 1.21, 0.005);
  assert.equal(KCAL_PER_KG, 7700);
});

test('trendStatus: workout burn adds to expected loss', () => {
  const days = build(14, () => ({ kg: 90, meals: [meal('Idli', 1800)], burn: 385 }));
  const s = trendStatus(challenge(), days, addDays(START, 13), { startDate: START });
  near(s.expectedLossKg, (13 * (716.25 + 385)) / 7700, 0.01);
});

test('weekCheck: stalled needs >=5 green days and a flat trend', () => {
  const c = challenge();
  const flat = build(14, () => day1800(90));
  const today = addDays(START, 13);
  assert.deepEqual(weekCheck(c, flat, today, { startDate: START }), { stalled: true, greenDays: 7, changeKg: 0 });

  const falling = build(14, (i) => day1800(95 - i * 0.5));
  const f = weekCheck(c, falling, today, { startDate: START });
  assert.equal(f.stalled, false);
  assert.ok(f.changeKg < 0);

  const few = build(14, (i) => (i >= 7 && i < 11 ? { kg: 90, meals: [] } : day1800(90)));
  const w = weekCheck(c, few, today, { startDate: START });
  assert.equal(w.greenDays, 3);
  assert.equal(w.stalled, false);
});

test('eatingPatterns: lateKcalPct counts meals at/after 20:00, skips meals without at', () => {
  const d = addDays(START, 1);
  const days = build(3, (i) => (i === 1
    ? { meals: [meal('Rice', 600, { at: at(d, 21) }), meal('Dal', 400, { at: at(d, 12) }), meal('Chai', 900)] }
    : null));
  const p = eatingPatterns(challenge(), days, addDays(START, 2), { startDate: START });
  assert.equal(p.lateKcalPct, 60);
  assert.equal(p.avgMealsPerDay, 3);
  assert.deepEqual(p.topDishes.map((x) => x.dish).sort(), ['Chai', 'Dal', 'Rice']);
  assert.deepEqual(p.feelTags, {});
});

test('eatingPatterns: weekday/weekend kcal, protein per kg, macros', () => {
  // 2026-09-05 is a Saturday, 09-07 a Monday.
  const days = build(7, (i) => ({ kg: 100, meals: [meal('A', i === 4 || i === 5 ? 2000 : 1500)] }));
  const p = eatingPatterns(challenge(), days, addDays(START, 6), { startDate: START });
  assert.equal(p.weekendVsWeekdayKcal.weekend, 2000);
  assert.equal(p.weekendVsWeekdayKcal.weekday, 1500);
  assert.equal(p.proteinGPerKg, 0.2);
  assert.equal(p.carbPctOfKcal, Math.round((50 * 4 * 7) / (1500 * 5 + 2000 * 2) * 100));
  assert.equal(p.fiberAvgG, 5);
});

test('eatingPatterns: reads meal.feel when present', () => {
  const days = build(4, (i) => ({ meals: [meal('Curd rice', 500, i < 2 ? { feel: 'bloated' } : {})] }));
  const p = eatingPatterns(challenge(), days, addDays(START, 3), { startDate: START });
  assert.deepEqual(p.feelTags, { bloated: { count: 2, topDishes: ['Curd rice'] } });
});

function bumpFixture(bump) {
  // even days: Curd rice, next-morning weight +bump; odd days: Salad, +0.
  let w = 100;
  const raw = [];
  for (let i = 0; i < 14; i++) { raw.push(w); w += i % 2 === 0 ? bump : 0; }
  return build(14, (i) => ({ kg: raw[i], meals: [meal(i % 2 === 0 ? 'Curd rice' : 'Salad', 500)] }));
}

test('nextDayBumps: threshold is +0.3 kg', () => {
  const c = challenge();
  const today = addDays(START, 13);
  const low = eatingPatterns(c, bumpFixture(0.2), today, { startDate: START });
  assert.deepEqual(low.nextDayBumps, []);
  const high = eatingPatterns(c, bumpFixture(0.5), today, { startDate: START });
  assert.equal(high.nextDayBumps.length, 1);
  assert.equal(high.nextDayBumps[0].dish, 'Curd rice');
  assert.equal(high.nextDayBumps[0].bumpKg, 0.5);
  assert.ok(high.nextDayBumps[0].n >= 3);
});

test('nextDayBumps: needs a weigh-in on both days, and dishes eaten >= 3 times', () => {
  const c = challenge();
  const today = addDays(START, 13);
  // Drop the weigh-in on every odd day: no consecutive pairs at all.
  const noPairs = bumpFixture(0.5);
  for (const [date, d] of Object.entries(noPairs)) if (diffOdd(date)) delete d.steps.body;
  assert.deepEqual(eatingPatterns(c, noPairs, today, { startDate: START }).nextDayBumps, []);
  // Dish eaten only twice.
  const twice = build(14, (i) => ({ kg: 100 + (i === 0 || i === 4 ? 0 : 0), meals: [meal(i === 0 || i === 4 ? 'Pizza' : 'Salad', 500)] }));
  assert.deepEqual(eatingPatterns(c, twice, today, { startDate: START }).nextDayBumps, []);
});

function diffOdd(date) {
  return Number(date.slice(-2)) % 2 === 0; // START is the 1st, so odd offsets are even day numbers
}

test('nextDayBumps: capped at 6, largest first', () => {
  // 48 days: even days rotate through 8 dishes (+1 kg next morning), odd days are filler (-1).
  const days = build(48, (i) => ({
    kg: i % 2 === 0 ? 100 : 101,
    meals: [meal(i % 2 === 0 ? `Dish ${(i / 2) % 8}` : 'Filler', 500)],
  }));
  const p = eatingPatterns(challenge(), days, addDays(START, 47), { startDate: START, days: 60 });
  assert.equal(p.nextDayBumps.length, 6);
  for (let i = 1; i < 6; i++) assert.ok(p.nextDayBumps[i - 1].bumpKg >= p.nextDayBumps[i].bumpKg);
});
