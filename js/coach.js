// Pure model for the Plateau Coach's AI review (R2 of
// docs/superpowers/plans/2026-10-10-plateau-coach.md §4-§6, §12.2): the
// deterministic risk signals, the compact review input, the prompt, the
// response schema, the code-enforced response checks (parseReview) and the
// Apply / Undo helpers. No DOM, no IndexedDB, no network — tested in
// tests/coach.test.js. The Gemini call itself lives in js/gemini.js.

import { addDays, diffDays, dayStatus, flexDates } from './rules.js';
import { mealsTotal } from './foodLogic.js';
import { bmr, tdee, latestBodyWeightKg } from './fitness.js';
import { bodyCheckText, scheduleOf } from './mealPlan.js';
import { trendStatus, eatingPatterns, dayFeelTags, normDish } from './trend.js';
import { LAB_KEYS } from './health.js';

export const REVIEW_BUDGET_CHARS = 16000;
export const MIN_REVIEW_DAYS = 14;
export const REVIEW_DAYS = 28;
export const RERUN_AFTER_DAYS = 3;
export const RERUN_AFTER_NEW_DAYS = 3;
export const REVIEW_FRESH_DAYS = 21; // R3: a review feeds suggestions for 21 days

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round10 = (n) => Math.round(n / 10) * 10;
const ceil10 = (n) => Math.ceil(n / 10) * 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// ---------- risk signals (§4) ----------

// Which review cause category each signal supports (used by parseReview to
// allow a risk category only when a matching signal was sent).
export const SIGNAL_CATEGORY = {
  whtr: 'insulin_resistance_signs',
  waist: 'insulin_resistance_signs',
  homa_ir: 'insulin_resistance_signs',
  hba1c: 'insulin_resistance_signs',
  glucose: 'insulin_resistance_signs',
  tg_hdl: 'insulin_resistance_signs',
  alt_ast: 'insulin_resistance_signs',
  belly_fat: 'insulin_resistance_signs',
  carb_late_cravings: 'insulin_resistance_signs',
  crp: 'sensitivity_inflammation',
};

// Deterministic "signs consistent with ..." facts computed from numbers, so
// the AI never has to guess them. Health data (waist, labs, conditions) is
// used only when profile.health.shareWithAi is on. `trend` (optional) is a
// trendStatus() result, for the weight-gain red flag.
// Each signal: { id, label, value, threshold, source }.
export function riskSignals(profile, patterns, bodyCheck, trend) {
  const out = [];
  const p = profile || {};
  const h = p.health && p.health.shareWithAi ? p.health : null;
  const male = p.sex === 'male';
  const add = (id, label, value, threshold, source) => out.push({ id, label, value, threshold, source });
  const labs = (h && h.labs) || {};
  const lab = (k) => (isNum(labs[k]) ? labs[k] : null);

  if (h && isNum(h.waistCm) && h.waistCm > 0) {
    if (isNum(p.heightCm) && p.heightCm > 0) {
      const r = h.waistCm / p.heightCm;
      if (r >= 0.5) add('whtr', 'Signs consistent with central (belly) fat: waist-to-height ratio', round2(r), r >= 0.6 ? '>=0.6 (high)' : '>=0.5', 'waist');
    }
    const cut = male ? 90 : 80;
    if (h.waistCm >= cut) add('waist', 'Signs consistent with central (belly) fat: waist (South Asian cut-off)', h.waistCm, `>=${cut} cm`, 'waist');
  }

  const glucose = lab('fastingGlucose');
  const insulin = lab('fastingInsulin');
  if (glucose !== null && insulin !== null) {
    const homa = (glucose * insulin) / 405;
    if (homa >= 2) add('homa_ir', 'Signs consistent with insulin resistance: HOMA-IR', round1(homa), homa >= 2.9 ? '>=2.9 (high)' : '>=2.0', 'labs');
  }
  const a1c = lab('hba1c');
  if (a1c !== null && a1c >= 5.7) {
    add('hba1c', a1c >= 6.5 ? 'HbA1c in the diabetes range' : 'HbA1c in the prediabetes range', a1c, a1c >= 6.5 ? '>=6.5' : '5.7-6.4', 'labs');
  }
  if (glucose !== null && glucose >= 100) {
    add('glucose', glucose >= 126 ? 'Fasting glucose in the diabetes range' : 'Fasting glucose in the prediabetes range', glucose, glucose >= 126 ? '>=126 mg/dL' : '100-125 mg/dL', 'labs');
  }
  const tg = lab('triglycerides');
  const hdl = lab('hdl');
  if (tg !== null && hdl !== null && hdl > 0 && tg / hdl >= 3) {
    add('tg_hdl', 'Signs consistent with insulin resistance: TG/HDL ratio', round1(tg / hdl), '>=3', 'labs');
  }
  const alt = lab('alt');
  const ast = lab('ast');
  if ((alt !== null && alt > (male ? 40 : 30)) || (ast !== null && ast > 40)) {
    add('alt_ast', 'Possible fatty liver: raised ALT/AST (an ultrasound or FibroScan would confirm)', `ALT ${alt ?? '-'} / AST ${ast ?? '-'}`, `ALT>${male ? 40 : 30} or AST>40`, 'labs');
  }
  const tsh = lab('tsh');
  if (tsh !== null && tsh > 4.5) add('tsh', 'Signs consistent with an under-active thyroid: TSH', tsh, '>4.5', 'labs');
  const crp = lab('crp');
  if (crp !== null && crp > 3) add('crp', 'Signs consistent with inflammation: CRP', crp, '>3 mg/L', 'labs');
  const vitD = lab('vitD');
  if (vitD !== null && vitD < 20) add('vit_d', 'Low vitamin D (can cause fatigue)', vitD, '<20 ng/mL', 'labs');
  const b12 = lab('b12');
  if (b12 !== null && b12 < 200) add('b12', 'Low vitamin B12 (can cause fatigue)', b12, '<200 pg/mL', 'labs');

  if (bodyCheck && bodyCheck.bellyFat === 'high') add('belly_fat', 'Signs consistent with central (belly) fat: body check', 'high', 'high', 'bodyCheck');

  const pat = patterns || {};
  if (isNum(pat.carbPctOfKcal) && isNum(pat.lateKcalPct) && pat.carbPctOfKcal >= 60 && pat.lateKcalPct >= 30
    && pat.feelTags && pat.feelTags.cravings) {
    add('carb_late_cravings', 'Eating pattern linked to insulin resistance: high carbs, late eating and cravings', `carbs ${pat.carbPctOfKcal}%, late ${pat.lateKcalPct}%`, 'carbs>=60%, late>=30%, cravings', 'patterns');
  }

  // Red flags: the review leads with "see a doctor".
  if (h && Array.isArray(h.conditions) && h.conditions.includes('kidney_heart_edema')) {
    add('red_edema', 'See a doctor first: kidney/heart issue or swelling (oedema) reported', 'yes', 'any', 'conditions');
  }
  if (trend && isNum(trend.slopeKgPerWeek) && trend.slopeKgPerWeek > 2) {
    add('red_gain', 'See a doctor first: fast weight gain on the trend', trend.slopeKgPerWeek, '>2 kg/week', 'trend');
  }
  if ((a1c !== null && a1c >= 9) || (glucose !== null && glucose >= 250)) {
    add('red_glucose', 'See a doctor first: very high blood sugar reading', a1c !== null && a1c >= 9 ? a1c : glucose, 'HbA1c>=9 or glucose>=250', 'labs');
  }
  return out;
}

// ---------- review input (§5) ----------

function findStep(challenge, type) {
  return (challenge.steps || []).find((s) => s.type === type) || null;
}

function stepNum(day, step) {
  const e = step && day && day.steps && day.steps[step.id];
  return e && isNum(e.value) ? e.value : null;
}

function hhmm(at) {
  if (!isNum(at)) return null;
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dropEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isEmpty(v)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = dropEmpty(v);
      if (Object.keys(inner).length) out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function compactTrend(t) {
  if (!t || t.status === 'no-data') return { status: 'no-data' };
  const { windowDays, ...rest } = t; // eslint-disable-line no-unused-vars
  return dropEmpty(rest);
}

function compactPatterns(p) {
  const tags = {};
  for (const [tag, v] of Object.entries(p.feelTags || {})) tags[tag] = [v.count, v.topDishes];
  return dropEmpty({
    top: p.topDishes.map((d) => [d.dish, d.count, round10(d.avgKcal)]),
    lateKcalPct: p.lateKcalPct,
    kcalWeekday: p.weekendVsWeekdayKcal && p.weekendVsWeekdayKcal.weekday,
    kcalWeekend: p.weekendVsWeekdayKcal && p.weekendVsWeekdayKcal.weekend,
    proteinGPerKg: p.proteinGPerKg,
    carbPctOfKcal: p.carbPctOfKcal,
    fiberAvgG: p.fiberAvgG,
    mealsPerDay: p.avgMealsPerDay,
    bumps: (p.nextDayBumps || []).map((b) => [b.dish, b.n, b.bumpKg]),
    feel: tags,
  });
}

function compactSchedule(profile) {
  const s = scheduleOf(profile);
  const out = { slots: s.slots.map((x) => `${x.name} ${x.time}`) };
  if (s.pattern === 'if') out.fast = s.fast;
  return out;
}

// What was said last time, summarised for the next review (`prev`).
export function previousReviewSummary(review) {
  if (!review || typeof review !== 'object') return null;
  return dropEmpty({
    date: review.date,
    verdict: review.verdict,
    mistakes: (review.mistakes || []).map((m) => m.what),
    food_changes: review.food_changes && { add: review.food_changes.add, reduce: review.food_changes.reduce },
    maintenance: review.maintenance && { action: review.maintenance.action, new_kcal: review.maintenance.new_kcal },
    applied: review.applied && { action: review.applied.action, from: review.applied.from, to: review.applied.to, date: review.applied.date },
  });
}

// The whole payload for one review call: the profile (health only when the
// user turned sharing on), the precomputed trend/patterns/risk, and up to 28
// days of tuples (never before the attempt start). `opts.startDate` is the
// attempt start. Compact on purpose: see REVIEW_BUDGET_CHARS.
export function buildReviewInput(challenge, daysMap, today, opts = {}) {
  const profile = challenge.profile || {};
  const food = findStep(challenge, 'food');
  const workout = findStep(challenge, 'workout');
  const stepsStep = findStep(challenge, 'steps');
  const water = findStep(challenge, 'water');
  const sleep = findStep(challenge, 'sleep');
  const body = findStep(challenge, 'body');
  const keys = Object.keys(daysMap || {}).sort();
  const start = opts.startDate || keys[0] || today;
  const tOpts = { startDate: start };

  const t14 = trendStatus(challenge, daysMap, today, { ...tOpts, windowDays: 14 });
  const t28 = trendStatus(challenge, daysMap, today, { ...tOpts, windowDays: 28 });
  const pat = eatingPatterns(challenge, daysMap, today, { ...tOpts, days: REVIEW_DAYS });
  const bc = bodyCheckText(challenge, daysMap);

  const sharing = !!(profile.health && profile.health.shareWithAi);
  let health;
  if (sharing) {
    const { shareWithAi, ...rest } = profile.health; // eslint-disable-line no-unused-vars
    health = dropEmpty(rest);
  }

  const targets = food ? {
    kcal: food.goal ? food.goal.target : null,
    protein: food.macros && food.macros.protein ? food.macros.protein.target : null,
    carbs: food.macros && food.macros.carbs ? food.macros.carbs.target : null,
    fat: food.macros && food.macros.fat ? food.macros.fat.target : null,
    fiber: food.macros && food.macros.fiber ? food.macros.fiber.target : null,
  } : null;

  const flex = flexDates(challenge, start, daysMap, today);
  let from = addDays(today, -REVIEW_DAYS); // 28 full days, ending yesterday
  if (from < start) from = start;
  const d = [];
  // Today is still being logged, so it would read as under-eating: stop at yesterday.
  for (let date = from; date < today; date = addDays(date, 1)) {
    const day = daysMap && daysMap[date];
    const entry = food && day && day.steps && day.steps[food.id];
    const meals = entry && Array.isArray(entry.meals) ? entry.meals : [];
    const tuples = meals.map((m) => {
      const mac = m.macros || {};
      return [String(m.dish || ''), round10(isNum(m.calories) ? m.calories : 0),
        round1(isNum(mac.protein) ? mac.protein : 0), round1(isNum(mac.carbs) ? mac.carbs : 0),
        round1(isNum(mac.fat) ? mac.fat : 0), round1(isNum(mac.fiber) ? mac.fiber : 0), hhmm(m.at)];
    }).map((t) => { while (t.length > 1 && t[t.length - 1] === null) t.pop(); return t; });
    const wEntry = workout && day && day.steps && day.steps[workout.id];
    const wo = wEntry && Array.isArray(wEntry.sessions)
      ? wEntry.sessions.map((s) => [s.type, s.minutes, s.kcal]) : [];
    const kg = stepNum(day, body);
    const tuple = [
      date,
      dayStatus(date, day, challenge, today, flex) === 'green' ? 1 : 0,
      kg === null ? null : round1(kg),
      meals.length ? round10(mealsTotal(meals)) : null,
      tuples,
      wo,
      stepNum(day, stepsStep),
      stepNum(day, water) === null ? null : round1(stepNum(day, water)),
      stepNum(day, sleep) === null ? null : round1(stepNum(day, sleep)),
      food ? dayFeelTags(day, food.id) : [],
    ].map((v, i) => (i >= 2 && isEmpty(v) ? null : v));
    while (tuple.length > 2 && tuple[tuple.length - 1] === null) tuple.pop();
    d.push(tuple);
  }

  const [, m] = today.split('-').map(Number);
  const input = {
    today,
    month: MONTHS[m - 1],
    weeksOnPlan: Math.max(0, Math.floor(diffDays(start, today) / 7)),
    profile: dropEmpty({
      sex: profile.sex,
      age: profile.age,
      heightCm: profile.heightCm,
      currentWeightKg: latestBodyWeightKg(challenge, daysMap, profile),
      startWeightKg: profile.startWeightKg,
      targetWeightKg: profile.targetWeightKg,
      aim: profile.aim,
      activity: profile.activity,
      location: profile.location,
      cuisine: profile.cuisine,
      diet: profile.diet,
      avoid: profile.avoid,
      schedule: compactSchedule(profile),
      health,
    }),
    targets: targets ? dropEmpty(targets) : undefined,
    t14: compactTrend(t14),
    t28: compactTrend(t28),
    pat: compactPatterns(pat),
    d,
    prev: previousReviewSummary(challenge.plateauReview) || undefined,
    bodyCheck: bc ? dropEmpty({ bmi: bc.bmi, build: bc.build, bellyFat: bc.bellyFat }) : undefined,
    risk: riskSignals(profile, pat, bc, t14),
  };
  if (!input.risk.length) delete input.risk;
  if (Array.isArray(opts.photoDates) && opts.photoDates.length) {
    input.photos = { dates: opts.photoDates.slice(0, 4), note: 'collage 2x2, oldest top-left' };
  }
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
  return input;
}

// ---------- prompt (§12.2, verbatim apart from the ${} wiring) ----------

export function reviewFloorKcal(profile, currentTargetKcal) {
  const p = profile || {};
  const kg = isNum(p.currentWeightKg) ? p.currentWeightKg : p.startWeightKg;
  const sexFloor = p.sex === 'male' ? 1500 : 1200;
  if (!isNum(kg) || !isNum(p.age) || !isNum(p.heightCm)) return sexFloor;
  const b = Math.round(bmr({ sex: p.sex, age: p.age, heightCm: p.heightCm, startWeightKg: kg }));
  return Math.max(sexFloor, isNum(currentTargetKcal) ? Math.min(b, currentTargetKcal) : b);
}

export function reviewPrompt(input) {
  const floorKcal = reviewFloorKcal(input.profile, input.targets && input.targets.kcal);
  const location = (input.profile && input.profile.location) || 'their city';
  const month = input.month || '';
  return `You review why someone's weight isn't dropping while they follow a plan. Informational only, not a diagnosis. Write to them as "you", in plain words.
Legend: weeksOnPlan=weeks since the plan started; t14/t28=trend (computed, trust it); pat=eating patterns (computed); risk=health signals (computed); d=days [date,green,kg,kcal,meals[[dish,kcal,p,c,f,fib,time]],wo[[type,min,kcal]],steps,waterL,sleepH,feel]; prev=last review.
Rules:
1. Use only this data. Never invent foods, numbers, dates, labs or symptoms; quote numbers exactly as given. Leave out what the data can't support. Thin data → verdict not_enough_data.
2. Every cause and mistake lists real dates and dishes from d in "dates" and "dishes".
3. Check in this order: under-logging (expected vs actual gap; oil, ghee, snacks, drinks); water retention (salty or restaurant food, carb spikes, poor sleep, new workouts); insulin-resistance, belly-fat and fatty-liver signs; food sensitivity (feel tags, next-day bumps); low protein or fibre; late eating; sleep or stress; low steps; long deficit (adaptation); conditions or medicines.
4. Health causes only when risk has a matching signal. Say "signs consistent with", never "you have". Put confirming tests in ask_doctor.
5. If risk has a red flag, the summary starts with "See a doctor:".
6. Elimination test: one food for 2 weeks, never several at once.
6b. maintenance: diet_break only if weeksOnPlan ≥ 8; lower_target only if under-logging is unlikely; otherwise keep or raise_protein.
7. Safety: kcal never below ${floorKcal}; loss ≤ 1% body weight per week; no supplements, drugs or detox; no longer fasting than their schedule; diabetes → no fasting change without a doctor.
8. food_changes and new_local_foods: their regional cuisine, sold in ${location}, in season for ${month}. new_local_foods = 6 dishes not in pat.top or d.
9. Every string ≤ 20 words. summary ≤ 2 sentences.${input.photos ? `
10. Image = body photos (dates in photos.dates, oldest top-left). Compare only the visible belly/waist and face puffiness across dates. Report it in photo_trend. Never diagnose; link to risk signals only as "signs consistent with". If lighting, pose or clothing differ too much to compare, say so.` : ''}
Data:${JSON.stringify(input)}`;
}

// Drops the oldest day tuples until the built prompt fits the budget, down to
// MIN_REVIEW_DAYS. Mutates and returns `input`.
export function fitReviewInput(input, maxChars = REVIEW_BUDGET_CHARS) {
  while (reviewPrompt(input).length > maxChars && input.d.length > MIN_REVIEW_DAYS) input.d.shift();
  return input;
}

// ---------- response schema (§5) ----------

const S = { type: 'STRING' };
const strArr = { type: 'ARRAY', items: S };

export const CAUSE_CATEGORIES = ['under_logging', 'water_retention', 'insulin_resistance_signs', 'sensitivity_inflammation',
  'low_protein_fiber', 'meal_timing', 'sleep_stress', 'low_daily_movement', 'metabolic_adaptation', 'condition_or_meds', 'other'];
export const VERDICTS = ['real_plateau', 'water_noise', 'under_logging', 'gaining', 'losing_fine', 'not_enough_data'];
export const MIN_DIET_BREAK_WEEKS = 8;
export const MAINT_ACTIONS = ['keep', 'lower_target', 'raise_protein', 'diet_break', 'recalc'];
const CONFIDENCES = ['low', 'medium', 'high'];
export const PHOTO_BELLY = ['smaller', 'same', 'larger', 'unclear'];

export const REVIEW_SCHEMA = {
  type: 'OBJECT',
  required: ['summary', 'verdict', 'likely_causes', 'mistakes', 'food_changes', 'new_local_foods', 'maintenance', 'habits', 'ask_doctor', 'watch_next'],
  properties: {
    summary: S,
    verdict: { type: 'STRING', enum: VERDICTS },
    likely_causes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['category', 'cause', 'evidence', 'confidence', 'dates', 'dishes'],
        properties: {
          category: { type: 'STRING', enum: CAUSE_CATEGORIES },
          cause: S,
          evidence: S,
          confidence: { type: 'STRING', enum: CONFIDENCES },
          dates: strArr,
          dishes: strArr,
        },
      },
    },
    mistakes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['what', 'since', 'how_often', 'fix', 'dates', 'dishes'],
        properties: { what: S, since: S, how_often: S, fix: S, dates: strArr, dishes: strArr },
      },
    },
    food_changes: {
      type: 'OBJECT',
      required: ['add', 'reduce', 'swap'],
      properties: {
        add: strArr,
        reduce: strArr,
        swap: { type: 'ARRAY', items: { type: 'OBJECT', required: ['from', 'to'], properties: { from: S, to: S } } },
      },
    },
    new_local_foods: {
      type: 'ARRAY',
      items: { type: 'OBJECT', required: ['dish', 'why', 'where'], properties: { dish: S, why: S, where: S } },
    },
    maintenance: {
      type: 'OBJECT',
      required: ['action', 'why'],
      properties: {
        action: { type: 'STRING', enum: MAINT_ACTIONS },
        new_kcal: { type: 'INTEGER' },
        duration_days: { type: 'INTEGER' },
        why: S,
      },
    },
    habits: strArr,
    ask_doctor: { type: 'ARRAY', items: { type: 'OBJECT', required: ['test', 'why'], properties: { test: S, why: S } } },
    watch_next: S,
    photo_trend: {
      type: 'OBJECT',
      properties: { belly: { type: 'STRING', enum: PHOTO_BELLY }, note: S },
    },
  },
};

// ---------- parseReview (§5): code enforces the rules ----------

// Which lab values a piece of text depends on.
const LAB_MENTIONS = [
  ['hba1c', /hba1c|\ba1c\b|glycated|glycosylated/i],
  ['fastingGlucose', /glucose|fasting sugar/i],
  ['fastingInsulin', /fasting insulin|homa/i],
  ['tsh', /\btsh\b/i],
  ['vitD', /vit(amin)?\.? ?d\b/i],
  ['b12', /\bb[- ]?12\b/i],
  ['crp', /\bcrp\b|c-reactive/i],
  ['triglycerides', /triglycerid|\btg\b/i],
  ['hdl', /\bhdl\b/i],
  ['alt', /\balt\b/i],
  ['ast', /\bast\b/i],
];

const DOCTOR_TESTS = {
  insulin_resistance_signs: 'HbA1c, fasting glucose and fasting insulin; LFT with an ultrasound or FibroScan',
  sensitivity_inflammation: 'CRP and a review of food sensitivities',
};

function str(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function strList(v, max, n) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = str(x, max);
    if (s) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

const wordsIn = (a, b) => ` ${b} `.includes(` ${a} `);
// A cited dish matches a history dish when equal, or when one is a whole-word
// phrase inside the other (so "curd rice" matches "Curd rice (small)").
function dishMatches(norm, histNorm) {
  if (!norm || !histNorm) return false;
  return norm === histNorm || (norm.length >= 4 && wordsIn(norm, histNorm)) || (histNorm.length >= 4 && wordsIn(histNorm, norm));
}

function toNormList(x) {
  if (!x) return [];
  return [...x].map((d) => normDish(d)).filter(Boolean);
}

function checkRefs(item, ctx, dateSet, history) {
  // Returns the item with only verifiable dates/dishes, or null when it cited
  // some and none of them check out.
  let dates = strList(item.dates, 10, 31).filter((s) => DATE_RE.test(s));
  const rawDates = Array.isArray(item.dates) && item.dates.length > 0;
  if (dateSet) {
    dates = dates.filter((s) => dateSet.has(s));
    if (rawDates && dates.length === 0) return null;
  }
  let dishes = strList(item.dishes, 60, 8);
  const rawDishes = dishes.length > 0;
  if (history) {
    dishes = dishes.filter((dish) => history.some((h) => dishMatches(normDish(dish), h)));
    if (rawDishes && dishes.length === 0) return null;
  }
  return { dates: dates.slice(0, 6), dishes: dishes.slice(0, 5) };
}

// json: the model's raw answer. ctx: { bmr, sex, currentTargetKcal,
// historyDishes, maintenanceKcal?, dates?, healthShared?, labs?, signals?,
// redFlag?, feelOrBumps? } — see reviewContext(). Optional ctx fields that
// are missing skip the check they drive.
export function parseReview(json, ctx = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Unexpected response from Gemini');
  const dateSet = ctx.dates ? new Set(ctx.dates) : null;
  const history = ctx.historyDishes ? toNormList(ctx.historyDishes) : null;
  const signals = ctx.signals ? new Set(ctx.signals) : null;
  const sexFloor = ctx.sex === 'male' ? 1500 : 1200;
  // BMR is the floor, unless the current target is already below it (common
  // at high body weight) — then nothing may go lower than the current target.
  const bmrCap = isNum(ctx.bmr) ? Math.round(ctx.bmr) : 0;
  const floor = ceil10(Math.max(sexFloor, isNum(ctx.currentTargetKcal) ? Math.min(bmrCap, ctx.currentTargetKcal) : bmrCap));
  const labsHave = new Set(ctx.labs || []);

  const verdict = VERDICTS.includes(json.verdict) ? json.verdict : 'not_enough_data';
  let summary = str(json.summary, 300);
  if (ctx.redFlag && !/^see a doctor:/i.test(summary)) summary = `See a doctor: ${summary}`.trim();

  const askDoctor = [];
  for (const a of Array.isArray(json.ask_doctor) ? json.ask_doctor : []) {
    if (!a || typeof a !== 'object') continue;
    const test = str(a.test, 140);
    if (test) askDoctor.push({ test, why: str(a.why, 200) });
  }

  const causes = [];
  for (const c of Array.isArray(json.likely_causes) ? json.likely_causes : []) {
    if (!c || typeof c !== 'object' || !CAUSE_CATEGORIES.includes(c.category)) continue;
    const cause = str(c.cause, 200);
    if (!cause) continue;
    const evidence = str(c.evidence, 260);
    const refs = checkRefs(c, ctx, dateSet, history);
    if (!refs) continue;
    if (c.category === 'condition_or_meds' && ctx.healthShared === false) continue;
    // A cause leaning on a lab value the user never provided is dropped.
    const text = `${cause} ${evidence}`;
    if (LAB_MENTIONS.some(([k, re]) => re.test(text) && !labsHave.has(k))) continue;
    // Risk categories need a matching computed signal; otherwise they become a
    // question for the doctor instead of a claim.
    if (signals && (c.category === 'insulin_resistance_signs' || c.category === 'sensitivity_inflammation')) {
      const has = [...signals].some((id) => SIGNAL_CATEGORY[id] === c.category)
        || (c.category === 'sensitivity_inflammation' && ctx.feelOrBumps);
      if (!has) {
        askDoctor.push({ test: DOCTOR_TESTS[c.category], why: cause });
        continue;
      }
    }
    causes.push({
      category: c.category,
      cause,
      evidence,
      confidence: CONFIDENCES.includes(c.confidence) ? c.confidence : 'low',
      dates: refs.dates,
      dishes: refs.dishes,
    });
    if (causes.length >= 5) break;
  }

  const mistakes = [];
  for (const m of Array.isArray(json.mistakes) ? json.mistakes : []) {
    if (!m || typeof m !== 'object') continue;
    const what = str(m.what, 200);
    if (!what) continue;
    const refs = checkRefs(m, ctx, dateSet, history);
    if (!refs) continue;
    const out = { what, how_often: str(m.how_often, 120), fix: str(m.fix, 220), dates: refs.dates, dishes: refs.dishes };
    if (typeof m.since === 'string' && DATE_RE.test(m.since) && !Number.isNaN(Date.parse(m.since))) out.since = m.since;
    mistakes.push(out);
    if (mistakes.length >= 5) break;
  }

  const fc = json.food_changes && typeof json.food_changes === 'object' ? json.food_changes : {};
  const swap = [];
  for (const s of Array.isArray(fc.swap) ? fc.swap : []) {
    if (!s || typeof s !== 'object') continue;
    const from = str(s.from, 80);
    const to = str(s.to, 80);
    if (from && to) swap.push({ from, to });
    if (swap.length >= 5) break;
  }
  const food_changes = { add: strList(fc.add, 120, 5), reduce: strList(fc.reduce, 120, 5), swap };

  const newFoods = [];
  const seen = new Set();
  for (const f of Array.isArray(json.new_local_foods) ? json.new_local_foods : []) {
    if (!f || typeof f !== 'object') continue;
    const dish = str(f.dish, 60);
    const norm = normDish(dish);
    if (!norm || seen.has(norm)) continue;
    if (history && history.some((h) => dishMatches(norm, h))) continue;
    seen.add(norm);
    newFoods.push({ dish, why: str(f.why, 160), where: str(f.where, 120) });
    if (newFoods.length >= 6) break;
  }

  const mt = json.maintenance && typeof json.maintenance === 'object' ? json.maintenance : {};
  let action = MAINT_ACTIONS.includes(mt.action) ? mt.action : 'keep';
  const current = isNum(ctx.currentTargetKcal) ? ctx.currentTargetKcal : null;
  const maintenance = { action, why: str(mt.why, 240) };
  const asked = isNum(mt.new_kcal) ? mt.new_kcal : null;
  if (action === 'lower_target') {
    let kcal = asked === null ? null : Math.max(round10(asked), floor);
    if (kcal !== null && current !== null && kcal > current) kcal = current;
    if (kcal === null || (current !== null && kcal >= current)) maintenance.action = 'keep'; // nothing lower to apply
    else maintenance.new_kcal = kcal;
  } else if (action === 'diet_break' && isNum(ctx.weeksOnPlan) && ctx.weeksOnPlan < MIN_DIET_BREAK_WEEKS) {
    // Too early for a diet break (prompt rule 6b) — enforced here, not trusted.
    maintenance.action = 'keep';
  } else if (action === 'diet_break') {
    let kcal = asked === null ? (isNum(ctx.maintenanceKcal) ? ctx.maintenanceKcal : null) : asked;
    if (kcal === null) {
      maintenance.action = 'keep';
    } else {
      if (isNum(ctx.maintenanceKcal) && kcal > ctx.maintenanceKcal) kcal = ctx.maintenanceKcal;
      if (current !== null && kcal < current) kcal = current;
      kcal = round10(kcal);
      if (current !== null) kcal = Math.max(kcal, current);
      maintenance.new_kcal = kcal;
      const days = isNum(mt.duration_days) ? Math.round(mt.duration_days) : 10;
      maintenance.duration_days = Math.min(14, Math.max(7, days));
    }
  }

  let photo_trend;
  if (ctx.photosSent && json.photo_trend && typeof json.photo_trend === 'object') {
    const pt = json.photo_trend;
    let note = str(pt.note, 160);
    if (/\byou have\b/i.test(note)) note = '';
    photo_trend = { belly: PHOTO_BELLY.includes(pt.belly) ? pt.belly : 'unclear', note };
  }

  return {
    summary,
    verdict,
    likely_causes: causes,
    mistakes,
    food_changes,
    new_local_foods: newFoods,
    maintenance,
    habits: strList(json.habits, 160, 4),
    ask_doctor: askDoctor.slice(0, 4),
    watch_next: str(json.watch_next, 200),
    ...(photo_trend ? { photo_trend } : {}),
  };
}

// Everything parseReview needs, derived from the input that was actually
// sent (so the checks match exactly what the model could see).
export function reviewContext(input) {
  const p = input.profile || {};
  const kg = isNum(p.currentWeightKg) ? p.currentWeightKg : p.startWeightKg;
  const canCalc = isNum(kg) && isNum(p.age) && isNum(p.heightCm);
  const calcProfile = canCalc ? { sex: p.sex, age: p.age, heightCm: p.heightCm, startWeightKg: kg, activity: p.activity } : null;
  const history = new Set();
  const dates = [];
  for (const row of input.d || []) {
    dates.push(row[0]);
    for (const m of row[4] || []) if (m && m[0]) history.add(m[0]);
  }
  for (const t of (input.pat && input.pat.top) || []) if (t && t[0]) history.add(t[0]);
  const risk = input.risk || [];
  const pat = input.pat || {};
  return {
    bmr: calcProfile ? bmr(calcProfile) : null,
    sex: p.sex,
    currentTargetKcal: input.targets && isNum(input.targets.kcal) ? input.targets.kcal : null,
    weeksOnPlan: isNum(input.weeksOnPlan) ? input.weeksOnPlan : null,
    maintenanceKcal: calcProfile ? round10(tdee(calcProfile)) : null,
    historyDishes: [...history],
    dates,
    healthShared: !!p.health,
    labs: p.health && p.health.labs ? Object.keys(p.health.labs).filter((k) => LAB_KEYS.includes(k)) : [],
    signals: risk.map((r) => r.id),
    redFlag: risk.some((r) => r.id.startsWith('red_')),
    photosSent: !!input.photos,
    feelOrBumps: !!((pat.feel && Object.keys(pat.feel).length) || (pat.bumps && pat.bumps.length)),
  };
}

// ---------- storage, freshness, re-run ----------

export function newReviewRecord(parsed, today, trend, applied = null) {
  return {
    date: today,
    trendAtReview: dropEmpty({
      status: trend.status, slopeKgPerWeek: trend.slopeKgPerWeek, endKg: trend.endKg, rangeKg: trend.rangeKg,
      adherencePct: trend.adherencePct, expectedLossKg: trend.expectedLossKg, actualLossKg: trend.actualLossKg,
    }),
    ...parsed,
    useInSuggestions: true,
    applied,
  };
}

// Days of data (a food log or a weigh-in) after the review date.
export function newDataDays(challenge, daysMap, reviewDate) {
  const food = findStep(challenge, 'food');
  const body = findStep(challenge, 'body');
  let n = 0;
  for (const [date, day] of Object.entries(daysMap || {})) {
    if (date <= reviewDate) continue;
    const steps = (day && day.steps) || {};
    const fe = food && steps[food.id];
    const be = body && steps[body.id];
    if ((fe && Array.isArray(fe.meals) && fe.meals.length) || (be && isNum(be.value))) n++;
  }
  return n;
}

// { available, onDate }: Re-run needs the last review to be >= 3 days old or
// >= 3 new days of data.
export function rerunInfo(challenge, daysMap, today) {
  const r = challenge.plateauReview;
  if (!r || !DATE_RE.test(r.date || '')) return { available: true, onDate: null };
  const age = diffDays(r.date, today);
  const available = age >= RERUN_AFTER_DAYS || newDataDays(challenge, daysMap, r.date) >= RERUN_AFTER_NEW_DAYS;
  return { available, onDate: available ? null : addDays(r.date, RERUN_AFTER_DAYS) };
}

// A review is shown (not re-run) when it's still in effect (applied), or when
// re-running isn't available yet.
export function shouldShowExisting(challenge, daysMap, today) {
  const r = challenge.plateauReview;
  if (!r || typeof r !== 'object' || !r.verdict) return false;
  if (r.applied) return true;
  return !rerunInfo(challenge, daysMap, today).available;
}

// ---------- Apply / Undo (§6) ----------

export function foodStepOf(challenge) {
  return findStep(challenge, 'food');
}

// R3 uses this: a review feeds suggestions when fresh and switched on.
export function reviewIsFresh(review, today) {
  return !!review && review.useInSuggestions !== false && DATE_RE.test(review.date || '') && diffDays(review.date, today) < REVIEW_FRESH_DAYS;
}

// Protein hint for the "raise protein" action: 1.6 g per kg, rounded to 5,
// never lower than the current target.
export function proteinRaiseTarget(weightKg, currentTarget) {
  if (!isNum(weightKg)) return null;
  const goal = Math.round((weightKg * 1.6) / 5) * 5;
  return isNum(currentTarget) && goal <= currentTarget ? null : goal;
}

// Returns a new challenge object with the review's maintenance change
// applied to the food step (the caller saves it with store.updateChallenge so
// today's snapshot is re-taken) and `plateauReview.applied` recorded.
// `kind` is 'kcal' (lower_target / diet_break) or 'protein'.
export function applyChange(challenge, today, { kind = 'kcal', to, durationDays = null } = {}) {
  const review = challenge.plateauReview;
  const food = findStep(challenge, 'food');
  if (!review || !food || !isNum(to)) throw new Error('Nothing to apply.');
  const action = kind === 'protein' ? 'raise_protein' : review.maintenance.action;
  const field = kind === 'protein' ? 'protein' : 'kcal';
  const prior = review.applied && review.applied.field === field ? review.applied : null;
  const currentValue = field === 'kcal'
    ? (food.goal && food.goal.target)
    : (food.macros && food.macros.protein && food.macros.protein.target);
  if (!isNum(currentValue)) throw new Error('This challenge has no target to change.');
  const from = prior ? prior.from : currentValue;
  const steps = challenge.steps.map((s) => {
    if (s.id !== food.id) return s;
    if (field === 'kcal') return { ...s, goal: { ...s.goal, target: to } };
    return { ...s, macros: { ...s.macros, protein: { ...s.macros.protein, target: to } } };
  });
  const untilDate = action === 'diet_break' && isNum(durationDays) ? addDays(today, durationDays) : null;
  return {
    ...challenge,
    steps,
    plateauReview: { ...review, applied: { action, field, from, to, date: today, untilDate } },
  };
}

// Puts the exact previous target back and clears `applied`.
export function revertChange(challenge) {
  const review = challenge.plateauReview;
  const a = review && review.applied;
  const food = findStep(challenge, 'food');
  if (!a || !food || !isNum(a.from)) return challenge;
  const steps = challenge.steps.map((s) => {
    if (s.id !== food.id) return s;
    if (a.field === 'protein') return { ...s, macros: { ...s.macros, protein: { ...s.macros.protein, target: a.from } } };
    return { ...s, goal: { ...s.goal, target: a.from } };
  });
  return { ...challenge, steps, plateauReview: { ...review, applied: null } };
}
