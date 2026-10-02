// App-state layer: loads challenges/attempts/days from IndexedDB, keeps an
// in-memory `state`, evaluates attempts (reset/complete loop), and is the
// only place that writes back to the DB. UI screens (later tasks) call
// these functions and subscribe via onChange to know when to re-render.

import * as db from './db.js';
import { addDays, isEditable, evaluateAttempt, mandatorySnapshot } from './rules.js';
import { baseTargets } from './fitness.js';
import { dayKey } from './migrate.js';
import { deletePhoto } from './photos.js';
import { nextSelectedId, applyStepPatch, resnapshotToday, validateChallengeInput } from './storeLogic.js';

const SELECTED_KEY = 'tracker:selected';

export const state = {
  challenges: [],
  selectedId: null,
  attempts: {}, // id -> Attempt[]
  days: {}, // id -> { date: Day }
  evaluations: {}, // id -> evaluateAttempt result
};

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readSelectedId() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch (_) {
    return null;
  }
}

function writeSelectedId(id) {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

function makeAttemptId() {
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function selected() {
  return state.challenges.find((c) => c.id === state.selectedId) || null;
}

export function select(id) {
  state.selectedId = id;
  writeSelectedId(id);
  notify();
}

// Active attempt if there is one, else the latest complete attempt.
export function displayAttempt(challengeId) {
  const attempts = state.attempts[challengeId] || [];
  const active = attempts.find((a) => a.status === 'active');
  if (active) return active;
  const completed = attempts.filter((a) => a.status === 'complete');
  return completed.reduce((latest, a) => (!latest || a.startDate > latest.startDate ? a : latest), null);
}

export function getDay(challengeId, date) {
  const days = state.days[challengeId] || {};
  return days[date] || { key: dayKey(challengeId, date), challengeId, date, mandatoryStepIds: null, steps: {} };
}

async function reevaluate(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  const attempts = state.attempts[id] || (state.attempts[id] = []);
  let attempt = displayAttempt(id);
  if (!challenge || !attempt) {
    delete state.evaluations[id];
    return;
  }
  if (attempt.status !== 'active') {
    // Finalised (complete/reset) attempts are frozen — just compute a
    // display evaluation, never mutate them.
    state.evaluations[id] = evaluateAttempt(challenge, attempt, state.days[id] || {}, today());
    return;
  }
  let guard = 0;
  while (guard++ < 1000) {
    const result = evaluateAttempt(challenge, attempt, state.days[id] || {}, today());
    state.evaluations[id] = result;

    const greenWeeksCount = result.weeks.filter((w) => w.status === 'green').length;
    if (greenWeeksCount > (attempt.greenWeeks || 0)) {
      attempt.greenWeeks = greenWeeksCount;
      await db.put('attempts', attempt);
    }

    if (result.outcome === 'reset') {
      const failedWeek = result.weeks[result.weeks.length - 1];
      attempt.status = 'reset';
      attempt.endDate = failedWeek.endDate;
      await db.put('attempts', attempt);
      const newAttempt = { id: makeAttemptId(), challengeId: id, startDate: result.resetDate, status: 'active', greenWeeks: 0 };
      await db.put('attempts', newAttempt);
      attempts.push(newAttempt);
      attempt = newAttempt;
      continue;
    }
    if (result.outcome === 'complete' && attempt.status !== 'complete') {
      attempt.status = 'complete';
      attempt.endDate = addDays(attempt.startDate, challenge.totalDays - 1);
      await db.put('attempts', attempt);
    }
    break;
  }
}

export async function loadAll() {
  const challenges = await db.getAll('challenges');
  state.challenges = challenges;
  state.attempts = {};
  state.days = {};
  state.evaluations = {};

  for (const c of challenges) {
    const attempts = await db.getAllByChallenge('attempts', c.id);
    state.attempts[c.id] = attempts;
    const days = await db.getAllByChallenge('days', c.id);
    const daysMap = {};
    for (const d of days) daysMap[d.date] = d;
    state.days[c.id] = daysMap;
  }

  const savedId = readSelectedId();
  if (savedId && challenges.some((c) => c.id === savedId)) {
    state.selectedId = savedId;
  } else {
    state.selectedId = challenges.length ? challenges[0].id : null;
  }

  for (const c of challenges) await reevaluate(c.id);
}

function isOutsideDisplayAttempt(challengeId, challenge, date) {
  const attempt = displayAttempt(challengeId);
  if (!attempt) return true;
  const lastDate = addDays(attempt.startDate, challenge.totalDays - 1);
  return date < attempt.startDate || date > lastDate;
}

export async function updateStep(challengeId, date, stepId, patch) {
  const challenge = state.challenges.find((c) => c.id === challengeId);
  if (!challenge) throw new Error('This day can no longer be edited.');
  if (!isEditable(date, today())) throw new Error('This day can no longer be edited.');
  if (isOutsideDisplayAttempt(challengeId, challenge, date)) throw new Error('This day can no longer be edited.');

  const oldDay = getDay(challengeId, date);
  // Build the new day as a copy — never mutate oldDay/oldDay.steps in place —
  // so that if db.put below fails, the in-memory state (assigned only after
  // a successful write) still reflects what's actually on disk instead of a
  // value the UI displayed as saved but that never made it to the DB.
  const day = { ...oldDay, steps: { ...(oldDay.steps || {}) } };
  if (day.mandatoryStepIds == null) {
    day.mandatoryStepIds = mandatorySnapshot(challenge);
    day.targets = baseTargets(challenge);
  }

  const stepDef = challenge.steps.find((s) => s.id === stepId);
  const oldEntry = day.steps[stepId];
  const oldPhotoId = oldEntry && oldEntry.photoId;
  day.steps[stepId] = applyStepPatch(stepDef, oldEntry, patch);

  await db.put('days', day);
  state.days[challengeId] = state.days[challengeId] || {};
  state.days[challengeId][date] = day;

  // The day is now saved — updateStep must not throw past this point.
  // Callers (e.g. today.js's handlePhotoFile) treat a thrown updateStep as
  // "nothing was persisted" and clean up the photo they just wrote; once
  // db.put above has succeeded, that cleanup would delete a photo the saved
  // day now references. Best-effort cleanup/reevaluate/notify failures are
  // logged instead of rethrown.
  try {
    if (patch.photoId && oldPhotoId && oldPhotoId !== patch.photoId) {
      await deletePhoto(oldPhotoId);
    }

    await reevaluate(challengeId);
    notify();
  } catch (err) {
    console.error(err);
  }
}

// Writes a food step's `planned` placeholders (docs §9) for `date`, which —
// unlike updateStep — may be *today or tomorrow*: "Tomorrow's plan can be
// edited today, even though logging for that day stays locked" (isEditable
// only allows today/yesterday). Deliberately never touches
// mandatoryStepIds/targets (compare updateStep, which snapshots them on a
// day's first edit): a placeholder never counts toward calories, macros or
// green (see js/foodLogic.js's buildFoodPatch and js/mealPlan.js's
// placeholderStatus), so writing one must not make dayStatus/isDayGreen
// treat the day as started. Tomorrow's own dayStatus is 'future' regardless
// (rules.js's dayStatus short-circuits on date > today), so this is only
// ever observable once tomorrow becomes today — at which point the first
// real updateStep on it snapshots mandatoryStepIds/targets exactly as it
// always has, off the challenge as it stands *then*.
export async function updatePlanned(challengeId, date, stepId, planned) {
  const challenge = state.challenges.find((c) => c.id === challengeId);
  if (!challenge) throw new Error('This day can no longer be edited.');
  const t = today();
  if (date !== t && date !== addDays(t, 1)) throw new Error('This day can no longer be edited.');
  if (isOutsideDisplayAttempt(challengeId, challenge, date)) throw new Error('This day can no longer be edited.');

  const oldDay = getDay(challengeId, date);
  const day = { ...oldDay, steps: { ...(oldDay.steps || {}) } };
  const oldEntry = day.steps[stepId] || {};
  day.steps[stepId] = { ...oldEntry, planned };

  await db.put('days', day);
  state.days[challengeId] = state.days[challengeId] || {};
  state.days[challengeId][date] = day;

  try {
    await reevaluate(challengeId);
    notify();
  } catch (err) {
    console.error(err);
  }
}

function makeChallengeId() {
  return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function createChallenge(input) {
  const errors = validateChallengeInput(input, today());
  if (errors.length) throw new Error(errors.join(' '));

  const id = makeChallengeId();
  // startDate belongs to the attempt, not the challenge record (mirroring
  // the shape migrate.js produces: challenges never carry a startDate,
  // since it would go stale across resets).
  const { startDate, ...challengeFields } = input;
  const challenge = { ...challengeFields, id, createdAt: Date.now() };
  const attempt = { id, challengeId: id, startDate, status: 'active', greenWeeks: 0 };

  await db.putMany([
    { store: 'challenges', value: challenge },
    { store: 'attempts', value: attempt },
  ]);

  select(id);
  await loadAll();
  notify();
  return challenge;
}

export async function updateChallenge(challenge) {
  // Validate ignoring startDate: an existing challenge's startDate is
  // already in the past, so the "yesterday at the earliest" rule must not
  // fire for it here.
  const errors = validateChallengeInput({ ...challenge, startDate: undefined }, today());
  if (errors.length) throw new Error(errors.join(' '));

  // The edit form only ever carries name/totalDays/weeklyTarget/steps — never
  // createdAt — so writing `challenge` as-is would silently drop it from the
  // stored record. Preserve whatever the existing record has.
  const existing = state.challenges.find((c) => c.id === challenge.id);
  // Merge onto the existing record so fields the form doesn't carry
  // (mealPlan, bodyCheck) survive an edit.
  const toStore = { ...(existing || {}), ...challenge, createdAt: (existing && existing.createdAt) ?? challenge.createdAt };

  await db.put('challenges', toStore);

  const days = state.days[challenge.id] || {};
  const resnapshotted = resnapshotToday(days[today()], toStore);
  if (resnapshotted) await db.put('days', resnapshotted);

  await loadAll();
  notify();
}

// Merges `patch` onto a challenge record and writes it straight to
// IndexedDB — no resnapshotting today's mandatory/targets (unlike
// updateChallenge, which changes the steps/profile that snapshot is derived
// from). Meant for fields that live on the challenge but don't affect
// scoring: challenge.mealPlan and challenge.bodyCheck (see
// docs/superpowers/plans/2026-09-30-meal-suggestions.md §6).
export async function patchChallenge(id, patch) {
  const existing = state.challenges.find((c) => c.id === id);
  if (!existing) throw new Error('Challenge not found.');
  const updated = { ...existing, ...patch };
  await db.put('challenges', updated);
  const idx = state.challenges.findIndex((c) => c.id === id);
  if (idx !== -1) state.challenges[idx] = updated;
  notify();
  return updated;
}

export async function deleteChallenge(id) {
  await db.deleteChallengeCascade(id);
  select(nextSelectedId(state.challenges, id, state.selectedId));
  await loadAll();
  notify();
}
