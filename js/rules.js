// Pure rule functions for the N-day challenge tracker.
// No DOM access, no IndexedDB — everything here takes plain data in and
// returns plain data out, so it can be unit tested with Node's test runner.

export const BODY_STEP_ID = 'body';

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

// A day is green when every mandatory step recorded in its snapshot
// (day.mandatoryStepIds) is complete. Optional steps never affect colour.
export function isDayGreen(day, config) {
  if (!day || !Array.isArray(day.mandatoryStepIds)) return false;
  for (const id of day.mandatoryStepIds) {
    if (id === BODY_STEP_ID) {
      const hasWeight = day.weight !== undefined && day.weight !== null && day.weight !== '';
      if (!hasWeight || !day.bodyPhotoId) return false;
    } else {
      const entry = day.steps && day.steps[id];
      if (!entry || !entry.done) return false;
      const stepDef = config && config.steps && config.steps.find((s) => s.id === id);
      if (stepDef && stepDef.requiresPhoto && !entry.photoId) return false;
    }
  }
  return true;
}

export function dayStatus(date, day, config, today) {
  if (date > today) return 'future';
  if (isDayGreen(day, config)) return 'green';
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
export function evaluateAttempt(config, attempt, daysMap, today) {
  const { totalDays, weeklyTarget } = config;
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
    for (let i = 0; i < 7 && dayNumber <= totalDays; i++, dayNumber++) {
      const date = addDays(startDate, dayNumber - 1);
      const day = daysMap[date];
      weekDayStatuses.push(dayStatus(date, day, config, today));
      weekEndDate = date;
    }
    const status = weekIndex < frozenWeeks ? 'green' : weekStatus(weekDayStatuses, weeklyTarget);
    weeks.push({ startDate: weekStartDate, endDate: weekEndDate, dayStatuses: weekDayStatuses, status });
    weekIndex++;

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
