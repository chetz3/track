// Today (#/today) and Day detail (#/day/:date) screens: the hero "day
// status" card plus the grouped step list with inline expand-to-edit rows.
//
// Render contract (see app.js): renderToday/renderDay receive a container
// already attached inside #app. They may only write inside it, and must call
// hydratePhotos only on that attached container.

import * as store from '../store.js';
import { dayStatus, isEditable, isStepComplete, parseNumberInput, addDays, diffDays } from '../rules.js';
import { savePhoto } from '../photos.js';
import { esc, formatDateLong, hydratePhotos, readFileAsPhoto } from './dom.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
// time, so they always act on the screen currently rendered into `root`.
let current = null;

const PILL_LABELS = { green: 'Complete', red: 'Missed', pending: 'In progress', future: 'Upcoming', outside: 'Outside attempt' };

// ---------- mini progress ring (reused by Task 7) ----------

export function miniRing(done, total, sizePx) {
  const size = sizePx;
  const stroke = Math.max(3, Math.round(size * 0.09));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const dash = c * pct;
  const center = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="mini-ring" role="img" aria-label="${done} of ${total}">` +
    `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--raised)" stroke-width="${stroke}" />` +
    `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-dasharray="${dash} ${c - dash}" transform="rotate(-90 ${center} ${center})" />` +
    `</svg>`;
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

function photoRowHtml(step, entry) {
  const label = entry.photoId ? 'Replace photo' : 'Take photo';
  return `<div class="row">
    <span class="field-label">Photo</span>
    <label class="btn btn-secondary photo-field-btn">${esc(label)}
      <input type="file" accept="image/*" hidden data-role="photo-input" data-step-id="${esc(step.id)}" />
    </label>
  </div>`;
}

function numberRowHtml(step, entry) {
  const value = entry.value != null ? esc(String(entry.value)) : '';
  const unit = step.number.unit ? `<span class="field-unit">${esc(step.number.unit)}</span>` : '';
  return `<div class="row">
    <span class="field-label">${esc(step.number.label)}</span>
    <input type="text" inputmode="decimal" data-role="number-input" data-step-id="${esc(step.id)}" value="${value}" />
    ${unit}
  </div>`;
}

function noteRowHtml(step, entry) {
  return `<div class="row">
    <span class="field-label">Note</span>
    <textarea data-role="note-input" data-step-id="${esc(step.id)}">${esc(entry.note || '')}</textarea>
  </div>`;
}

function expandedRowsHtml(step, entry) {
  let html = '';
  if (step.photo !== 'none') html += photoRowHtml(step, entry);
  if (step.number) html += numberRowHtml(step, entry);
  if (step.note !== 'none') html += noteRowHtml(step, entry);
  return html;
}

function editableStepRowHtml(step, entry, expanded) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  let html = `<div class="row" data-role="step-row" data-step-id="${esc(step.id)}">
    <input type="checkbox" class="check" data-role="check" ${entry.done ? 'checked' : ''} />
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
    </div>
    <div class="step-summary">${stepSummaryHtml(step, entry)}</div>
  </div>`;
  if (expanded) html += expandedRowsHtml(step, entry);
  return html;
}

function readOnlyStepRowHtml(step, entry) {
  const requiredCaption = step.mandatory ? '<div class="step-required">Required</div>' : '';
  const complete = isStepComplete(step, entry);
  const check = `<span class="ro-check${complete ? ' done' : ''}">${complete ? '✓' : '–'}</span>`;
  const summary = stepSummaryHtml(step, entry);
  return `<div class="row">
    <div class="row-label">
      <div>${esc(step.name)}</div>
      ${requiredCaption}
    </div>
    <div class="row-value">${check}${summary}</div>
  </div>`;
}

// ---------- delegated event wiring (attached once per root) ----------

function wireDelegation(root) {
  if (root.__todayWired) return;
  root.__todayWired = true;

  root.addEventListener('click', (e) => {
    const switchBtn = e.target.closest('[data-role="switch-challenge"]');
    if (switchBtn) {
      store.select(switchBtn.dataset.challengeId);
      return;
    }
    const backBtn = e.target.closest('[data-role="back"]');
    if (backBtn) {
      location.hash = '#/today';
      return;
    }
    const stepRow = e.target.closest('[data-role="step-row"]');
    if (stepRow && !e.target.closest('[data-role="check"]')) {
      const stepId = stepRow.dataset.stepId;
      expandedStepId = expandedStepId === stepId ? null : stepId;
      current?.rerender();
    }
  });

  root.addEventListener('change', async (e) => {
    if (!current) return;
    const { challengeId, date } = current;

    const check = e.target.closest('[data-role="check"]');
    if (check) {
      const stepId = check.closest('[data-role="step-row"]').dataset.stepId;
      await store.updateStep(challengeId, date, stepId, { done: check.checked });
      return;
    }

    const numberInput = e.target.closest('[data-role="number-input"]');
    if (numberInput) {
      const stepId = numberInput.dataset.stepId;
      const raw = numberInput.value;
      if (raw.trim() === '') {
        numberInput.classList.remove('invalid');
        await store.updateStep(challengeId, date, stepId, { value: undefined });
        return;
      }
      const parsed = parseNumberInput(raw);
      if (parsed === undefined) {
        numberInput.classList.add('invalid');
        return;
      }
      numberInput.classList.remove('invalid');
      await store.updateStep(challengeId, date, stepId, { value: parsed });
      return;
    }

    const noteInput = e.target.closest('[data-role="note-input"]');
    if (noteInput) {
      const stepId = noteInput.dataset.stepId;
      await store.updateStep(challengeId, date, stepId, { note: noteInput.value });
      return;
    }

    const photoInput = e.target.closest('[data-role="photo-input"]');
    if (photoInput) {
      const stepId = photoInput.dataset.stepId;
      const file = readFileAsPhoto(photoInput);
      if (!file) return;
      const photoId = await savePhoto(file);
      await store.updateStep(challengeId, date, stepId, { photoId });
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
  }

  const todayStr = store.today();
  const attempt = store.displayAttempt(challenge.id);
  const day = store.getDay(challenge.id, date);
  const ctx = computeDayContext(challenge, attempt, date, day, todayStr);
  const editable = !ctx.outside && isEditable(date, todayStr);
  const pop = popClassFor(key, ctx.status);

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
    return editableStepRowHtml(step, entry, expandedStepId === step.id);
  }).join('');

  root.innerHTML = `${headerHtml}
    ${heroHtml}
    <div class="section">
      <h2 class="section-header">Today's steps</h2>
      <div class="group">${stepsHtml}</div>
    </div>`;

  wireDelegation(root);
  await hydratePhotos(root);
}

export async function renderToday(root) {
  await renderScreen(root, { date: store.today(), dayRoute: false });
}

export async function renderDay(root, dateParam) {
  const date = DATE_RE.test(dateParam) ? dateParam : store.today();
  await renderScreen(root, { date, dayRoute: true });
}
