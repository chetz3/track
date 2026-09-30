// Pure logic for food-photo steps. No DOM, no IndexedDB — everything here
// takes plain data in and returns plain data out, so it can be unit tested
// (tests/food.test.js). The Gemini network call lives in js/gemini.js; the
// UI wiring (photo picker, confirm sheet, meal rows) lives in js/ui/today.js.

// A food step is an ordinary step with `type: 'food'` and this fixed
// `number` shape, so the existing Stats trend chart, average, day summaries
// and backup validator all work unchanged (see js/chartMath.js,
// js/backup.js). showSum/showDiff are off — a running calorie total/change
// isn't meaningful the way it is for weight or distance — but showAvg is on.
export const FOOD_NUMBER = {
  label: 'Calories', unit: 'kcal', required: false, showSum: false, showDiff: false, showAvg: true,
};

export function makeFoodStep({ id, name, mandatory }) {
  return {
    id,
    name,
    mandatory,
    type: 'food',
    photo: 'none',
    note: 'none',
    number: { ...FOOD_NUMBER },
  };
}

export function isFoodStep(step) {
  return step?.type === 'food';
}

// ---------- macros (see docs §9) ----------

export const MACRO_KEYS = ['protein', 'carbs', 'fat', 'fiber'];
export const MACRO_META = {
  protein: { label: 'Protein', short: 'P' },
  carbs: { label: 'Carbs', short: 'C' },
  fat: { label: 'Fat', short: 'F' },
  fiber: { label: 'Fiber', short: 'Fib' },
};

// Fills in 0 for any missing/non-finite key — old meals and day entries
// saved before macros existed have no `macros` at all, and must still
// render and total as 0 without errors.
export function macrosOrZero(macros) {
  const out = {};
  for (const key of MACRO_KEYS) out[key] = macros && Number.isFinite(macros[key]) ? macros[key] : 0;
  return out;
}

// "P 30 · C 40 · F 10 · Fib 5 g" — the dot-separated macro summary shared by
// the meal row (Today) and the food trend's "Today" line (Stats).
export function macroDotLine(macros) {
  const m = macrosOrZero(macros);
  return MACRO_KEYS.map((key) => `${MACRO_META[key].short} ${m[key]}`).join(' · ') + ' g';
}

// "P 30g C 40g F 10g Fib 5g" — the space-separated, per-value macro summary
// used on the food confirm sheet (item lines and the totals line).
export function macroInlineLine(macros) {
  const m = macrosOrZero(macros);
  return MACRO_KEYS.map((key) => `${MACRO_META[key].short} ${m[key]}g`).join(' ');
}

// Sum of a day entry's logged meals' macros, each key rounded to an integer.
// All-zero for an empty/missing list, same as mealsTotal.
export function mealsMacros(meals) {
  const totals = { protein: 0, carbs: 0, fat: 0, fiber: 0 };
  if (!Array.isArray(meals)) return totals;
  for (const meal of meals) {
    const m = macrosOrZero(meal?.macros);
    for (const key of MACRO_KEYS) totals[key] += m[key];
  }
  for (const key of MACRO_KEYS) totals[key] = Math.round(totals[key]);
  return totals;
}

// Sum of a day entry's logged meals, rounded to an integer. 0 for an empty
// or missing list (a day with no meals yet, or a non-food step's entry).
export function mealsTotal(meals) {
  if (!Array.isArray(meals) || meals.length === 0) return 0;
  const sum = meals.reduce((total, m) => total + (Number.isFinite(m?.calories) ? m.calories : 0), 0);
  return Math.round(sum);
}

function clampCalories(n) {
  const rounded = Math.round(Number(n));
  if (!Number.isFinite(rounded)) return 0;
  return Math.min(5000, Math.max(0, rounded));
}

// Grams are clamped tighter than calories (0-500) — see docs §9's
// meal.macros. Missing/non-numeric (an older prompt/response with no macro
// fields) becomes 0 rather than throwing.
function clampGrams(n) {
  const rounded = Math.round(Number(n));
  if (!Number.isFinite(rounded)) return 0;
  return Math.min(500, Math.max(0, rounded));
}

function itemMacros(it) {
  return {
    protein: clampGrams(it.protein_g),
    carbs: clampGrams(it.carbs_g),
    fat: clampGrams(it.fat_g),
    fiber: clampGrams(it.fiber_g),
  };
}

function sumItemMacros(items) {
  const totals = { protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const it of items) {
    for (const key of MACRO_KEYS) totals[key] += it.macros[key];
  }
  for (const key of MACRO_KEYS) totals[key] = clampGrams(totals[key]);
  return totals;
}

// Validates and normalises the JSON Gemini returns (already schema-shaped by
// generationConfig.responseSchema, but never trust a network response blindly).
// Throws when the shape doesn't match what estimateCalories expects.
export function parseCalorieResult(json) {
  if (!json || typeof json !== 'object' || typeof json.is_food !== 'boolean') {
    throw new Error('Unexpected response from Gemini');
  }
  const rawItems = json.items;
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new Error('Unexpected response from Gemini');
  }
  const items = (rawItems || []).map((it) => {
    if (!it || typeof it !== 'object' || typeof it.name !== 'string' || typeof it.portion !== 'string') {
      throw new Error('Unexpected response from Gemini');
    }
    return { name: it.name, portion: it.portion, calories: clampCalories(it.calories), macros: itemMacros(it) };
  });
  const total = items.length > 0
    ? items.reduce((sum, it) => sum + it.calories, 0)
    : clampCalories(json.total_calories);
  // Sum over items when there are any; otherwise (an "add total only" style
  // response, or no items detected) fall back to the top-level total_*_g
  // fields — same fallback shape as `total`/total_calories above.
  const macros = items.length > 0
    ? sumItemMacros(items)
    : {
      protein: clampGrams(json.total_protein_g),
      carbs: clampGrams(json.total_carbs_g),
      fat: clampGrams(json.total_fat_g),
      fiber: clampGrams(json.total_fiber_g),
    };
  return {
    isFood: json.is_food,
    dish: typeof json.dish === 'string' ? json.dish : '',
    items,
    total,
    macros,
  };
}

// `value`/`macros` are always recomputed from `meals`, so callers never set
// them on their own — this is the only place a food day-entry patch is built.
// Deliberately never touches `entry.planned` (the day's meal-plan
// placeholders — see docs §9 and js/mealPlan.js's placeholderStatus): the
// patch this returns is merged onto the existing entry (js/storeLogic.js's
// applyStepPatch, `{...entry, ...patch}`), and since `planned` is never a
// key on the returned object, whatever placeholders the entry already has
// survive every logged-meal add/delete untouched. Placeholders themselves
// never count toward value/macros/done — those three are derived from
// `meals` alone.
export function buildFoodPatch(entry, meals) {
  return { meals, value: mealsTotal(meals), macros: mealsMacros(meals), done: meals.length > 0 };
}
