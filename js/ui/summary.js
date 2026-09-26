// Green-day summary viewer (#/summary/:date): a full-screen photo strip with
// a 30%-wide activity overlay panel. Task 8A.
//
// Render contract (see app.js): renderSummary receives a container already
// attached inside #app. It may only write inside it, and must call
// hydratePhotos only on that attached container. The router hides the tab
// bar for this route (it's a "full-screen" route, like the empty state).

import * as store from '../store.js';
import { dayStatus, isEditable, addDays } from '../rules.js';
import { esc, formatDateShort, hydratePhotos } from './dom.js';
import { buildDaySummary } from '../summaryModel.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_LABELS = { green: 'Complete', red: 'Missed', pending: 'In progress', future: 'Upcoming', outside: 'Outside attempt' };

function computeStatus(challenge, date, day, todayStr) {
  const attempt = store.displayAttempt(challenge.id);
  if (!attempt) return 'outside';
  const lastDate = addDays(attempt.startDate, challenge.totalDays - 1);
  if (date < attempt.startDate || date > lastDate) return 'outside';
  return dayStatus(date, day, challenge, todayStr);
}

// ---------- markup ----------

function slideHtml(photo, index) {
  return `<div class="summary-slide" data-index="${index}">
    <img data-photo-id="${esc(photo.photoId)}" alt="${esc(photo.stepName)}" />
    <span class="summary-caption">${esc(photo.stepName)}</span>
  </div>`;
}

function photosHtml(photos) {
  if (!photos.length) {
    return `<div class="summary-empty">No photos for this day</div>`;
  }
  const dotsHtml = photos.length > 1
    ? `<div class="summary-dots" data-role="dots">${photos.map((_, i) => `<span class="summary-dot${i === 0 ? ' active' : ''}"></span>`).join('')}</div>`
    : '';
  return `<div class="summary-photos-wrap">
    <div class="summary-photos" data-role="photos-strip">${photos.map(slideHtml).join('')}</div>
    ${dotsHtml}
  </div>`;
}

function itemHtml(item) {
  const checkCls = item.complete ? 'summary-check done' : 'summary-check';
  const checkGlyph = item.complete ? '✓' : '○';
  const valueHtml = item.value ? `<div class="summary-item-value">${esc(item.value)}</div>` : '';
  const noteHtml = item.note ? `<div class="summary-item-note">${esc(item.note)}</div>` : '';
  const photoTagHtml = item.hasPhoto ? `<span class="summary-photo-tag">Photo</span>` : '';
  return `<div class="summary-item${item.mandatory ? ' mandatory' : ''}">
    <div class="summary-item-head">
      <span class="${checkCls}">${checkGlyph}</span>
      <span class="summary-item-name">${esc(item.name)}</span>
    </div>
    ${valueHtml}${noteHtml}${photoTagHtml}
  </div>`;
}

function panelHtml(date, status, items) {
  return `<div class="summary-panel">
    <div class="summary-panel-date">${esc(formatDateShort(date))}</div>
    <span class="pill ${status}">${esc(STATUS_LABELS[status] || status)}</span>
    <div class="summary-items">${items.map(itemHtml).join('')}</div>
  </div>`;
}

function controlsHtml(showEdit) {
  const editBtn = showEdit ? `<button type="button" class="summary-edit" data-role="edit">Edit day</button>` : '';
  return `<div class="summary-controls">
    <button type="button" class="summary-close" data-role="close" aria-label="Close">✕</button>
    ${editBtn}
  </div>`;
}

// ---------- behaviour ----------

function closeViewer() {
  if (window.history.length > 1) {
    history.back();
  } else {
    location.hash = '#/calendar';
  }
}

function wireStrip(root, photoCount) {
  if (photoCount <= 1) return;
  const strip = root.querySelector('[data-role="photos-strip"]');
  const dotsWrap = root.querySelector('[data-role="dots"]');
  if (!strip || !dotsWrap) return;
  strip.addEventListener('scroll', () => {
    const idx = Math.round(strip.scrollLeft / (strip.clientWidth || 1));
    dotsWrap.querySelectorAll('.summary-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
  }, { passive: true });
}

function wireControls(root, date) {
  if (root.__summaryWired) return;
  root.__summaryWired = true;
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="close"]')) {
      closeViewer();
      return;
    }
    if (e.target.closest('[data-role="edit"]')) {
      location.hash = `#/day/${date}`;
    }
  });
}

// ---------- main render ----------

export async function renderSummary(root, dateParam) {
  const challenge = store.selected();
  if (!challenge) {
    root.innerHTML = '';
    return;
  }

  const todayStr = store.today();
  const date = DATE_RE.test(dateParam) ? dateParam : todayStr;
  const day = store.getDay(challenge.id, date);
  const status = computeStatus(challenge, date, day, todayStr);
  const summary = buildDaySummary(challenge, day);
  const showEdit = isEditable(date, todayStr);

  root.innerHTML = `<div class="summary-viewer">
    ${photosHtml(summary.photos)}
    ${controlsHtml(showEdit)}
    ${panelHtml(date, status, summary.items)}
  </div>`;

  const viewer = root.querySelector('.summary-viewer');
  wireStrip(viewer, summary.photos.length);
  wireControls(viewer, date);
  await hydratePhotos(root);
}
