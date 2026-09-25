// Router + tab bar + boot. Screens are plain modules exported as
// `render(root, params)` and wired into the ROUTES table below; Tasks 6-9
// replace the placeholder entries one at a time without touching this file.

import * as store from './store.js';
import { esc } from './ui/dom.js';

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
  today: placeholder('Today'),
  day: placeholder('Day'),
  calendar: placeholder('Calendar'),
  overview: placeholder('Overview'),
  stats: placeholder('Stats'),
  challenges: placeholder('Challenges'),
  'challenges/new': placeholder('New Challenge'),
  'challenges/:id': placeholder('Challenge'),
  'summary/:date': placeholder('Summary'),
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
    // Stub: real import lives in the Challenges module (Task 7).
    location.hash = '#/challenges';
  });
}

// ---------- render loop ----------

let previousTop = null;
let previousKey = null;
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

async function render() {
  const scrollY = window.scrollY;
  const hasChallenges = store.state.challenges.length > 0;
  const { top, key, params } = matchRoute();

  appEl.classList.remove('enter');
  appEl.innerHTML = '';

  let effectiveTop = top;
  let effectiveKey = key;
  let showTabbar = hasChallenges;

  if (!hasChallenges && key !== 'challenges/new') {
    effectiveTop = 'empty';
    effectiveKey = 'empty';
    renderEmptyState(appEl);
    showTabbar = false;
  } else {
    if (key === 'challenges/new' && !hasChallenges) showTabbar = false;
    const renderFn = ROUTES[key] || ROUTES.today;
    await renderFn(appEl, params);
  }

  setActiveTab(effectiveTop === 'empty' ? 'today' : top);
  tabbarEl.style.display = showTabbar ? '' : 'none';

  const topChanged = effectiveTop !== previousTop;
  const sameRoute = effectiveKey === previousKey;
  previousTop = effectiveTop;
  previousKey = effectiveKey;

  if (topChanged) {
    void appEl.offsetWidth; // restart the CSS animation
    appEl.classList.add('enter');
    window.scrollTo(0, 0);
  } else if (sameRoute) {
    window.scrollTo(0, scrollY);
  } else {
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', () => scheduleRender());
store.onChange(() => scheduleRender());

// ---------- boot ----------

async function boot() {
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
}

boot();
