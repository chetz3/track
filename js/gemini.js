// AI calls: food-photo calorie estimation, next-day meal suggestions, and the
// weekly body check (see docs/superpowers/plans/2026-09-30-meal-suggestions.md).
// Called straight from the browser with fetch — there is no server. The
// request goes through js/ai/router.js, which tries Gemini, then Groq, then
// OpenRouter, using whichever keys the user saved on this device.

import { parseCalorieResult } from './foodLogic.js';
import { parseMealPlan, planTotals, kcalWarning, eatingWindow, compactSuggestInput, MEAL_STYLES, slotStyle } from './mealPlan.js';
import { REVIEW_SCHEMA, reviewPrompt, parseReview } from './coach.js';
import { askAI } from './ai/router.js';
import { PROVIDERS, getKey, setKey, clearKey, anyKey } from './ai/keys.js';

// Kept so older imports keep working; the key logic lives in js/ai/keys.js.
export const GEMINI_KEY_RE = PROVIDERS[0].keyRe;
export const KEY_STORAGE = PROVIDERS[0].storage;
export const getGeminiKey = () => getKey('gemini');
export const setGeminiKey = (key) => setKey('gemini', key);
export const clearGeminiKey = () => clearKey('gemini');

// True when an AI call can run: any saved key, or (dev host only) the
// ?mock=1 canned-answer mode, so the AI screens can be tested without a key.
export function aiAvailable() {
  if (anyKey()) return true;
  try {
    return localStorage.getItem('tracker:mockGemini') === '1'
      && /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(location.hostname);
  } catch (_) {
    return false;
  }
}

const PROMPT = `You are a nutrition estimator. Estimate the calories of the food in this photo.
- List each distinct food or drink with its visible portion (use plates, cutlery, hands for scale).
- Use standard nutrition values; include visible oil, butter, sauces and dressings.
- Give one best integer estimate per item, never a range. total_calories = sum of items.
- dish: a short name for the whole meal (max 5 words).
- Also estimate protein, carbs, fat and fiber in grams per item (integers); totals are sums.
- If there is no food or drink, set is_food=false, items=[], total_calories=0.
Respond only with JSON matching the schema.`;

// Same rules for a meal the user describes in words instead of a photo.
const TEXT_PROMPT = PROMPT
  .replace('the food in this photo.', 'the food the user describes below.')
  .replace('with its visible portion (use plates, cutlery, hands for scale).', 'with its portion; when none is given, assume one typical home serving.')
  .replace('include visible oil,', 'include the usual oil,');

const SCHEMA = {
  type: 'OBJECT',
  required: ['is_food', 'dish', 'total_calories', 'confidence', 'items'],
  properties: {
    is_food: { type: 'BOOLEAN' },
    dish: { type: 'STRING' },
    total_calories: { type: 'INTEGER' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    total_protein_g: { type: 'INTEGER' },
    total_carbs_g: { type: 'INTEGER' },
    total_fat_g: { type: 'INTEGER' },
    total_fiber_g: { type: 'INTEGER' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['name', 'portion', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
        properties: {
          name: { type: 'STRING' },
          portion: { type: 'STRING' },
          calories: { type: 'INTEGER' },
          protein_g: { type: 'INTEGER' },
          carbs_g: { type: 'INTEGER' },
          fat_g: { type: 'INTEGER' },
          fiber_g: { type: 'INTEGER' },
        },
      },
    },
  },
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// `blob` null = no photo: `note` is the user's description of what they ate.
export async function estimateCalories(blob, note) {
  const opts = { offlineMessage: "You're offline. Connect to add food.", parse: parseCalorieResult };
  if (!blob) return askAI([{ text: `${TEXT_PROMPT}\nWhat the user ate: ${note}` }], SCHEMA, opts);
  const data = await blobToBase64(blob);
  const text = PROMPT + (note ? `\nUser note about this meal: ${note}` : '');
  const parts = [
    { inline_data: { mime_type: blob.type || 'image/jpeg', data } },
    { text },
  ];
  return askAI(parts, SCHEMA, opts);
}

// Dev-only: prompt size, so the token budget can be watched in the console
// (about 4 characters per token). Never logs on the live site.
function logPromptSize(label, text, extra) {
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || /^192\.168\.|^10\./.test(h)) {
      console.log(`[gemini] ${label} prompt: ${text.length} chars ≈ ${Math.round(text.length / 4)} tokens${extra ? `; ${extra}` : ''}`);
    }
  } catch (_) { /* no location */ }
}

// ---------- meal suggestions (docs §2, §4, §5) ----------

const SUGGEST_SCHEMA = {
  type: 'OBJECT',
  required: ['meals', 'why', 'tips', 'fixes'],
  properties: {
    meals: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['slot', 'dish', 'portion', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
        properties: {
          slot: { type: 'STRING' },
          dish: { type: 'STRING' },
          portion: { type: 'STRING' },
          kcal: { type: 'INTEGER' },
          protein_g: { type: 'INTEGER' },
          carbs_g: { type: 'INTEGER' },
          fat_g: { type: 'INTEGER' },
          fiber_g: { type: 'INTEGER' },
          swap_for: { type: 'STRING' },
          is_new: { type: 'BOOLEAN' },
          local_note: { type: 'STRING' },
          ingredients: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['name', 'qty', 'unit', 'category'],
              properties: {
                name: { type: 'STRING' },
                qty: { type: 'NUMBER' },
                unit: { type: 'STRING', enum: ['g', 'ml', 'pcs', 'tbsp', 'tsp', 'cup', 'bunch'] },
                category: { type: 'STRING', enum: ['vegetables', 'fruits', 'dairy', 'meat_fish_eggs', 'grains', 'pulses', 'spices_oils', 'other'] },
              },
            },
          },
        },
      },
    },
    why: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: { type: 'ARRAY', items: { type: 'STRING' } },
    fixes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
};

// The diet preference as a hard rule for the prompt (meal suggest v2 §2),
// shortened for the R3 prompt (docs §12.1).
const PREF_RULES = {
  veg: 'Veg only: no meat, fish or egg.',
  vegan: 'Vegan only: no meat, fish, egg, dairy or honey.',
  egg: 'Egg diet: veg plus eggs; no meat or fish.',
  nonveg: 'Non-veg: include meat, fish or egg wherever it fits.',
  mix: 'Mix: ≥ 1 veg meal and ≥ 1 meat/fish/egg meal.',
};

const VARIETY_RULES = {
  familiar: 'mostly dishes from freq, made healthier; at most 1 new dish.',
  balanced: 'at least half the dishes not in freq.',
  explore: 'every dish not in freq.',
};

// Builds the "suggest one dish per slot" instruction from profile.schedule
// (docs §9: "The AI plan uses these slots: same count, names and times. It
// fits calories and macros into the window and never suggests food outside
// it."). `input.profile.schedule` always exists — buildSuggestionInput runs
// every profile through js/mealPlan.js's scheduleOf first.
function scheduleLines(schedule, mealStyles) {
  const slots = (schedule && Array.isArray(schedule.slots)) ? schedule.slots : [];
  // A slot's meal-type preference is appended as " = hint OR hint (\"note\")".
  let hasStyles = false;
  const slotList = slots.map((s) => {
    const { styles, note } = slotStyle(mealStyles, s.name);
    const hints = styles.map((k) => (MEAL_STYLES.find((m) => m[0] === k) || [])[2]).filter(Boolean);
    if (!hints.length && !note) return `${s.name} (${s.time})`;
    hasStyles = true;
    const pref = hints.length ? hints.join(' OR ') + (note ? ` ("${note}")` : '') : `"${note}"`;
    return `${s.name} (${s.time}) = ${pref}`;
  }).join(', ');
  const win = eatingWindow(schedule);
  const windowLine = win ? ` Eat only ${win.start}–${win.end} (fasting window).` : '';
  return { count: slots.length || 1, slotList, windowLine, hasStyles };
}

// docs §12.1, verbatim apart from the ${} wiring. If the built prompt is over
// SUGGEST_BUDGET_CHARS the lowest-count freq rows are dropped until it fits.
export const SUGGEST_BUDGET_CHARS = 6000;

export function suggestPrompt(input, avoidDishes, forDay = 'tomorrow') {
  const { slotList, windowLine, hasStyles } = scheduleLines(input.profile && input.profile.schedule, input.profile && input.profile.mealStyles);
  const data = compactSuggestInput(input, avoidDishes);
  const variety = VARIETY_RULES[input.variety] ? input.variety : 'balanced';
  const t = input.targets || {};
  const kcal = Number.isFinite(t.kcal) ? t.kcal : 'their target';
  const protein = Number.isFinite(t.protein) ? t.protein : 0;
  const fiber = Number.isFinite(t.fiber) ? t.fiber : 0;
  const location = (input.profile && input.profile.location) || 'their city';
  const prefRule = PREF_RULES[input.pref] || PREF_RULES[input.profile && input.profile.diet] || 'Follow their diet.';
  const coachRule = data.coach
    ? '\n6b. Fix coach.mistakes and follow coach.changes; prefer coach.foods. Name the mistake fixed in fixes.'
    : '';
  const styleRule = hasStyles
    ? '\n9. A slot with "=" is the user\'s meal-type preference: that slot\'s dish must be that type (diet and avoid still win). Name every part in dish, e.g. "Rice, sambar, beans poriyal".'
    : '';
  const build = () => `Plan meals for ${forDay} (${input.month || ''}). One dish per slot: ${slotList}.${windowLine}
Legend: y=yesterday [dish,kcal,p,c,f,fib,time]; gaps=[nutrient,yesterday,target,short|over]; freq=[dish,times] last 14 days; recent=dishes in last 3 plans; avoid=never use; coach=fixes from their weight review.
Rules:
1. Only dishes of their regional cuisine (freq, cuisine, location). No other cuisines.
2. ${prefRule} Follow diet and avoid strictly.
3. Variety ${variety}: ${VARIETY_RULES[variety]}
4. No dish from recent or y. No dish twice in this plan.
5. Any dish not in freq must be commonly eaten or sold in ${location}, in season, cookable on a weekday.
6. Close gaps: short → more of it, over → less.${coachRule}
7. Day total within ±5% of ${kcal} kcal. Push protein toward ${protein} g and fibre toward ${fiber} g with real foods; report true values, never inflate them to hit a target.
8. Realistic home portions; kcal and macros must match the portion. Ingredients = what the dish is really made of.${styleRule}
Output: ingredients for 1 serving, raw qty. local_note ≤ 8 words (where to buy/eat). fixes ≤ 3 ("gap → how"). why ≤ 2. tips ≤ 2. Every string ≤ 15 words.
Data:${JSON.stringify(data)}`;
  let text = build();
  while (text.length > SUGGEST_BUDGET_CHARS && data.freq.length > 0) {
    data.freq.pop();
    text = build();
  }
  return text;
}

// Asks Gemini for tomorrow's meal plan. `input` is js/mealPlan.js's
// buildSuggestionInput() output; `avoidDishes` (optional) are the previous
// plan's dish names, sent on "New ideas" so the next plan doesn't repeat
// them. Totals are always recomputed in code (planTotals), never trusted
// from the model, and a warning is attached (not thrown) when they land
// outside the target ±10% band — see docs §5.
export async function suggestMeals(input, avoidDishes, forDay) {
  let plan = null;
  const known = [...(input.dishFrequency || []).map((f) => f[0]), ...(input.recentPlans || []), ...(Array.isArray(avoidDishes) ? avoidDishes : [])];
  const parse = (json) => parseMealPlan(json, { known });
  // Dev-only canned response (js/dev/mockSuggest.js), never on the live site.
  let mockOn = false;
  try { mockOn = localStorage.getItem('tracker:mockGemini') === '1'; } catch { /* storage blocked */ }
  if (mockOn) {
    const { isDevHost } = await import('./dev/mock.js');
    if (isDevHost()) plan = parse(await (await import('./dev/mockSuggest.js')).mockSuggest(input, avoidDishes));
  }
  if (!plan) {
    const parts = [{ text: suggestPrompt(input, avoidDishes, forDay) }];
    logPromptSize('suggest', parts[0].text);
    plan = await askAI(parts, SUGGEST_SCHEMA, { temperature: 0.8, offlineMessage: "You're offline. Connect to get meal suggestions.", parse });
  }
  const totals = planTotals(plan);
  const warning = kcalWarning(totals.kcal, input.targets && input.targets.kcal);
  return { meals: plan.meals, why: plan.why, tips: plan.tips, fixes: plan.fixes, totals, warning };
}

// ---------- weekly body check (docs §3) ----------

const BODY_PROMPT = `You are a fitness coach giving a general, informational body-composition read from a photo — not a medical diagnosis.
- Estimate BMI, build (lean, average, overweight or obese) and belly fat level (low, moderate or high) from what's visible, cross-checked against the given height/weight.
- note: at most 2 short sentences.
- focus: up to 3 short, practical focus areas for the coming week (e.g. "cut refined carbs at night", "prioritise protein and fibre").
Respond only with JSON matching the schema.`;

const BODY_SCHEMA = {
  type: 'OBJECT',
  required: ['bmi', 'build', 'bellyFat', 'note', 'focus'],
  properties: {
    bmi: { type: 'NUMBER' },
    build: { type: 'STRING', enum: ['lean', 'average', 'overweight', 'obese'] },
    bellyFat: { type: 'STRING', enum: ['low', 'moderate', 'high'] },
    note: { type: 'STRING' },
    focus: { type: 'ARRAY', items: { type: 'STRING' } },
  },
};

const BUILD_VALUES = new Set(['lean', 'average', 'overweight', 'obese']);
const BELLY_FAT_VALUES = new Set(['low', 'moderate', 'high']);

function bmiFromProfile(profile) {
  const kg = profile && (profile.currentWeightKg ?? profile.startWeightKg);
  const heightCm = profile && profile.heightCm;
  if (!Number.isFinite(kg) || !Number.isFinite(heightCm) || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((kg / (m * m)) * 10) / 10;
}

function parseBodyCheck(json, fallbackBmi) {
  if (!json || typeof json !== 'object') throw new Error('Unexpected response from Gemini');
  const bmi = Number.isFinite(json.bmi) ? Math.round(json.bmi * 10) / 10 : fallbackBmi;
  return {
    bmi,
    build: BUILD_VALUES.has(json.build) ? json.build : null,
    bellyFat: BELLY_FAT_VALUES.has(json.bellyFat) ? json.bellyFat : null,
    note: typeof json.note === 'string' ? json.note.slice(0, 400) : '',
    focus: Array.isArray(json.focus) ? json.focus.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [],
  };
}

// The weekly body check (docs §3). `photoBlob` is the latest Body-step
// photo, or null/undefined when there is none, or the opt-in switch
// (profile.shareBodyPhoto) is off — in which case this never calls Gemini at
// all and falls back to a BMI-only result from height/weight, exactly as the
// no-photo case in js/mealPlan.js's bodyCheckText does for display. Callers
// are responsible for the opt-in/weekly-refresh decision (js/ui/today.js);
// this function itself just decides "photo -> call Gemini" vs. "no photo ->
// BMI only".
export async function checkBody(photoBlob, profile) {
  const fallbackBmi = bmiFromProfile(profile);
  if (!photoBlob) {
    return { bmi: fallbackBmi, build: null, bellyFat: null, note: 'Estimated from height and weight only — no body photo shared.', focus: [] };
  }

  const data = await blobToBase64(photoBlob);
  const kg = profile && (profile.currentWeightKg ?? profile.startWeightKg);
  const text = BODY_PROMPT + `\nProfile: sex ${profile?.sex ?? 'unknown'}, age ${profile?.age ?? 'unknown'}, height ${profile?.heightCm ?? 'unknown'} cm, weight ${kg ?? 'unknown'} kg.`;
  const parts = [
    { inline_data: { mime_type: photoBlob.type || 'image/jpeg', data } },
    { text },
  ];
  return askAI(parts, BODY_SCHEMA, {
    offlineMessage: "You're offline. Connect to update your body check.",
    parse: (json) => parseBodyCheck(json, fallbackBmi),
  });
}

// ---------- plateau review (plateau-coach plan §5) ----------

// Asks Gemini why the weight isn't moving. `input` is js/coach.js's
// buildReviewInput() output (already fitted to the budget); `ctx` is
// reviewContext(input). The answer goes through parseReview, which enforces
// the safety and no-hallucination rules in code. Mirrors suggestMeals: with
// localStorage 'tracker:mockGemini' === '1' on a dev host it returns a canned
// answer (js/dev/mockReview.js) built from the input itself.
export async function reviewPlateau(input, ctx, imageBlob = null) {
  let parsed = null;
  let mockOn = false;
  try { mockOn = localStorage.getItem('tracker:mockGemini') === '1'; } catch { /* storage blocked */ }
  const parse = (json) => parseReview(json, ctx);
  const text = reviewPrompt(input);
  logPromptSize('review', text, imageBlob ? 'image: 1 tile ≈258 tokens' : '');
  if (mockOn) {
    const { isDevHost } = await import('./dev/mock.js');
    if (isDevHost()) parsed = parse(await (await import('./dev/mockReview.js')).mockReview(input));
  }
  if (!parsed) {
    const parts = [{ text }];
    if (imageBlob) parts.push({ inlineData: { mimeType: 'image/jpeg', data: await blobToBase64(imageBlob) } });
    parsed = await askAI(parts, REVIEW_SCHEMA, {
      temperature: 0.4,
      offlineMessage: "You're offline. Connect to run the weight review.",
      parse,
    });
  }
  return parsed;
}
