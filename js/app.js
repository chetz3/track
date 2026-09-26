// Router + tab bar + boot. Screens are plain modules exported as
// `render(root, params)` and wired into the ROUTES table below; Tasks 6-9
// replace the placeholder entries one at a time without touching this file.
//
// Render contract: screens receive an attached container (a live descendant
// of #app, already in the document); they may measure it (clientWidth,
// getBoundingClientRect, etc.); they must only write inside it — never touch
// #app or any sibling directly. Call hydratePhotos only on nodes already
// attached inside the container; hydrating a detached subtree revokes its
// URLs immediately.

import * as store from './store.js';
import { esc, revokePhotosIn } from './ui/dom.js';
import { renderToday, renderDay } from './ui/today.js';
import { renderCalendar, renderOverview } from './ui/calendar.js';
import { renderChallenges, renderChallengeForm, importBackupFlow } from './ui/challenges.js';
import { renderSummary } from './ui/summary.js';
import { renderStats } from './ui/stats.js';

const appEl = document.getElementById('app');
const tabbarEl = document.getElementById('tabbar');

// ---------- placeholder screens (replaced in later tasks) ----------

function placeholder(title) {
  return (root) => {
    root.innerHTML = `
      <h1 class="large-title">${esc(title)}</h1>
      <p class="subtitle">Coming soon</p>
    `;
  };
}

// Single route table: route name -> render(root, params). Later tasks swap
// individual entries for the real screen module's render function.
const ROUTES = {
  today: renderToday,
  day: (root, params) => renderDay(root, params.date),
  calendar: (root, params) => renderCalendar(root, params.month),
  overview: renderOverview,
  stats: renderStats,
  challenges: renderChallenges,
  'challenges/new': (root) => renderChallengeForm(root, 'new'),
  'challenges/:id': (root, params) => renderChallengeForm(root, params.id),
  'summary/:date': (root, params) => renderSummary(root, params.date),
};

// ---------- hash parsing ----------

function parseHash() {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

// Maps the current hash to { top, key, params }. `top` is the first path
// segment (used to decide whether the route "changed" for animation
// purposes); `key` indexes ROUTES.
function matchRoute() {
  const [first, second] = parseHash();
  switch (first) {
    case undefined:
    case 'today':
      return { top: 'today', key: 'today', params: {} };
    case 'day':
      return { top: 'day', key: 'day', params: { date: second || store.today() } };
    case 'calendar':
      return { top: 'calendar', key: 'calendar', params: { month: second } };
    case 'overview':
      return { top: 'overview', key: 'overview', params: {} };
    case 'stats':
      return { top: 'stats', key: 'stats', params: {} };
    case 'summary':
      return { top: 'summary', key: 'summary/:date', params: { date: second } };
    case 'challenges':
      if (second === 'new') return { top: 'challenges', key: 'challenges/new', params: {} };
      if (second) return { top: 'challenges', key: 'challenges/:id', params: { id: second } };
      return { top: 'challenges', key: 'challenges', params: {} };
    default:
      return { top: 'today', key: 'today', params: {} };
  }
}

function tabForTop(top) {
  if (top === 'today') return 'today';
  if (top === 'stats') return 'stats';
  if (top === 'challenges') return 'challenges';
  return 'calendar'; // day, calendar, summary
}

function setActiveTab(top) {
  const active = tabForTop(top);
  tabbarEl.querySelectorAll('a[data-route]').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === active);
  });
}

// ---------- empty state ----------

function renderEmptyState(root) {
  root.innerHTML = `
    <h1 class="large-title">Welcome</h1>
    <p class="subtitle">Create a challenge to start tracking your daily steps.</p>
    <button type="button" class="btn btn-primary" id="empty-create-btn">Create your first challenge</button>
    <button type="button" class="btn btn-secondary" id="empty-import-btn">Import backup</button>
  `;
  root.querySelector('#empty-create-btn').addEventListener('click', () => {
    location.hash = '#/challenges/new';
  });
  root.querySelector('#empty-import-btn').addEventListener('click', () => {
    importBackupFlow();
  });
}

// ---------- render loop ----------

let previousTop = null;
let previousScrollKey = null;
let renderScheduled = false;
let renderSeq = 0;
// The pre-render scrollY, held across a render that gets superseded mid-await
// so the next render reads the real pre-swap position rather than whatever
// scrollY has clamped to once #app was emptied for the swap.
let pendingScrollY = null;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

// Distinguishes "the same screen, re-rendered" (restore scroll position)
// from "a different screen under the same route name" (e.g. switching
// which day or which challenge is shown), which should scroll to top.
function routeScrollKey(key, params) {
  if (key === 'day') return `day:${params.date}`;
  if (key === 'calendar') return `calendar:${params.month || ''}`;
  if (key === 'challenges/:id') return `challenges/:id:${params.id}`;
  if (key === 'summary/:date') return `summary/:date:${params.date}`;
  return key;
}

// Renders are async (screen modules may await data/photos), so a slower
// render started earlier can finish after a newer one. Each call gets a
// token; a render whose token is no longer current when its work finishes
// is discarded before it touches any bookkeeping (its container was already
// swapped out by the newer render, and any of its photos that were still
// loading are revoked immediately by hydratePhotos' isConnected check).
//
// The new screen's container is attached to #app up front, *before*
// renderFn runs, so screens can measure themselves (clientWidth,
// getBoundingClientRect, ...) during their own render — a detached node
// always measures as zero. The swap briefly empties #app, which would
// otherwise collapse the page and clamp window.scrollY before the render
// that triggered it has even finished reading it (or before a render that
// supersedes it mid-await gets a chance to); `container.style.minHeight`
// holds the previous screen's height across the swap so the page doesn't
// collapse, and `pendingScrollY` holds the intended scroll position across
// however many superseding renders run before one finally commits.
async function render() {
  const token = ++renderSeq;
  const scrollY = pendingScrollY ?? window.scrollY;
  pendingScrollY = scrollY;
  const hasChallenges = store.state.challenges.length > 0;
  const { top, key, params } = matchRoute();

  const container = document.createElement('div');
  container.dataset.renderRoot = '';

  const old = appEl.firstElementChild;
  container.style.minHeight = old ? old.offsetHeight + 'px' : '';
  appEl.replaceChildren(container);
  if (old) revokePhotosIn(old);

  let effectiveTop = top;
  let effectiveKey = key;
  let showTabbar = hasChallenges;

  if (!hasChallenges && key !== 'challenges/new') {
    effectiveTop = 'empty';
    effectiveKey = 'empty';
    renderEmptyState(container);
    showTabbar = false;
  } else {
    if (key === 'challenges/new' && !hasChallenges) showTabbar = false;
    if (key === 'summary/:date') showTabbar = false; // full-screen route, like the empty state
    const renderFn = ROUTES[key] || ROUTES.today;
    await renderFn(container, params);
  }

  if (token !== renderSeq) return; // a newer render has since swapped this container out; discard

  container.style.minHeight = '';

  setActiveTab(effectiveTop === 'empty' ? 'today' : top);
  tabbarEl.hidden = !showTabbar;

  const scrollKey = routeScrollKey(effectiveKey, params);
  const topChanged = effectiveTop !== previousTop;
  const sameRoute = scrollKey === previousScrollKey;
  previousTop = effectiveTop;
  previousScrollKey = scrollKey;

  if (topChanged) {
    void container.offsetWidth; // restart the CSS animation
    container.classList.add('enter');
    window.scrollTo(0, 0);
  } else if (sameRoute) {
    window.scrollTo(0, scrollY);
  } else {
    window.scrollTo(0, 0);
  }
  pendingScrollY = null;
}

window.addEventListener('hashchange', () => scheduleRender());
store.onChange(() => scheduleRender());

// ---------- boot ----------

// Shown when boot() itself throws — e.g. IndexedDB failed to open (blocked by
// another tab, private-mode quota, a corrupt DB) or store.loadAll() choked on
// bad data. Without this the app was a permanently blank white screen with no
// way out but to already know to hard-reload.
function renderBootError(err) {
  console.error('Boot failed:', err);
  tabbarEl.hidden = true;
  appEl.innerHTML = `
    <h1 class="large-title">Couldn't open your data</h1>
    <p class="subtitle">${esc(err && err.message)}</p>
    <p class="section-footer">If the app is open in another tab or window, close it, then reload.</p>
    <button type="button" class="btn btn-primary" data-role="boot-reload">Reload</button>
  `;
  appEl.querySelector('[data-role="boot-reload"]').addEventListener('click', () => location.reload());
}

async function boot() {
  try {
    await store.loadAll();
    try {
      await navigator.storage?.persist?.();
    } catch (_) {
      // not available/denied — non-fatal
    }
    // No explicit `#/today` write here: matchRoute() already treats a blank
    // hash as `today`, and writing it would fire a redundant hashchange.
    await render();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  } catch (err) {
    renderBootError(err);
  }
}

boot();
