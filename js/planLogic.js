// Pure helpers for meal times and the Plan tab (R0 of
// docs/superpowers/plans/2026-10-10-plateau-coach.md §3A). No DOM, no
// IndexedDB, no network — plain data in, plain data out, tested in
// tests/planLogic.test.js.

import { addDays } from './rules.js';
import { placeholderStatus } from './mealPlan.js';
import { normDish } from './dish.js';

// ---------- meal times ----------

// "8:45 am" from a meal's `at` (epoch ms), in local time. '' when the meal
// predates the field (no `at`), so old meals show no time at all.
export function mealTimeLabel(at) {
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, (_, c) => ` ${c.toLowerCase()}m`);
}

// Meals ordered by `at` ascending; meals without a usable `at` keep their
// stored order after the timed ones. Returns a new array (never mutates).
export function sortMealsByAt(meals) {
  const list = Array.isArray(meals) ? meals : [];
  const timed = [];
  const untimed = [];
  list.forEach((m, i) => {
    if (m && Number.isFinite(m.at)) timed.push({ m, i }); else untimed.push(m);
  });
  timed.sort((a, b) => a.m.at - b.m.at || a.i - b.i);
  return timed.map((x) => x.m).concat(untimed);
}

// ---------- planner range ----------

// The Plan tab (and store.updatePlanned) may write today through today + 6.
export function isPlannableDate(date, today) {
  return typeof date === 'string' && date >= today && date <= addDays(today, 6);
}

// ---------- planned-meal merging ----------

export { normDish } from './dish.js';

function slotKey(p) {
  return String((p && p.slot) || '').trim().toLowerCase();
}

// "Add to existing": append `incoming`, skipping any whose slot + dish
// already exists (in `existing` or earlier in `incoming`). Returns
// { list, added, skipped }.
export function mergeAddToExisting(existing, incoming) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(list.map((p) => `${slotKey(p)}|${normDish(p && p.dish)}`));
  let added = 0;
  let skipped = 0;
  for (const p of Array.isArray(incoming) ? incoming : []) {
    const key = `${slotKey(p)}|${normDish(p && p.dish)}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    list.push(p);
    added++;
  }
  return { list, added, skipped };
}

// Placeholders that are not yet linked to a logged meal.
export function unloggedPlaceholders(planned, meals) {
  return (Array.isArray(planned) ? planned : []).filter((p) => placeholderStatus(p, meals).status !== 'logged');
}

// Drops every unlogged placeholder; logged ones are never touched.
export function clearUnlogged(planned, meals) {
  return (Array.isArray(planned) ? planned : []).filter((p) => placeholderStatus(p, meals).status === 'logged');
}

// "Replace this day's plan": keeps the logged placeholders, drops the rest,
// then appends `incoming` — except for slots a logged placeholder already
// fills, so a slot that's been eaten isn't planned twice.
export function replaceKeepingLogged(planned, meals, incoming) {
  const kept = clearUnlogged(planned, meals);
  const loggedSlots = new Set(kept.map((p) => p.slot));
  return kept.concat((Array.isArray(incoming) ? incoming : []).filter((p) => !loggedSlots.has(p.slot)));
}

// Copies of `planned` for another day: fresh ids from `makeId`, no link to
// any logged meal (ids are new, so they start as Planned).
export function copyPlaceholders(planned, makeId) {
  return (Array.isArray(planned) ? planned : []).map((p) => ({ ...p, id: makeId() }));
}

// Placeholders in time order (HH:MM strings), stable.
export function sortPlanned(planned) {
  return (Array.isArray(planned) ? planned : []).slice()
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

export function plannedKcal(planned) {
  return (Array.isArray(planned) ? planned : []).reduce((t, p) => t + (p && Number.isFinite(p.kcal) ? p.kcal : 0), 0);
}
