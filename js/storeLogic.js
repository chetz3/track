// Pure helpers for the app-state layer. No DOM, no IndexedDB — everything
// here takes plain data in and returns plain data out, so it can be unit
// tested with Node's test runner.

import { requiredFieldsFilled, mandatorySnapshot, addDays } from './rules.js';
import { baseTargets } from './fitness.js';

export function nextSelectedId(challenges, deletedId, currentId) {
  if (currentId !== deletedId) return currentId;
  const rest = challenges.filter((c) => c.id !== deletedId);
  return rest.length ? rest[0].id : null;
}

export function applyStepPatch(stepDef, entry, patch) {
  const next = { ...(entry || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const filledNow = requiredFieldsFilled(stepDef, next);
  const filledBefore = requiredFieldsFilled(stepDef, entry || {});
  if (!('done' in patch) && filledNow && !filledBefore) next.done = true;
  return next;
}

export function resnapshotToday(day, challenge) {
  if (!day) return undefined;
  return { ...day, mandatoryStepIds: mandatorySnapshot(challenge), targets: baseTargets(challenge) };
}

export function validateChallengeInput(input, today) {
  const errors = [];
  if (!input.name || !input.name.trim()) errors.push('Give the challenge a name.');
  if (!Number.isInteger(input.totalDays) || input.totalDays < 1 || input.totalDays > 1000) errors.push('Days must be between 1 and 1000.');
  if (!Number.isInteger(input.weeklyTarget) || input.weeklyTarget < 1 || input.weeklyTarget > 7) errors.push('Green days per week must be 1–7.');
  if (input.startDate && input.startDate < addDays(today, -1)) errors.push('Start date can be yesterday at the earliest.');
  if (!input.steps || input.steps.length === 0) errors.push('Add at least one step.');
  else if (!input.steps.some((s) => s.mandatory)) errors.push('Make at least one step mandatory.');
  return errors;
}
