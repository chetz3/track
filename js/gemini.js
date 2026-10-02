// Gemini calls: food-photo calorie estimation, next-day meal suggestions,
// and the weekly body check (see
// docs/superpowers/plans/2026-09-30-meal-suggestions.md). Called straight
// from the browser with fetch — there is no server. The API key lives only
// in this device's localStorage (never committed, never put in the URL) and
// is sent as the x-goog-api-key header on each request.

import { parseCalorieResult } from './foodLogic.js';
import { parseMealPlan, planTotals, kcalWarning, eatingWindow } from './mealPlan.js';

export const KEY_STORAGE = 'tracker:geminiKey';

export function getGeminiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch (_) {
    return '';
  }
}

export function setGeminiKey(key) {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

export function clearGeminiKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

// Aliases track the current free-tier models. The lite model is the fallback
// when Flash is overloaded (503) or unavailable.
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const endpoint = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// 429 too: each model has its own free-tier quota, so Lite can still answer
// when Flash's per-minute limit is used up.
const RETRYABLE = new Set([404, 429, 500, 503]);

const PROMPT = `You are a nutrition estimator. Estimate the calories of the food in this photo.
- List each distinct food or drink with its visible portion (use plates, cutlery, hands for scale).
- Use standard nutrition values; include visible oil, butter, sauces and dressings.
- Give one best integer estimate per item, never a range. total_calories = sum of items.
- dish: a short name for the whole meal (max 5 words).
- Also estimate protein, carbs, fat and fiber in grams per item (integers); totals are sums.
- If there is no food or drink, set is_food=false, items=[], total_calories=0.
Respond only with JSON matching the schema.`;

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

// A 429 body carries google.rpc.QuotaFailure details naming the exact limit
// hit, e.g. { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
// quotaValue: '250', quotaDimensions: { model: 'gemini-2.5-flash' } }.
// Google doesn't publish free-tier numbers, so this is the only concrete
// source — surfaced in the error text as "(limit 250/day on gemini-2.5-flash)".
function quotaLimitText(bodyText) {
  try {
    const details = JSON.parse(bodyText).error.details || [];
    const v = details.flatMap((d) => d.violations || []).find((x) => x.quotaValue);
    if (!v) return '';
    const per = /PerDay/i.test(v.quotaId) ? 'day' : /PerMinute/i.test(v.quotaId) ? 'min' : '';
    const model = v.quotaDimensions && v.quotaDimensions.model;
    return ` (limit ${v.quotaValue}${per ? '/' + per : ''}${model ? ' on ' + model : ''})`;
  } catch (_) {
    return '';
  }
}

function friendlyError(status, bodyText) {
  if (status === 429) console.warn('Gemini quota hit:', bodyText);
  if (status === 429 && /PerDay/i.test(bodyText || '')) return `Gemini free-tier daily limit reached${quotaLimitText(bodyText)}. Try again tomorrow.`;
  if (status === 429) return `Gemini free-tier limit reached${quotaLimitText(bodyText)}. Try again in a minute.`;
  if (status === 401 || status === 403) return 'Gemini API key is invalid.';
  if (status === 400 && /API_KEY_INVALID/.test(bodyText || '')) return 'Gemini API key is invalid.';
  return `Gemini error (${status})`;
}

// Shared by estimateCalories/suggestMeals/checkBody: the key/offline checks,
// the model-fallback fetch loop (Flash first, Lite on a 404/429/500/503), the
// friendly-error mapping, and pulling the answer text out of the response
// (thinking models can return thought parts first — keep only the rest).
// Returns the parsed JSON body; each caller applies its own
// parse*/validation on top (parseCalorieResult, parseMealPlan, ...), exactly
// as estimateCalories always has. `offlineMessage` lets callers other than
// food (which this message was originally written for) show wording that
// fits what they were trying to do; estimateCalories's own default keeps its
// original text unchanged.
async function callGemini(parts, schema, { temperature = 0.2, offlineMessage = "You're offline. Connect to add food." } = {}) {
  const key = getGeminiKey();
  if (!key) throw new Error('Add your Gemini API key in Challenges → Gemini AI.');
  if (!navigator.onLine) throw new Error(offlineMessage);

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
  });

  let res;
  for (const model of MODELS) {
    try {
      res = await fetch(endpoint(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
      });
    } catch (_) {
      // fetch rejects on a genuine network failure (offline mid-request, DNS,
      // connection reset) — navigator.onLine already caught the common case.
      throw new Error(offlineMessage);
    }
    if (res.ok || !RETRYABLE.has(res.status)) break;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    if (res.status === 503) throw new Error('Gemini is busy right now. Try again in a minute.');
    throw new Error(friendlyError(res.status, bodyText));
  }

  const json = await res.json();
  // Thinking models may return thought parts first; keep only answer text.
  const rawText = (json?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  try {
    return JSON.parse(rawText);
  } catch (_) {
    throw new Error('Unexpected response from Gemini');
  }
}

export async function estimateCalories(blob, note) {
  const key = getGeminiKey();
  if (!key) throw new Error('Add your Gemini API key in Challenges → Gemini AI.');
  if (!navigator.onLine) throw new Error("You're offline. Connect to add food.");

  const data = await blobToBase64(blob);
  const text = PROMPT + (note ? `\nUser note about this meal: ${note}` : '');
  const parts = [
    { inline_data: { mime_type: blob.type || 'image/jpeg', data } },
    { text },
  ];
  const parsed = await callGemini(parts, SCHEMA);
  return parseCalorieResult(parsed);
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

// The diet preference as a hard rule for the prompt (meal suggest v2 §2).
const PREF_RULES = {
  veg: 'Diet preference (hard rule): Veg. No meat, fish or eggs in any meal.',
  vegan: 'Diet preference (hard rule): Vegan. No meat, fish, eggs, dairy or honey in any meal.',
  egg: 'Diet preference (hard rule): Egg. Vegetarian food plus eggs; no meat or fish.',
  nonveg: 'Diet preference (hard rule): Non-veg. Every meal that can include meat, fish or eggs should.',
  mix: 'Diet preference (hard rule): Mix. At least 1 vegetarian meal and at least 1 non-veg meal (meat, fish or egg).',
};

// Builds the "suggest one dish per slot" instruction from profile.schedule
// (docs §9: "The AI plan uses these slots: same count, names and times. It
// fits calories and macros into the window and never suggests food outside
// it."). `input.profile.schedule` always exists — buildSuggestionInput runs
// every profile through js/mealPlan.js's scheduleOf first.
function scheduleLines(schedule) {
  const slots = (schedule && Array.isArray(schedule.slots)) ? schedule.slots : [];
  const slotList = slots.map((s) => `${s.name} (${s.time})`).join(', ');
  const win = eatingWindow(schedule);
  const windowLine = win
    ? `\nThis person eats within a fasting window, ${win.start}–${win.end}. Never suggest food outside that window.`
    : '';
  return { count: slots.length || 1, slotList, windowLine };
}

function suggestPrompt(input, avoidDishes) {
  const { count, slotList, windowLine } = scheduleLines(input.profile && input.profile.schedule);
  const avoidLine = Array.isArray(avoidDishes) && avoidDishes.length
    ? `\nDo not repeat these dishes from the previous plan: ${avoidDishes.join(', ')}.`
    : '';
  return `You are a nutrition planner. Suggest a ${count}-meal plan for tomorrow for this person, one dish for each of these exact time slots: ${slotList}.
Rules, in this order:
1. Stay in the cuisine they actually eat. Work out their eating style from recentDishes and yesterday.dishes (e.g. South Indian: idli, dosa, ragi mudde, sambar, rice + curry), with profile.cuisine as a hint and profile.location for what is common and available there. Every dish must be one people in that region routinely eat at home or in local eateries. Never switch cuisine: no Italian, Mexican, continental or other out-of-pattern dishes for someone who eats South Indian food.
2. Suggest familiar, similar dishes, not novelty: the same kinds of dishes they already eat, or close local variants of them, made healthier (e.g. more dal/eggs/chicken/paneer, less rice, more vegetables, less oil).
3. Close yesterday's gaps (see yesterday.gaps: a "short" status means eat more of it, "over" means less) within that cuisine, e.g. "protein was 70 of 155 g: add egg bhurji with dosa, chicken sukka, extra dal".
4. Don't copy yesterday's plate exactly: no dish from yesterday.dishes in the same slot, and at least half the dishes should differ from yesterday's.
5. ${PREF_RULES[input.pref] || PREF_RULES[input.profile && input.profile.diet] || 'Follow their diet.'} Also follow their diet and avoid list strictly; never include a dish or ingredient that clashes with them.
6. Fit the schedule's slots and times, and hit the calorie and macro targets.${windowLine}
Use the exact slot name given above as "slot" in your response, one dish per slot, each with a portion size and its kcal and grams of protein/carbs/fat/fiber (integers). Set swap_for to a lighter alternative when relevant, otherwise leave it blank.
ingredients: for each meal, list its ingredients for 1 serving in raw/uncooked quantities, each with name, qty (number), unit (g, ml, pcs, tbsp, tsp, cup or bunch) and category (vegetables, fruits, dairy, meat_fish_eggs, grains, pulses, spices_oils or other).
fixes: up to 3 short lines saying how this plan fixes yesterday's gaps, e.g. "Protein: 70 → 150 g with eggs, chicken, dal".
why: 2-3 short lines tied to the last 7 days' actual eating.
tips: up to 3 short, practical tips.${avoidLine}

Person and data (JSON):
${JSON.stringify(input)}

Respond only with JSON matching the schema.`;
}

// Asks Gemini for tomorrow's meal plan. `input` is js/mealPlan.js's
// buildSuggestionInput() output; `avoidDishes` (optional) are the previous
// plan's dish names, sent on "New ideas" so the next plan doesn't repeat
// them. Totals are always recomputed in code (planTotals), never trusted
// from the model, and a warning is attached (not thrown) when they land
// outside the target ±10% band — see docs §5.
export async function suggestMeals(input, avoidDishes) {
  let parsed = null;
  // Dev-only canned response (js/dev/mockSuggest.js), never on the live site.
  let mockOn = false;
  try { mockOn = localStorage.getItem('tracker:mockGemini') === '1'; } catch { /* storage blocked */ }
  if (mockOn) {
    const { isDevHost } = await import('./dev/mock.js');
    if (isDevHost()) parsed = await (await import('./dev/mockSuggest.js')).mockSuggest(input);
  }
  if (!parsed) {
    const parts = [{ text: suggestPrompt(input, avoidDishes) }];
    parsed = await callGemini(parts, SUGGEST_SCHEMA, { offlineMessage: "You're offline. Connect to get meal suggestions." });
  }
  const plan = parseMealPlan(parsed);
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
  const parsed = await callGemini(parts, BODY_SCHEMA, { offlineMessage: "You're offline. Connect to update your body check." });
  return parseBodyCheck(parsed, fallbackBmi);
}
