// Today (#/today) and Day detail (#/day/:date) screens: the hero "day
// status" card plus the grouped step list with inline expand-to-edit rows.
//
// Render contract (see app.js): renderToday/renderDay receive a container
// already attached inside #app. They may only write inside it, and must call
// hydratePhotos only on that attached container.

import * as store from '../store.js';
import { dayStatus, isEditable, isStepComplete, parseNumberInput, isNumberValue, addDays, diffDays } from '../rules.js';
import { savePhoto, deletePhoto, getPhotoBlob, photoDateOf } from '../photos.js';
import { esc, formatDateLong, hydratePhotos, readFileAsPhoto } from './dom.js';
import { isFoodStep, buildFoodPatch, mealsTotal, mealsMacros, macroDotLine, macroInlineLine, MACRO_KEYS, MACRO_META } from '../foodLogic.js';
import { estimateCalories, suggestMeals, checkBody } from '../gemini.js';
import { openSheet } from './sheet.js';
import { targetFor, workoutBurnKcal, latestBodyWeightKg, latestBodyPhotoId, meetsGoal, WORKOUT_TYPES, INTENSITIES } from '../fitness.js';
import { canSuggest, buildSuggestionInput, planTotals, scheduleOf, windowStatus, placeholderStatus } from '../mealPlan.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLE_MAP = { 'number-input': 'number', 'note-input': 'note' };

// Which step (if any) has its edit panel open. Kept in module scope, keyed
// by `${challengeId}:${date}`, so it survives the store-driven re-renders
// that replace the whole screen but resets when the user actually navigates
// to a different challenge/day.
let expandedKey = null;
let expandedStepId = null;

// Last-seen day status per `${challengeId}:${date}`, used to detect the
// pending/red -> green transition that plays the pill's "pop" animation.
const lastStatusByKey = new Map();

// Mutable box the delegated (attached-once) event listeners read at event
// time, so a step-row tap can re-render whichever screen is currently
// mounted into `root`. Never used for save correctness (see fieldContext).
let current = null;

// The number/note field the user currently has focus in, if any: identifies
// the field (role/stepId/challengeId/date) and the latest uncommitted raw
// value + caret so a re-render triggered mid-typing (by any store change,
// not just this field's own) can put it all back instead of dropping the
// keystrokes and closing the on-screen keyboard. Cleared once focus truly
// leaves our fields (see wireDelegation's focusout handler).
let focusRecord = null;

// Round-1 fix: expandedKey (and the focusRecord reset tied to it) only
// changes inside renderScreen, i.e. only when the challenge or date being
// viewed actually changes. Today(A,D) -> another tab (e.g. #/calendar) ->
// Today(A,D) never changes that key, so a focusRecord left over from before
// the user switched tabs would otherwise survive and get restored into the
// freshly re-expanded field. Any real navigation changes location.hash;
// store-driven re-renders (the case restoreFocus exists for) never do, so
// this only fires on genuine navigation. Registered once at module load.
//
// `navigatedInApp` latches true the first time this fires: goBack() uses it
// to tell "there's real in-app history to go back to" apart from "this tab
// was opened straight onto a deep link" (history.length > 1 is unreliable
// for that — a deep link opened in an already-used tab still has history
// entries, just none of them are this app).
let navigatedInApp = false;
// Set true the instant Done/"‹ Back" is activated (see wireDelegation) and
// cleared here once the resulting navigation actually lands, so a second
// activation before then (e.g. an accidental double-tap) can't fire a
// second history.back()/hash change on top of the first.
let navigating = false;
window.addEventListener('hashchange', () => { navigatedInApp = true; navigating = false; focusRecord = null; });
// Round-3 fix: history.back() doesn't always produce a hashchange (e.g. it
// can land on an entry whose hash happens to match the current one), which
// would leave `navigating` stuck true and Done/"‹ Back" permanently inert
// for the rest of the page's life. `pageshow` fires whenever the page
// becomes the active one again — including via back/forward navigation —
// so it's a reliable second place to clear it. Registered once at module
// load; renderScreen also clears it as a third belt-and-braces reset.
window.addEventListener('pageshow', () => { navigating = false; });

// Per-step save error, keyed the same way as expandedKey
// (`${challengeId}:${date}:${stepId}`), shown as an inline red footer under
// that step's expanded fields until the step is re-collapsed/expanded, a
// save on it succeeds, or the screen navigates to a different challenge/day
// (see renderScreen's key check). Covers both the photo-date mismatch
// message and a generic save failure from any field on the step (check,
// number, note, or photo).
const photoErrorByKey = new Map();

// Steps whose photo is currently being processed (resize + IndexedDB write),
// keyed the same way as photoErrorByKey. While a key is present, the photo
// row's buttons show "Saving…" and are disabled instead of sitting silent —
// the whole point being the user sees *something* happening.
const savingByKey = new Map();

// The most recent successful save on the currently-viewed screen, so a
// "Saved ✓" indicator can show for a short window afterwards. Scoped to
// challenge+date (not per-step) since it reflects "this screen just saved
// something", not any one field. `hideTimer` re-renders once when the
// window expires — nothing else would otherwise trigger a re-render to hide
// it, since no further store change happens.
const SAVED_INDICATOR_MS = 1500;
let lastSaved = null; // { challengeId, date, at } | null
let savedHideTimer = null;

// Re-renders the screen for `ctx` — but only if that's genuinely still the
// screen on display: the challenge/date match `current` (an async save or
// rejection resolving after the user has navigated elsewhere shouldn't yank
// them back or rebuild a now-unrelated screen), and `current.root` is still
// attached to the document (app.js swaps in a brand-new container on every
// real route render; a stale `current` whose container has already been
// replaced/detached must not be re-rendered into thin air).
function rerenderIfCurrent(ctx) {
  if (current && current.challengeId === ctx.challengeId && current.date === ctx.date && current.root?.isConnected) {
    current.rerender();
  }
}

function markSaved(ctx) {
  // A slow save for a screen the user has since left must not touch (or
  // reset the hide-timer for) whatever screen they're looking at now.
  if (!current || current.challengeId !== ctx.challengeId || current.date !== ctx.date) return;
  lastSaved = { challengeId: ctx.challengeId, date: ctx.date, at: Date.now() };
  if (savedHideTimer) clearTimeout(savedHideTimer);
  savedHideTimer = setTimeout(() => {
    savedHideTimer = null;
    rerenderIfCurrent(ctx);
  }, SAVED_INDICATOR_MS);
}

// Shared by the "‹ Back" button and the "Done" button on an editable Day
// detail screen: return to wherever the user came from, falling back to the
// calendar when there's nowhere in *this app* to go back to. `history.length`
// alone isn't a reliable signal for that — a deep link opened in an
// already-used browser tab still has history entries, just none of them are
// this app — so this relies on navigatedInApp instead (see above).
function goBack() {
  if (navigatedInApp) history.back();
  else location.hash = '#/calendar';
}

function messageForPhotoError(err) {
  const code = err && err.code;
  if (code === 'UNSUPPORTED_IMAGE') return "This photo format isn't supported here. Try a JPEG or PNG, or take a new photo.";
  if (code === 'IMAGE_ENCODE_FAILED') return "Couldn't process this photo. Try a smaller one or take a new photo.";
  return "Couldn't save the photo. Please try again.";
}

const PILL_LABELS = { green: 'Complete', red: 'Missed', pending: 'In progress', future: 'Upcoming', outside: 'Outside attempt' };

// ---------- mini progress ring (reused by Task 7) ----------

export function miniRing(done, total, sizePx) {
  const size = sizePx;
  const stroke = Math.max(3, Math.round(size * 0.09));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const rawPct = total > 0 ? done / total : 0;
  const pct = Number.isFinite(rawPct) ? Math.min(1, Math.max(0, rawPct)) : 0;
  const center = size / 2;
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="mini-ring" role="img" aria-label="${esc(done)} of ${esc(total)}">` +
    `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--raised)" stroke-width="${stroke}" />`;
  if (pct > 0) {
    const dash = c * pct;
    svg += `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}" stroke-linecap="round" ` +
      `stroke-dasharray="${dash} ${c - dash}" transform="rotate(-90 ${center} ${center})" />`;
  }
  svg += `</svg>`;
  return svg;
}

// ---------- day/week arithmetic ----------

function computeDayContext(challenge, attempt, date, day, todayStr) {
  const totalDays = challenge.totalDays;
  if (!attempt) {
    return { dayNumber: 1, totalDays, weekNum: 1, green: 0, weekTarget: Math.min(challenge.weeklyTarget, totalDays), status: 'outside', outside: true };
  }
  const lastDate = addDays(attempt.startDate, totalDays - 1);
  const outside = date < attempt.startDate || date > lastDate;
  const rawDayNumber = diffDays(attempt.startDate, date) + 1;
  const dayNumber = Math.min(Math.max(rawDayNumber, 1), totalDays);
  const weekIndex = Math.floor((dayNumber - 1) / 7);
  const weekNum = weekIndex + 1;
  const weekStart = addDays(attempt.startDate, weekIndex * 7);
  const weekLen = Math.min(7, totalDays - weekIndex * 7);
  let green = 0;
  for (let i = 0; i < weekLen; i++) {
    const d = addDays(weekStart, i);
    if (dayStatus(d, store.getDay(challenge.id, d), challenge, todayStr) === 'green') green++;
  }
  const weekTarget = Math.min(challenge.weeklyTarget, weekLen);
  const status = outside ? 'outside' : dayStatus(date, day, challenge, todayStr);
  return { dayNumber, totalDays, weekNum, green, weekTarget, status, outside };
}

// "Eating window 12:00–20:00 · open · closes in 3h" — Today only, and only
// for an intermittent-fasting fitness challenge (docs §9's Decisions #2:
// "shown on Today, for intermittent fasting only"). Computed fresh from the
// current wall-clock time on every render; no timers.
function eatingWindowLineHtml(challenge, date, todayStr) {
  if (date !== todayStr || !challenge || challenge.category !== 'fitness') return '';
  const schedule = scheduleOf(challenge.profile || {});
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const text = windowStatus(schedule, nowHHMM);
  return text ? `<p class="section-footer">${esc(text)}</p>` : '';
}

function popClassFor(key, status) {
  const prev = lastStatusByKey.get(key);
  lastStatusByKey.set(key, status);
  return prev != null && prev !== 'green' && status === 'green';
}

// ---------- markup builders ----------

function switcherHtml(challenges, selectedId) {
  return `<div class="switcher">${challenges.map((c) =>
    `<button type="button" class="pill${c.id === selectedId ? ' pending' : ''}" data-role="switch-challenge" data-challenge-id="${esc(c.id)}">${esc(c.name)}</button>`
  ).join('')}</div>`;
}

// `target` is the day-snapshotted target for this step (see
// fitness.targetFor), or null for a step without a goal. A goal-bearing step
// shows "actual / target unit" (e.g. "1.5 / 2.8 L"), turning green (`.met`)
// once meetsGoal is satisfied — see the Phase A spec's Today section.
function stepSummaryHtml(step, entry, target) {
  const parts = [];
  if (entry.photoId) parts.push(`<img class="thumb" data-photo-id="${esc(entry.photoId)}" alt="" />`);
  if (step.goal && target != null) {
    const unit = step.number && step.number.unit ? ' ' + esc(step.number.unit) : '';
    if (isNumberValue(entry.value)) {
      const met = isStepComplete(step, entry, target);
      parts.push(`<span class="${met ? 'met' : ''}">${esc(entry.value)} / ${esc(target)}${unit}</span>`);
    } else {
      parts.push(`<span>Target ${esc(target)}${unit}</span>`);
    }
    return parts.join('');
  }
  if (step.number && entry.value != null && entry.value !== '') {
    const unit = step.number.unit ? ' ' + esc(step.number.unit) : '';
    parts.push(`<span>${esc(String(entry.value))}${unit}</span>`);
  }
  return parts.join('');
}

// fieldCtx = { challengeId, date }, stamped onto each interactive row so
// event handlers can read the right target straight off the DOM (see
// fieldContext) instead of a shared module variable that a later render
// (of a different challenge/day) would have already overwritten by the
// time an in-flight async action — e.g. the photo picker — resolves.
function photoRowHtml(step, entry, fieldCtx, isSaving) {
  const disabledAttr = isSaving ? ' disabled' : '';
  const label = isSaving ? 'Saving…' : entry.photoId ? 'Change photo' : 'Add photo';
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <label class="btn btn-primary photo-field-btn" style="width:100%">${esc(label)}
      <input type="file" accept="image/*" hidden data-role="photo-input" data-step-id="${esc(step.id)}"${disabledAttr} />
    </label>
  </div>`;
}

function numberRowHtml(step, entry, fieldCtx) {
  const value = entry.value != null ? esc(String(entry.value)) : '';
  const unit = step.number.unit ? `<span class="field-unit">${esc(step.number.unit)}</span>` : '';
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <span class="field-label">${esc(step.number.label)}</span>
    <input type="text" inputmode="decimal" data-role="number-input" data-step-id="${esc(step.id)}" value="${value}" />
    ${unit}
  </div>`;
}

function noteRowHtml(step, entry, fieldCtx) {
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <span class="field-label">Note</span>
    <textarea data-role="note-input" data-step-id="${esc(step.id)}">${esc(entry.note || '')}</textarea>
  </div>`;
}

// One meal row: thumbnail, dish name (with a small muted macro line under
// it — 0s when this meal predates macros, see macroDotLine) and its calorie
// total, with a small "x" to remove it (this is only ever rendered inside an
// expanded row of an editable day, so the delete button is always shown —
// see foodRowsHtml).
function mealRowHtml(step, meal, fieldCtx) {
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <img class="thumb" data-photo-id="${esc(meal.photoId)}" alt="" />
    <div class="row-label">
      <div>${esc(meal.dish || 'Meal')}</div>
      <div class="item-sub">${esc(macroDotLine(meal.macros))}</div>
    </div>
    <span>${esc(meal.calories)} kcal</span>
    <button type="button" data-role="meal-delete" data-step-id="${esc(step.id)}" data-meal-id="${esc(meal.id)}" aria-label="Remove meal">×</button>
  </div>`;
}

// One planned-meal placeholder row (docs §9's Decisions #1): time · slot ·
// dish, a Planned/Logged pill (never a checkbox — only a linked photo
// completes it, see placeholderStatus), and edit/delete. A still-"Planned"
// placeholder also gets its own "Add photo" row, which runs the exact same
// estimate flow as the ordinary "Add food" button (handleFoodFile) but
// passes this placeholder's id through so the resulting meal links back to
// it (meal.plannedId) instead of standing alone.
function plannedRowHtml(step, planned, meals, fieldCtx, isSavingPhoto) {
  const { status, label, actualKcal } = placeholderStatus(planned, meals);
  const kcalLine = status === 'logged'
    ? `planned ${Number.isFinite(planned.kcal) ? planned.kcal : 0} · actual ${actualKcal} kcal`
    : (Number.isFinite(planned.kcal) && planned.kcal > 0 ? `planned ${planned.kcal} kcal` : 'No kcal set');
  const pillClass = status === 'logged' ? 'green' : 'future';
  const summaryRow = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <div class="row-label">
      <div>${esc(planned.time || '')} · ${esc(planned.slot || '')} · ${esc(planned.dish || 'Meal')}</div>
      <div class="item-sub">${esc(kcalLine)}</div>
    </div>
    <span class="pill ${pillClass}">${esc(label)}</span>
    <button type="button" data-role="planned-edit" data-step-id="${esc(step.id)}" data-planned-id="${esc(planned.id)}" aria-label="Edit planned meal">✎</button>
    <button type="button" data-role="planned-delete" data-step-id="${esc(step.id)}" data-planned-id="${esc(planned.id)}" aria-label="Remove planned meal">×</button>
  </div>`;
  if (status === 'logged') return summaryRow;
  const addLabel = isSavingPhoto ? 'Analyzing…' : 'Add photo';
  const photoRow = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <label class="btn btn-secondary photo-field-btn" style="width:100%">${esc(addLabel)}
      <input type="file" accept="image/*" hidden data-role="planned-photo-input" data-step-id="${esc(step.id)}" data-planned-id="${esc(planned.id)}"${isSavingPhoto ? ' disabled' : ''} />
    </label>
  </div>`;
  return summaryRow + photoRow;
}

// The day's placeholders, in time order (docs §9: "Today's Food step lists
// the day's slots in time order"). Logged meals never belong to `planned`
// itself (see js/foodLogic.js's buildFoodPatch) — they're only ever looked
// up by id via placeholderStatus, to decide each row's Planned/Logged state.
function plannedListHtml(step, entry, fieldCtx, isSavingPhoto) {
  const meals = Array.isArray(entry.meals) ? entry.meals : [];
  const planned = (Array.isArray(entry.planned) ? entry.planned.slice() : [])
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return planned.map((p) => plannedRowHtml(step, p, meals, fieldCtx, isSavingPhoto)).join('');
}

// Under the Total row, when the food step has macro targets, one compact
// "actual / target" line per macro — .met the same way stepSummaryHtml's
// span is, via meetsGoal. Macros without a target on this step are skipped;
// nothing is shown at all when the step has no macros (targets only —
// photo estimates are too rough to gate anything, see docs §9).
function macroTargetLinesHtml(step, meals, fieldCtx) {
  if (!step.macros) return '';
  const totals = mealsMacros(meals);
  return MACRO_KEYS.filter((key) => step.macros[key]).map((key) => {
    const { target, dir } = step.macros[key];
    const met = meetsGoal(totals[key], target, dir);
    return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
      <span class="row-label${met ? ' met' : ''}">${esc(MACRO_META[key].label)} ${esc(totals[key])} / ${esc(target)} g</span>
    </div>`;
  }).join('');
}

// The "Suggest tomorrow's meals" button (or, once a plan exists for this
// date, a "Today's plan" row that reopens it) — only on the actual Today
// screen (see docs §1's "On Today's Food step"): a day-detail view of
// yesterday has nothing sensible to suggest "tomorrow" relative to, and a
// saved plan's forDate only ever matches store.today() once that day
// arrives. '' for a non-fitness/non-food-step challenge (no diet to plan
// around) or any other date.
function mealPlanSectionHtml(step, fieldCtx) {
  if (fieldCtx.date !== store.today()) return '';
  const challenge = store.state.challenges.find((c) => c.id === fieldCtx.challengeId);
  // Suggestions need a profile (diet, targets, weight...) to plan around,
  // which only a fitness challenge has — a food step added by hand to a
  // custom challenge has nowhere to set Diet, so it never shows this at all.
  if (!challenge || challenge.category !== 'fitness') return '';
  const plan = challenge.mealPlan;
  if (plan && plan.forDate === fieldCtx.date) {
    return `<div class="row chevron" data-role="open-meal-plan" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
      <span class="row-label">Today's plan</span>
    </div>`;
  }
  const daysMap = store.state.days[fieldCtx.challengeId] || {};
  const hasDiet = !!(challenge.profile && challenge.profile.diet);
  const enough = canSuggest(daysMap, step.id, fieldCtx.date);
  const enabled = hasDiet && enough;
  const hint = !hasDiet ? 'Set Diet in the challenge profile to get suggestions.' : !enough ? 'Log 3 meals in a day to get suggestions.' : '';
  const hintHtml = hint ? `<div class="section-footer">${esc(hint)}</div>` : '';
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <button type="button" class="btn btn-secondary" style="width:100%" data-role="suggest-meals" data-step-id="${esc(step.id)}"${enabled ? '' : ' disabled'}>Suggest tomorrow's meals</button>
  </div>${hintHtml}`;
}

// Renders in place of the photo/number/note rows for a food step: one row
// per logged meal, a running total, and the "Add food" picker that drives
// handleFoodFile below. Errors go through the same photoErrorByKey slot the
// photo/number/note flow uses.
function foodRowsHtml(step, entry, fieldCtx) {
  const key = `${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`;
  const meals = Array.isArray(entry.meals) ? entry.meals : [];
  const analyzing = savingByKey.has(key);
  const mealsHtml = meals.map((m) => mealRowHtml(step, m, fieldCtx)).join('');
  const totalHtml = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <span class="row-label">Total · ${esc(mealsTotal(meals))} kcal</span>
  </div>`;
  const macroLinesHtml = macroTargetLinesHtml(step, meals, fieldCtx);
  // Placeholders and "Plan a meal" (docs §9) only make sense for a fitness
  // challenge's food step — the same gate mealPlanSectionHtml below uses,
  // since both need a profile.schedule to plan slots around.
  const challenge = store.state.challenges.find((c) => c.id === fieldCtx.challengeId);
  const isFitness = !!challenge && challenge.category === 'fitness';
  const plannedHtml = isFitness ? plannedListHtml(step, entry, fieldCtx, analyzing) : '';
  const addLabel = analyzing ? 'Analyzing…' : 'Add food';
  const addHtml = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <label class="btn btn-primary photo-field-btn" style="width:100%">${esc(addLabel)}
      <input type="file" accept="image/*" hidden data-role="food-input" data-step-id="${esc(step.id)}"${analyzing ? ' disabled' : ''} />
    </label>
  </div>`;
  const planMealBtnHtml = isFitness ? `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <button type="button" class="btn btn-secondary" style="width:100%" data-role="plan-meal-open" data-step-id="${esc(step.id)}">Plan a meal</button>
  </div>` : '';
  const errorMessage = photoErrorByKey.get(key);
  const errorHtml = errorMessage ? `<div class="section-footer photo-error">${esc(errorMessage)}</div>` : '';
  const planHtml = mealPlanSectionHtml(step, fieldCtx);
  return `${mealsHtml}${totalHtml}${macroLinesHtml}${plannedHtml}${addHtml}${planMealBtnHtml}${errorHtml}${planHtml}`;
}

// Water: +0.25 L / +0.5 L quick-add buttons on top of the ordinary number
// row (still there for a manual/precise entry or a correction).
function waterRowsHtml(step, entry, fieldCtx) {
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <div class="btn-pair" style="width:100%">
      <button type="button" class="btn btn-secondary" data-role="water-add" data-step-id="${esc(step.id)}" data-amount="0.25">+0.25 L</button>
      <button type="button" class="btn btn-secondary" data-role="water-add" data-step-id="${esc(step.id)}" data-amount="0.5">+0.5 L</button>
    </div>
  </div>
  ${numberRowHtml(step, entry, fieldCtx)}`;
}

// One logged workout session: type · minutes · kcal, with a × to delete —
// modelled on mealRowHtml.
function workoutSessionRowHtml(step, session, fieldCtx) {
  return `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <span class="row-label">${esc(session.type)} · ${esc(session.minutes)} min · ${esc(session.kcal)} kcal</span>
    <button type="button" data-role="workout-delete" data-step-id="${esc(step.id)}" data-session-id="${esc(session.id)}" aria-label="Remove session">×</button>
  </div>`;
}

// Renders in place of the photo/number/note rows for a workout step: one row
// per logged session, a running total, and the "Add workout" sheet opener —
// modelled on foodRowsHtml.
function workoutRowsHtml(step, entry, fieldCtx) {
  const key = `${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`;
  const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
  const sessionsHtml = sessions.map((s) => workoutSessionRowHtml(step, s, fieldCtx)).join('');
  const totalHtml = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <span class="row-label">Total · ${esc(entry.value || 0)} min · ${esc(entry.burn || 0)} kcal</span>
  </div>`;
  const addHtml = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <button type="button" class="btn btn-primary" style="width:100%" data-role="workout-add" data-step-id="${esc(step.id)}">Add workout</button>
  </div>`;
  const errorMessage = photoErrorByKey.get(key);
  const errorHtml = errorMessage ? `<div class="section-footer photo-error">${esc(errorMessage)}</div>` : '';
  return `${sessionsHtml}${totalHtml}${addHtml}${errorHtml}`;
}

function expandedRowsHtml(step, entry, fieldCtx) {
  const key = `${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`;
  if (isFoodStep(step)) return foodRowsHtml(step, entry, fieldCtx);
  if (step.type === 'water') return waterRowsHtml(step, entry, fieldCtx);
  if (step.type === 'workout') return workoutRowsHtml(step, entry, fieldCtx);
  // Steps, Sleep and Body all fall through to the same generic path a
  // custom step uses (they're photo:'none'/note:'none' with a plain number
  // field — see js/fitness.js's makeTypedStep), so no special-casing needed.
  let html = '';
  if (step.photo !== 'none') {
    html += photoRowHtml(step, entry, fieldCtx, savingByKey.has(key));
  }
  if (step.number) html += numberRowHtml(step, entry, fieldCtx);
  if (step.note !== 'none') html += noteRowHtml(step, entry, fieldCtx);
  // One error slot per step, regardless of which field on it failed to
  // save — shown once, after all of the step's expanded fields.
  const errorMessage = photoErrorByKey.get(key);
  if (errorMessage) html += `<div class="section-footer photo-error">${esc(errorMessage)}</div>`;
  return html;
}

function editableStepRowHtml(step, entry, expanded, fieldCtx, target) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  // A save error on this step shows expanded (as the shared footer in
  // expandedRowsHtml, right under its fields) or, collapsed, as this short
  // line under the step name — either way the user shouldn't have to
  // re-expand a collapsed, failed step just to find out something's wrong.
  const errorMessage = !expanded && photoErrorByKey.get(`${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`);
  const collapsedErrorHtml = errorMessage ? `<div class="step-error">${esc(errorMessage)}</div>` : '';
  // A goal-bearing step's completion is decided entirely by meetsGoal (see
  // isStepComplete) — the done checkbox has no effect on it, so it's shown
  // as a read-only indicator instead of an interactive checkbox.
  const goalMet = !!step.goal && isStepComplete(step, entry, target);
  const checkHtml = step.goal
    ? `<span class="check goal-check${goalMet ? ' done' : ''}" role="img" aria-label="${goalMet ? 'Target met' : 'Target not met yet'}"></span>`
    : `<input type="checkbox" class="check" data-role="check" ${entry.done ? 'checked' : ''} />`;
  let html = `<div class="row" data-role="step-row" data-step-id="${esc(step.id)}" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    ${checkHtml}
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
      ${collapsedErrorHtml}
    </div>
    <div class="step-summary">${stepSummaryHtml(step, entry, target)}</div>
  </div>`;
  if (expanded) html += expandedRowsHtml(step, entry, fieldCtx);
  return html;
}

function readOnlyStepRowHtml(step, entry, target) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  const noteHtml = entry.note ? `<div class="step-note">${esc(entry.note)}</div>` : '';
  const complete = isStepComplete(step, entry, target);
  const check = `<span class="ro-check${complete ? ' done' : ''}">${complete ? '✓' : '–'}</span>`;
  const summary = stepSummaryHtml(step, entry, target);
  return `<div class="row">
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
      ${noteHtml}
    </div>
    <div class="row-value">${check}${summary}</div>
  </div>`;
}

// ---------- focus preservation across store-driven re-renders ----------

// Nearest ancestor (or self) carrying the challenge/date this field/row
// belongs to. Reading identity off the DOM at event time (rather than the
// shared `current` box) means a late event from a now-detached row — the
// photo picker returning after the user has already navigated elsewhere —
// still saves against the challenge/date it was opened for.
function fieldContext(el) {
  const row = el.closest('[data-challenge-id]');
  return row ? { challengeId: row.dataset.challengeId, date: row.dataset.date } : null;
}

function rememberFocus(e) {
  const role = ROLE_MAP[e.target.dataset.role];
  if (!role) return;
  const ctx = fieldContext(e.target);
  if (!ctx) return;
  focusRecord = {
    role,
    stepId: e.target.dataset.stepId,
    challengeId: ctx.challengeId,
    date: ctx.date,
    value: e.target.value,
    selectionStart: e.target.selectionStart ?? null,
    selectionEnd: e.target.selectionEnd ?? null,
  };
}

function trackFocusValue(e) {
  const role = ROLE_MAP[e.target.dataset.role];
  if (!role || !focusRecord || focusRecord.role !== role || focusRecord.stepId !== e.target.dataset.stepId) return;
  focusRecord.value = e.target.value;
  focusRecord.selectionStart = e.target.selectionStart;
  focusRecord.selectionEnd = e.target.selectionEnd;
}

function forgetFocusIfLeft() {
  setTimeout(() => {
    const active = document.activeElement;
    const stillOurs = active && ROLE_MAP[active.dataset && active.dataset.role];
    if (!stillOurs) focusRecord = null;
  }, 0);
}

// Companion to restoreFocus's `data-restored` marker: fires on every blur of
// one of our fields (both a natural tab-away/click-elsewhere and a forced
// blur — see wireDelegation's Done/"‹ Back" handling). A restored field
// whose value still differs from what's actually stored never got a native
// `change` (browsers only fire it after a *user* edit, and restoreFocus set
// .value programmatically), so without this the edit is silently lost the
// moment the field blurs with nothing typed into it since the restore.
// Dispatching `change` ourselves — only when the value genuinely still
// differs from the store — routes it through the existing save path
// (fieldContext-based, so it's correct even after this field's row has
// changed shape) without ever double-saving an edit the user made after the
// restore, which already triggers its own native `change` on blur.
function saveRestoredFieldIfNeeded(e) {
  const field = e.target;
  if (!field.dataset || field.dataset.restored !== '1') return;
  delete field.dataset.restored;
  const role = ROLE_MAP[field.dataset.role];
  if (!role) return;
  const ctx = fieldContext(field);
  if (!ctx) return;
  const day = store.getDay(ctx.challengeId, ctx.date);
  const entry = (day.steps && day.steps[field.dataset.stepId]) || {};
  let stillUnsaved;
  if (role === 'number') {
    const raw = field.value;
    const parsed = raw.trim() === '' ? undefined : parseNumberInput(raw);
    stillUnsaved = parsed !== (entry.value ?? undefined);
  } else {
    stillUnsaved = field.value !== (entry.note || '');
  }
  if (stillUnsaved) field.dispatchEvent(new Event('change', { bubbles: true }));
}

// Called after every (re-)render: if the user was mid-typing in a field on
// this same challenge/date, put the field back the way they left it —
// value (even invalid text, re-flagged), caret position, and focus itself —
// since the router always builds a brand-new DOM subtree.
function restoreFocus(root, challengeId, date) {
  if (!focusRecord) return;
  if (focusRecord.challengeId !== challengeId || focusRecord.date !== date) return;
  const roleAttr = focusRecord.role === 'number' ? 'number-input' : 'note-input';
  const stepIdSelector = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusRecord.stepId) : focusRecord.stepId;
  const el = root.querySelector(`[data-role="${roleAttr}"][data-step-id="${stepIdSelector}"]`);
  if (!el) return;
  if (focusRecord.value !== undefined && el.value !== focusRecord.value) {
    el.value = focusRecord.value;
    if (focusRecord.role === 'number') {
      const trimmed = focusRecord.value.trim();
      const parsed = parseNumberInput(focusRecord.value);
      el.classList.toggle('invalid', trimmed !== '' && parsed === undefined);
    }
    // The DOM now shows an edit the store doesn't have yet. Browsers only
    // fire `change` on blur after a *user* edit to the element — setting
    // .value programmatically (as just above) doesn't count — so if nothing
    // is typed into this field again before it loses focus, no `change`
    // would ever fire and this edit would quietly vanish. The delegated
    // focusout listener below dispatches one itself for any field still
    // marked restored when it blurs.
    el.dataset.restored = '1';
  }
  if (focusRecord.selectionStart != null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(focusRecord.selectionStart, focusRecord.selectionEnd ?? focusRecord.selectionStart);
    } catch (_) {
      // setSelectionRange can throw on some input types; focusing still matters more.
    }
  }
  el.focus({ preventScroll: true });
}

// ---------- photo save (library picker) ----------

// The library file input funnels through here. `ctx`/`stepId` are read off
// the DOM at the moment the user acted (see fieldContext), not off the
// shared `current` box, so a photo that resolves after the user has
// navigated away still saves (or is rejected) against the row it was opened
// for.
async function handlePhotoFile(ctx, stepId, file) {
  if (!file) return;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  try {
    photoErrorByKey.delete(key);
    savingByKey.set(key, true);
    rerenderIfCurrent(ctx); // show "Saving…" right away, before the (possibly slow) resize/write below
    const photoId = await savePhoto(file);
    try {
      await store.updateStep(ctx.challengeId, ctx.date, stepId, { photoId });
    } catch (err) {
      // The photo blob was written but the day it was meant for couldn't be
      // saved (e.g. it stopped being editable while the resize/write was in
      // flight) — without this it would sit in the `photos` store forever,
      // never referenced by any day.
      await deletePhoto(photoId).catch(() => {});
      throw err;
    }
    // Cleared before markSaved's (or store.updateStep's own, deferred)
    // re-render runs, so it never renders a still-"Saving…" row on top of
    // the now-saved photo.
    savingByKey.delete(key);
    markSaved(ctx);
  } catch (err) {
    // resizeImage (js/photos.js) can reject for a file the browser can't
    // decode (HEIC on desktop Chrome/Firefox, a corrupt file) or one whose
    // canvas encode fails; either way, this used to fail silently.
    console.error('Photo save failed:', err);
    // Cleared *before* rerenderIfCurrent(), which (unlike the store-driven
    // path above) rebuilds the DOM synchronously right here — clearing it
    // after would leave a stuck "Saving…" row next to the error message.
    savingByKey.delete(key);
    photoErrorByKey.set(key, messageForPhotoError(err));
    rerenderIfCurrent(ctx);
  }
}

// ---------- food photo -> calorie estimate flow ----------

function makeMealId() {
  return 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function foodItemLineHtml(item) {
  return `<div class="row"><span class="row-label">${esc(item.name)} · ${esc(item.portion)} · ${esc(item.calories)} kcal · ${esc(macroInlineLine(item.macros))}</span></div>`;
}

function foodConfirmBodyHtml(state) {
  const itemsHtml = state.items.map(foodItemLineHtml).join('');
  const errorHtml = state.error ? `<div class="section-footer error">${esc(state.error)}</div>` : '';
  const disabledAttr = state.busy ? ' disabled' : '';
  return `<div class="group">
    <div class="row">
      <span class="field-label">Dish</span>
      <input type="text" data-role="food-dish" value="${esc(state.dish)}" placeholder="Dish name" />
    </div>
    ${itemsHtml}
    <div class="row">
      <span class="field-label">Total</span>
      <input type="text" inputmode="numeric" data-role="food-total" value="${esc(String(state.total))}" />
      <span class="field-unit">kcal</span>
    </div>
    <div class="row">
      <span class="field-label">Macros</span>
      <span class="row-value">${esc(macroInlineLine(state.macros))}</span>
    </div>
    <div class="row">
      <span class="field-label">Note</span>
      <input type="text" data-role="food-note" value="${esc(state.note)}" placeholder="Optional, e.g. 'no rice'" />
    </div>
  </div>
  ${errorHtml}
  <div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="food-reestimate"${disabledAttr}>${state.busy ? 'Re-estimating…' : 'Re-estimate'}</button>
    <button type="button" class="btn btn-secondary" data-role="food-cancel">Cancel</button>
  </div>
  <button type="button" class="btn btn-primary" data-role="food-save"${disabledAttr}>Save</button>`;
}

// A total must be a plain non-negative integer — mirrors parseIntStrict in
// js/ui/challenges.js.
function parseTotalStrict(s) {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

// Opens the confirm sheet for a just-estimated meal. `photoId` was already
// written to the `photos` store by handleFoodFile; unless Save succeeds,
// onClose (covers Cancel, Escape, the backdrop, and being superseded by
// another sheet) deletes it so nothing orphaned is left behind. `plannedId`
// (docs §9), when set, came from a placeholder's own "Add photo" — on Save
// the new meal is linked to it (`meal.plannedId`) so that placeholder's row
// turns "Logged" (see js/mealPlan.js's placeholderStatus). undefined for the
// ordinary "Add food" flow, which never links to anything.
function openFoodConfirmSheet(ctx, stepId, photoId, blob, result, plannedId) {
  const state = { dish: result.dish || '', items: result.items, total: result.total, macros: result.macros, note: '', busy: false, error: '' };
  let saved = false;
  let sheetEl = null;

  const render = () => `<div id="food-confirm-root">${foodConfirmBodyHtml(state)}</div>`;

  const close = openSheet({
    title: 'Confirm meal',
    bodyHtml: render(),
    onMount: (el) => { sheetEl = el; wire(el); },
    onClose: () => {
      if (!saved) deletePhoto(photoId).catch(() => {});
    },
  });

  function rerenderSheet() {
    const root = sheetEl.querySelector('#food-confirm-root');
    if (root) root.outerHTML = render();
  }

  function wire(el) {
    el.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (role === 'food-dish') state.dish = e.target.value;
      else if (role === 'food-note') state.note = e.target.value;
      else if (role === 'food-total') state.total = e.target.value;
    });

    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-role="food-cancel"]')) {
        close();
        return;
      }

      if (e.target.closest('[data-role="food-reestimate"]')) {
        if (state.busy) return;
        state.busy = true;
        state.error = '';
        rerenderSheet();
        try {
          const fresh = await estimateCalories(blob, state.note);
          if (!fresh.isFood) {
            state.error = 'No food found in that photo.';
          } else {
            state.dish = fresh.dish || state.dish;
            state.items = fresh.items;
            state.total = fresh.total;
            state.macros = fresh.macros;
          }
        } catch (err) {
          state.error = err.message || "Couldn't re-estimate. Please try again.";
        } finally {
          state.busy = false;
          rerenderSheet();
        }
        return;
      }

      if (e.target.closest('[data-role="food-save"]')) {
        if (state.busy) return;
        const parsedTotal = parseTotalStrict(state.total);
        if (!Number.isFinite(parsedTotal)) {
          state.error = 'Enter a valid total.';
          rerenderSheet();
          return;
        }
        state.busy = true;
        state.error = '';
        rerenderSheet();
        try {
          const day = store.getDay(ctx.challengeId, ctx.date);
          const entry = (day.steps && day.steps[stepId]) || {};
          const newMeal = {
            id: makeMealId(),
            photoId,
            dish: state.dish.trim(),
            calories: parsedTotal,
            macros: state.macros,
            items: state.items,
            at: Date.now(),
          };
          if (plannedId) newMeal.plannedId = plannedId;
          const meals = (Array.isArray(entry.meals) ? entry.meals : []).concat([newMeal]);
          await store.updateStep(ctx.challengeId, ctx.date, stepId, buildFoodPatch(entry, meals));
          saved = true;
          photoErrorByKey.delete(`${ctx.challengeId}:${ctx.date}:${stepId}`);
          markSaved(ctx);
          close();
        } catch (err) {
          console.error('Save meal failed:', err);
          state.busy = false;
          state.error = "Couldn't save. Please try again.";
          rerenderSheet();
        }
      }
    });
  }
}

// The "Add food" file input (and a placeholder's own "Add photo" — docs §9,
// via `plannedId`) funnels through here, modeled on handlePhotoFile: save
// the photo, ask Gemini to estimate its calories, then hand off to the
// confirm sheet. Any failure along the way deletes the photo it just wrote
// so nothing orphaned is left in the `photos` store.
async function handleFoodFile(ctx, stepId, file, plannedId) {
  if (!file) return;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  let photoId = null;
  try {
    photoErrorByKey.delete(key);
    // Meals only count for the day they were eaten on: EXIF date, else the
    // file's lastModified (a fresh camera capture is always "now").
    const takenOn = await photoDateOf(file);
    if (takenOn !== ctx.date) {
      photoErrorByKey.set(key, `This photo is from ${formatDateLong(takenOn)}. Add a meal photo taken on ${formatDateLong(ctx.date)}.`);
      rerenderIfCurrent(ctx);
      return;
    }
    savingByKey.set(key, true);
    rerenderIfCurrent(ctx); // show "Analyzing…" right away, before the (possibly slow) resize/upload below
    photoId = await savePhoto(file);
    const blob = await getPhotoBlob(photoId);
    const result = await estimateCalories(blob);
    savingByKey.delete(key);
    if (!result.isFood) {
      await deletePhoto(photoId).catch(() => {});
      photoErrorByKey.set(key, 'No food found in that photo.');
      rerenderIfCurrent(ctx);
      return;
    }
    rerenderIfCurrent(ctx);
    openFoodConfirmSheet(ctx, stepId, photoId, blob, result, plannedId);
  } catch (err) {
    console.error('Food estimate failed:', err);
    savingByKey.delete(key);
    if (photoId) await deletePhoto(photoId).catch(() => {});
    // err.code marks a resizeImage failure (see photos.js) — everything
    // else (no key, offline, Gemini HTTP errors) already carries a
    // user-facing message on err.message (see js/gemini.js).
    photoErrorByKey.set(key, err && err.code ? messageForPhotoError(err) : (err.message || "Couldn't estimate calories. Please try again."));
    rerenderIfCurrent(ctx);
  }
}

// Shared by the meal "×" button: removes one meal from a food step's entry
// and deletes its photo. Modeled on handlePhotoFile's error handling.
async function handleMealDelete(btn) {
  if (!confirm('Remove this meal?')) return;
  const ctx = fieldContext(btn);
  if (!ctx) return;
  const stepId = btn.dataset.stepId;
  const mealId = btn.dataset.mealId;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  try {
    const day = store.getDay(ctx.challengeId, ctx.date);
    const entry = (day.steps && day.steps[stepId]) || {};
    const meals = Array.isArray(entry.meals) ? entry.meals : [];
    const meal = meals.find((m) => m.id === mealId);
    const remaining = meals.filter((m) => m.id !== mealId);
    await store.updateStep(ctx.challengeId, ctx.date, stepId, buildFoodPatch(entry, remaining));
    if (meal && meal.photoId) await deletePhoto(meal.photoId).catch(() => {});
    photoErrorByKey.delete(key);
    markSaved(ctx);
  } catch (err) {
    console.error('Meal delete failed:', err);
    photoErrorByKey.set(key, "Couldn't save. Please try again.");
    rerenderIfCurrent(ctx);
  }
}

// ---------- planned-meal placeholders (docs §9) ----------

function makePlannedId() {
  return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Shared by a placeholder's "×" button: removes one placeholder from a food
// step's `planned` list. Uses store.updatePlanned (not updateStep) so this
// still works on tomorrow's placeholders, not just today's — see
// js/store.js's updatePlanned. Modeled on handleMealDelete.
async function handlePlannedDelete(btn) {
  if (!confirm('Remove this planned meal?')) return;
  const ctx = fieldContext(btn);
  if (!ctx) return;
  const stepId = btn.dataset.stepId;
  const plannedId = btn.dataset.plannedId;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  try {
    const day = store.getDay(ctx.challengeId, ctx.date);
    const entry = (day.steps && day.steps[stepId]) || {};
    const remaining = (Array.isArray(entry.planned) ? entry.planned : []).filter((p) => p.id !== plannedId);
    await store.updatePlanned(ctx.challengeId, ctx.date, stepId, remaining);
    photoErrorByKey.delete(key);
    markSaved(ctx);
  } catch (err) {
    console.error('Planned meal delete failed:', err);
    photoErrorByKey.set(key, "Couldn't save. Please try again.");
    rerenderIfCurrent(ctx);
  }
}

function planMealSheetBodyHtml(state, slots, isEdit) {
  const dateRow = isEdit ? '' : `<div class="row">
    <span class="field-label">Day</span>
    <div class="segmented">
      <label><input type="radio" name="plan-meal-date" value="today" data-role="plan-meal-date" ${state.dateChoice === 'today' ? 'checked' : ''}><span>Today</span></label>
      <label><input type="radio" name="plan-meal-date" value="tomorrow" data-role="plan-meal-date" ${state.dateChoice === 'tomorrow' ? 'checked' : ''}><span>Tomorrow</span></label>
    </div>
  </div>`;
  const slotOptions = slots.map((s, i) => `<option value="${i}" ${state.slotIndex === i ? 'selected' : ''}>${esc(s.name)} · ${esc(s.time)}</option>`).join('');
  const errorHtml = state.error ? `<div class="section-footer error">${esc(state.error)}</div>` : '';
  const disabledAttr = state.busy ? ' disabled' : '';
  return `<div class="group">
    ${dateRow}
    <div class="row">
      <span class="field-label">Slot</span>
      <select data-role="plan-meal-slot">${slotOptions}</select>
    </div>
    <div class="row">
      <span class="field-label">Dish</span>
      <input type="text" data-role="plan-meal-dish" value="${esc(state.dish)}" placeholder="Dish name" />
    </div>
    <div class="row">
      <span class="field-label">Calories</span>
      <input type="text" inputmode="numeric" data-role="plan-meal-kcal" value="${esc(state.kcal)}" placeholder="Optional" />
      <span class="field-unit">kcal</span>
    </div>
  </div>
  ${errorHtml}
  <div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="plan-meal-cancel"${disabledAttr}>Cancel</button>
    <button type="button" class="btn btn-primary" data-role="plan-meal-save"${disabledAttr}>${state.busy ? 'Saving…' : 'Save'}</button>
  </div>`;
}

// The manual "Plan a meal" sheet (docs §9's "Ways to fill" #2): slot, dish
// and an optional kcal, for today or tomorrow — works without any AI call at
// all. `existing`, when set, opens it in edit mode for that one placeholder
// (its date is fixed — only slot/dish/kcal are editable once created).
// Saves through store.updatePlanned, same as the AI sheet's "Add to
// tomorrow's plan"/"Add all" below.
function openPlanMealSheet({ challengeId, date, foodStepId, schedule, existing }) {
  const isEdit = !!existing;
  const slots = (schedule && Array.isArray(schedule.slots)) ? schedule.slots : [];
  const initialSlotIndex = isEdit ? Math.max(0, slots.findIndex((s) => s.name === existing.slot)) : 0;
  const state = {
    dateChoice: 'today',
    slotIndex: initialSlotIndex,
    dish: isEdit ? (existing.dish || '') : '',
    kcal: isEdit && Number.isFinite(existing.kcal) && existing.kcal > 0 ? String(existing.kcal) : '',
    error: '',
    busy: false,
  };

  let sheetEl = null;
  const render = () => `<div id="plan-meal-root">${planMealSheetBodyHtml(state, slots, isEdit)}</div>`;

  const close = openSheet({
    title: isEdit ? 'Edit planned meal' : 'Plan a meal',
    bodyHtml: render(),
    onMount: (el) => { sheetEl = el; wire(el); },
  });

  function rerenderSheet() {
    const root = sheetEl.querySelector('#plan-meal-root');
    if (root) root.outerHTML = render();
  }

  function targetDate() {
    return isEdit ? date : (state.dateChoice === 'tomorrow' ? addDays(date, 1) : date);
  }

  async function save() {
    const dish = state.dish.trim();
    if (!dish) {
      state.error = 'Enter a dish.';
      rerenderSheet();
      return;
    }
    const kcalRaw = state.kcal.trim();
    const kcalNum = kcalRaw === '' ? 0 : parseNumberInput(kcalRaw);
    if (kcalNum === undefined || kcalNum < 0) {
      state.error = 'Enter a valid calorie value, or leave it blank.';
      rerenderSheet();
      return;
    }
    const slot = slots[state.slotIndex] || { name: 'Meal', time: '12:00' };
    state.busy = true;
    state.error = '';
    rerenderSheet();
    try {
      const targetD = targetDate();
      const day = store.getDay(challengeId, targetD);
      const entry = (day.steps && day.steps[foodStepId]) || {};
      const list = Array.isArray(entry.planned) ? entry.planned.slice() : [];
      if (isEdit) {
        const idx = list.findIndex((p) => p.id === existing.id);
        if (idx !== -1) list[idx] = { ...existing, slot: slot.name, time: slot.time, dish, kcal: Math.round(kcalNum) };
      } else {
        list.push({
          id: makePlannedId(), slot: slot.name, time: slot.time, dish, kcal: Math.round(kcalNum),
          macros: { protein: 0, carbs: 0, fat: 0, fiber: 0 }, source: 'manual',
        });
      }
      await store.updatePlanned(challengeId, targetD, foodStepId, list);
      markSaved({ challengeId, date });
      close();
    } catch (err) {
      console.error('Save planned meal failed:', err);
      state.busy = false;
      state.error = err.message || "Couldn't save. Please try again.";
      rerenderSheet();
    }
  }

  function wire(el) {
    el.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (role === 'plan-meal-dish') state.dish = e.target.value;
      else if (role === 'plan-meal-kcal') state.kcal = e.target.value;
    });
    el.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'plan-meal-date') state.dateChoice = e.target.value;
      else if (role === 'plan-meal-slot') state.slotIndex = parseInt(e.target.value, 10);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="plan-meal-cancel"]')) {
        close();
        return;
      }
      if (e.target.closest('[data-role="plan-meal-save"]')) {
        if (state.busy) return;
        save();
      }
    });
  }
}

// ---------- weekly body check (docs §3) ----------

// Refreshes challenge.bodyCheck by calling Gemini with the latest Body-step
// photo, when due: sharing is on (always required — `force`, from
// challenges.js's Update button, only skips the staleness check), a body
// photo exists, and the existing check is missing or older than 7 days.
// When sharing is off, or there's no photo, this never
// touches the network at all — js/mealPlan.js's bodyCheckText already falls
// back to a BMI-only note for display. Exported for challenges.js's body
// check card, the same cross-import pattern as miniRing above.
export async function refreshBodyCheckIfDue(challenge, { force = false } = {}) {
  const profile = challenge.profile;
  if (!profile) return;
  if (!profile.shareBodyPhoto) return;
  const daysMap = store.state.days[challenge.id] || {};
  const photoId = latestBodyPhotoId(challenge, daysMap);
  if (!photoId) return;
  if (!force) {
    const last = challenge.bodyCheck && challenge.bodyCheck.date;
    if (last && diffDays(last, store.today()) < 7) return;
  }
  const blob = await getPhotoBlob(photoId);
  if (!blob) return;
  const result = await checkBody(blob, { ...profile, currentWeightKg: latestBodyWeightKg(challenge, daysMap, profile) });
  await store.patchChallenge(challenge.id, { bodyCheck: { date: store.today(), ...result } });
}

// ---------- meal plan sheet (docs §1) ----------

function planFromChallenge(challenge) {
  const plan = challenge.mealPlan;
  return plan ? { meals: plan.meals, why: plan.why, tips: plan.tips, forDate: plan.forDate } : null;
}

// "1480 / 1500 kcal · P 150 / 155 g …" (docs §1's totals-vs-targets line).
// Macros without a target are skipped; '' when there's no food target at all.
function targetsLineHtml(targets, totals) {
  if (!targets || !totals || !Number.isFinite(targets.kcal)) return '';
  const parts = [`${totals.kcal} / ${targets.kcal} kcal`];
  for (const key of MACRO_KEYS) {
    if (Number.isFinite(targets[key])) parts.push(`${MACRO_META[key].short} ${totals[key]} / ${targets[key]} g`);
  }
  return parts.join(' · ');
}

function bodyNoteFrom(bodyCheck) {
  if (!bodyCheck) return '';
  const bits = [`BMI ${bodyCheck.bmi ?? '–'}`];
  if (bodyCheck.build) bits.push(bodyCheck.build);
  if (bodyCheck.bellyFat) bits.push(`${bodyCheck.bellyFat} belly fat`);
  const head = bits.join(' · ');
  return bodyCheck.note ? `${head} — ${bodyCheck.note}` : head;
}

// `added` is true once this suggested meal has been turned into a
// placeholder in this sheet session (docs §9's "Add to tomorrow's plan" —
// see addMealToPlan below); tracked only for the life of the open sheet, not
// persisted, so reopening the sheet later always offers every meal again —
// adding the same dish twice just leaves two placeholders, which the user
// can delete like any other (see plannedRowHtml/handlePlannedDelete).
function planMealRowHtml(meal, index, added) {
  const macroLine = macroInlineLine({ protein: meal.protein, carbs: meal.carbs, fat: meal.fat, fiber: meal.fiber });
  const swapHtml = meal.swapFor ? `<div class="item-sub">Swap: ${esc(meal.swapFor)}</div>` : '';
  return `<div class="row">
    <div class="row-label">
      <div>${esc(meal.slot)} · ${esc(meal.dish)}</div>
      <div class="item-sub">${esc(meal.portion)} · ${esc(macroLine)}</div>
      ${swapHtml}
    </div>
    <span>${esc(meal.kcal)} kcal</span>
  </div>
  <div class="row">
    <button type="button" class="btn btn-secondary" style="width:100%" data-role="plan-add-meal" data-index="${index}"${added ? ' disabled' : ''}>${added ? 'Added to tomorrow’s plan' : "Add to tomorrow's plan"}</button>
  </div>`;
}

function linesHtml(title, lines) {
  if (!lines || !lines.length) return '';
  return `<div class="section">
    <h2 class="section-header">${esc(title)}</h2>
    <div class="group"><div class="row"><div class="row-label">${lines.map(esc).join('<br>')}</div></div></div>
  </div>`;
}

function mealPlanBodyHtml(state) {
  if (state.loading) {
    return `<p class="section-footer">Generating your plan…</p>`;
  }
  if (state.error) {
    return `<div class="section-footer error">${esc(state.error)}</div>
      <button type="button" class="btn btn-primary" data-role="meal-plan-close">Close</button>`;
  }
  const mealsHtml = state.meals.map((m, i) => planMealRowHtml(m, i, state.addedIndices.has(i))).join('');
  const targetsHtml = targetsLineHtml(state.targets, state.totals);
  const warningHtml = state.warning ? `<p class="section-footer error">${esc(state.warning)}</p>` : '';
  const bodyNote = bodyNoteFrom(state.bodyCheck);
  const allAdded = state.meals.length > 0 && state.meals.every((_, i) => state.addedIndices.has(i));
  const addAllDisabled = state.busy || allAdded || state.meals.length === 0;
  const addAllError = state.addError ? `<p class="section-footer error">${esc(state.addError)}</p>` : '';
  return `<div class="group">${mealsHtml}</div>
    ${targetsHtml ? `<p class="section-footer">${esc(targetsHtml)}</p>` : ''}
    ${warningHtml}
    ${linesHtml('Why this plan', state.why)}
    ${bodyNote ? `<p class="section-footer">${esc(bodyNote)}</p>` : ''}
    ${linesHtml('Tips', state.tips)}
    <button type="button" class="btn btn-primary" data-role="plan-add-all"${addAllDisabled ? ' disabled' : ''}>${allAdded ? 'All added to plan' : 'Add all to tomorrow’s plan'}</button>
    ${addAllError}
    <div class="btn-pair">
      <button type="button" class="btn btn-secondary" data-role="meal-plan-new"${state.busy ? ' disabled' : ''}>${state.busy ? 'Thinking…' : 'New ideas'}</button>
      <button type="button" class="btn btn-secondary" data-role="meal-plan-close">Close</button>
    </div>
    <p class="section-footer">Not medical advice.</p>`;
}

// Opens the plan sheet. `opts.generate` (from the "Suggest tomorrow's
// meals" button) fetches a fresh plan for `opts.forDate` before showing
// anything; otherwise (the "Today's plan" row) it shows the saved plan
// straight away, still refreshed against the current targets/body-check text
// (both pure, no network — see js/mealPlan.js).
function openMealPlanSheet(ctx, opts = {}) {
  const challenge = store.state.challenges.find((c) => c.id === ctx.challengeId);
  if (!challenge) return;
  const existing = planFromChallenge(challenge);
  if (!existing && !opts.generate) return;

  const daysMap = store.state.days[ctx.challengeId] || {};
  const input = buildSuggestionInput(challenge, daysMap, ctx.date);
  // The schedule whose slot times back-fill each added placeholder's `time`
  // (docs §9) — refreshed alongside everything else on "New ideas", via
  // runGenerate's freshInput below.
  let currentSchedule = input.profile.schedule;

  const state = {
    loading: !!opts.generate,
    busy: false,
    error: '',
    forDate: opts.generate ? opts.forDate : existing.forDate,
    meals: existing ? existing.meals : [],
    why: existing ? existing.why : [],
    tips: existing ? existing.tips : [],
    totals: existing ? planTotals({ meals: existing.meals }) : null,
    warning: null,
    targets: input.targets,
    bodyCheck: input.bodyCheck,
    // Which suggested meals (by index into state.meals) have been turned
    // into a placeholder this sheet session — see planMealRowHtml/
    // addMealToPlan/addAllMealsToPlan. Reset whenever state.meals changes.
    addedIndices: new Set(),
    addError: '',
  };

  let sheetEl = null;
  const render = () => `<div id="meal-plan-root">${mealPlanBodyHtml(state)}</div>`;

  const close = openSheet({
    title: "Tomorrow's meal plan",
    bodyHtml: render(),
    onMount: (el) => { sheetEl = el; wire(el); if (opts.generate) runGenerate(opts.avoidDishes); },
  });

  function rerenderSheet() {
    const root = sheetEl.querySelector('#meal-plan-root');
    if (root) root.outerHTML = render();
  }

  async function runGenerate(avoidDishes) {
    state.busy = true;
    state.error = '';
    rerenderSheet();
    try {
      // The weekly body check (if due) refreshes first, so this suggestion
      // uses the freshest body-check text — see refreshBodyCheckIfDue.
      await refreshBodyCheckIfDue(challenge).catch((err) => console.error('Body check failed:', err));
      const freshChallenge = store.state.challenges.find((c) => c.id === ctx.challengeId) || challenge;
      const freshDaysMap = store.state.days[ctx.challengeId] || {};
      const freshInput = buildSuggestionInput(freshChallenge, freshDaysMap, ctx.date);
      const result = await suggestMeals(freshInput, avoidDishes);
      await store.patchChallenge(ctx.challengeId, {
        mealPlan: { forDate: state.forDate, createdAt: Date.now(), meals: result.meals, why: result.why, tips: result.tips },
      });
      state.meals = result.meals;
      state.why = result.why;
      state.tips = result.tips;
      state.totals = result.totals;
      state.warning = result.warning;
      state.targets = freshInput.targets;
      state.bodyCheck = freshInput.bodyCheck;
      currentSchedule = freshInput.profile.schedule;
      // A fresh plan means fresh meals at the same indices — nothing
      // suggested a moment ago is still "added" against this new list.
      state.addedIndices = new Set();
      state.addError = '';
    } catch (err) {
      console.error('Meal suggestion failed:', err);
      state.error = err.message || "Couldn't get suggestions. Please try again.";
    } finally {
      state.loading = false;
      state.busy = false;
      rerenderSheet();
    }
  }

  // Matches a suggested meal's slot name to this schedule's slot time
  // (case-insensitively — Gemini is asked to echo the slot name exactly, but
  // never trusted to get the casing right); '12:00' when nothing matches.
  function slotTimeFor(slotName) {
    const slots = (currentSchedule && Array.isArray(currentSchedule.slots)) ? currentSchedule.slots : [];
    const match = slots.find((s) => String(s.name).toLowerCase() === String(slotName || '').toLowerCase());
    return match ? match.time : '12:00';
  }

  function aiMealToPlaceholder(meal) {
    return {
      id: makePlannedId(),
      slot: meal.slot,
      time: slotTimeFor(meal.slot),
      dish: meal.dish,
      portion: meal.portion,
      kcal: meal.kcal,
      macros: { protein: meal.protein, carbs: meal.carbs, fat: meal.fat, fiber: meal.fiber },
      source: 'ai',
    };
  }

  // Appends placeholders to tomorrow's (state.forDate's) food-step `planned`
  // list via store.updatePlanned — same store call the manual "Plan a meal"
  // sheet uses (js/store.js's updatePlanned works for today or tomorrow).
  async function addPlaceholders(newPlaceholders) {
    const foodStep = (challenge.steps || []).find((s) => s.type === 'food');
    if (!foodStep) throw new Error("This challenge has no Food step to plan.");
    const day = store.getDay(ctx.challengeId, state.forDate);
    const entry = (day.steps && day.steps[foodStep.id]) || {};
    const list = (Array.isArray(entry.planned) ? entry.planned : []).concat(newPlaceholders);
    await store.updatePlanned(ctx.challengeId, state.forDate, foodStep.id, list);
  }

  async function addMealToPlan(index) {
    if (state.addedIndices.has(index)) return;
    const meal = state.meals[index];
    if (!meal) return;
    state.addError = '';
    try {
      await addPlaceholders([aiMealToPlaceholder(meal)]);
      state.addedIndices.add(index);
      markSaved(ctx);
      rerenderSheet();
    } catch (err) {
      console.error('Add to plan failed:', err);
      state.addError = err.message || "Couldn't add to your plan. Please try again.";
      rerenderSheet();
    }
  }

  async function addAllMealsToPlan() {
    const toAdd = state.meals.map((m, i) => i).filter((i) => !state.addedIndices.has(i));
    if (!toAdd.length) return;
    state.addError = '';
    try {
      await addPlaceholders(toAdd.map((i) => aiMealToPlaceholder(state.meals[i])));
      for (const i of toAdd) state.addedIndices.add(i);
      markSaved(ctx);
      rerenderSheet();
    } catch (err) {
      console.error('Add all to plan failed:', err);
      state.addError = err.message || "Couldn't add to your plan. Please try again.";
      rerenderSheet();
    }
  }

  function wire(el) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="meal-plan-close"]')) {
        close();
        return;
      }
      if (e.target.closest('[data-role="meal-plan-new"]')) {
        if (state.busy) return;
        const avoidDishes = state.meals.map((m) => m.dish).filter(Boolean);
        runGenerate(avoidDishes);
        return;
      }
      const addMealBtn = e.target.closest('[data-role="plan-add-meal"]');
      if (addMealBtn) {
        addMealToPlan(parseInt(addMealBtn.dataset.index, 10));
        return;
      }
      if (e.target.closest('[data-role="plan-add-all"]')) {
        addAllMealsToPlan();
      }
    });
  }
}

// ---------- water quick-add ----------

// Shared by the +0.25 L / +0.5 L buttons: adds `amount` to whatever's
// currently stored (0 if nothing yet), rounded to avoid float noise
// (0.1 + 0.25 etc.).
async function handleWaterAdd(btn) {
  const ctx = fieldContext(btn);
  if (!ctx) return;
  const stepId = btn.dataset.stepId;
  const amount = parseFloat(btn.dataset.amount);
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  try {
    const day = store.getDay(ctx.challengeId, ctx.date);
    const entry = (day.steps && day.steps[stepId]) || {};
    const current = isNumberValue(entry.value) ? entry.value : 0;
    const next = Math.round((current + amount) * 100) / 100;
    await store.updateStep(ctx.challengeId, ctx.date, stepId, { value: next });
    photoErrorByKey.delete(key);
    markSaved(ctx);
  } catch (err) {
    console.error('Save failed:', err);
    photoErrorByKey.set(key, "Couldn't save. Please try again.");
    rerenderIfCurrent(ctx);
  }
}

// ---------- workout sessions ----------

function makeSessionId() {
  return 'ws-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function workoutAddBodyHtml(state) {
  const typeOptions = WORKOUT_TYPES.map((t) => `<option value="${esc(t)}" ${state.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const intensityOptions = INTENSITIES.map((i) => `<option value="${esc(i)}" ${state.intensity === i ? 'selected' : ''}>${esc(i)}</option>`).join('');
  const errorHtml = state.error ? `<div class="section-footer error">${esc(state.error)}</div>` : '';
  return `<div class="group">
    <div class="row">
      <span class="field-label">Type</span>
      <select data-role="workout-type">${typeOptions}</select>
    </div>
    <div class="row">
      <span class="field-label">Minutes</span>
      <input type="text" inputmode="numeric" data-role="workout-minutes" value="${esc(state.minutes)}" />
    </div>
    <div class="row">
      <span class="field-label">Intensity</span>
      <select data-role="workout-intensity">${intensityOptions}</select>
    </div>
    <div class="row">
      <span class="field-label">Calories burned</span>
      <input type="text" inputmode="numeric" data-role="workout-kcal" value="${esc(state.kcal)}" />
      <span class="field-unit">kcal</span>
    </div>
  </div>
  ${errorHtml}
  <div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="workout-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" data-role="workout-save">Save</button>
  </div>`;
}

// "Add workout" sheet: type/minutes/intensity, with kcal auto-filled from
// workoutBurnKcal (MET × intensity × latest body weight × minutes) and
// editable — the auto-fill stops recomputing once the user has touched the
// kcal field themselves, same pattern as the food confirm sheet's total.
function openWorkoutAddSheet(ctx, stepId) {
  const challenge = store.state.challenges.find((c) => c.id === ctx.challengeId);
  if (!challenge) return;
  const daysMap = store.state.days[ctx.challengeId] || {};
  const kg = latestBodyWeightKg(challenge, daysMap, challenge.profile) || 70;
  const state = { type: WORKOUT_TYPES[0], minutes: '30', intensity: 'moderate', kcal: '', kcalTouched: false, error: '' };
  state.kcal = String(workoutBurnKcal({ type: state.type, minutes: Number(state.minutes), intensity: state.intensity, kg }));

  let sheetEl = null;
  const render = () => `<div id="workout-add-root">${workoutAddBodyHtml(state)}</div>`;

  const close = openSheet({
    title: 'Add workout',
    bodyHtml: render(),
    onMount: (el) => { sheetEl = el; wire(el); },
  });

  function rerenderSheet() {
    const root = sheetEl.querySelector('#workout-add-root');
    if (root) root.outerHTML = render();
  }

  function recomputeKcal() {
    if (state.kcalTouched) return;
    const minutes = parseNumberInput(state.minutes) || 0;
    state.kcal = String(workoutBurnKcal({ type: state.type, minutes, intensity: state.intensity, kg }));
  }

  function wire(el) {
    el.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (role === 'workout-minutes') {
        state.minutes = e.target.value;
        recomputeKcal();
        rerenderSheet();
      } else if (role === 'workout-kcal') {
        state.kcal = e.target.value;
        state.kcalTouched = true;
      }
    });

    el.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'workout-type') {
        state.type = e.target.value;
        recomputeKcal();
        rerenderSheet();
      } else if (role === 'workout-intensity') {
        state.intensity = e.target.value;
        recomputeKcal();
        rerenderSheet();
      }
    });

    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-role="workout-cancel"]')) {
        close();
        return;
      }
      if (e.target.closest('[data-role="workout-save"]')) {
        const minutes = parseNumberInput(state.minutes);
        const kcal = parseNumberInput(state.kcal);
        if (minutes === undefined || minutes <= 0) {
          state.error = 'Enter minutes.';
          rerenderSheet();
          return;
        }
        if (kcal === undefined || kcal < 0) {
          state.error = 'Enter a valid calorie value.';
          rerenderSheet();
          return;
        }
        try {
          const day = store.getDay(ctx.challengeId, ctx.date);
          const entry = (day.steps && day.steps[stepId]) || {};
          const sessions = (Array.isArray(entry.sessions) ? entry.sessions : []).concat([{
            id: makeSessionId(), type: state.type, minutes, intensity: state.intensity, kcal: Math.round(kcal),
          }]);
          const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
          const totalKcal = sessions.reduce((sum, s) => sum + s.kcal, 0);
          await store.updateStep(ctx.challengeId, ctx.date, stepId, { sessions, value: totalMinutes, burn: totalKcal });
          photoErrorByKey.delete(`${ctx.challengeId}:${ctx.date}:${stepId}`);
          markSaved(ctx);
          close();
        } catch (err) {
          console.error('Save workout failed:', err);
          state.error = "Couldn't save. Please try again.";
          rerenderSheet();
        }
      }
    });
  }
}

// Shared by a session's "×" button: removes one session from a workout
// step's entry and recomputes the totals. Modeled on handleMealDelete.
async function handleWorkoutDelete(btn) {
  if (!confirm('Remove this session?')) return;
  const ctx = fieldContext(btn);
  if (!ctx) return;
  const stepId = btn.dataset.stepId;
  const sessionId = btn.dataset.sessionId;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  try {
    const day = store.getDay(ctx.challengeId, ctx.date);
    const entry = (day.steps && day.steps[stepId]) || {};
    const sessions = (Array.isArray(entry.sessions) ? entry.sessions : []).filter((s) => s.id !== sessionId);
    const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
    const totalKcal = sessions.reduce((sum, s) => sum + s.kcal, 0);
    await store.updateStep(ctx.challengeId, ctx.date, stepId, { sessions, value: totalMinutes, burn: totalKcal });
    photoErrorByKey.delete(key);
    markSaved(ctx);
  } catch (err) {
    console.error('Session delete failed:', err);
    photoErrorByKey.set(key, "Couldn't save. Please try again.");
    rerenderIfCurrent(ctx);
  }
}

// ---------- delegated event wiring (attached once per root) ----------

// Shared by the two click branches below.
function navigateBackOrDone(isDone) {
  // Today has nowhere to "go back" to that makes sense — Calendar is the
  // natural place to land after finishing today's steps. Day detail (only
  // editable for yesterday) uses the same "back to wherever this was opened
  // from" behaviour as the back button.
  if (isDone && !location.hash.startsWith('#/day/')) location.hash = '#/calendar';
  else goBack();
}

function wireDelegation(root) {
  if (root.__todayWired) return;
  root.__todayWired = true;

  root.addEventListener('focusin', rememberFocus);
  root.addEventListener('input', trackFocusValue);
  root.addEventListener('focusout', forgetFocusIfLeft);
  root.addEventListener('focusout', saveRestoredFieldIfNeeded);

  // Round-2 fix: pointerdown-based navigation (round 1) had three problems —
  // on touch it fires at touchstart, so the re-render it triggers can rip a
  // focused note/number field out from under an in-progress edit before its
  // blur/change ever fires, losing the edit; a scroll that merely started on
  // the full-width Done button would navigate away; and the double-fire
  // guard reset on a 0ms timeout, long before `click` actually fires, so it
  // never actually prevented a double `history.back()`.
  //
  // Instead: `mousedown` on Done/"‹ Back" only calls preventDefault(), which
  // stops the button from stealing focus — mouse, touch-compatibility, and
  // keyboard activation all still produce a normal `click`, and nothing
  // moves until then. The `click` handler blurs whatever field is currently
  // focused *before* navigating — synchronously, while it's still attached —
  // so that field's own change handler fires and saves via fieldContext
  // exactly as if the user had tabbed away normally, and only then leaves
  // the screen. `navigating` (module-level, reset by the hashchange listener
  // above) blocks a second activation before the resulting hash change has
  // had a chance to land.
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-role="back"], [data-role="done"]')) e.preventDefault();
  });

  // Blurring here is what makes a pending edit save before navigating away —
  // its own `change` (native, if the user typed something; the synthetic
  // one from saveRestoredFieldIfNeeded above otherwise) fires as part of
  // this call, synchronously, while the field is still attached.
  const blurActiveField = () => {
    const active = document.activeElement;
    if (active && root.contains(active) && active.matches('input, textarea')) active.blur();
  };

  root.addEventListener('click', (e) => {
    const switchBtn = e.target.closest('[data-role="switch-challenge"]');
    if (switchBtn) {
      store.select(switchBtn.dataset.challengeId);
      return;
    }
    const backBtn = e.target.closest('[data-role="back"]');
    if (backBtn) {
      if (navigating) return;
      navigating = true;
      blurActiveField();
      navigateBackOrDone(false);
      return;
    }
    const doneBtn = e.target.closest('[data-role="done"]');
    if (doneBtn) {
      if (navigating) return;
      navigating = true;
      blurActiveField();
      navigateBackOrDone(true);
      return;
    }
    const summaryBtn = e.target.closest('[data-role="view-summary"]');
    if (summaryBtn) {
      location.hash = `#/summary/${summaryBtn.dataset.date}`;
      return;
    }
    const mealDeleteBtn = e.target.closest('[data-role="meal-delete"]');
    if (mealDeleteBtn) {
      handleMealDelete(mealDeleteBtn);
      return;
    }
    const waterAddBtn = e.target.closest('[data-role="water-add"]');
    if (waterAddBtn) {
      handleWaterAdd(waterAddBtn);
      return;
    }
    const workoutAddBtn = e.target.closest('[data-role="workout-add"]');
    if (workoutAddBtn) {
      const ctx = fieldContext(workoutAddBtn);
      if (ctx) openWorkoutAddSheet(ctx, workoutAddBtn.dataset.stepId);
      return;
    }
    const workoutDeleteBtn = e.target.closest('[data-role="workout-delete"]');
    if (workoutDeleteBtn) {
      handleWorkoutDelete(workoutDeleteBtn);
      return;
    }
    const suggestBtn = e.target.closest('[data-role="suggest-meals"]');
    if (suggestBtn) {
      const ctx = fieldContext(suggestBtn);
      if (ctx) openMealPlanSheet(ctx, { generate: true, forDate: addDays(ctx.date, 1), avoidDishes: [] });
      return;
    }
    const openPlanBtn = e.target.closest('[data-role="open-meal-plan"]');
    if (openPlanBtn) {
      const ctx = fieldContext(openPlanBtn);
      if (ctx) openMealPlanSheet(ctx, { generate: false });
      return;
    }
    const planMealOpenBtn = e.target.closest('[data-role="plan-meal-open"]');
    if (planMealOpenBtn) {
      const ctx = fieldContext(planMealOpenBtn);
      const challenge = ctx && store.state.challenges.find((c) => c.id === ctx.challengeId);
      if (challenge) {
        openPlanMealSheet({
          challengeId: ctx.challengeId, date: ctx.date, foodStepId: planMealOpenBtn.dataset.stepId,
          schedule: scheduleOf(challenge.profile || {}), existing: null,
        });
      }
      return;
    }
    const plannedEditBtn = e.target.closest('[data-role="planned-edit"]');
    if (plannedEditBtn) {
      const ctx = fieldContext(plannedEditBtn);
      const challenge = ctx && store.state.challenges.find((c) => c.id === ctx.challengeId);
      if (challenge) {
        const stepId = plannedEditBtn.dataset.stepId;
        const day = store.getDay(ctx.challengeId, ctx.date);
        const entry = (day.steps && day.steps[stepId]) || {};
        const existing = (Array.isArray(entry.planned) ? entry.planned : []).find((p) => p.id === plannedEditBtn.dataset.plannedId);
        if (existing) {
          openPlanMealSheet({
            challengeId: ctx.challengeId, date: ctx.date, foodStepId: stepId,
            schedule: scheduleOf(challenge.profile || {}), existing,
          });
        }
      }
      return;
    }
    const plannedDeleteBtn = e.target.closest('[data-role="planned-delete"]');
    if (plannedDeleteBtn) {
      handlePlannedDelete(plannedDeleteBtn);
      return;
    }
    const stepRow = e.target.closest('[data-role="step-row"]');
    if (stepRow && !e.target.closest('[data-role="check"]')) {
      const stepId = stepRow.dataset.stepId;
      // A row error persists across expand/collapse — it only ever clears
      // on the next successful save for this step (see each change handler)
      // — so collapsing or re-expanding it doesn't quietly hide a failure.
      expandedStepId = expandedStepId === stepId ? null : stepId;
      current?.rerender();
      return;
    }
  });

  root.addEventListener('change', async (e) => {
    const check = e.target.closest('[data-role="check"]');
    if (check) {
      const ctx = fieldContext(check);
      if (!ctx) return;
      const stepId = check.closest('[data-role="step-row"]').dataset.stepId;
      const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
      try {
        await store.updateStep(ctx.challengeId, ctx.date, stepId, { done: check.checked });
        photoErrorByKey.delete(key);
        markSaved(ctx);
      } catch (err) {
        console.error('Save failed:', err);
        photoErrorByKey.set(key, "Couldn't save. Please try again.");
        rerenderIfCurrent(ctx);
      }
      return;
    }

    const numberInput = e.target.closest('[data-role="number-input"]');
    if (numberInput) {
      const ctx = fieldContext(numberInput);
      if (!ctx) return;
      const stepId = numberInput.dataset.stepId;
      const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
      const raw = numberInput.value;
      const matchesFocusRecord = () =>
        focusRecord && focusRecord.role === 'number' && focusRecord.stepId === stepId &&
        focusRecord.challengeId === ctx.challengeId && focusRecord.date === ctx.date;
      if (raw.trim() === '') {
        numberInput.classList.remove('invalid');
        try {
          await store.updateStep(ctx.challengeId, ctx.date, stepId, { value: undefined });
          photoErrorByKey.delete(key);
          markSaved(ctx);
          // Field still owns the record: nothing typed left to write back
          // over the now-cleared stored value on the next re-render.
          if (matchesFocusRecord()) focusRecord.value = '';
        } catch (err) {
          console.error('Save failed:', err);
          photoErrorByKey.set(key, "Couldn't save. Please try again.");
          rerenderIfCurrent(ctx);
        }
        return;
      }
      const parsed = parseNumberInput(raw);
      if (parsed === undefined) {
        numberInput.classList.add('invalid');
        return;
      }
      numberInput.classList.remove('invalid');
      try {
        await store.updateStep(ctx.challengeId, ctx.date, stepId, { value: parsed });
        photoErrorByKey.delete(key);
        markSaved(ctx);
        // Normalise the tracked value to what was actually stored (e.g.
        // "3,5" -> "3.5") so restoreFocus doesn't write the raw comma form
        // back over it on the next store-driven re-render.
        if (matchesFocusRecord()) focusRecord.value = String(parsed);
      } catch (err) {
        console.error('Save failed:', err);
        photoErrorByKey.set(key, "Couldn't save. Please try again.");
        rerenderIfCurrent(ctx);
      }
      return;
    }

    const noteInput = e.target.closest('[data-role="note-input"]');
    if (noteInput) {
      const ctx = fieldContext(noteInput);
      if (!ctx) return;
      const stepId = noteInput.dataset.stepId;
      const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
      try {
        await store.updateStep(ctx.challengeId, ctx.date, stepId, { note: noteInput.value });
        photoErrorByKey.delete(key);
        markSaved(ctx);
      } catch (err) {
        console.error('Save failed:', err);
        photoErrorByKey.set(key, "Couldn't save. Please try again.");
        rerenderIfCurrent(ctx);
      }
      return;
    }

    const photoInput = e.target.closest('[data-role="photo-input"]');
    if (photoInput) {
      const ctx = fieldContext(photoInput);
      if (!ctx) return;
      const stepId = photoInput.dataset.stepId;
      const file = readFileAsPhoto(photoInput);
      photoInput.value = ''; // allow re-picking the same file (e.g. after a rejection)
      await handlePhotoFile(ctx, stepId, file);
      return;
    }

    const foodInput = e.target.closest('[data-role="food-input"]');
    if (foodInput) {
      const ctx = fieldContext(foodInput);
      if (!ctx) return;
      const stepId = foodInput.dataset.stepId;
      const file = readFileAsPhoto(foodInput);
      foodInput.value = ''; // allow re-picking the same file (e.g. after a rejection)
      await handleFoodFile(ctx, stepId, file);
      return;
    }

    const plannedPhotoInput = e.target.closest('[data-role="planned-photo-input"]');
    if (plannedPhotoInput) {
      const ctx = fieldContext(plannedPhotoInput);
      if (!ctx) return;
      const stepId = plannedPhotoInput.dataset.stepId;
      const plannedId = plannedPhotoInput.dataset.plannedId;
      const file = readFileAsPhoto(plannedPhotoInput);
      plannedPhotoInput.value = ''; // allow re-picking the same file (e.g. after a rejection)
      await handleFoodFile(ctx, stepId, file, plannedId);
      return;
    }
  });
}

// ---------- main render ----------

async function renderScreen(root, { date, dayRoute }) {
  // Belt-and-braces alongside the hashchange reset: any render at all means
  // the app is live and responsive again, so a `navigating` guard left over
  // from a Done/"‹ Back" tap that didn't happen to change the hash (e.g.
  // history.back() landing on an entry with the same hash) can't get stuck.
  navigating = false;
  const challenge = store.selected();
  if (!challenge) {
    root.innerHTML = '';
    return;
  }

  const key = `${challenge.id}:${date}`;
  if (expandedKey !== key) {
    expandedKey = key;
    expandedStepId = null;
    // The user left this challenge/day. A focused field's focusout may not
    // have fired yet (Safari/Firefox don't reliably fire it on removal), so
    // without this focusRecord would sit around describing a field that no
    // longer exists on screen and could wrongly resurrect a stale typed
    // value if a same-named step/date/challenge combo is ever rendered
    // again later. Restoring is only ever valid within one screen's
    // lifetime, so the record doesn't survive a screen change.
    focusRecord = null;
    photoErrorByKey.clear();
  }

  const todayStr = store.today();
  const attempt = store.displayAttempt(challenge.id);
  const day = store.getDay(challenge.id, date);
  const ctx = computeDayContext(challenge, attempt, date, day, todayStr);
  const editable = !ctx.outside && isEditable(date, todayStr);
  const pop = popClassFor(key, ctx.status);
  const fieldCtx = { challengeId: challenge.id, date };

  current = {
    challengeId: challenge.id,
    date,
    editable,
    root,
    rerender: () => renderScreen(root, { date, dayRoute }),
  };

  const headerHtml = dayRoute
    ? `<button type="button" class="back-btn" data-role="back">‹ Back</button>
       <h1 class="large-title">${esc(formatDateLong(date))}</h1>`
    : `<h1 class="large-title">${esc(challenge.name)}</h1>
       ${store.state.challenges.length >= 2 ? switcherHtml(store.state.challenges, challenge.id) : ''}`;

  const heroHtml = `<div class="group">
    <div class="row">
      ${miniRing(ctx.dayNumber, ctx.totalDays, 44)}
      <div class="row-label">
        <div class="day-line">Day <span class="day-num">${esc(ctx.dayNumber)}</span> of ${esc(ctx.totalDays)}</div>
        <div class="week-line">Week ${esc(ctx.weekNum)} · ${esc(ctx.green)}/${esc(ctx.weekTarget)} green</div>
      </div>
      <span class="pill ${ctx.status}${pop ? ' pop' : ''}">${PILL_LABELS[ctx.status] || ctx.status}</span>
    </div>
  </div>`;

  const eatingWindowHtml = eatingWindowLineHtml(challenge, date, todayStr);

  const stepsHtml = challenge.steps.map((step) => {
    const entry = (day.steps && day.steps[step.id]) || {};
    const target = targetFor(day, step);
    if (!editable) return readOnlyStepRowHtml(step, entry, target);
    return editableStepRowHtml(step, entry, expandedStepId === step.id, fieldCtx, target);
  }).join('');

  const sectionTitle = dayRoute && date !== todayStr ? 'Steps' : "Today's steps";

  // Only steps still present in the challenge count — a step removed from
  // the challenge but still recorded on an old day (a "ghost" entry) is
  // skipped, matching buildDaySummary.
  const hasPhoto = challenge.steps.some((step) => {
    const entry = day.steps && day.steps[step.id];
    return !!(entry && entry.photoId);
  });
  const summaryBtnHtml = dayRoute && (ctx.status === 'green' || hasPhoto)
    ? `<button type="button" class="btn btn-secondary" data-role="view-summary" data-date="${esc(date)}">View summary</button>`
    : '';

  // "Saved ✓" always renders (reserving its line so it never shifts layout
  // on appearing/disappearing) but only becomes visible for a short window
  // right after a save on *this* challenge/date (see markSaved). Both this
  // and the Done button below are editable-only: a read-only day has
  // nothing to save and the "‹ Back" button already gets you out of it.
  const showSaved = editable && lastSaved && lastSaved.challengeId === challenge.id && lastSaved.date === date &&
    Date.now() - lastSaved.at < SAVED_INDICATOR_MS;
  const savedIndicatorHtml = editable
    ? `<div class="section-footer saved-indicator${showSaved ? ' visible' : ''}" aria-live="polite">Saved ✓</div>`
    : '';
  const doneBtnHtml = editable ? `<button type="button" class="btn btn-primary" data-role="done">Done</button>` : '';

  root.innerHTML = `${headerHtml}
    ${heroHtml}
    ${eatingWindowHtml}
    ${summaryBtnHtml}
    <div class="section">
      <h2 class="section-header">${sectionTitle}</h2>
      <div class="group">${stepsHtml}</div>
      ${savedIndicatorHtml}
    </div>
    ${doneBtnHtml}`;

  wireDelegation(root);
  restoreFocus(root, challenge.id, date);
  await hydratePhotos(root);
}

export async function renderToday(root) {
  await renderScreen(root, { date: store.today(), dayRoute: false });
}

export async function renderDay(root, dateParam) {
  const date = DATE_RE.test(dateParam) ? dateParam : store.today();
  await renderScreen(root, { date, dayRoute: true });
}
