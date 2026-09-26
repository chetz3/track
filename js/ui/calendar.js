// Calendar (#/calendar[/:month]) and Overview (#/overview) screens.
//
// Render contract (see app.js): renderCalendar/renderOverview receive a
// container already attached inside #app. They may only write inside it.

import * as store from '../store.js';
import { dayStatus, addDays } from '../rules.js';
import { esc, formatMonthLong, formatDateShort } from './dom.js';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------- month helpers ----------

function currentMonth() {
  return store.today().slice(0, 7); // 'YYYY-MM'
}

function validMonth(yyyyMm) {
  return MONTH_RE.test(yyyyMm || '') ? yyyyMm : currentMonth();
}

function shiftMonth(yyyyMm, delta) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- calendar (#/calendar[/:month]) ----------

// A day's route (Task 8A adds a green-day branch to the summary viewer).
function dayHref(status, date) {
  return `#/day/${date}`;
}

function calendarCellHtml(date, status, isToday) {
  const classes = ['cal-cell', status];
  if (isToday) classes.push('today');
  const dayNum = Number(date.slice(-2));
  return `<button type="button" class="${classes.join(' ')}" data-role="cal-day" data-date="${esc(date)}" data-status="${esc(status)}" aria-label="${esc(formatDateShort(date))}">${dayNum}</button>`;
}

function wireCalendarDelegation(root) {
  if (root.__calendarWired) return;
  root.__calendarWired = true;

  root.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-role="cal-prev"], [data-role="cal-next"]');
    if (navBtn) {
      location.hash = `#/calendar/${navBtn.dataset.month}`;
      return;
    }
    const dayBtn = e.target.closest('[data-role="cal-day"]');
    if (dayBtn) {
      location.hash = dayHref(dayBtn.dataset.status, dayBtn.dataset.date);
      return;
    }
    if (e.target.closest('[data-role="view-challenge"]')) {
      location.hash = `#/challenges/${root.__calendarChallengeId}`;
    }
  });
}

export async function renderCalendar(root, yyyyMm) {
  const challenge = store.selected();
  if (!challenge) {
    root.innerHTML = '';
    return;
  }

  const month = validMonth(yyyyMm);
  const [year, mon] = month.split('-').map(Number);
  const todayStr = store.today();
  const attempt = store.displayAttempt(challenge.id);
  const lastDate = attempt ? addDays(attempt.startDate, challenge.totalDays - 1) : null;

  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstDow = new Date(year, mon - 1, 1).getDay();

  const cellsHtml = [];
  for (let i = 0; i < firstDow; i++) cellsHtml.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const outside = !attempt || date < attempt.startDate || date > lastDate;
    const status = outside ? 'outside' : dayStatus(date, store.getDay(challenge.id, date), challenge, todayStr);
    cellsHtml.push(calendarCellHtml(date, status, date === todayStr));
  }

  root.__calendarChallengeId = challenge.id;
  root.innerHTML = `
    <h1 class="large-title">Calendar</h1>
    <p class="subtitle">${esc(challenge.name)}</p>
    <div class="group cal-group">
      <div class="cal-header">
        <button type="button" class="btn btn-secondary cal-nav" data-role="cal-prev" data-month="${esc(shiftMonth(month, -1))}" aria-label="Previous month">&lsaquo;</button>
        <span class="cal-month-label">${esc(formatMonthLong(year, mon))}</span>
        <button type="button" class="btn btn-secondary cal-nav" data-role="cal-next" data-month="${esc(shiftMonth(month, 1))}" aria-label="Next month">&rsaquo;</button>
      </div>
      <div class="cal-weekdays">${WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cellsHtml.join('')}</div>
    </div>
    <button type="button" class="btn btn-secondary" data-role="view-challenge">View full challenge</button>
  `;

  wireCalendarDelegation(root);
}

// ---------- overview (#/overview) ----------

function badgeFor(status) {
  if (status === 'green') return ['green', 'Pass'];
  if (status === 'red') return ['red', 'Fail'];
  return ['pending', '–'];
}

function legendHtml() {
  return `<div class="ov-legend">
    <span class="ov-legend-item"><span class="ov-dot green"></span>Green</span>
    <span class="ov-legend-item"><span class="ov-dot red"></span>Red</span>
    <span class="ov-legend-item"><span class="ov-dot pending"></span>Pending</span>
    <span class="ov-legend-item"><span class="ov-dot future"></span>Future</span>
  </div>`;
}

function wireOverviewDelegation(root) {
  if (root.__overviewWired) return;
  root.__overviewWired = true;

  root.addEventListener('click', (e) => {
    const dayBtn = e.target.closest('[data-role="ov-day"]');
    if (dayBtn) {
      location.hash = dayHref(dayBtn.dataset.status, dayBtn.dataset.date);
    }
  });
}

export async function renderOverview(root) {
  const challenge = store.selected();
  if (!challenge) {
    root.innerHTML = '';
    return;
  }

  const evaluation = store.state.evaluations[challenge.id];

  if (!evaluation || !evaluation.weeks.length) {
    root.innerHTML = `
      <h1 class="large-title">Overview</h1>
      <p class="subtitle">${esc(challenge.name)}</p>
      ${legendHtml()}
      <p class="section-footer">No active attempt yet.</p>
    `;
    return;
  }

  const weeksHtml = evaluation.weeks.map((week, i) => {
    const [cls, label] = badgeFor(week.status);
    const daysHtml = week.dayStatuses.map((status, di) => {
      const date = addDays(week.startDate, di);
      return `<button type="button" class="ov-day ${status}" data-role="ov-day" data-date="${esc(date)}" data-status="${esc(status)}" aria-label="${esc(formatDateShort(date))}"></button>`;
    }).join('');
    return `<div class="ov-week">
      <span class="ov-week-label">W${i + 1}</span>
      ${daysHtml}
      <span class="pill ov-badge ${cls}">${label}</span>
    </div>`;
  }).join('');

  root.innerHTML = `
    <h1 class="large-title">Overview</h1>
    <p class="subtitle">${esc(challenge.name)}</p>
    ${legendHtml()}
    <div class="group ov-group">${weeksHtml}</div>
  `;

  wireOverviewDelegation(root);
}
