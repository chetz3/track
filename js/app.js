import * as db from './db.js';
import {
  BODY_STEP_ID,
  addDays,
  isEditable,
  dayStatus,
  weekStatus,
  evaluateAttempt,
} from './rules.js';
import { savePhoto, getPhotoUrl, deletePhoto } from './photos.js';
import { exportBackup, importBackup } from './backup.js';

const appEl = document.getElementById('app');
const navEl = document.getElementById('bottom-nav');

const state = {
  config: null,
  attempts: [],
  days: {},
  activeAttempt: null,
  lastEvaluation: null,
};

let objectUrls = [];
const lastKnownStatus = {}; // date -> status, used to only "pop" the pill on change

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_ABBR[dt.getDay()]}, ${d} ${MONTH_ABBR[m - 1]} ${y}`;
}

function formatMonthLong(y, m) {
  return `${MONTH_FULL[m - 1]} ${y}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function revokeObjectUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

async function hydratePhotos(container) {
  const imgs = container.querySelectorAll('img[data-photo-id]');
  for (const img of imgs) {
    const id = img.dataset.photoId;
    if (!id) continue;
    const url = await getPhotoUrl(id);
    if (url) {
      objectUrls.push(url);
      img.src = url;
    }
  }
}

// ---------- data loading / attempt evaluation ----------

function pickDisplayAttempt(attempts) {
  const active = attempts.find((a) => a.status === 'active');
  if (active) return active;
  const completed = attempts.filter((a) => a.status === 'complete');
  return completed.reduce((latest, a) => (!latest || a.startDate > latest.startDate ? a : latest), null);
}

async function loadState() {
  state.config = await db.getConfig();
  if (!state.config) return;
  state.attempts = await db.getAll('attempts');
  const days = await db.getAll('days');
  state.days = {};
  for (const d of days) state.days[d.date] = d;
  state.activeAttempt = pickDisplayAttempt(state.attempts);
  await reevaluate();
}

async function reevaluate() {
  if (!state.config || !state.activeAttempt) {
    state.lastEvaluation = null;
    return;
  }
  let attempt = state.activeAttempt;
  if (attempt.status !== 'active') {
    // Finalised (complete/reset) attempts are frozen — just compute a
    // display evaluation, never mutate them.
    state.lastEvaluation = evaluateAttempt(state.config, attempt, state.days, todayStr());
    return;
  }
  let guard = 0;
  while (guard++ < 1000) {
    const result = evaluateAttempt(state.config, attempt, state.days, todayStr());
    state.lastEvaluation = result;

    const greenWeeksCount = result.weeks.filter((w) => w.status === 'green').length;
    if (greenWeeksCount > (attempt.greenWeeks || 0)) {
      attempt.greenWeeks = greenWeeksCount;
      await db.put('attempts', attempt);
    }

    if (result.outcome === 'reset') {
      const failedWeek = result.weeks[result.weeks.length - 1];
      attempt.status = 'reset';
      attempt.endDate = failedWeek.endDate;
      await db.put('attempts', attempt);
      const newAttempt = { id: makeId('attempt'), startDate: result.resetDate, status: 'active', greenWeeks: 0 };
      await db.put('attempts', newAttempt);
      state.attempts.push(newAttempt);
      attempt = newAttempt;
      continue;
    }
    if (result.outcome === 'complete' && attempt.status !== 'complete') {
      attempt.status = 'complete';
      attempt.endDate = addDays(attempt.startDate, state.config.totalDays - 1);
      await db.put('attempts', attempt);
    }
    break;
  }
  state.activeAttempt = attempt;
}

function ensureSnapshot(day) {
  if (!day.mandatoryStepIds) {
    day.mandatoryStepIds = [BODY_STEP_ID, ...state.config.steps.filter((s) => s.mandatory).map((s) => s.id)];
  }
  return day;
}

function getOrInitDay(date) {
  return state.days[date] || { date, mandatoryStepIds: null, weight: undefined, bodyPhotoId: undefined, steps: {} };
}

async function saveDay(day) {
  ensureSnapshot(day);
  await db.put('days', day);
  state.days[day.date] = day;
  await reevaluate();
}

// True when date falls before the active attempt's start, or after its
// last day — i.e. it isn't part of the current challenge attempt at all,
// so it should never be shown as green/red/pending.
function isDateOutsideAttempt(date) {
  const attempt = state.activeAttempt;
  if (!attempt || !state.config) return true;
  const lastDay = addDays(attempt.startDate, state.config.totalDays - 1);
  return date < attempt.startDate || date > lastDay;
}

// ---------- router ----------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('/').filter(Boolean);
}

function setActiveNav(route) {
  const links = [...navEl.querySelectorAll('a')];
  let activeIndex = 0;
  links.forEach((a, i) => {
    const isActive = a.dataset.route === route;
    a.classList.toggle('active', isActive);
    if (isActive) activeIndex = i;
  });
  navEl.style.setProperty('--nav-index', activeIndex);
  navEl.style.setProperty('--nav-count', links.length);
}

let previousRoute = null;

async function render() {
  revokeObjectUrls();
  const scrollY = window.scrollY;

  let route;
  if (!state.config) {
    navEl.style.display = 'none';
    route = 'setup';
    appEl.innerHTML = renderSetupScreen();
    attachSetupHandlers();
  } else {
    navEl.style.display = 'flex';
    const parts = parseHash();
    route = parts[0] || 'today';
    setActiveNav(route === 'day' ? 'calendar' : route);

    switch (route) {
      case 'today':
        appEl.innerHTML = renderDayScreen(todayStr(), true);
        attachDayHandlers(todayStr());
        await hydratePhotos(appEl);
        break;
      case 'day': {
        const date = parts[1] || todayStr();
        appEl.innerHTML = renderDayScreen(date, false);
        attachDayHandlers(date);
        await hydratePhotos(appEl);
        break;
      }
      case 'calendar':
        appEl.innerHTML = renderCalendarScreen(parts[1]);
        attachCalendarHandlers();
        break;
      case 'overview':
        appEl.innerHTML = renderOverviewScreen();
        attachOverviewHandlers();
        break;
      case 'settings':
        appEl.innerHTML = renderSettingsScreen();
        attachSettingsHandlers();
        break;
      default:
        location.hash = '#/today';
        return;
    }
  }

  const routeChanged = route !== previousRoute;
  previousRoute = route;
  appEl.classList.remove('screen-enter');
  if (routeChanged) {
    void appEl.offsetWidth; // restart the CSS animation
    appEl.classList.add('screen-enter');
    window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, scrollY);
  }
}

window.addEventListener('hashchange', render);

// ---------- Setup screen ----------

function renderSetupScreen() {
  return `
    <div class="screen-header">
      <h1>Set up your challenge</h1>
      <p class="screen-subtitle">This stays on your device. You can change most of this later in Settings.</p>
    </div>
    <form id="setup-form" class="stack">
      <div class="card">
        <div class="field">
          <label for="s-name">Challenge name</label>
          <input type="text" id="s-name" placeholder="e.g. 100 Day Reset" required />
        </div>
        <div class="field">
          <label for="s-days">Number of days</label>
          <input type="number" id="s-days" min="1" value="100" required />
        </div>
        <div class="field">
          <label for="s-start">Start date</label>
          <input type="date" id="s-start" value="${todayStr()}" min="${addDays(todayStr(), -1)}" required />
          <p class="hint">Earliest allowed is yesterday, so no days are already locked when you start.</p>
        </div>
        <div class="field">
          <label for="s-target">Green days needed per week (1-7)</label>
          <input type="number" id="s-target" min="1" max="7" value="5" required />
        </div>
      </div>
      <div class="card">
        <h3>Body check-in <span class="mandatory-mark">*</span></h3>
        <p>Always required every day: a photo and your weight.</p>
      </div>
      <div class="card">
        <div class="row space-between">
          <h3>Your daily steps</h3>
          <button type="button" class="secondary" id="add-step-btn">+ Add step</button>
        </div>
        <div id="steps-editor" class="stack"></div>
      </div>
      <button type="submit">Start challenge</button>
    </form>
  `;
}

function stepEditorRow(step) {
  return `
    <div class="step-editor-row" data-step-id="${step.id}">
      <div class="field">
        <label>Step name</label>
        <input type="text" class="step-name" value="${esc(step.name)}" placeholder="e.g. Read 10 pages" />
      </div>
      <label class="toggle-row"><span>Mandatory (required for a green day)</span><input type="checkbox" class="step-mandatory toggle-input" ${step.mandatory ? 'checked' : ''}/></label>
      <label class="toggle-row"><span>Requires a photo</span><input type="checkbox" class="step-photo toggle-input" ${step.requiresPhoto ? 'checked' : ''}/></label>
      <label class="toggle-row"><span>Allow a note</span><input type="checkbox" class="step-note toggle-input" ${step.allowsNote ? 'checked' : ''}/></label>
      <button type="button" class="link remove-step-btn">Remove step</button>
    </div>
  `;
}

let setupSteps = [];

function attachSetupHandlers() {
  setupSteps = [];
  const editor = document.getElementById('steps-editor');
  const renderStepsEditor = () => {
    editor.innerHTML = setupSteps.map(stepEditorRow).join('');
    editor.querySelectorAll('.remove-step-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        setupSteps.splice(idx, 1);
        renderStepsEditor();
      });
    });
  };
  document.getElementById('add-step-btn').addEventListener('click', () => {
    setupSteps.push({ id: makeId('step'), name: '', mandatory: true, requiresPhoto: false, allowsNote: false });
    renderStepsEditor();
  });
  renderStepsEditor();

  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = [...editor.querySelectorAll('.step-editor-row')];
    const steps = rows.map((row) => ({
      id: row.dataset.stepId,
      name: row.querySelector('.step-name').value.trim() || 'Step',
      mandatory: row.querySelector('.step-mandatory').checked,
      requiresPhoto: row.querySelector('.step-photo').checked,
      allowsNote: row.querySelector('.step-note').checked,
    }));
    const config = {
      name: document.getElementById('s-name').value.trim() || 'My Challenge',
      totalDays: Math.max(1, parseInt(document.getElementById('s-days').value, 10) || 100),
      weeklyTarget: Math.min(7, Math.max(1, parseInt(document.getElementById('s-target').value, 10) || 5)),
      steps,
    };
    const minStart = addDays(todayStr(), -1);
    let startDate = document.getElementById('s-start').value || todayStr();
    if (startDate < minStart) startDate = minStart;
    await db.setConfig(config);
    const attempt = { id: makeId('attempt'), startDate, status: 'active', greenWeeks: 0 };
    await db.put('attempts', attempt);
    await loadState();
    try { await navigator.storage.persist(); } catch (_) { /* ignore */ }
    location.hash = '#/today';
    await render();
  });
}

// ---------- Day / Today screen ----------

function stepFieldHtml(step, entry, editable) {
  const done = !!(entry && entry.done);
  const photoId = entry && entry.photoId;
  const note = (entry && entry.note) || '';
  let html = `<div class="step-item" data-step-id="${step.id}">`;
  html += `<div class="step-title">`;
  html += `<input type="checkbox" class="step-done" data-step-id="${step.id}" ${done ? 'checked' : ''} ${editable ? '' : 'disabled'} />`;
  html += `<span>${esc(step.name)}${step.mandatory ? ' <span class="mandatory-mark">*</span>' : ''}</span>`;
  html += `</div>`;

  const bodyParts = [];
  if (step.requiresPhoto) {
    let photoHtml = `<div class="photo-row">`;
    photoHtml += photoId
      ? `<img class="photo-thumb" data-photo-id="${photoId}" alt="${esc(step.name)} photo" />`
      : `<div class="photo-placeholder"></div>`;
    if (editable) {
      photoHtml += `<label class="file-btn secondary">${photoId ? 'Replace photo' : 'Take photo'}<input type="file" accept="image/*" capture="environment" class="step-photo-input visually-hidden-file" data-step-id="${step.id}" /></label>`;
    } else if (!photoId) {
      photoHtml += `<p class="readonly-note">No photo</p>`;
    }
    photoHtml += `</div>`;
    bodyParts.push(photoHtml);
  }
  if (step.allowsNote) {
    if (editable) {
      bodyParts.push(`<textarea class="step-note-input" data-step-id="${step.id}" placeholder="Note (optional)">${esc(note)}</textarea>`);
    } else if (note) {
      bodyParts.push(`<p class="readonly-note">${esc(note)}</p>`);
    }
  }
  if (bodyParts.length) html += `<div class="step-body">${bodyParts.join('')}</div>`;
  html += `</div>`;
  return html;
}

function weekLineText(date) {
  if (!state.lastEvaluation) return '';
  const eval_ = state.lastEvaluation;
  const week = eval_.weeks.find((w) => date >= w.startDate && date <= w.endDate) || eval_.weeks[eval_.weeks.length - 1];
  if (!week) return '';
  const greenCount = week.dayStatuses.filter((s) => s === 'green').length;
  const weekIndex = eval_.weeks.indexOf(week) + 1;
  return `Week ${weekIndex} &middot; ${greenCount}/${state.config.weeklyTarget} green days`;
}

function heroCardHtml(date, config, status, statusChanged, dayNumber) {
  const pct = Math.max(0, Math.min(100, Math.round((dayNumber / config.totalDays) * 100)));
  let html = `<div class="card hero-card">`;
  html += `<div class="row baseline"><span class="day-number">${dayNumber}</span><span class="day-total">/ ${config.totalDays}</span></div>`;
  html += `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  html += `<div class="row space-between">`;
  html += `<span class="week-line">${weekLineText(date)}</span>`;
  html += `<span class="status-pill ${status}${statusChanged ? ' pop' : ''}">${status.toUpperCase()}</span>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

function bodyCheckInCardHtml(day, editable) {
  let html = `<div class="card">`;
  html += `<h3><span class="mandatory-mark">*</span> Body check-in</h3>`;
  html += `<div class="field"><label>Weight (kg)</label>`;
  html += `<input type="number" step="0.1" id="weight-input" value="${day.weight ?? ''}" ${editable ? '' : 'disabled'} /></div>`;
  html += `<div class="photo-row">`;
  html += day.bodyPhotoId
    ? `<img class="photo-thumb" data-photo-id="${day.bodyPhotoId}" alt="Body check-in photo" />`
    : `<div class="photo-placeholder"></div>`;
  if (editable) {
    html += `<label class="file-btn secondary">${day.bodyPhotoId ? 'Replace photo' : 'Take photo'}<input type="file" accept="image/*" capture="environment" id="body-photo-input" class="visually-hidden-file" /></label>`;
  } else if (!day.bodyPhotoId) {
    html += `<p class="readonly-note">No photo</p>`;
  }
  html += `</div></div>`;
  return html;
}

function renderCheckInSection(day, config, editable) {
  let html = bodyCheckInCardHtml(day, editable);
  html += `<div class="card"><h3>Steps</h3>`;
  for (const step of config.steps) {
    html += stepFieldHtml(step, day.steps[step.id], editable);
  }
  if (config.steps.length === 0) html += `<p>No custom steps yet. Add some in Settings.</p>`;
  html += `</div>`;
  return html;
}

function renderDayScreen(date, isTodayRoute) {
  const config = state.config;
  const attempt = state.activeAttempt;
  const today = todayStr();

  if (!attempt) {
    return `<div class="screen-header"><h1>${esc(config.name)}</h1></div><div class="banner info">No active attempt yet. Check Settings.</div>`;
  }

  if (isTodayRoute && today < attempt.startDate) {
    return `<div class="screen-header"><h1>${esc(config.name)}</h1></div><div class="banner info">Your challenge starts on ${attempt.startDate}. Come back then!</div>`;
  }

  if (isTodayRoute && attempt.status === 'complete') {
    return `
      <div class="screen-header"><h1>${esc(config.name)}</h1></div>
      <div class="banner success">Challenge complete! You finished all ${config.totalDays} days.</div>
      <a href="#/overview">View your overview &rarr;</a>
    `;
  }

  const day = getOrInitDay(date);
  const outsideAttempt = isDateOutsideAttempt(date);
  const status = dayStatus(date, day, config, today);
  const editable = !outsideAttempt && isEditable(date, today) && date <= today;
  const dayNumber = state.lastEvaluation ? state.lastEvaluation.currentDayNumber : null;
  const isFuture = date > today;

  const statusChanged = !outsideAttempt && lastKnownStatus[date] !== undefined && lastKnownStatus[date] !== status;
  lastKnownStatus[date] = status;

  if (isTodayRoute) {
    let html = `<div class="screen-header"><h1>${esc(config.name)}</h1></div>`;
    html += heroCardHtml(date, config, status, statusChanged, dayNumber);
    html += renderCheckInSection(day, config, editable);
    return html;
  }

  let html = `<div class="back-row"><button type="button" class="secondary" id="back-btn">&lsaquo; Back</button></div>`;
  html += `<div class="screen-header"><h1>${formatDateLong(date)}</h1></div>`;
  html += `<div class="card">`;
  html += `<div class="row space-between">`;
  html += outsideAttempt
    ? `<span class="status-pill outside">Not in challenge</span>`
    : `<span class="status-pill ${status}${statusChanged ? ' pop' : ''}">${status.toUpperCase()}</span>`;
  if (!outsideAttempt && !editable && !isFuture) html += `<span class="readonly-note">Locked</span>`;
  html += `</div>`;
  if (outsideAttempt) {
    html += `<p class="muted-line">This date is outside your current challenge attempt.</p>`;
  } else if (isFuture) {
    html += `<p class="muted-line">This day hasn't arrived yet.</p>`;
  }
  html += `</div>`;

  if (!outsideAttempt && !isFuture) {
    html += renderCheckInSection(day, config, editable);
  }

  return html;
}

async function handleBodyPhotoChange(date, file) {
  if (!file) return;
  const day = getOrInitDay(date);
  const oldId = day.bodyPhotoId;
  const id = await savePhoto(file);
  day.bodyPhotoId = id;
  await saveDay(day);
  if (oldId) await deletePhoto(oldId);
  await render();
}

async function handleStepPhotoChange(date, stepId, file) {
  if (!file) return;
  const day = getOrInitDay(date);
  day.steps = day.steps || {};
  const oldId = day.steps[stepId] && day.steps[stepId].photoId;
  const id = await savePhoto(file);
  day.steps[stepId] = { ...(day.steps[stepId] || {}), photoId: id, done: true };
  await saveDay(day);
  if (oldId) await deletePhoto(oldId);
  await render();
}

function attachDayHandlers(date) {
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (history.length > 1) history.back();
      else location.hash = '#/calendar';
    });
  }

  const weightInput = document.getElementById('weight-input');
  if (weightInput) {
    weightInput.addEventListener('change', async () => {
      const day = getOrInitDay(date);
      const v = weightInput.value;
      day.weight = v === '' ? undefined : Number(v);
      await saveDay(day);
      await render();
    });
  }

  const bodyPhotoInput = document.getElementById('body-photo-input');
  if (bodyPhotoInput) {
    bodyPhotoInput.addEventListener('change', () => handleBodyPhotoChange(date, bodyPhotoInput.files[0]));
  }

  appEl.querySelectorAll('.step-done').forEach((el) => {
    el.addEventListener('change', async () => {
      const stepId = el.dataset.stepId;
      const day = getOrInitDay(date);
      day.steps = day.steps || {};
      day.steps[stepId] = { ...(day.steps[stepId] || {}), done: el.checked };
      await saveDay(day);
      await render();
    });
  });

  appEl.querySelectorAll('.step-photo-input').forEach((el) => {
    el.addEventListener('change', () => handleStepPhotoChange(date, el.dataset.stepId, el.files[0]));
  });

  appEl.querySelectorAll('.step-note-input').forEach((el) => {
    el.addEventListener('change', async () => {
      const stepId = el.dataset.stepId;
      const day = getOrInitDay(date);
      day.steps = day.steps || {};
      day.steps[stepId] = { ...(day.steps[stepId] || {}), note: el.value };
      await saveDay(day);
    });
  });
}

// ---------- Calendar screen ----------

let calendarViewMonth = null; // 'YYYY-MM'

function monthMeta(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const firstOfMonth = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  return { y, m, daysInMonth, startWeekday };
}

function renderCalendarScreen(monthParam) {
  const today = todayStr();
  if (monthParam) calendarViewMonth = monthParam;
  if (!calendarViewMonth) calendarViewMonth = today.slice(0, 7);
  const { y, m, daysInMonth, startWeekday } = monthMeta(calendarViewMonth);
  const config = state.config;

  let html = `<div class="screen-header"><h1>Calendar</h1></div>`;
  html += `<div class="card">`;
  html += `<div class="cal-header">
    <button type="button" class="secondary round-icon-btn" id="prev-month" aria-label="Previous month">&lsaquo;</button>
    <div class="cal-month-title">${formatMonthLong(y, m)}</div>
    <button type="button" class="secondary round-icon-btn" id="next-month" aria-label="Next month">&rsaquo;</button>
  </div>`;
  html += `<div class="cal-weekdays">`;
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((w) => (html += `<div class="weekday-label">${w}</div>`));
  html += `</div>`;
  html += `<div class="calendar-grid">`;
  for (let i = 0; i < startWeekday; i++) html += `<div class="calendar-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const day = state.days[date];
    const status = isDateOutsideAttempt(date) ? 'outside' : dayStatus(date, day, config, today);
    const isToday = date === today ? 'today' : '';
    html += `<button type="button" class="calendar-cell ${status} ${isToday}" data-date="${date}">${d}</button>`;
  }
  html += `</div>`;
  html += `</div>`;
  html += `<button type="button" class="secondary full-width" id="view-overview-btn">View full challenge</button>`;
  return html;
}

function attachCalendarHandlers() {
  document.getElementById('prev-month').addEventListener('click', () => {
    const { y, m } = monthMeta(calendarViewMonth);
    const prev = new Date(y, m - 2, 1);
    location.hash = `#/calendar/${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  });
  document.getElementById('next-month').addEventListener('click', () => {
    const { y, m } = monthMeta(calendarViewMonth);
    const next = new Date(y, m, 1);
    location.hash = `#/calendar/${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  });
  appEl.querySelectorAll('.calendar-cell[data-date]').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = `#/day/${el.dataset.date}`;
    });
  });
  document.getElementById('view-overview-btn').addEventListener('click', () => {
    location.hash = '#/overview';
  });
}

// ---------- Overview screen ----------

function buildFullOverview() {
  const config = state.config;
  const attempt = state.activeAttempt;
  const today = todayStr();
  const frozenWeeks = attempt.greenWeeks || 0;
  const weeks = [];
  let dayNumber = 1;
  let weekIndex = 0;
  while (dayNumber <= config.totalDays) {
    const dates = [];
    const statuses = [];
    for (let i = 0; i < 7 && dayNumber <= config.totalDays; i++, dayNumber++) {
      const date = addDays(attempt.startDate, dayNumber - 1);
      dates.push(date);
      statuses.push(dayStatus(date, state.days[date], config, today));
    }
    const status = weekIndex < frozenWeeks ? 'green' : weekStatus(statuses, config.weeklyTarget);
    weeks.push({ dates, statuses, status });
    weekIndex++;
  }
  return weeks;
}

const WEEK_BADGE_TEXT = { green: 'Pass', red: 'Fail', pending: '–' };

function renderOverviewScreen() {
  const config = state.config;
  const attempt = state.activeAttempt;
  if (!attempt) {
    return `<div class="screen-header"><h1>Overview</h1></div><p>No active attempt.</p>`;
  }
  const weeks = buildFullOverview();
  let html = `<div class="screen-header"><h1>Challenge overview</h1><p class="screen-subtitle">${esc(config.name)} — started ${attempt.startDate}</p></div>`;
  html += `<div class="card">`;
  html += `<div class="legend-row">
    <span class="legend-item"><span class="legend-dot green"></span>Green</span>
    <span class="legend-item"><span class="legend-dot red"></span>Red</span>
    <span class="legend-item"><span class="legend-dot pending"></span>Pending</span>
    <span class="legend-item"><span class="legend-dot upcoming"></span>Upcoming</span>
  </div>`;
  html += `<div class="overview-weeks">`;
  weeks.forEach((week, idx) => {
    html += `<div class="overview-week">`;
    html += `<div class="week-label">W${idx + 1}</div>`;
    week.dates.forEach((date) => {
      const status = dayStatus(date, state.days[date], config, todayStr());
      html += `<button type="button" class="overview-day ${status}" data-date="${date}" title="${date}"></button>`;
    });
    for (let pad = week.dates.length; pad < 7; pad++) html += `<div class="overview-day empty"></div>`;
    html += `<div class="week-badge ${week.status}">${WEEK_BADGE_TEXT[week.status] || week.status}</div>`;
    html += `</div>`;
  });
  html += `</div>`;
  html += `</div>`;
  return html;
}

function attachOverviewHandlers() {
  appEl.querySelectorAll('.overview-day[data-date]').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = `#/day/${el.dataset.date}`;
    });
  });
}

// ---------- Settings screen ----------

function attemptRowHtml(attempt) {
  const label = { active: 'Active', reset: 'Reset (failed week)', complete: 'Complete' }[attempt.status] || attempt.status;
  return `<div class="attempt-row"><span>${attempt.startDate} &rarr; ${attempt.endDate || 'now'}</span><span>${label}</span></div>`;
}

function lastExportInfo() {
  const iso = localStorage.getItem('tracker:lastExportAt');
  if (!iso) return { text: 'Never exported. Export a backup soon.', warn: true };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days >= 7) return { text: `Last export was ${days} days ago. Consider exporting again.`, warn: true };
  return { text: `Last export: ${days === 0 ? 'today' : days + ' day(s) ago'}.`, warn: false };
}

function renderSettingsScreen() {
  const config = state.config;
  const exportInfo = lastExportInfo();
  let html = `<div class="screen-header"><h1>Settings</h1></div>`;

  html += `<div class="card info-card">
    <p>Add this app to your Home Screen for reliable offline storage (Share &rarr; Add to Home Screen on iOS, or the browser menu on Android).</p>
    <p>${exportInfo.text}</p>
  </div>`;

  html += `<div class="card">
    <h3>Backup</h3>
    <div class="two-col">
      <button type="button" id="export-btn">Export backup</button>
      <button type="button" class="secondary" id="import-btn">Import backup</button>
    </div>
    <input type="file" id="import-input" accept=".json,application/json" style="display:none" />
    <p class="hint">Saves everything, including photos, to one JSON file. Import replaces ALL data on this device.</p>
  </div>`;

  html += `<div class="card"><h3>Storage</h3><p id="persist-status">Checking...</p></div>`;

  html += `<div class="card"><h3>Attempt history</h3>${state.attempts.slice().reverse().map(attemptRowHtml).join('') || '<p>No attempts yet.</p>'}</div>`;

  html += `<form id="settings-form" class="stack">
  <div class="card">
    <h3>Challenge</h3>
    <div class="field"><label>Name</label><input type="text" id="set-name" value="${esc(config.name)}" /></div>
    <div class="field"><label>Number of days</label><input type="number" id="set-days" min="1" value="${config.totalDays}" /></div>
    <div class="field"><label>Green days needed per week (1-7)</label><input type="number" id="set-target" min="1" max="7" value="${config.weeklyTarget}" /></div>
    <p class="hint">Changing these affects today onward, not already-logged days.</p>
  </div>
  <div class="card">
    <div class="row space-between"><h3>Steps</h3><button type="button" class="secondary" id="add-step-btn-settings">+ Add step</button></div>
    <div id="settings-steps-editor" class="stack"></div>
  </div>
  <button type="submit">Save settings</button>
  </form>`;

  return html;
}

function attachSettingsHandlers() {
  document.getElementById('export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-btn');
    btn.disabled = true;
    try {
      await exportBackup();
      localStorage.setItem('tracker:lastExportAt', new Date().toISOString());
      await render();
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const importInput = document.getElementById('import-input');
  document.getElementById('import-btn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    if (!confirm('This will replace ALL data on this device with the backup file. Continue?')) {
      importInput.value = '';
      return;
    }
    try {
      const text = await file.text();
      await importBackup(text);
      await loadState();
      location.hash = '#/today';
      await render();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  navigator.storage?.persisted?.().then((persisted) => {
    const el = document.getElementById('persist-status');
    if (el) el.textContent = persisted ? 'Persistent storage is enabled.' : 'Persistent storage not yet granted.';
  });

  let editorSteps = state.config.steps.map((s) => ({ ...s }));
  const editor = document.getElementById('settings-steps-editor');
  const renderStepsEditor = () => {
    editor.innerHTML = editorSteps.map(stepEditorRow).join('');
    editor.querySelectorAll('.remove-step-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        editorSteps.splice(idx, 1);
        renderStepsEditor();
      });
    });
  };
  document.getElementById('add-step-btn-settings').addEventListener('click', () => {
    editorSteps.push({ id: makeId('step'), name: '', mandatory: true, requiresPhoto: false, allowsNote: false });
    renderStepsEditor();
  });
  renderStepsEditor();

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = [...editor.querySelectorAll('.step-editor-row')];
    const steps = rows.map((row) => ({
      id: row.dataset.stepId,
      name: row.querySelector('.step-name').value.trim() || 'Step',
      mandatory: row.querySelector('.step-mandatory').checked,
      requiresPhoto: row.querySelector('.step-photo').checked,
      allowsNote: row.querySelector('.step-note').checked,
    }));
    const config = {
      ...state.config,
      name: document.getElementById('set-name').value.trim() || state.config.name,
      totalDays: Math.max(1, parseInt(document.getElementById('set-days').value, 10) || state.config.totalDays),
      weeklyTarget: Math.min(7, Math.max(1, parseInt(document.getElementById('set-target').value, 10) || state.config.weeklyTarget)),
      steps,
    };
    await db.setConfig(config);

    // Today's snapshot (if it already exists) is re-taken from the new
    // config so a step added/removed today is reflected immediately.
    // Yesterday and older days are left untouched.
    const today = todayStr();
    const todayDay = state.days[today];
    if (todayDay) {
      todayDay.mandatoryStepIds = [BODY_STEP_ID, ...config.steps.filter((s) => s.mandatory).map((s) => s.id)];
      await db.put('days', todayDay);
    }

    await loadState();
    await render();
    alert('Settings saved.');
  });
}

// ---------- boot ----------

async function boot() {
  await loadState();
  try {
    await navigator.storage.persist();
  } catch (_) {
    // not available/denied — non-fatal
  }
  await render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
