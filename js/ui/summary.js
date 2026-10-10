// Green-day summary viewer (#/summary/:date): a full-screen photo strip with
// a bottom details overlay (per-step cards, collapsible).
//
// Render contract (see app.js): renderSummary receives a container already
// attached inside #app. It may only write inside it, and must call
// hydratePhotos only on that attached container. The router hides the tab
// bar for this route (it's a "full-screen" route, like the empty state).

import * as store from '../store.js';
import { dayStatus, isEditable, addDays } from '../rules.js';
import { esc, formatDateShort, hydratePhotos } from './dom.js';
import { buildDaySummary, buildDayDetails, groupPhotosByStep } from '../summaryModel.js';

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
  return dayStatus(date, day, challenge, todayStr, store.flexDatesFor(challenge.id));
}

// ---------- markup ----------

function slideHtml(photo, index) {
  return `<div class="summary-slide" data-index="${index}">
    <img data-photo-id="${esc(photo.photoId)}" alt="${esc(photo.stepName)}" />
  </div>`;
}

// Big ‹ › buttons on the picture itself: step through this day's photos,
// then on to the previous/next day that has photos (see neighbourDates).
function pictureNavHtml(hasPrev, hasNext) {
  return `${hasPrev ? '<button type="button" class="summary-pic-nav prev" data-role="pic-prev" aria-label="Previous picture">‹</button>' : ''}
    ${hasNext ? '<button type="button" class="summary-pic-nav next" data-role="pic-next" aria-label="Next picture">›</button>' : ''}`;
}

function photosHtml(photos, nav = { prev: null, next: null }) {
  const navHtml = pictureNavHtml(photos.length > 1 || !!nav.prev, photos.length > 1 || !!nav.next);
  if (!photos.length) {
    return `<div class="summary-empty">No photos for this day</div>${navHtml}`;
  }
  const dotsHtml = photos.length > 1
    ? `<div class="summary-dots" data-role="dots">${photos.map((_, i) => `<span class="summary-dot${i === 0 ? ' active' : ''}"></span>`).join('')}</div>`
    : '';
  return `<div class="summary-photos-wrap">
    <div class="summary-photos" data-role="photos-strip">${photos.map(slideHtml).join('')}</div>
    ${dotsHtml}
  </div>${navHtml}`;
}

// The nearest earlier / later day (not after today) that has at least one
// photo, so the picture's ‹ › can roll on past this day's last photo.
function neighbourDates(challenge, date, todayStr, stepId) {
  const daysMap = store.state.days[challenge.id] || {};
  const withPhotos = Object.keys(daysMap)
    .filter((d) => d <= todayStr && d !== date && buildDaySummary(challenge, daysMap[d]).photos.some((p) => p.stepId === stepId))
    .sort();
  const prev = withPhotos.filter((d) => d < date).pop() || null;
  const next = withPhotos.find((d) => d > date) || null;
  return { prev, next };
}

// Within the day first; past its first/last photo, jump to the adjacent day.
function stepPicture(root, photos, dir, nav) {
  const strip = root.querySelector('[data-role="photos-strip"]');
  const idx = strip ? currentSlideIndex(strip, photos.length) : 0;
  const target = idx + dir;
  if (photos.length > 1 && target >= 0 && target < photos.length) {
    goToSlide(root, photos, dir);
    return;
  }
  const date = dir > 0 ? nav.next : nav.prev;
  if (date) location.replace(`#/summary/${date}`);
  else if (photos.length > 1) goToSlide(root, photos, dir); // wrap within the day
}

// ---------- photo tabs ----------

// Remembered tab (step kind + id), so it survives re-renders and day changes.
let selectedTab = null;

function resolveTab(groups) {
  if (!groups.length) return null;
  if (selectedTab) {
    const hit = groups.find((g) => g.stepId === selectedTab.stepId)
      || (selectedTab.kind !== 'custom' ? groups.find((g) => g.kind === selectedTab.kind) : null);
    if (hit) return hit;
  }
  return groups.find((g) => g.kind === 'body') || groups[0];
}

function tabsHtml(groups, active) {
  if (!groups.length) return '';
  return `<div class="summary-tabs" role="tablist" aria-label="Photo categories">${groups.map((g) => {
    const on = g === active;
    return `<button type="button" class="summary-tab${on ? ' active' : ''}" role="tab" aria-selected="${on}" data-role="photo-tab" data-step-id="${esc(g.stepId)}">${esc(g.name)} <span class="summary-tab-count">${g.photos.length}</span></button>`;
  }).join('')}</div>`;
}

// ---------- details overlay ----------

const DETAILS_KEY = 'tracker:summaryDetails';

function readDetailsShown() {
  try { return localStorage.getItem(DETAILS_KEY) !== '0'; } catch { return true; }
}

function writeDetailsShown(shown) {
  try { localStorage.setItem(DETAILS_KEY, shown ? '1' : '0'); } catch { /* storage unavailable */ }
}

// Per-step open/closed choices made this session, keyed by stepId. Steps
// without a choice default to open for food/workout, closed otherwise.
const stepOpenState = new Map();

function isStepOpen(detail, type) {
  return stepOpenState.has(detail.stepId) ? stepOpenState.get(detail.stepId) : (type === 'food' || type === 'workout');
}

function photoInfoText(photos, idx) {
  if (!photos.length) return '';
  const p = photos[idx];
  return `Photo ${idx + 1} / ${photos.length} · ${p.caption || p.stepName}`;
}

function rowHtml(row, hasPhoto) {
  const thumb = row.photoId ? `<img class="summary-row-thumb" data-photo-id="${esc(row.photoId)}" alt="" />` : '';
  const goto = row.photoId && hasPhoto ? ` data-role="goto-photo" data-photo-ref="${esc(row.photoId)}"` : '';
  return `<div class="summary-row${goto ? ' tappable' : ''}"${goto}>
    ${thumb}
    <div class="summary-row-text">
      <div class="summary-row-title">${esc(row.title)}</div>
      ${row.sub ? `<div class="summary-row-sub">${esc(row.sub)}</div>` : ''}
    </div>
  </div>`;
}

function stepCardHtml(detail, type, photos) {
  const open = isStepOpen(detail, type);
  const checkCls = detail.complete ? 'summary-check done' : 'summary-check';
  const rowsHtml = detail.rows.map((r) => rowHtml(r, !!r.photoId && photos.some((p) => p.photoId === r.photoId))).join('');
  const noteHtml = detail.note ? `<div class="summary-step-note">${esc(detail.note)}</div>` : '';
  const bodyHtml = rowsHtml + noteHtml || '<div class="summary-row-sub">Nothing logged</div>';
  return `<div class="summary-step${detail.mandatory ? ' mandatory' : ''}${open ? ' open' : ''}">
    <button type="button" class="summary-step-head" data-role="toggle-step" data-step-id="${esc(detail.stepId)}" aria-expanded="${open}">
      <span class="${checkCls}">${detail.complete ? '✓' : '○'}</span>
      <span class="summary-step-name">${esc(detail.name)}</span>
      <span class="summary-step-headline">${esc(detail.headline)}</span>
      <span class="summary-chevron" aria-hidden="true">›</span>
    </button>
    <div class="summary-step-body"${open ? '' : ' hidden'}>${bodyHtml}</div>
  </div>`;
}

function detailsHtml(date, status, details, challenge, photos, shown) {
  const typeOf = (id) => (challenge.steps.find((s) => s.id === id) || {}).type;
  return `<div class="summary-details" data-role="details">
    <div class="summary-details-head">
      <div class="summary-panel-date">${esc(formatDateShort(date))}</div>
      <span class="pill ${status}">${esc(STATUS_LABELS[status] || status)}</span>
      <div class="summary-photo-info" data-role="photo-info">${esc(photoInfoText(shown, 0))}</div>
    </div>
    ${details.map((d) => stepCardHtml(d, typeOf(d.stepId), photos)).join('')}
  </div>`;
}

function controlsHtml(showEdit, showDetails = true) {
  const editBtn = showEdit ? `<button type="button" class="summary-edit" data-role="edit">Edit day</button>` : '';
  return `<div class="summary-controls">
    <button type="button" class="summary-close" data-role="close" aria-label="Close">✕</button>
    ${editBtn}
  </div>
  <button type="button" class="summary-toggle-details" data-role="toggle-details" aria-expanded="${showDetails}">${showDetails ? 'Hide details' : 'Show details'}</button>`;
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
  const infoEl = root.querySelector('[data-role="photo-info"]');
  if (infoEl) infoEl.textContent = photoInfoText(photos, idx);
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

function wireControls(root, date, photos, nav = { prev: null, next: null }, allPhotos = photos, selectTab = null) {
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
    const toggleDetails = e.target.closest('[data-role="toggle-details"]');
    if (toggleDetails) {
      const shown = root.classList.contains('details-off');
      root.classList.toggle('details-off', !shown);
      toggleDetails.setAttribute('aria-expanded', String(shown));
      toggleDetails.textContent = shown ? 'Hide details' : 'Show details';
      writeDetailsShown(shown);
      return;
    }
    const toggleStep = e.target.closest('[data-role="toggle-step"]');
    if (toggleStep) {
      const card = toggleStep.closest('.summary-step');
      const open = toggleStep.getAttribute('aria-expanded') !== 'true';
      toggleStep.setAttribute('aria-expanded', String(open));
      card.classList.toggle('open', open);
      const body = card.querySelector('.summary-step-body');
      if (body) body.hidden = !open;
      stepOpenState.set(toggleStep.dataset.stepId, open);
      return;
    }
    const tab = e.target.closest('[data-role="photo-tab"]');
    if (tab) {
      if (selectTab) selectTab(tab.dataset.stepId);
      return;
    }
    const gotoPhoto = e.target.closest('[data-role="goto-photo"]');
    if (gotoPhoto) {
      const target = allPhotos.find((p) => p.photoId === gotoPhoto.dataset.photoRef);
      if (!target) return;
      const inTab = photos.some((p) => p.photoId === target.photoId);
      if (!inTab && selectTab) {
        selectTab(target.stepId, target.photoId);
        return;
      }
      const strip = root.querySelector('[data-role="photos-strip"]');
      const i = photos.findIndex((p) => p.photoId === target.photoId);
      if (strip && i >= 0) strip.scrollTo({ left: i * strip.clientWidth, behavior: 'smooth' });
      return;
    }
    if (e.target.closest('.summary-details')) return;
    if (e.target.closest('[data-role="pic-prev"]')) {
      stepPicture(root, photos, -1, nav);
      return;
    }
    if (e.target.closest('[data-role="pic-next"]')) {
      stepPicture(root, photos, 1, nav);
      return;
    }
    // Tapping the photo itself: left third goes back, anywhere else forward.
    const slide = e.target.closest('.summary-slide');
    if (slide) {
      const rect = slide.getBoundingClientRect();
      stepPicture(root, photos, e.clientX < rect.left + rect.width / 3 ? -1 : 1, nav);
    }
  });
}

// ---------- main render ----------

export async function renderSummary(root, dateParam, scrollToPhotoId = null) {
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
  const details = buildDayDetails(challenge, day, { flexOn: store.flexDatesFor(challenge.id).has(date) });
  const detailsShown = readDetailsShown();
  const showEdit = isEditable(date, todayStr);

  const groups = groupPhotosByStep(challenge, summary.photos);
  const active = resolveTab(groups);
  if (active) selectedTab = { kind: active.kind, stepId: active.stepId };
  const photos = active ? active.photos : [];
  const nav = active ? neighbourDates(challenge, date, todayStr, active.stepId) : { prev: null, next: null };
  root.innerHTML = `<div class="summary-viewer${detailsShown ? '' : ' details-off'}">
    ${photosHtml(photos, nav)}
    ${controlsHtml(showEdit, detailsShown)}
    ${tabsHtml(groups, active)}
    ${detailsHtml(date, status, details, challenge, summary.photos, photos)}
  </div>`;

  const viewer = root.querySelector('.summary-viewer');
  const selectTab = (stepId, photoId = null) => {
    const g = groups.find((x) => x.stepId === stepId);
    if (!g) return;
    selectedTab = { kind: g.kind, stepId: g.stepId };
    renderSummary(root, dateParam, photoId);
  };
  wireStrip(viewer, photos);
  wireControls(viewer, date, photos, nav, summary.photos, selectTab);
  attachEscHandler();
  await hydratePhotos(root);
  if (scrollToPhotoId) {
    const strip = viewer.querySelector('[data-role="photos-strip"]');
    const i = photos.findIndex((p) => p.photoId === scrollToPhotoId);
    if (strip && i > 0) {
      strip.scrollLeft = i * strip.clientWidth;
      updateNavUi(viewer, photos, i);
    }
  }
}
