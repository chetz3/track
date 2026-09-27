// Today (#/today) and Day detail (#/day/:date) screens: the hero "day
// status" card plus the grouped step list with inline expand-to-edit rows.
//
// Render contract (see app.js): renderToday/renderDay receive a container
// already attached inside #app. They may only write inside it, and must call
// hydratePhotos only on that attached container.

import * as store from '../store.js';
import { dayStatus, isEditable, isStepComplete, parseNumberInput, addDays, diffDays } from '../rules.js';
import { savePhoto, deletePhoto } from '../photos.js';
import { esc, formatDateLong, hydratePhotos, readFileAsPhoto } from './dom.js';

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

function stepSummaryHtml(step, entry) {
  const parts = [];
  if (entry.photoId) parts.push(`<img class="thumb" data-photo-id="${esc(entry.photoId)}" alt="" />`);
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

function expandedRowsHtml(step, entry, fieldCtx) {
  let html = '';
  const key = `${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`;
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

function editableStepRowHtml(step, entry, expanded, fieldCtx) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  // A save error on this step shows expanded (as the shared footer in
  // expandedRowsHtml, right under its fields) or, collapsed, as this short
  // line under the step name — either way the user shouldn't have to
  // re-expand a collapsed, failed step just to find out something's wrong.
  const errorMessage = !expanded && photoErrorByKey.get(`${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`);
  const collapsedErrorHtml = errorMessage ? `<div class="step-error">${esc(errorMessage)}</div>` : '';
  let html = `<div class="row" data-role="step-row" data-step-id="${esc(step.id)}" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <input type="checkbox" class="check" data-role="check" ${entry.done ? 'checked' : ''} />
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
      ${collapsedErrorHtml}
    </div>
    <div class="step-summary">${stepSummaryHtml(step, entry)}</div>
  </div>`;
  if (expanded) html += expandedRowsHtml(step, entry, fieldCtx);
  return html;
}

function readOnlyStepRowHtml(step, entry) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  const noteHtml = entry.note ? `<div class="step-note">${esc(entry.note)}</div>` : '';
  const complete = isStepComplete(step, entry);
  const check = `<span class="ro-check${complete ? ' done' : ''}">${complete ? '✓' : '–'}</span>`;
  const summary = stepSummaryHtml(step, entry);
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

  const stepsHtml = challenge.steps.map((step) => {
    const entry = (day.steps && day.steps[step.id]) || {};
    if (!editable) return readOnlyStepRowHtml(step, entry);
    return editableStepRowHtml(step, entry, expandedStepId === step.id, fieldCtx);
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
