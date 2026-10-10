// Plan tab (#/plan): view, add, edit and delete planned meals for today
// through today + 6 (R0 of docs/superpowers/plans/2026-10-10-plateau-coach.md
// §3A). Data is the existing day.steps[food].planned[] placeholders written
// through store.updatePlanned; the add/edit form and the AI suggest sheet are
// the ones Today already uses (exported from today.js). Pure helpers live in
// js/planLogic.js.

import * as store from '../store.js';
import { addDays } from '../rules.js';
import { esc, formatDateShort, icon } from './dom.js';
import { scheduleOf, placeholderStatus, canSuggest } from '../mealPlan.js';
import { targetFor } from '../fitness.js';
import { sortPlanned, plannedKcal, clearUnlogged, mergeAddToExisting, copyPlaceholders } from '../planLogic.js';
import { openPlanMealSheet, openMealPlanSheet } from './today.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// UI-only state, kept across store-driven re-renders. Reset when the
// challenge changes or the selected day falls out of the 7-day window.
let ui = { challengeId: null, date: null, deleteId: null, confirmClear: false, copyOpen: false, error: '' };

function parts(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { dt: new Date(y, m - 1, d), d };
}

function chipLabel(date, i) {
  if (i === 0) return 'Today';
  if (i === 1) return 'Tmrw';
  return WEEKDAYS[parts(date).dt.getDay()];
}

function dayLabel(date) {
  const { dt, d } = parts(date);
  const month = formatDateShort(date).split(' ')[2];
  return `${WEEKDAYS[dt.getDay()]} ${d} ${month}`;
}

function newId() {
  return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function plannedOf(challengeId, date, stepId) {
  const entry = (store.getDay(challengeId, date).steps || {})[stepId] || {};
  return { planned: Array.isArray(entry.planned) ? entry.planned : [], meals: Array.isArray(entry.meals) ? entry.meals : [] };
}

function itemHtml(p, meals) {
  const { status, label } = placeholderStatus(p, meals);
  const kcal = Number.isFinite(p.kcal) && p.kcal > 0 ? `${p.kcal} kcal` : 'No kcal set';
  const aiTag = p.source === 'ai' ? '<span class="plan-tag">AI</span>' : '';
  const actions = ui.deleteId === p.id
    ? `<span class="plan-confirm">Delete?
        <button type="button" data-role="plan-del-yes" data-id="${esc(p.id)}">Yes</button>
        <button type="button" data-role="plan-del-no">No</button>
      </span>`
    : `<span class="plan-item-actions">
        <button type="button" data-role="plan-edit" data-id="${esc(p.id)}" aria-label="Edit ${esc(p.dish || 'meal')}">Edit</button>
        <button type="button" data-role="plan-del" data-id="${esc(p.id)}" aria-label="Delete ${esc(p.dish || 'meal')}">${icon('x')}</button>
      </span>`;
  return `<div class="row">
    <div class="row-label">
      <div>${esc(p.dish || 'Meal')}${aiTag}</div>
      <div class="item-sub">${esc(p.time || '')} · ${esc(p.slot || '')} · ${esc(kcal)}</div>
    </div>
    <span class="pill ${status === 'logged' ? 'green' : 'future'}">${esc(label)}</span>
    ${actions}
  </div>`;
}

// Items grouped by the schedule's slots (in schedule order); anything whose
// slot isn't in the schedule any more goes in a trailing "Other" group.
function groupsHtml(planned, meals, schedule) {
  const slots = schedule.slots || [];
  const names = slots.map((s) => String(s.name).toLowerCase());
  const used = new Set();
  const out = [];
  const seenSlot = new Set();
  for (const s of slots) {
    const key = String(s.name).toLowerCase();
    if (seenSlot.has(key)) continue; // schedules can repeat a name (two Snacks)
    seenSlot.add(key);
    const items = planned.filter((p) => String(p.slot || '').toLowerCase() === key);
    items.forEach((p) => used.add(p.id));
    if (items.length) out.push({ name: s.name, items });
  }
  const rest = planned.filter((p) => !used.has(p.id) && !names.includes(String(p.slot || '').toLowerCase()));
  if (rest.length) out.push({ name: 'Other', items: rest });
  return out.map((g) => `<div class="group">
    <div class="plan-slot-head">${esc(g.name)}</div>
    ${g.items.map((p) => itemHtml(p, meals)).join('')}
  </div>`).join('<div style="height:12px"></div>');
}

function bodyHtml(challenge, foodStep, days, today) {
  const attempt = store.displayAttempt(challenge.id);
  const lastDate = attempt ? addDays(attempt.startDate, challenge.totalDays - 1) : null;
  const inAttempt = (d) => !!attempt && d >= attempt.startDate && d <= lastDate;

  const chips = days.map((date, i) => {
    const has = plannedOf(challenge.id, date, foodStep.id).planned.length > 0;
    const ok = inAttempt(date);
    return `<button type="button" class="plan-chip${date === ui.date ? ' active' : ''}" data-role="plan-day" data-date="${esc(date)}"${ok ? '' : ' disabled'} aria-label="${esc(dayLabel(date))}${has ? ', has plans' : ''}" aria-pressed="${date === ui.date}">
      ${has ? '<span class="plan-dot"></span>' : ''}<span>${esc(chipLabel(date, i))}</span><span class="plan-chip-num">${parts(date).d}</span>
    </button>`;
  }).join('');

  const { planned: raw, meals } = plannedOf(challenge.id, ui.date, foodStep.id);
  const planned = sortPlanned(raw);
  const schedule = scheduleOf(challenge.profile || {});
  const target = targetFor(store.getDay(challenge.id, ui.date), foodStep);
  const total = plannedKcal(planned);
  const totalLine = `Planned ${total.toLocaleString()}${Number.isFinite(target) ? ` / ${Math.round(target).toLocaleString()}` : ''} kcal`;

  const listHtml = planned.length
    ? `${groupsHtml(planned, meals, schedule)}<p class="section-footer" style="margin-top:8px">${esc(totalLine)}</p>`
    : `<div class="group"><div class="row"><span class="row-label">Nothing planned for ${esc(dayLabel(ui.date))} yet.</span></div></div>`;

  const hasDiet = !!(challenge.profile && challenge.profile.diet);
  const enough = canSuggest(store.state.days[challenge.id] || {}, foodStep.id, today);
  const canAi = hasDiet && enough;
  const hint = !hasDiet ? 'Set Diet in the challenge profile to get AI suggestions.' : !enough ? 'Log 3 meals in a day to get AI suggestions.' : '';

  const others = days.filter((d) => d !== ui.date && inAttempt(d));
  const copyHtml = ui.copyOpen
    ? `<div class="section-footer">Copy ${esc(dayLabel(ui.date))} to:</div>
       <div class="plan-strip">${others.map((d) => `<button type="button" class="plan-chip" data-role="plan-copy-to" data-date="${esc(d)}"><span>${esc(chipLabel(d, days.indexOf(d)))}</span><span class="plan-chip-num">${parts(d).d}</span></button>`).join('')}</div>
       <button type="button" class="btn btn-secondary" data-role="plan-copy-cancel">Cancel</button>`
    : '<button type="button" class="btn btn-secondary" data-role="plan-copy"' + (planned.length && others.length ? '' : ' disabled') + '>Copy to…</button>';

  const unlogged = clearUnlogged(planned, meals).length !== planned.length;
  const clearHtml = ui.confirmClear
    ? `<div class="section-footer">Remove the unlogged meals planned for ${esc(dayLabel(ui.date))}?</div>
       <div class="btn-pair">
         <button type="button" class="btn btn-secondary" data-role="plan-clear-no">No</button>
         <button type="button" class="btn btn-primary" data-role="plan-clear-yes">Yes, clear</button>
       </div>`
    : `<button type="button" class="btn btn-secondary" data-role="plan-clear"${unlogged ? '' : ' disabled'}>Clear day</button>`;

  return `<div class="plan-strip" role="group" aria-label="Day">${chips}</div>
    <h2 class="section-header" style="margin-bottom:8px">${esc(dayLabel(ui.date))}</h2>
    ${listHtml}
    ${ui.error ? `<p class="section-footer error">${esc(ui.error)}</p>` : ''}
    <div class="plan-actions">
      <button type="button" class="btn btn-primary" data-role="plan-add">${icon('plus')}Add meal</button>
      <button type="button" class="btn btn-secondary" data-role="plan-suggest"${canAi ? '' : ' disabled'}>${icon('sparkles')}Suggest with AI</button>
      ${hint ? `<p class="section-footer">${esc(hint)}</p>` : ''}
      ${copyHtml}
      ${clearHtml}
    </div>`;
}

function render(root) {
  const challenge = store.selected();
  if (!challenge) { root.innerHTML = ''; return; }
  const foodStep = (challenge.steps || []).find((s) => s.type === 'food');
  if (challenge.category !== 'fitness' || !foodStep) {
    root.innerHTML = `<h1 class="large-title">Plan</h1>
      <p class="subtitle">${esc(challenge.name)}</p>
      <p class="section-footer" style="margin-top:16px">Planner works with fitness challenges.</p>`;
    return;
  }
  const today = store.today();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  if (ui.challengeId !== challenge.id || !days.includes(ui.date)) {
    ui = { challengeId: challenge.id, date: today, deleteId: null, confirmClear: false, copyOpen: false, error: '' };
  }
  root.innerHTML = `<h1 class="large-title">Plan</h1>
    <p class="subtitle">${esc(challenge.name)}</p>
    <div style="margin-top:16px">${bodyHtml(challenge, foodStep, days, today)}</div>`;
}

export async function renderPlanner(root) {
  render(root);
  wire(root);
}

function ctxNow() {
  const challenge = store.selected();
  const foodStep = challenge && (challenge.steps || []).find((s) => s.type === 'food');
  return challenge && foodStep ? { challenge, foodStep } : null;
}

async function save(challengeId, date, stepId, list, root) {
  ui.error = '';
  try {
    await store.updatePlanned(challengeId, date, stepId, list);
  } catch (err) {
    console.error('Planner save failed:', err);
    ui.error = err.message || "Couldn't save. Please try again.";
    render(root);
  }
}

function wire(root) {
  if (root.__plannerWired) return;
  root.__plannerWired = true;
  const redraw = () => render(root);

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn || !root.contains(btn)) return;
    const role = btn.dataset.role;
    const c = ctxNow();
    if (!c) return;
    const { challenge, foodStep } = c;
    const today = store.today();

    if (role === 'plan-day') {
      ui = { ...ui, date: btn.dataset.date, deleteId: null, confirmClear: false, copyOpen: false, error: '' };
      redraw();
    } else if (role === 'plan-add' || role === 'plan-edit') {
      const { planned } = plannedOf(challenge.id, ui.date, foodStep.id);
      const existing = role === 'plan-edit' ? planned.find((p) => p.id === btn.dataset.id) : null;
      if (role === 'plan-edit' && !existing) return;
      openPlanMealSheet({
        challengeId: challenge.id, date: ui.date, foodStepId: foodStep.id,
        schedule: scheduleOf(challenge.profile || {}), existing, fixedDate: ui.date, source: 'custom',
      });
    } else if (role === 'plan-suggest') {
      openMealPlanSheet({ challengeId: challenge.id, date: today }, {
        generate: true, forDate: ui.date, dateLabel: dayLabel(ui.date), askMode: true, avoidDishes: [],
      });
    } else if (role === 'plan-del') {
      ui.deleteId = btn.dataset.id;
      redraw();
    } else if (role === 'plan-del-no') {
      ui.deleteId = null;
      redraw();
    } else if (role === 'plan-del-yes') {
      const { planned } = plannedOf(challenge.id, ui.date, foodStep.id);
      ui.deleteId = null;
      await save(challenge.id, ui.date, foodStep.id, planned.filter((p) => p.id !== btn.dataset.id), root);
      redraw();
    } else if (role === 'plan-copy') {
      ui.copyOpen = true;
      redraw();
    } else if (role === 'plan-copy-cancel') {
      ui.copyOpen = false;
      redraw();
    } else if (role === 'plan-copy-to') {
      const src = plannedOf(challenge.id, ui.date, foodStep.id).planned;
      const dest = btn.dataset.date;
      const { list } = mergeAddToExisting(plannedOf(challenge.id, dest, foodStep.id).planned, copyPlaceholders(src, newId));
      ui.copyOpen = false;
      await save(challenge.id, dest, foodStep.id, list, root);
      ui = { ...ui, date: dest, deleteId: null };
      redraw();
    } else if (role === 'plan-clear') {
      ui.confirmClear = true;
      redraw();
    } else if (role === 'plan-clear-no') {
      ui.confirmClear = false;
      redraw();
    } else if (role === 'plan-clear-yes') {
      const { planned, meals } = plannedOf(challenge.id, ui.date, foodStep.id);
      ui.confirmClear = false;
      await save(challenge.id, ui.date, foodStep.id, clearUnlogged(planned, meals), root);
      redraw();
    }
  });
}
