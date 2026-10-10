// Pure weight-trend model for the Plateau Coach (R1 of
// docs/superpowers/plans/2026-10-10-plateau-coach.md §3). No DOM, no
// IndexedDB, no network: plain data in, plain data out, tested in
// tests/trend.test.js.
//
// `daysMap` is { [YYYY-MM-DD]: dayEntry } for one challenge. Functions that
// need the attempt start take it as `opts.startDate`; when it's omitted the
// earliest date in `daysMap` is used.

import { addDays, diffDays, dayStatus, flexDates } from './rules.js';
import { mealsTotal, mealsMacros } from './foodLogic.js';
import { tdee } from './fitness.js';
import { normDish } from './dish.js';

export { normDish };

export const EWMA_ALPHA = 0.1;
export const LOSING_PCT_WK = -0.2;
export const GAINING_PCT_WK = 0.2;
export const FLUCT_RANGE_PCT = 0.9;
export const STALL_BAND_PCT = 0.5;
export const MIN_WEIGH_INS = 4;
export const MIN_SPAN_DAYS = 10;
export const WEEK_CHECK_MIN_GREEN = 5;
export const WEEK_CHECK_MAX_CHANGE_PCT = -0.1;
export const KCAL_PER_KG = 7700;
export const LATE_HOUR = 20;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function startOf(daysMap, opts) {
  if (opts && opts.startDate) return opts.startDate;
  const keys = Object.keys(daysMap || {}).sort();
  return keys.length ? keys[0] : null;
}

function bodyStep(challenge) {
  return (challenge && challenge.steps || []).find((s) => s.type === 'body') || null;
}

function foodStep(challenge) {
  return (challenge && challenge.steps || []).find((s) => s.type === 'food') || null;
}

function mealsOf(day, foodId) {
  const m = day && day.steps && foodId && day.steps[foodId] && day.steps[foodId].meals;
  return Array.isArray(m) ? m : [];
}

// ---------- series ----------

// Raw weigh-ins from the body step, sorted by date. Finite values only.
export function weightSeries(challenge, daysMap) {
  const step = bodyStep(challenge);
  if (!step) return [];
  const out = [];
  for (const [date, day] of Object.entries(daysMap || {})) {
    const entry = day && day.steps && day.steps[step.id];
    const v = entry && entry.value;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.push({ date, kg: v });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Exponentially weighted moving average. A gap of g days weighs the new
// reading by 1 - (1 - alpha)^g. The first point seeds the trend.
export function smoothWeights(series) {
  const out = [];
  let trend = null;
  let prevDate = null;
  for (const p of series || []) {
    if (trend === null) {
      trend = p.kg;
    } else {
      const g = Math.max(1, diffDays(prevDate, p.date));
      const a = 1 - (1 - EWMA_ALPHA) ** g;
      trend = trend + a * (p.kg - trend);
    }
    prevDate = p.date;
    out.push({ date: p.date, kg: p.kg, trendKg: trend });
  }
  return out;
}

function trendOnOrBefore(smoothed, date) {
  let found = null;
  for (const p of smoothed) {
    if (p.date <= date) found = p; else break;
  }
  return found || smoothed[0] || null;
}

// ---------- status ----------

function emptyStatus(windowDays) {
  return {
    status: 'no-data', windowDays, weighIns: 0, slopeKgPerWeek: null, slopePctPerWeek: null,
    changeKg: null, rangeKg: null, startKg: null, endKg: null, adherencePct: null, greenDays: 0,
    loggedFoodDays: 0, avgKcal: null, targetKcal: null, expectedLossKg: null, actualLossKg: null,
    gapKg: null, stalledSince: null,
  };
}

function leastSquaresSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const x0 = points[0].date;
  const xs = points.map((p) => diffDays(x0, p.date));
  const ys = points.map((p) => p.trendKg);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

// opts: { windowDays = 14 (Infinity = whole attempt), startDate }
export function trendStatus(challenge, daysMap, today, opts = {}) {
  const windowDays = opts.windowDays === undefined ? 14 : opts.windowDays;
  const start = startOf(daysMap, opts);
  const res = emptyStatus(windowDays);
  if (!start || !bodyStep(challenge)) return res;

  const smoothed = smoothWeights(weightSeries(challenge, daysMap).filter((p) => p.date >= start && p.date <= today));
  const winStart = Number.isFinite(windowDays) ? addDays(today, -(windowDays - 1)) : start;
  const from = winStart < start ? start : winStart;
  const pts = smoothed.filter((p) => p.date >= from);

  res.weighIns = pts.length;

  // Adherence: green days over decided days (green or red) in the window.
  // Still-editable days that aren't green yet are pending, not failures.
  const flex = flexDates(challenge, start, daysMap, today);
  let green = 0;
  let decided = 0;
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const st = dayStatus(d, daysMap[d], challenge, today, flex);
    if (st === 'green') { green++; decided++; } else if (st === 'red') decided++;
  }
  res.greenDays = green;
  res.adherencePct = decided > 0 ? Math.round((green / decided) * 100) : null;

  // Food: only completed days (today is still being logged).
  const food = foodStep(challenge);
  if (food) {
    let n = 0;
    let kcal = 0;
    let tgt = 0;
    let tgtN = 0;
    for (let d = from; d < today; d = addDays(d, 1)) {
      const meals = mealsOf(daysMap[d], food.id);
      if (meals.length === 0) continue;
      n++;
      kcal += mealsTotal(meals);
      const t = daysMap[d].targets && daysMap[d].targets[food.id];
      const tv = Number.isFinite(t) ? t : (food.goal && food.goal.target);
      if (Number.isFinite(tv)) { tgt += tv; tgtN++; }
    }
    res.loggedFoodDays = n;
    res.avgKcal = n ? Math.round(kcal / n) : null;
    res.targetKcal = tgtN ? Math.round(tgt / tgtN) : null;
  }

  if (pts.length < MIN_WEIGH_INS || diffDays(pts[0].date, pts[pts.length - 1].date) < MIN_SPAN_DAYS) return res;

  const startKg = pts[0].trendKg;
  const endKg = pts[pts.length - 1].trendKg;
  const raws = pts.map((p) => p.kg);
  const rangeKg = Math.max(...raws) - Math.min(...raws);
  const slope = leastSquaresSlope(pts) * 7;
  const slopePct = (slope / endKg) * 100;

  let status;
  if (slopePct <= LOSING_PCT_WK) status = 'losing';
  else if (slopePct >= GAINING_PCT_WK) status = 'gaining';
  else if (rangeKg >= (FLUCT_RANGE_PCT / 100) * endKg) status = 'fluctuating';
  else status = 'plateau';

  res.status = status;
  res.slopeKgPerWeek = round2(slope);
  res.slopePctPerWeek = round2(slopePct);
  res.changeKg = round2(endKg - startKg);
  res.rangeKg = round2(rangeKg);
  res.startKg = round2(startKg);
  res.endKg = round2(endKg);
  res.actualLossKg = round2(startKg - endKg);

  // Expected loss from logged energy balance, on each day's own trend weight.
  const profile = challenge.profile;
  const workout = (challenge.steps || []).find((s) => s.type === 'workout');
  if (profile && food && res.loggedFoodDays > 0) {
    let total = 0;
    for (let d = from; d < today; d = addDays(d, 1)) {
      const meals = mealsOf(daysMap[d], food.id);
      if (meals.length === 0) continue;
      const t = trendOnOrBefore(smoothed, d);
      if (!t) continue;
      const w = workout && daysMap[d].steps && daysMap[d].steps[workout.id];
      const burn = w && Number.isFinite(w.burn) ? w.burn : 0;
      total += (tdee({ ...profile, startWeightKg: t.trendKg }) + burn - mealsTotal(meals)) / KCAL_PER_KG;
    }
    res.expectedLossKg = round2(total);
    res.gapKg = round2(total - res.actualLossKg);
  }

  // Walk back while the trend stays within the stall band of where it ends.
  if (status !== 'losing') {
    const band = (STALL_BAND_PCT / 100) * endKg;
    let since = smoothed[smoothed.length - 1].date;
    for (let i = smoothed.length - 1; i >= 0; i--) {
      if (Math.abs(smoothed[i].trendKg - endKg) <= band) since = smoothed[i].date; else break;
    }
    res.stalledSince = since;
  }
  return res;
}

// Stalled = at least 5 green days in the last 7 and the trend hasn't fallen
// more than 0.1 % over those 7 days.
export function weekCheck(challenge, daysMap, today, opts = {}) {
  const start = startOf(daysMap, opts);
  const out = { stalled: false, greenDays: 0, changeKg: null };
  if (!start) return out;
  const from = addDays(today, -6) < start ? start : addDays(today, -6);
  const flex = flexDates(challenge, start, daysMap, today);
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if (dayStatus(d, daysMap[d], challenge, today, flex) === 'green') out.greenDays++;
  }
  const smoothed = smoothWeights(weightSeries(challenge, daysMap).filter((p) => p.date >= start && p.date <= today));
  const pts = smoothed.filter((p) => p.date >= from);
  if (pts.length < 2) return out;
  const first = pts[0].trendKg;
  const last = pts[pts.length - 1].trendKg;
  out.changeKg = round2(last - first);
  const pct = ((last - first) / first) * 100;
  out.stalled = out.greenDays >= WEEK_CHECK_MIN_GREEN && pct > WEEK_CHECK_MAX_CHANGE_PCT;
  return out;
}

// ---------- eating patterns ----------

function feelTagsOf(meal) {
  const f = meal && meal.feel;
  if (typeof f === 'string' && f) return [f];
  if (Array.isArray(f)) return f.filter((t) => typeof t === 'string' && t);
  return [];
}

function isWeekend(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return wd === 0 || wd === 6;
}

export function eatingPatterns(challenge, daysMap, today, opts = {}) {
  const days = opts.days === undefined ? 28 : opts.days;
  const start = startOf(daysMap, opts);
  const food = foodStep(challenge);
  const out = {
    topDishes: [], lateKcalPct: null, weekendVsWeekdayKcal: { weekday: null, weekend: null },
    proteinGPerKg: null, carbPctOfKcal: null, fiberAvgG: null, avgMealsPerDay: null,
    nextDayBumps: [], feelTags: {},
  };
  if (!start || !food) return out;
  const from = addDays(today, -(days - 1)) < start ? start : addDays(today, -(days - 1));

  const dishes = new Map(); // norm -> { dish, count, kcal, dates:Set }
  const tags = new Map(); // tag -> { count, dishes: Map }
  const loggedDates = [];
  let timedKcal = 0;
  let lateKcal = 0;
  let wkdayKcal = 0; let wkdayN = 0; let wkendKcal = 0; let wkendN = 0;
  let protein = 0; let carbs = 0; let fiber = 0; let kcalAll = 0; let mealCount = 0;

  for (let d = from; d <= today; d = addDays(d, 1)) {
    const meals = mealsOf(daysMap[d], food.id);
    if (meals.length === 0) continue;
    loggedDates.push(d);
    const total = mealsTotal(meals);
    const mac = mealsMacros(meals);
    kcalAll += total; protein += mac.protein; carbs += mac.carbs; fiber += mac.fiber; mealCount += meals.length;
    if (isWeekend(d)) { wkendKcal += total; wkendN++; } else { wkdayKcal += total; wkdayN++; }
    for (const m of meals) {
      const kcal = Number.isFinite(m.calories) ? m.calories : 0;
      if (Number.isFinite(m.at)) {
        timedKcal += kcal;
        if (new Date(m.at).getHours() >= LATE_HOUR) lateKcal += kcal;
      }
      const key = normDish(m.dish);
      if (key) {
        const rec = dishes.get(key) || { dish: String(m.dish).trim(), count: 0, kcal: 0, dates: new Set() };
        rec.count++; rec.kcal += kcal; rec.dates.add(d);
        dishes.set(key, rec);
      }
      for (const tag of feelTagsOf(m)) {
        const t = tags.get(tag) || { count: 0, dishes: new Map() };
        t.count++;
        if (key) t.dishes.set(key, { dish: String(m.dish).trim(), n: (t.dishes.get(key)?.n || 0) + 1 });
        tags.set(tag, t);
      }
    }
  }

  const byCount = (a, b) => b.count - a.count || (a.dish < b.dish ? -1 : 1);
  out.topDishes = [...dishes.values()]
    .map((r) => ({ dish: r.dish, count: r.count, avgKcal: Math.round(r.kcal / r.count) }))
    .sort(byCount).slice(0, 15);

  if (timedKcal > 0) out.lateKcalPct = Math.round((lateKcal / timedKcal) * 100);
  out.weekendVsWeekdayKcal = {
    weekday: wkdayN ? Math.round(wkdayKcal / wkdayN) : null,
    weekend: wkendN ? Math.round(wkendKcal / wkendN) : null,
  };
  const n = loggedDates.length;
  if (n > 0) {
    const smoothed = smoothWeights(weightSeries(challenge, daysMap).filter((p) => p.date >= start && p.date <= today));
    const latest = smoothed.length ? smoothed[smoothed.length - 1].trendKg : null;
    if (latest) out.proteinGPerKg = round2(protein / n / latest);
    if (kcalAll > 0) out.carbPctOfKcal = Math.round((carbs * 4 / kcalAll) * 100);
    out.fiberAvgG = round1(fiber / n);
    out.avgMealsPerDay = round1(mealCount / n);
  }

  // Next-day weight bumps: dishes eaten on a day whose next morning's raw
  // weight rose clearly more than on days without that dish. Needs a weigh-in
  // on both days and at least 3 such pairs per dish.
  const raw = {};
  for (const p of weightSeries(challenge, daysMap)) raw[p.date] = p.kg;
  const pairs = [];
  for (const d of loggedDates) {
    const next = addDays(d, 1);
    if (raw[d] === undefined || raw[next] === undefined) continue;
    const eaten = new Set(mealsOf(daysMap[d], food.id).map((m) => normDish(m.dish)).filter(Boolean));
    pairs.push({ delta: raw[next] - raw[d], eaten });
  }
  const bumps = [];
  for (const [key, rec] of dishes) {
    if (rec.count < 3) continue;
    const withD = pairs.filter((p) => p.eaten.has(key));
    const without = pairs.filter((p) => !p.eaten.has(key));
    if (withD.length < 3 || without.length === 0) continue;
    const mean = (xs) => xs.reduce((a, p) => a + p.delta, 0) / xs.length;
    const bump = mean(withD) - mean(without);
    if (bump >= 0.3 - 1e-9) bumps.push({ dish: rec.dish, n: withD.length, bumpKg: round2(bump) });
  }
  out.nextDayBumps = bumps.sort((a, b) => b.bumpKg - a.bumpKg).slice(0, 6);

  for (const [tag, t] of tags) {
    out.feelTags[tag] = {
      count: t.count,
      topDishes: [...t.dishes.values()].sort((a, b) => b.n - a.n || (a.dish < b.dish ? -1 : 1)).slice(0, 3).map((x) => x.dish),
    };
  }
  return out;
}

// ---------- hooks for later releases ----------

// R2 replaces this with a real check (a running diet break hides the coach
// card, since the diet-break banner takes its place). Always false in R1.
export function isDietBreakActive(challenge) { // eslint-disable-line no-unused-vars
  return false;
}
