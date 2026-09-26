// Today (#/today) and Day detail (#/day/:date) screens: the hero "day
// status" card plus the grouped step list with inline expand-to-edit rows.
//
// Render contract (see app.js): renderToday/renderDay receive a container
// already attached inside #app. They may only write inside it, and must call
// hydratePhotos only on that attached container.

import * as store from '../store.js';
import { dayStatus, isEditable, isStepComplete, parseNumberInput, addDays, diffDays } from '../rules.js';
import { savePhoto, photoDateOf } from '../photos.js';
import { esc, formatDateLong, formatDateShort, hydratePhotos, readFileAsPhoto } from './dom.js';
import { openCamera } from './camera.js';

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
window.addEventListener('hashchange', () => { focusRecord = null; });

// Photo-date mismatch message per step, keyed the same way as expandedKey
// (`${challengeId}:${date}:${stepId}`), shown as an inline red footer under
// the photo row until the step is re-collapsed/expanded, a matching photo is
// saved, or the screen navigates to a different challenge/day (see
// renderScreen's key check).
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

function markSaved(ctx) {
  lastSaved = { challengeId: ctx.challengeId, date: ctx.date, at: Date.now() };
  if (savedHideTimer) clearTimeout(savedHideTimer);
  savedHideTimer = setTimeout(() => {
    savedHideTimer = null;
    if (current && current.challengeId === ctx.challengeId && current.date === ctx.date) current.rerender();
  }, SAVED_INDICATOR_MS);
}

// Shared by the "‹ Back" button and the "Done" button on an editable Day
// detail screen: return to wherever the user came from, falling back to the
// calendar when there's nowhere in this tab's history to go back to (e.g.
// the day was opened via a direct link).
function goBack() {
  if (history.length > 1) history.back();
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
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="mini-ring" role="img" aria-label="${done} of ${total}">` +
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
function photoRowHtml(step, entry, fieldCtx, errorMessage, isSaving) {
  const disabledAttr = isSaving ? ' disabled' : '';
  const takeLabel = isSaving ? 'Saving…' : 'Take photo';
  const libraryLabel = isSaving ? 'Saving…' : 'Library';
  const rowHtml = `<div class="row" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <div class="btn-pair">
      <button type="button" class="btn btn-primary photo-field-btn" data-role="camera-btn" data-step-id="${esc(step.id)}"${disabledAttr}>${esc(takeLabel)}</button>
      <label class="btn btn-secondary photo-field-btn">${esc(libraryLabel)}
        <input type="file" accept="image/*" hidden data-role="photo-input" data-step-id="${esc(step.id)}"${disabledAttr} />
      </label>
    </div>
  </div>`;
  const footerHtml = errorMessage ? `<div class="section-footer photo-error">${esc(errorMessage)}</div>` : '';
  return rowHtml + footerHtml;
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
  if (step.photo !== 'none') {
    const photoKey = `${fieldCtx.challengeId}:${fieldCtx.date}:${step.id}`;
    const errorMessage = photoErrorByKey.get(photoKey);
    const isSaving = savingByKey.has(photoKey);
    html += photoRowHtml(step, entry, fieldCtx, errorMessage, isSaving);
  }
  if (step.number) html += numberRowHtml(step, entry, fieldCtx);
  if (step.note !== 'none') html += noteRowHtml(step, entry, fieldCtx);
  return html;
}

function editableStepRowHtml(step, entry, expanded, fieldCtx) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  let html = `<div class="row" data-role="step-row" data-step-id="${esc(step.id)}" data-challenge-id="${esc(fieldCtx.challengeId)}" data-date="${esc(fieldCtx.date)}">
    <input type="checkbox" class="check" data-role="check" ${entry.done ? 'checked' : ''} />
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
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

// ---------- photo save (shared by the camera and the library picker) ----------

// Both photo paths — the in-app camera and the library file input — funnel
// through here so the "must match the day being logged" rule applies
// identically. `ctx`/`stepId` are read off the DOM at the moment the user
// acted (see fieldContext), not off the shared `current` box, so a photo
// that resolves after the user has navigated away still saves (or is
// rejected) against the row it was opened for.
// `fromCamera` skips the day-match check: the spec's "must match the day
// being logged" rule targets the library picker (any photo could be handed
// to it), not a photo the in-app camera just took — which is also the only
// way to log yesterday's photo at all, since a camera shot's Exif/lastModified
// date is always "now".
async function handlePhotoFile(ctx, stepId, file, { fromCamera = false } = {}) {
  if (!file) return;
  const key = `${ctx.challengeId}:${ctx.date}:${stepId}`;
  // Only re-render if this row is still the one on screen — a save/rejection
  // that resolves after the user has navigated elsewhere shouldn't yank them
  // back or re-render a now-unrelated screen.
  const rerenderIfCurrent = () => {
    if (current && current.challengeId === ctx.challengeId && current.date === ctx.date) current.rerender();
  };
  try {
    if (!fromCamera) {
      const photoDate = await photoDateOf(file);
      if (photoDate !== ctx.date) {
        photoErrorByKey.set(key, `This photo is from ${formatDateShort(photoDate)}. Pick one taken on ${formatDateShort(ctx.date)}, or take a new one.`);
        rerenderIfCurrent();
        return;
      }
    }
    photoErrorByKey.delete(key);
    savingByKey.set(key, true);
    rerenderIfCurrent(); // show "Saving…" right away, before the (possibly slow) resize/write below
    const photoId = await savePhoto(file);
    await store.updateStep(ctx.challengeId, ctx.date, stepId, { photoId });
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
    rerenderIfCurrent();
  }
}

// Re-queries the library input for (ctx, stepId) against the *live* root at
// the moment it's needed, rather than a row element captured back when the
// camera button was clicked — the camera sheet can stay open across a
// store-driven re-render that replaces that row entirely. Returns null (do
// nothing) if the row/input no longer exists, e.g. the step got collapsed or
// the user navigated to a different challenge/day while the sheet was open.
function findPhotoInput(root, ctx, stepId) {
  const cssEscape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s;
  return root.querySelector(
    `[data-challenge-id="${cssEscape(ctx.challengeId)}"][data-date="${cssEscape(ctx.date)}"] [data-role="photo-input"][data-step-id="${cssEscape(stepId)}"]`
  );
}

// ---------- delegated event wiring (attached once per root) ----------

function wireDelegation(root) {
  if (root.__todayWired) return;
  root.__todayWired = true;

  root.addEventListener('focusin', rememberFocus);
  root.addEventListener('input', trackFocusValue);
  root.addEventListener('focusout', forgetFocusIfLeft);

  root.addEventListener('click', (e) => {
    const switchBtn = e.target.closest('[data-role="switch-challenge"]');
    if (switchBtn) {
      store.select(switchBtn.dataset.challengeId);
      return;
    }
    const backBtn = e.target.closest('[data-role="back"]');
    if (backBtn) {
      goBack();
      return;
    }
    const doneBtn = e.target.closest('[data-role="done"]');
    if (doneBtn) {
      // Today has nowhere to "go back" to that makes sense — Calendar is the
      // natural place to land after finishing today's steps. Day detail
      // (only editable for yesterday) uses the same "back to wherever this
      // was opened from" behaviour as the back button.
      if (location.hash.startsWith('#/day/')) goBack();
      else location.hash = '#/calendar';
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
      const rowCtx = fieldContext(stepRow);
      if (rowCtx) photoErrorByKey.delete(`${rowCtx.challengeId}:${rowCtx.date}:${stepId}`);
      expandedStepId = expandedStepId === stepId ? null : stepId;
      current?.rerender();
      return;
    }

    const cameraBtn = e.target.closest('[data-role="camera-btn"]');
    if (cameraBtn) {
      const ctx = fieldContext(cameraBtn);
      if (!ctx) return;
      const stepId = cameraBtn.dataset.stepId;
      openCamera({
        onCapture: (file) => { handlePhotoFile(ctx, stepId, file, { fromCamera: true }); },
        onUseLibrary: () => { findPhotoInput(root, ctx, stepId)?.click(); },
      });
    }
  });

  root.addEventListener('change', async (e) => {
    const check = e.target.closest('[data-role="check"]');
    if (check) {
      const ctx = fieldContext(check);
      if (!ctx) return;
      const stepId = check.closest('[data-role="step-row"]').dataset.stepId;
      await store.updateStep(ctx.challengeId, ctx.date, stepId, { done: check.checked });
      markSaved(ctx);
      return;
    }

    const numberInput = e.target.closest('[data-role="number-input"]');
    if (numberInput) {
      const ctx = fieldContext(numberInput);
      if (!ctx) return;
      const stepId = numberInput.dataset.stepId;
      const raw = numberInput.value;
      const matchesFocusRecord = () =>
        focusRecord && focusRecord.role === 'number' && focusRecord.stepId === stepId &&
        focusRecord.challengeId === ctx.challengeId && focusRecord.date === ctx.date;
      if (raw.trim() === '') {
        numberInput.classList.remove('invalid');
        await store.updateStep(ctx.challengeId, ctx.date, stepId, { value: undefined });
        markSaved(ctx);
        // Field still owns the record: nothing typed left to write back over
        // the now-cleared stored value on the next re-render.
        if (matchesFocusRecord()) focusRecord.value = '';
        return;
      }
      const parsed = parseNumberInput(raw);
      if (parsed === undefined) {
        numberInput.classList.add('invalid');
        return;
      }
      numberInput.classList.remove('invalid');
      await store.updateStep(ctx.challengeId, ctx.date, stepId, { value: parsed });
      markSaved(ctx);
      // Normalise the tracked value to what was actually stored (e.g. "3,5"
      // -> "3.5") so restoreFocus doesn't write the raw comma form back over
      // it on the next store-driven re-render.
      if (matchesFocusRecord()) focusRecord.value = String(parsed);
      return;
    }

    const noteInput = e.target.closest('[data-role="note-input"]');
    if (noteInput) {
      const ctx = fieldContext(noteInput);
      if (!ctx) return;
      const stepId = noteInput.dataset.stepId;
      await store.updateStep(ctx.challengeId, ctx.date, stepId, { note: noteInput.value });
      markSaved(ctx);
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
        <div class="day-line">Day <span class="day-num">${ctx.dayNumber}</span> of ${ctx.totalDays}</div>
        <div class="week-line">Week ${ctx.weekNum} · ${ctx.green}/${ctx.weekTarget} green</div>
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
