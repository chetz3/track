// Pure logic for AI meal suggestions (see
// docs/superpowers/plans/2026-09-30-meal-suggestions.md). No DOM, no
// IndexedDB, no network — everything here takes plain data in and returns
// plain data out, so it can be unit tested (tests/mealPlan.test.js). The
// Gemini network call lives in js/gemini.js; the UI wiring (the "Suggest
// tomorrow's meals" button, the plan sheet, the "Today's plan" row) lives in
// js/ui/today.js.

import { addDays } from './rules.js';
import { mealsTotal, mealsMacros } from './foodLogic.js';
import { latestBodyWeightKg } from './fitness.js';
import { normDish } from './dish.js';
import { reviewIsFresh } from './coach.js';

// ---------- canSuggest ----------

// Enabled when the 7 days ending on `today` (inclusive) contain at least one
// day with >= 3 logged meals on the food step — see docs §1. `foodStepId` is
// the challenge's food step id (there's only ever one); no food step at all
// means suggestions are never available.
export function canSuggest(daysMap, foodStepId, today) {
  if (!foodStepId || !daysMap) return false;
  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, -i);
    const meals = daysMap[date] && daysMap[date].steps && daysMap[date].steps[foodStepId] && daysMap[date].steps[foodStepId].meals;
    if (Array.isArray(meals) && meals.length >= 3) return true;
  }
  return false;
}

// ---------- body check text (fallback to BMI-only when there's no real
// weekly check yet — see docs §3's "without a Body photo" case, and §8.1's
// "when it's off, only food data plus profile BMI is used") ----------

// Rounds a BMI (or any 1-decimal display value) the same way everywhere.
function round1(n) {
  return Math.round(n * 10) / 10;
}

// `challenge.bodyCheck` verbatim when it exists (the real, possibly
// photo-informed weekly check — see js/gemini.js's checkBody); otherwise a
// locally-computed BMI-only stand-in, never a network call. null when there's
// no profile (height) to compute a BMI from at all.
export function bodyCheckText(challenge, daysMap) {
  if (challenge.bodyCheck) return challenge.bodyCheck;
  const profile = challenge.profile;
  if (!profile || !Number.isFinite(profile.heightCm) || profile.heightCm <= 0) return null;
  const kg = latestBodyWeightKg(challenge, daysMap, profile);
  if (!Number.isFinite(kg)) return null;
  const heightM = profile.heightCm / 100;
  return {
    bmi: round1(kg / (heightM * heightM)),
    build: null,
    bellyFat: null,
    note: 'Estimated from height and weight only — no body photo shared.',
    focus: [],
  };
}

// ---------- suggestion input (what's sent to Gemini for one call) ----------

// day.steps[stepId].value for a plain typed step (workout/steps/water/sleep),
// or null when the challenge has no step of that type / nothing logged yet.
function stepValue(day, stepId) {
  const entry = stepId && day && day.steps && day.steps[stepId];
  return entry && Number.isFinite(entry.value) ? entry.value : null;
}

function findStep(challenge, type) {
  return (challenge.steps || []).find((s) => s.type === type) || null;
}

// One row of `[dish, kcal, protein_g, carbs_g, fat_g, fiber_g]` per logged
// meal — the compact shape §4 asks for.
function mealTuples(meals) {
  return (Array.isArray(meals) ? meals : []).map((m) => {
    const macros = m.macros || {};
    return [
      m.dish || '',
      Number.isFinite(m.calories) ? m.calories : 0,
      Number.isFinite(macros.protein) ? macros.protein : 0,
      Number.isFinite(macros.carbs) ? macros.carbs : 0,
      Number.isFinite(macros.fat) ? macros.fat : 0,
      Number.isFinite(macros.fiber) ? macros.fiber : 0,
    ];
  });
}

// ---------- R3 additions: variety, dish frequency, coach ----------

export const VARIETY_VALUES = ['familiar', 'balanced', 'explore'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function clockOf(at) {
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// [[dish, count]] over the `days` days ending `today` (inclusive), most
// eaten first (ties: first seen). Dishes are grouped with normDish; the
// first spelling seen is the display name.
export function dishFrequency(foodStep, daysMap, today, days = 14) {
  const byNorm = new Map();
  if (!foodStep) return [];
  for (let i = days - 1; i >= 0; i--) {
    const entry = daysMap && daysMap[addDays(today, -i)] && daysMap[addDays(today, -i)].steps && daysMap[addDays(today, -i)].steps[foodStep.id];
    for (const m of (entry && Array.isArray(entry.meals) ? entry.meals : [])) {
      const key = normDish(m && m.dish);
      if (!key) continue;
      const cur = byNorm.get(key);
      if (cur) cur[1] += 1; else byNorm.set(key, [String(m.dish).trim(), 1]);
    }
  }
  return [...byNorm.values()].sort((a, b) => b[1] - a[1]);
}

// Dish names from challenge.mealPlanHistory (newest plans last), tolerant of
// junk entries (backups are loosely validated).
export function recentPlanDishes(history) {
  const out = [];
  for (const h of Array.isArray(history) ? history : []) {
    for (const d of (h && Array.isArray(h.dishes) ? h.dishes : [])) if (typeof d === 'string' && d.trim()) out.push(d.trim());
  }
  return out;
}

// New history array with this plan appended: {date, dishes}, capped at the
// last 3. Regenerating the same date ("New ideas") replaces that day's entry
// instead of filling the cap with drafts of one day.
export function pushPlanHistory(history, forDate, dishes) {
  const kept = (Array.isArray(history) ? history : []).filter((h) => h && h.date !== forDate);
  kept.push({ date: forDate, dishes: (dishes || []).filter((d) => typeof d === 'string' && d.trim()) });
  return kept.slice(-3);
}

// What a fresh, enabled plateau review feeds into suggestions, else null.
export function coachFromReview(review, today) {
  if (!reviewIsFresh(review, today)) return null;
  const fc = review.food_changes || {};
  const mistakes = (review.mistakes || []).filter((m) => m && m.what).map((m) => (m.fix ? `${m.what} → ${m.fix}` : m.what));
  return {
    mistakes,
    whats: (review.mistakes || []).filter((m) => m && m.what).map((m) => m.what),
    food_changes: { add: fc.add || [], reduce: fc.reduce || [], swap: (fc.swap || []).map((x) => `${x.from} → ${x.to}`) },
    new_local_foods: (review.new_local_foods || []).map((f) => f && f.dish).filter(Boolean),
    maintenance: review.maintenance && review.maintenance.action ? review.maintenance.action : null,
    reviewDate: review.date,
  };
}

// Builds the whole payload for one meal-suggestion call: the profile,
// today's food targets, the last 7 days (today inclusive) of meals/workout/
// steps/water/sleep, and the body check text. `today` is the date the
// suggestion is being made from (the resulting plan is for the day after).
export function buildSuggestionInput(challenge, daysMap, today, pref, variety) {
  const profile = challenge.profile || {};
  const foodStep = findStep(challenge, 'food');
  const workoutStep = findStep(challenge, 'workout');
  const stepsStep = findStep(challenge, 'steps');
  const waterStep = findStep(challenge, 'water');
  const sleepStep = findStep(challenge, 'sleep');

  const targets = foodStep ? {
    kcal: foodStep.goal ? foodStep.goal.target : null,
    protein: foodStep.macros && foodStep.macros.protein ? foodStep.macros.protein.target : null,
    carbs: foodStep.macros && foodStep.macros.carbs ? foodStep.macros.carbs.target : null,
    fat: foodStep.macros && foodStep.macros.fat ? foodStep.macros.fat.target : null,
    fiber: foodStep.macros && foodStep.macros.fiber ? foodStep.macros.fiber.target : null,
  } : null;

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const day = daysMap && daysMap[date];
    const meals = foodStep && day && day.steps && day.steps[foodStep.id] && day.steps[foodStep.id].meals;
    last7Days.push({
      date,
      meals: mealTuples(meals),
      totalKcal: mealsTotal(meals),
      targetKcal: targets ? targets.kcal : null,
      workoutMinutes: workoutStep ? stepValue(day, workoutStep.id) : null,
      workoutKcal: workoutStep && day && day.steps && day.steps[workoutStep.id] && Number.isFinite(day.steps[workoutStep.id].burn)
        ? day.steps[workoutStep.id].burn
        : null,
      steps: stepsStep ? stepValue(day, stepsStep.id) : null,
      waterL: waterStep ? stepValue(day, waterStep.id) : null,
      sleepH: sleepStep ? stepValue(day, sleepStep.id) : null,
    });
  }

  // Yesterday's food gaps + the unique dishes of the last 7 days (style
  // reference only — the prompt forbids repeating yesterday's dishes).
  const yesterday = addDays(today, -1);
  const yEntry = foodStep && daysMap && daysMap[yesterday] && daysMap[yesterday].steps && daysMap[yesterday].steps[foodStep.id];
  const yMeals = yEntry && Array.isArray(yEntry.meals) ? yEntry.meals : [];
  const seen = new Set();
  const recentDishes = [];
  for (const d of last7Days) {
    for (const t of d.meals) {
      const key = String(t[0]).trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); recentDishes.push(t[0]); }
    }
  }

  const coach = coachFromReview(challenge.plateauReview, today);
  const [, tm] = String(today).split('-').map(Number);
  return {
    pref: pref || null,
    month: MONTH_NAMES[(tm || 1) - 1] || '',
    variety: VARIETY_VALUES.includes(variety) ? variety : 'balanced',
    dishFrequency: dishFrequency(foodStep, daysMap, today, 14),
    recentPlans: recentPlanDishes(challenge.mealPlanHistory),
    coach,
    yesterday: {
      meals: yMeals.map((m) => {
        const mac = m.macros || {};
        const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
        const t = [String(m.dish || ''), n(m.calories), n(mac.protein), n(mac.carbs), n(mac.fat), n(mac.fiber), clockOf(m.at)];
        while (t.length > 1 && t[t.length - 1] === null) t.pop();
        return t;
      }),
      dishes: yMeals.map((m) => m.dish || '').filter(Boolean),
      gaps: dayGaps(yEntry, foodStep, targets ? targets.kcal : null),
    },
    recentDishes,
    profile: {
      sex: profile.sex || null,
      age: Number.isFinite(profile.age) ? profile.age : null,
      heightCm: Number.isFinite(profile.heightCm) ? profile.heightCm : null,
      currentWeightKg: latestBodyWeightKg(challenge, daysMap, profile) ?? null,
      targetWeightKg: Number.isFinite(profile.targetWeightKg) ? profile.targetWeightKg : null,
      aim: profile.aim || null,
      location: profile.location || '',
      cuisine: profile.cuisine || '',
      diet: profile.diet || null,
      avoid: profile.avoid || '',
      // schedule (docs §9) replaces the old mealsPerDay field: the AI plan
      // must use exactly these slots — same count, names and times — and
      // (for intermittent fasting) never suggest food outside the window.
      schedule: scheduleOf(profile),
    },
    targets,
    last7Days,
    bodyCheck: bodyCheckText(challenge, daysMap),
  };
}

// ---------- what the suggest prompt actually sends (docs §12.1) ----------

export const SUGGEST_FREQ_ROWS = 20;

// Compact data block for suggestPrompt: {y, gaps, freq, recent, avoid, coach?}.
// `extraRecent` (the previous plan's dishes on "New ideas") is merged into
// `recent`. profile is only {cuisine, location, diet}; slots, window and
// targets are inlined in the prompt rules instead. Does not mutate `input`.
export function compactSuggestInput(input, extraRecent) {
  const recent = [];
  const seen = new Set();
  for (const d of [...(input.recentPlans || []), ...(Array.isArray(extraRecent) ? extraRecent : [])]) {
    const k = normDish(d);
    if (k && !seen.has(k)) { seen.add(k); recent.push(d); }
  }
  const p = input.profile || {};
  const out = {
    profile: { cuisine: p.cuisine || '', location: p.location || '', diet: p.diet || null },
    y: (input.yesterday && input.yesterday.meals) || [],
    gaps: ((input.yesterday && input.yesterday.gaps) || []).filter((g) => g.status !== 'ok').map((g) => [g.key, g.actual, g.target, g.status]),
    freq: (input.dishFrequency || []).slice(0, SUGGEST_FREQ_ROWS),
    recent,
  };
  if (p.avoid) out.avoid = p.avoid;
  const c = input.coach;
  if (c) {
    const changes = {};
    const fc = c.food_changes || {};
    if (fc.add && fc.add.length) changes.add = fc.add;
    if (fc.reduce && fc.reduce.length) changes.reduce = fc.reduce;
    if (fc.swap && fc.swap.length) changes.swap = fc.swap;
    out.coach = { mistakes: c.mistakes, changes, foods: c.new_local_foods };
  }
  return out;
}

// ---------- diet preference (meal suggest v2 §2) ----------

// The choices offered in the suggest sheet for each profile.diet, default
// first. `fixed` means there's nothing to choose (no selector shown).
// 'veg' is what the profile stores for Vegetarian.
export function prefOptions(diet) {
  if (diet === 'nonveg') return { options: [{ value: 'mix', label: 'Mix' }, { value: 'nonveg', label: 'Non-veg' }, { value: 'veg', label: 'Veg' }], default: 'mix', fixed: false };
  if (diet === 'eggetarian') return { options: [{ value: 'egg', label: 'Egg' }, { value: 'veg', label: 'Veg' }], default: 'egg', fixed: false };
  if (diet === 'vegan') return { options: [{ value: 'vegan', label: 'Vegan' }], default: 'vegan', fixed: true };
  return { options: [{ value: 'veg', label: 'Veg' }], default: 'veg', fixed: true };
}

// ---------- yesterday's gaps (meal suggest v2 §3) ----------

const GAP_KEYS = [['kcal', 'atMost'], ['protein', 'atLeast'], ['carbs', 'atMost'], ['fat', 'atMost'], ['fiber', 'atLeast']];

// [{ key, target, actual, status }] for one day's food entry. atLeast goals
// (protein, fiber) are 'short' under 90% of target; atMost goals (kcal,
// carbs, fat) are 'over' above target. Keys without a target are skipped.
export function dayGaps(entry, foodStep, kcalTarget) {
  const meals = entry && Array.isArray(entry.meals) ? entry.meals : [];
  const macros = mealsMacros(meals);
  const actuals = { kcal: mealsTotal(meals), ...macros };
  const gaps = [];
  for (const [key, dir] of GAP_KEYS) {
    const target = key === 'kcal' ? kcalTarget : (foodStep && foodStep.macros && foodStep.macros[key] ? foodStep.macros[key].target : null);
    if (!Number.isFinite(target) || target <= 0) continue;
    const actual = actuals[key];
    let status = 'ok';
    if (dir === 'atLeast' && actual < target * 0.9) status = 'short';
    if (dir === 'atMost' && actual > target) status = 'over';
    gaps.push({ key, target, actual, status });
  }
  return gaps;
}

// ---------- meal schedule (docs §9) ----------
//
// profile.schedule = { pattern: 'regular'|'if', meals: 2..5, fast, windowStart, slots }
// replaces the old profile.mealsPerDay. `slots` (an array of { name, time })
// is the source of truth for what a day actually shows — defaultSlots/ifSlots
// below only ever *generate* it (on profile creation, or when the user
// changes pattern/meal count/fast/window start in js/ui/challenges.js);
// once generated, each slot's time can be edited individually without
// regenerating the rest.

const REGULAR_DEFAULTS = {
  2: [['Lunch', '12:30'], ['Dinner', '19:30']],
  3: [['Breakfast', '08:30'], ['Lunch', '13:30'], ['Dinner', '20:00']],
  4: [['Breakfast', '08:30'], ['Lunch', '13:00'], ['Snack', '16:30'], ['Dinner', '20:00']],
  5: [['Breakfast', '08:00'], ['Snack', '10:30'], ['Lunch', '13:00'], ['Snack', '16:30'], ['Dinner', '20:00']],
};

// Default slot names/times for a Regular eating pattern with `schedule.meals`
// meals (2..5, defaulting to 3 for anything else) — see docs §9.
export function defaultSlots(schedule) {
  const meals = schedule && REGULAR_DEFAULTS[schedule.meals] ? schedule.meals : 3;
  return REGULAR_DEFAULTS[meals].map(([name, time]) => ({ name, time }));
}

// Eating-window length in hours for each `fast` value (docs §9). OMAD's
// "window" is nominal — it's always exactly one meal — but a short window is
// still useful for eatingWindow()'s display line.
const WINDOW_HOURS = { '16:8': 8, '18:6': 6, '20:4': 4, omad: 1 };

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function toHHMM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Spreads `meals` slots evenly inside the fasting window that starts at
// `windowStart` and is WINDOW_HOURS[fast] long, with the *last* meal 30
// minutes before the window closes (docs §9: "16:8 from 12:00 gives Meal 1
// at 12:00 and Meal 2 at 19:30"). One meal (OMAD, or `meals` explicitly 1)
// is placed right at the window start.
export function ifSlots(fast, windowStart, meals) {
  const startMin = toMinutes(windowStart || '12:00');
  const n = Number.isInteger(meals) && meals > 0 ? meals : (fast === 'omad' ? 1 : 2);
  if (n <= 1) return [{ name: 'Meal 1', time: toHHMM(startMin) }];
  const windowMin = (WINDOW_HOURS[fast] ?? 8) * 60;
  const lastOffset = Math.max(0, windowMin - 30);
  const step = lastOffset / (n - 1);
  return Array.from({ length: n }, (_, i) => ({ name: `Meal ${i + 1}`, time: toHHMM(startMin + step * i) }));
}

// { start, end } of the eating window, HH:MM — intermittent fasting only
// (docs §9's Decisions #2: shown on Today for IF only). null for a Regular
// schedule, or when there's no schedule at all.
export function eatingWindow(schedule) {
  if (!schedule || schedule.pattern !== 'if') return null;
  const startMin = toMinutes(schedule.windowStart || '12:00');
  const durMin = (WINDOW_HOURS[schedule.fast] ?? 8) * 60;
  return { start: toHHMM(startMin), end: toHHMM(startMin + durMin) };
}

function fmtDuration(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// "Eating window 12:00–20:00 · opens in 2h" / "· open · closes in 3h" /
// "· closed" — computed fresh at render time from the schedule and the
// current HH:MM, no timers (docs §9's Decisions #2). '' for a Regular
// schedule (see eatingWindow). Known simplification: a window that crosses
// midnight (a very late windowStart) is only handled for the early-morning
// tail of *that same* window, not a full day-boundary walk — good enough
// for the realistic 4-8h fasting windows this is built for.
export function windowStatus(schedule, nowHHMM) {
  const win = eatingWindow(schedule);
  if (!win) return '';
  const startMin = toMinutes(win.start);
  const durMin = (WINDOW_HOURS[schedule.fast] ?? 8) * 60;
  const endMinRaw = startMin + durMin;
  const nowMin = toMinutes(nowHHMM);
  const label = `Eating window ${win.start}–${win.end}`;

  const openNow = (nowMin >= startMin && nowMin < endMinRaw) || (endMinRaw > 1440 && nowMin < endMinRaw - 1440);
  if (openNow) {
    const closesIn = nowMin >= startMin ? endMinRaw - nowMin : (endMinRaw - 1440) - nowMin;
    return `${label} · open · closes in ${fmtDuration(closesIn)}`;
  }
  if (nowMin < startMin) return `${label} · opens in ${fmtDuration(startMin - nowMin)}`;
  return `${label} · closed`;
}

// profile.schedule if it's already the new shape, else a Regular schedule
// migrated from the legacy profile.mealsPerDay (defaulting to 4) — used
// wherever a schedule is read (the AI prompt, Today's placeholder list) so
// a profile saved before this feature existed never crashes anything.
export function scheduleOf(profile) {
  if (profile && profile.schedule && Array.isArray(profile.schedule.slots) && profile.schedule.slots.length) {
    return profile.schedule;
  }
  const legacyMeals = profile && REGULAR_DEFAULTS[profile.mealsPerDay] ? profile.mealsPerDay : 4;
  const schedule = { pattern: 'regular', meals: legacyMeals, fast: '16:8', windowStart: '12:00' };
  return { ...schedule, slots: defaultSlots(schedule) };
}

// ---------- planned-meal placeholders (docs §9's Decisions #1) ----------
//
// A placeholder (day.steps[food].planned[i]) is never counted toward
// calories/macros/green — see js/foodLogic.js's buildFoodPatch, which only
// ever derives value/macros from logged `meals`. Its only state is whether a
// logged meal has been linked to it (`meal.plannedId === planned.id`).

// { status: 'planned'|'logged', label, actualKcal } for one placeholder.
// `actualKcal` is the linked meal's calories once logged, else null.
export function placeholderStatus(planned, meals) {
  const matched = (Array.isArray(meals) ? meals : []).find((m) => m && m.plannedId === planned.id);
  if (!matched) return { status: 'planned', label: 'Planned', actualKcal: null };
  return { status: 'logged', label: 'Logged', actualKcal: Number.isFinite(matched.calories) ? matched.calories : 0 };
}

// ---------- parsing Gemini's response (schema per docs §5) ----------

function clampInt(n, max) {
  const rounded = Math.round(Number(n));
  if (!Number.isFinite(rounded)) return 0;
  return Math.min(max, Math.max(0, rounded));
}

export const INGREDIENT_UNITS = ['g', 'ml', 'pcs', 'tbsp', 'tsp', 'cup', 'bunch'];
export const INGREDIENT_CATEGORIES = [
  ['vegetables', 'Vegetables'], ['fruits', 'Fruits'], ['dairy', 'Dairy'], ['meat_fish_eggs', 'Meat, fish & eggs'],
  ['grains', 'Grains'], ['pulses', 'Pulses'], ['spices_oils', 'Spices & oils'], ['other', 'Other'],
];

// Keeps well-formed ingredients (name + positive qty), clamps qty, and
// falls back to unit 'pcs' / category 'other' for unknown values. Anything
// that isn't an array (an old saved plan) gives [].
function parseIngredients(list) {
  if (!Array.isArray(list)) return [];
  const cats = new Set(INGREDIENT_CATEGORIES.map((c) => c[0]));
  const out = [];
  for (const i of list.slice(0, 20)) {
    if (!i || typeof i.name !== 'string' || !i.name.trim()) continue;
    const qty = Math.round(Number(i.qty) * 10) / 10;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      name: i.name.trim().slice(0, 60),
      qty: Math.min(5000, qty),
      unit: INGREDIENT_UNITS.includes(i.unit) ? i.unit : 'pcs',
      category: cats.has(i.category) ? i.category : 'other',
    });
  }
  return out;
}

// Stable key for an aggregated grocery item (also what challenge.mealPlan.have stores).
export function groceryKey(name, unit) {
  return `${String(name).trim().toLowerCase()}|${unit}`;
}

// Sums ingredients across meals by lower-cased name + unit (different units
// stay separate), grouped by category in a fixed order; empty categories are dropped.
export function groceryList(meals) {
  const byKey = new Map();
  for (const m of Array.isArray(meals) ? meals : []) {
    for (const i of (m && Array.isArray(m.ingredients) ? m.ingredients : [])) {
      const key = groceryKey(i.name, i.unit);
      const cur = byKey.get(key);
      if (cur) cur.qty += i.qty;
      else byKey.set(key, { name: i.name, qty: i.qty, unit: i.unit, category: i.category });
    }
  }
  return INGREDIENT_CATEGORIES.map(([category, label]) => ({
    category,
    label,
    items: [...byKey.values()].filter((i) => i.category === category)
      .map((i) => ({ name: i.name, qty: Math.round(i.qty * 10) / 10, unit: i.unit })),
  })).filter((g) => g.items.length);
}

// Validates and normalises the JSON Gemini returns for a meal suggestion.
// Never trusts a network response blindly — same spirit as
// js/foodLogic.js's parseCalorieResult. Throws on a shape that doesn't match.
export function parseMealPlan(json, ctx) {
  const known = ctx && Array.isArray(ctx.known) ? new Set(ctx.known.map(normDish).filter(Boolean)) : null;
  if (!json || typeof json !== 'object' || !Array.isArray(json.meals)) {
    throw new Error('Unexpected response from Gemini');
  }
  const meals = json.meals.map((m) => {
    if (!m || typeof m !== 'object' || typeof m.slot !== 'string' || typeof m.dish !== 'string' || typeof m.portion !== 'string') {
      throw new Error('Unexpected response from Gemini');
    }
    return {
      slot: m.slot,
      dish: m.dish,
      portion: m.portion,
      kcal: clampInt(m.kcal, 3000),
      protein: clampInt(m.protein_g, 500),
      carbs: clampInt(m.carbs_g, 500),
      fat: clampInt(m.fat_g, 500),
      fiber: clampInt(m.fiber_g, 500),
      swapFor: typeof m.swap_for === 'string' ? m.swap_for : '',
      ingredients: parseIngredients(m.ingredients),
      // Recomputed in code against what they eat/were planned, never trusted
      // from the model. Only set when the caller knows the history.
      ...(known ? { isNew: !known.has(normDish(m.dish)) } : {}),
      ...(typeof m.local_note === 'string' && m.local_note.trim() ? { localNote: m.local_note.trim().slice(0, 60) } : {}),
    };
  });
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : []);
  return { meals, why: strings(json.why), tips: strings(json.tips), fixes: strings(json.fixes) };
}

// Sum of a plan's meals, each key rounded to an integer — mirrors
// js/foodLogic.js's mealsMacros/mealsTotal, but over a meal *plan* (kcal +
// the 4 macros in one totals object) rather than logged day entries.
export function planTotals(plan) {
  const meals = (plan && Array.isArray(plan.meals)) ? plan.meals : [];
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const m of meals) {
    totals.kcal += Number.isFinite(m.kcal) ? m.kcal : 0;
    totals.protein += Number.isFinite(m.protein) ? m.protein : 0;
    totals.carbs += Number.isFinite(m.carbs) ? m.carbs : 0;
    totals.fat += Number.isFinite(m.fat) ? m.fat : 0;
    totals.fiber += Number.isFinite(m.fiber) ? m.fiber : 0;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key]);
  return totals;
}

// A one-line warning when the plan's total kcal lands outside the food
// target's ±10% band — shown, never rejected (see docs §5). null when
// there's no target to compare against, or the total is within band.
export function kcalWarning(totalKcal, targetKcal) {
  if (!Number.isFinite(targetKcal) || targetKcal <= 0 || !Number.isFinite(totalKcal)) return null;
  if (totalKcal >= targetKcal * 0.9 && totalKcal <= targetKcal * 1.1) return null;
  return `This plan totals ${totalKcal} kcal, outside your ${targetKcal} kcal target.`;
}
