// Pure scheduling for step reminders (docs/superpowers/plans/2026-10-02-step-reminders.md).
// No DOM, no localStorage — the runner (reminderRunner.js) owns the side effects.

import { isStepComplete, addDays, diffDays } from './rules.js';
import { targetFor } from './fitness.js';

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function firedKey(date, challengeId, stepId, time) {
  return `${date}|${challengeId}|${stepId}|${time}`;
}

// Reminders that should fire right now. `attempts` is store.state.attempts
// (id -> Attempt[]), `daysByChallenge` is store.state.days, `fired` is an
// array/Set of firedKey strings. Per step only the latest due time is
// returned; the caller marks every due time as fired (see allDueKeys).
export function dueReminders({ challenges, attempts, daysByChallenge, now, fired }) {
  const firedSet = fired instanceof Set ? fired : new Set(fired || []);
  const date = localDate(now);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const out = [];
  for (const challenge of challenges || []) {
    const attempt = ((attempts || {})[challenge.id] || []).find((a) => a.status === 'active');
    if (!attempt) continue;
    const dayNumber = diffDays(attempt.startDate, date) + 1;
    if (date < attempt.startDate || date > addDays(attempt.startDate, challenge.totalDays - 1) || dayNumber < 1) continue;
    const day = ((daysByChallenge || {})[challenge.id] || {})[date] || null;
    for (const step of challenge.steps || []) {
      const r = step.reminders;
      if (!r || !Array.isArray(r.times)) continue;
      const entry = day && day.steps ? day.steps[step.id] : undefined;
      if (isStepComplete(step, entry, targetFor(day, step))) continue;
      const due = r.times.filter((t) => t <= hhmm && !firedSet.has(firedKey(date, challenge.id, step.id, t)));
      if (!due.length) continue;
      const time = due.slice().sort()[due.length - 1];
      out.push({
        challengeId: challenge.id, stepId: step.id, stepName: step.name, challengeName: challenge.name,
        time, sound: r.sound !== false, vibrate: r.vibrate !== false, dueTimes: due,
      });
    }
  }
  return out;
}
