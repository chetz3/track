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

// ---------- in-app navigation tracking (for the close button's fallback) ----------

// Any hash our router recognises (see app.js's matchRoute) — in practice
// every hash, since its `default:` case treats an unknown one as `today`.
// So `arrivedFromInApp` really means "at least one hashchange has fired
// since this module loaded" — i.e. the summary viewer was reached via
// in-app navigation, and `history.back()` is safe. It stays false only
// when the summary route was the very first thing this tab loaded (a
// deep link/bookmark straight onto #/summary/:date), where back() could
// leave the app entirely.
const KNOWN_TOPS = ['', 'today', 'day', 'calendar', 'overview', 'stats', 'challenges', 'summary'];
function isInAppHash(hash) {
  const top = hash.replace(/^#\/?/, '').split('/')[0];
  return KNOWN_TOPS.includes(top);
}

let previousHash = location.hash;
let arrivedFromInApp = false;

// Registered once at module load (not per-render): also the single place
// that detaches the Escape handler, so navigating away (a real hashchange,
// as opposed to a store-driven re-render of the same route) always leaves
// at most one keydown listener attached.
window.addEventListener('hashchange', () => {
  if (isInAppHash(previousHash)) arrivedFromInApp = true;
  previousHash = location.hash;
  detachEscHandler();
});

// ---------- Escape-to-close ----------

let currentEscHandler = null;

function detachEscHandler() {
  if (currentEscHandler) {
    document.removeEventListener('keydown', currentEscHandler);
    currentEscHandler = null;
  }
}

function attachEscHandler() {
  detachEscHandler();
  currentEscHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeViewer();
    }
  };
  document.addEventListener('keydown', currentEscHandler);
}

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

function photoNavHtml(photos) {
  if (photos.length <= 1) return '';
  return `<div class="summary-photo-nav" data-role="photo-nav">
    <div class="summary-photo-nav-row">
      <button type="button" class="summary-nav-btn" data-role="prev" aria-label="Previous photo">‹</button>
      <span class="summary-photo-counter" data-role="photo-counter">1 / ${photos.length}</span>
      <button type="button" class="summary-nav-btn" data-role="next" aria-label="Next photo">›</button>
    </div>
    <div class="summary-photo-name" data-role="photo-name">${esc(photos[0].stepName)}</div>
  </div>`;
}

function panelHtml(date, status, items, photos) {
  return `<div class="summary-panel">
    ${photoNavHtml(photos)}
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
  if (arrivedFromInApp) {
    history.back();
  } else {
    location.hash = '#/calendar';
  }
}

// Index of the slide currently centred in the strip, derived from its
// scroll position rather than tracked separately, so swipe and the
// prev/next buttons never fall out of sync with each other.
function currentSlideIndex(strip, photoCount) {
  const raw = Math.round(strip.scrollLeft / (strip.clientWidth || 1));
  return Math.min(photoCount - 1, Math.max(0, raw));
}

// Updates the dots, counter and step name for slide `idx`. Called both from
// the strip's scroll listener (swipe) and after a prev/next click.
function updateNavUi(root, photos, idx) {
  const dotsWrap = root.querySelector('[data-role="dots"]');
  if (dotsWrap) dotsWrap.querySelectorAll('.summary-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
  const counterEl = root.querySelector('[data-role="photo-counter"]');
  if (counterEl) counterEl.textContent = `${idx + 1} / ${photos.length}`;
  const nameEl = root.querySelector('[data-role="photo-name"]');
  if (nameEl) nameEl.textContent = photos[idx].stepName;
}

function wireStrip(root, photos) {
  if (photos.length <= 1) return;
  const strip = root.querySelector('[data-role="photos-strip"]');
  if (!strip) return;
  strip.addEventListener('scroll', () => {
    updateNavUi(root, photos, currentSlideIndex(strip, photos.length));
  }, { passive: true });
}

// Scrolls the strip to the previous/next slide (dir = -1/+1), wrapping
// around at either end.
function goToSlide(root, photos, dir) {
  const strip = root.querySelector('[data-role="photos-strip"]');
  if (!strip || photos.length <= 1) return;
  const idx = currentSlideIndex(strip, photos.length);
  const next = ((idx + dir) % photos.length + photos.length) % photos.length;
  strip.scrollTo({ left: next * strip.clientWidth, behavior: 'smooth' });
}

function wireControls(root, date, photos) {
  if (root.__summaryWired) return;
  root.__summaryWired = true;
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="close"]')) {
      closeViewer();
      return;
    }
    if (e.target.closest('[data-role="edit"]')) {
      location.hash = `#/day/${date}`;
      return;
    }
    if (e.target.closest('[data-role="prev"]')) {
      goToSlide(root, photos, -1);
      return;
    }
    if (e.target.closest('[data-role="next"]')) {
      goToSlide(root, photos, 1);
    }
  });
}

// ---------- main render ----------

export async function renderSummary(root, dateParam) {
  const challenge = store.selected();
  if (!challenge) {
    // No selected challenge (e.g. transiently null mid-delete): still show
    // the close button rather than stranding the user on a blank,
    // tab-bar-less screen.
    root.innerHTML = `<div class="summary-viewer">${controlsHtml(false)}</div>`;
    wireControls(root.querySelector('.summary-viewer'), null, []);
    attachEscHandler();
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
    ${panelHtml(date, status, summary.items, summary.photos)}
  </div>`;

  const viewer = root.querySelector('.summary-viewer');
  wireStrip(viewer, summary.photos);
  wireControls(viewer, date, summary.photos);
  attachEscHandler();
  await hydratePhotos(root);
}
