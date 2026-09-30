// Pure fitness-challenge logic: BMR/TDEE, default targets, MET-based workout
// burn estimate, meetsGoal, and the preset-step factories. No DOM, no
// IndexedDB — everything here takes plain data in and returns plain data
// out, so it can be unit tested (tests/fitness.test.js).
//
// Data model (see docs/superpowers/plans/2026-09-30-fitness-goals-ai-review.md
// §3 and §8):
// - challenge.category: 'custom' | 'fitness' (missing == 'custom').
// - challenge.profile: { sex, age, heightCm, startWeightKg, targetWeightKg,
//   activity, aim }, fitness challenges only.
// - step.type: one of STEP_TYPES, or missing for a custom step.
// - step.goal: { target: number, dir: 'atLeast' | 'atMost' | 'near' } | null.

import { makeFoodStep } from './foodLogic.js';

export const STEP_TYPES = ['food', 'workout', 'steps', 'water', 'body', 'sleep'];

// Fixed goal direction for every typed step except food (aim-dependent —
// see calorieTarget) and body (never has a goal).
export const FIXED_DIR = { workout: 'atLeast', steps: 'atLeast', water: 'atLeast', sleep: 'atLeast' };

// number.label/unit for each type, used both by the preset factories below
// and by the step editor to show a fixed unit label on the Target row.
export const TYPE_META = {
  food: { label: 'Calories', unit: 'kcal' },
  workout: { label: 'Workout', unit: 'min' },
  steps: { label: 'Steps', unit: 'steps' },
  water: { label: 'Water', unit: 'L' },
  body: { label: 'Weight', unit: 'kg' },
  sleep: { label: 'Sleep', unit: 'h' },
};

export const DEFAULT_STEPS_TARGET = 8000;
export const DEFAULT_SLEEP_TARGET = 7.5;
export const DEFAULT_WORKOUT_TARGET = 30;
export const WATER_PER_KG = 0.035;

const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };

export const WORKOUT_TYPES = ['Walk', 'Run', 'Gym', 'Yoga', 'Cycling', 'Sports', 'Other'];
export const MET = { Walk: 3.5, Run: 9.8, Gym: 5, Yoga: 2.5, Cycling: 7.5, Sports: 7, Other: 4 };
export const INTENSITIES = ['light', 'moderate', 'hard'];
export const INTENSITY_MULT = { light: 0.8, moderate: 1, hard: 1.25 };

function round1(n) {
  return Math.round(n * 10) / 10;
}

function roundTo10(n) {
  return Math.round(n / 10) * 10;
}

// ---------- energy needs ----------

// At BMI ≥ 30, full body weight overstates energy needs; use the standard
// adjusted weight: ideal (Devine) + 40% of the excess.
export function effectiveWeightKg(profile) {
  const { sex, heightCm, startWeightKg: kg } = profile;
  const bmi = kg / ((heightCm / 100) ** 2);
  if (bmi < 30) return kg;
  const ideal = (sex === 'male' ? 50 : 45.5) + 0.9 * (heightCm - 152.4);
  return ideal + 0.4 * (kg - ideal);
}

// Mifflin-St Jeor on the effective weight.
export function bmr(profile) {
  const { sex, age, heightCm } = profile;
  const base = 10 * effectiveWeightKg(profile) + 6.25 * heightCm - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

// Daily-life energy only. Capped at "light" because workouts are logged
// (and burned) separately — counting them here too inflates the intake target.
const MAX_BASE_FACTOR = ACTIVITY_FACTORS.light;

export function tdee(profile) {
  const factor = ACTIVITY_FACTORS[profile.activity] ?? ACTIVITY_FACTORS.sedentary;
  return bmr(profile) * Math.min(factor, MAX_BASE_FACTOR);
}

const KCAL_PER_KG = 7700;
const MAX_SURPLUS = 500;

function calorieFloor(profile) {
  return profile.sex === 'male' ? 1500 : 1200;
}

// Calorie target sized to reach targetWeightKg in totalDays. The daily
// deficit is capped at the safe maximum (≤1000 kcal,
// never below the floor); minDays is the fewest days that cap allows.
// Returns null when there's no weight change to plan for.
export function goalPlan(profile, totalDays) {
  const { aim, startWeightKg: start, targetWeightKg: target } = profile;
  const kg = aim === 'lose' ? start - target : aim === 'gain' ? target - start : 0;
  if (!(kg > 0) || !(totalDays > 0)) return null;

  const energy = tdee(profile);
  const floor = calorieFloor(profile);
  const maxDelta = aim === 'lose'
    ? Math.max(0, Math.min(1000, energy - floor))
    : MAX_SURPLUS;
  if (maxDelta <= 0) return null;

  const totalKcal = kg * KCAL_PER_KG;
  const delta = Math.min(totalKcal / totalDays, maxDelta);
  const minDays = Math.ceil(totalKcal / maxDelta);
  const raw = aim === 'lose' ? energy - delta : energy + delta;
  return {
    calories: { target: Math.max(floor, roundTo10(raw)), dir: aim === 'lose' ? 'atMost' : 'atLeast' },
    dailyDelta: Math.round(delta),
    kg: Math.round(kg * 10) / 10,
    minDays,
    daysOk: totalDays >= minDays,
  };
}

// Returns { target, dir } — the calorie goal for the profile's aim, rounded
// to the nearest 10 with a floor of 1200 (female) / 1500 (male). With
// totalDays, lose/gain targets are sized to the weight goal (see goalPlan).
export function calorieTarget(profile, totalDays) {
  const plan = goalPlan(profile, totalDays);
  if (plan) return plan.calories;
  const energy = tdee(profile);
  let raw;
  let dir;
  if (profile.aim === 'lose') {
    // A 20% deficit, kept between 500 and 1000 kcal/day.
    raw = energy - Math.min(1000, Math.max(500, energy * 0.2));
    dir = 'atMost';
  } else if (profile.aim === 'gain') {
    raw = energy + 300;
    dir = 'atLeast';
  } else {
    raw = energy;
    dir = 'near';
  }
  const floor = profile.sex === 'male' ? 1500 : 1200;
  return { target: Math.max(floor, roundTo10(raw)), dir };
}

export function waterTargetL(kg) {
  return round1(kg * WATER_PER_KG);
}

// ---------- macro targets ----------

// Protein scales with body weight (not calories); carbs fill whatever's left
// after protein and fat; fiber scales with calories, floored at 25 g. See
// docs §9. Returns the step.macros shape — fixed directions per macro
// (protein/fiber "at least", carbs/fat "at most"), independent of the
// calorie goal's own direction.
export function macroTargets(profile, kcal) {
  const protein = Math.round(1.6 * effectiveWeightKg(profile));
  const fat = Math.round(0.25 * kcal / 9);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const fiber = Math.max(25, Math.round(14 * kcal / 1000));
  return {
    protein: { target: protein, dir: 'atLeast' },
    fiber: { target: fiber, dir: 'atLeast' },
    carbs: { target: carbs, dir: 'atMost' },
    fat: { target: fat, dir: 'atMost' },
  };
}

// ---------- workout burn ----------

export function workoutBurnKcal({ type, minutes, intensity, kg }) {
  const met = MET[type] ?? MET.Other;
  const mult = INTENSITY_MULT[intensity] ?? INTENSITY_MULT.moderate;
  const mins = Number.isFinite(minutes) ? minutes : 0;
  const weight = Number.isFinite(kg) ? kg : 0;
  return Math.round(met * mult * weight * mins / 60);
}

// The latest body weight logged anywhere in the challenge (across all days),
// or profile.startWeightKg if none has been logged yet. `daysMap` is the
// { date: Day } map for one challenge (see store.state.days).
export function latestBodyWeightKg(challenge, daysMap, profile) {
  const bodyStep = (challenge.steps || []).find((s) => s.type === 'body');
  if (bodyStep && daysMap) {
    const dates = Object.keys(daysMap).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const entry = daysMap[dates[i]] && daysMap[dates[i]].steps && daysMap[dates[i]].steps[bodyStep.id];
      if (entry && Number.isFinite(entry.value)) return entry.value;
    }
  }
  return profile ? profile.startWeightKg : undefined;
}

// The most recently logged Body-step photo anywhere in the challenge (same
// walk as latestBodyWeightKg, but for photoId instead of value) — the photo
// the weekly body check (see docs/.../meal-suggestions.md §3) sends to
// Gemini. null when there's no body step or no photo has been logged yet.
export function latestBodyPhotoId(challenge, daysMap) {
  const bodyStep = (challenge.steps || []).find((s) => s.type === 'body');
  if (!bodyStep || !daysMap) return null;
  const dates = Object.keys(daysMap).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const entry = daysMap[dates[i]] && daysMap[dates[i]].steps && daysMap[dates[i]].steps[bodyStep.id];
    if (entry && entry.photoId) return entry.photoId;
  }
  return null;
}

// ---------- goal check ----------

// The value must be a finite number greater than 0.
export function meetsGoal(value, target, dir) {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (!Number.isFinite(target)) return false;
  if (dir === 'atLeast') return value >= target;
  if (dir === 'atMost') return value <= target;
  if (dir === 'near') return Math.abs(value - target) <= 0.1 * target;
  return false;
}

export function dirLabel(dir) {
  if (dir === 'atLeast') return 'at least';
  if (dir === 'atMost') return 'at most';
  if (dir === 'near') return 'within ±10%';
  return '';
}

// ---------- step factories ----------

// Builds one typed step with the exact shape backup/stats expect (see
// docs §8 "presetSteps"). `goal` is `{ target, dir }` or null (body only).
// `macros` (food only — see docs §9) is the step.macros shape from
// macroTargets(), or null/missing when the step has no macro targets.
export function makeTypedStep(type, { id, name, mandatory, goal, macros }) {
  if (type === 'food') {
    const step = makeFoodStep({ id, name, mandatory });
    step.goal = goal || null;
    step.macros = macros || null;
    return step;
  }
  const meta = TYPE_META[type];
  if (!meta) throw new Error(`Unknown step type: ${type}`);
  return {
    id,
    name,
    mandatory: !!mandatory,
    type,
    // Body is picture + weight; logging the weight completes it.
    photo: type === 'body' ? 'optional' : 'none',
    note: 'none',
    number: { label: meta.label, unit: meta.unit, required: type === 'body', showSum: false, showDiff: type === 'body', showAvg: true },
    goal: type === 'body' ? null : (goal || null),
  };
}

// Food, Workout, Steps, Water, Body and Sleep, all mandatory except Body.
// Each preset target is derived from `profile`; ids are fixed (there's only
// ever one of each in a freshly-generated preset list).
export function presetSteps(profile, totalDays) {
  const kg = profile.startWeightKg;
  const foodGoal = calorieTarget(profile, totalDays);
  return [
    makeTypedStep('food', { id: 'food', name: 'Food', mandatory: true, goal: foodGoal, macros: macroTargets(profile, foodGoal.target) }),
    makeTypedStep('workout', { id: 'workout', name: 'Workout', mandatory: true, goal: { target: DEFAULT_WORKOUT_TARGET, dir: 'atLeast' } }),
    makeTypedStep('steps', { id: 'steps', name: 'Steps', mandatory: true, goal: { target: DEFAULT_STEPS_TARGET, dir: 'atLeast' } }),
    makeTypedStep('water', { id: 'water', name: 'Water', mandatory: true, goal: { target: waterTargetL(kg), dir: 'atLeast' } }),
    makeTypedStep('body', { id: 'body', name: 'Body', mandatory: false, goal: null }),
    makeTypedStep('sleep', { id: 'sleep', name: 'Sleep', mandatory: true, goal: { target: DEFAULT_SLEEP_TARGET, dir: 'atLeast' } }),
  ];
}

// ---------- targets ----------

// { stepId: goal.target } for every step that has a goal — the base
// (non-AI) targets snapshotted onto a day the first time it's edited.
export function baseTargets(challenge) {
  const targets = {};
  for (const step of challenge.steps || []) {
    if (step.goal && Number.isFinite(step.goal.target)) targets[step.id] = step.goal.target;
  }
  return targets;
}

// The target that applies for `step` on `day`: the day's snapshot, falling
// back to the step's base goal target, falling back to null (no goal).
export function targetFor(day, step) {
  return (day && day.targets && day.targets[step.id]) ?? (step.goal && step.goal.target) ?? null;
}
