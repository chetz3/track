// Pure rule functions for the N-day challenge tracker.
// No DOM access, no IndexedDB — everything here takes plain data in and
// returns plain data out, so it can be unit tested with Node's test runner.

import { meetsGoal } from './fitness.js';

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Adds n days (n may be negative) to a local YYYY-MM-DD date string.
export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatLocalDate(d);
}

// Whole-day difference (toStr - fromStr) between two local date strings.
export function diffDays(fromStr, toStr) {
  const a = parseLocalDate(fromStr);
  const b = parseLocalDate(toStr);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Only today and yesterday may be edited; everything else is locked.
export function isEditable(date, today) {
  return date === today || date === addDays(today, -1);
}

export function isNumberValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Matches a plain decimal: optional leading '-', digits (or none before a
// leading '.'), and an optional '.'/',' followed by digits — e.g. '78.4',
// '-2.5', '.5'. Deliberately excludes hex ('0x10') and exponent ('1e999')
// forms that `Number(...)` would otherwise happily parse.
const PLAIN_DECIMAL_RE = /^-?(\d+([.,]\d+)?|\.\d+)$/;
// A comma followed by exactly three digits and nothing else is ambiguous
// (European decimal '12,345' meaning 12.345 vs. a thousands separator
// meaning 12345) — reject rather than guess.
const THOUSANDS_RE = /^-?\d{1,3}(,\d{3})+$/;

export function parseNumberInput(str) {
  const t = String(str ?? '').trim();
  if (t === '') return undefined;
  if (THOUSANDS_RE.test(t)) return undefined;
  if (!PLAIN_DECIMAL_RE.test(t)) return undefined;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function requiredFieldsFilled(stepDef, entry) {
  if (!stepDef || !entry) return false;
  const needsPhoto = stepDef.photo === 'required';
  const needsNumber = !!(stepDef.number && stepDef.number.required);
  if (!needsPhoto && !needsNumber) return false;
  if (needsPhoto && !entry.photoId) return false;
  if (needsNumber && !isNumberValue(entry.value)) return false;
  return true;
}

// `target` is only used for a step with a goal (see fitness.js): when
// stepDef.goal exists, completion is decided purely by meetsGoal(value,
// target ?? stepDef.goal.target, dir) — the done checkbox is ignored, since
// there's nothing for the user to "tick" beyond hitting the number.
export function isStepComplete(stepDef, entry, target) {
  if (stepDef && stepDef.goal) {
    const t = target ?? stepDef.goal.target;
    const value = entry && entry.value;
    // Food (unless the aim is to gain) is green from half the target up to
    // the target — a snack isn't a day, and going over isn't a pass.
    if (stepDef.type === 'food' && stepDef.goal.dir !== 'atLeast') {
      return Number.isFinite(value) && Number.isFinite(t) && value >= 0.5 * t && value <= t;
    }
    return meetsGoal(value, t, stepDef.goal.dir);
  }
  if (!entry || !entry.done) return false;
  if (!stepDef) return true;
  if (stepDef.photo === 'required' && !entry.photoId) return false;
  if (stepDef.number && stepDef.number.required && !isNumberValue(entry.value)) return false;
  return true;
}

export function mandatorySnapshot(challenge) {
  return challenge.steps.filter((s) => s.mandatory).map((s) => s.id);
}

// A day is green when every mandatory step recorded in its snapshot
// (day.mandatoryStepIds) is complete. Optional steps never affect colour.
export function isDayGreen(day, challenge) {
  if (!day || !Array.isArray(day.mandatoryStepIds)) return false;
  const steps = day.steps || {};
  return day.mandatoryStepIds.every((id) =>
    isStepComplete(challenge.steps.find((s) => s.id === id), steps[id], day.targets && day.targets[id]));
}

export function dayStatus(date, day, challenge, today) {
  if (date > today) return 'future';
  if (isDayGreen(day, challenge)) return 'green';
  if (isEditable(date, today)) return 'pending';
  return 'red';
}

// A week is only decided once its last day is locked (green or red).
// Otherwise it is still "pending" (in progress).
// Green week = green day count >= min(weeklyTarget, days in this week),
// which handles a shorter final week when totalDays isn't a multiple of 7.
export function weekStatus(dayStatuses, weeklyTarget) {
  if (dayStatuses.length === 0) return 'pending';
  const last = dayStatuses[dayStatuses.length - 1];
  if (last !== 'green' && last !== 'red') return 'pending';
  const greenCount = dayStatuses.filter((s) => s === 'green').length;
  const threshold = Math.min(weeklyTarget, dayStatuses.length);
  return greenCount >= threshold ? 'green' : 'red';
}

// Walks an attempt week by week from its startDate and decides what should
// happen to it: still active, reset (a week finalised red), or complete
// (day N reached with every week green). Stops at the first pending
// (in-progress) or red week — the caller re-runs this against a fresh
// attempt after applying a reset.
//
// attempt.greenWeeks (if set) is the number of leading weeks already
// finalised green. Those weeks are frozen — always reported green,
// without being re-scored — so raising weeklyTarget/totalDays later can't
// retroactively fail a week that already passed under the old settings.
//
// Fitness challenges (challenge.category === 'fitness') use a hard **daily**
// reset instead of the weekly one: the first locked (red) day ends the
// attempt immediately, rather than waiting for the rest of that week to be
// walked/locked. Weeks are still grouped for display — a fitness week just
// ends early (with whatever days were walked so far) the moment a red day is
// hit. Custom challenges are unaffected (weeklyTarget-based weekStatus,
// unchanged).
export function evaluateAttempt(challenge, attempt, daysMap, today) {
  const { totalDays, weeklyTarget } = challenge;
  const isFitness = challenge.category === 'fitness';
  const startDate = attempt.startDate;
  const frozenWeeks = attempt.greenWeeks || 0;
  const weeks = [];
  let dayNumber = 1;
  let weekIndex = 0;
  let outcome = 'active';
  let resetDate = null;

  while (dayNumber <= totalDays) {
    const weekDayStatuses = [];
    const weekStartDate = addDays(startDate, dayNumber - 1);
    let weekEndDate = weekStartDate;
    let fitnessReset = false;
    for (let i = 0; i < 7 && dayNumber <= totalDays; i++, dayNumber++) {
      const date = addDays(startDate, dayNumber - 1);
      const day = daysMap[date];
      const ds = dayStatus(date, day, challenge, today);
      weekDayStatuses.push(ds);
      weekEndDate = date;
      if (isFitness && weekIndex >= frozenWeeks && ds === 'red') {
        fitnessReset = true;
        break;
      }
    }
    const status = fitnessReset ? 'red' : weekIndex < frozenWeeks ? 'green' : weekStatus(weekDayStatuses, weeklyTarget);
    weeks.push({ startDate: weekStartDate, endDate: weekEndDate, dayStatuses: weekDayStatuses, status });
    weekIndex++;

    if (fitnessReset) {
      outcome = 'reset';
      resetDate = addDays(weekEndDate, 1);
      break;
    }
    if (status === 'pending') break;
    if (status === 'red') {
      outcome = 'reset';
      resetDate = addDays(weekEndDate, 1);
      break;
    }
  }

  const coveredDays = weeks.reduce((sum, w) => sum + w.dayStatuses.length, 0);
  if (outcome === 'active' && coveredDays >= totalDays) {
    const lastWeek = weeks[weeks.length - 1];
    if (lastWeek && lastWeek.status === 'green') outcome = 'complete';
  }

  const elapsed = diffDays(startDate, today) + 1;
  const currentDayNumber = Math.max(1, Math.min(elapsed, totalDays));

  return { weeks, outcome, resetDate, currentDayNumber };
}
