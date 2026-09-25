// Challenges list (#/challenges), challenge create/edit form
// (#/challenges/new, #/challenges/:id) and the backup export/import flow.
//
// Render contract (see app.js): renderChallenges/renderChallengeForm receive
// a container already attached inside #app. They may only write inside it.
//
// Unsaved form state (name/days/weeklyTarget/startDate/steps) lives in this
// module's closure, keyed by route ('new' or the challenge id), so it
// survives the store-driven re-renders the router does on every
// store.onChange. It's reset whenever the route key actually changes
// (navigating to a different form) and cleared after a successful
// save/delete.

import * as store from '../store.js';
import { validateChallengeInput } from '../storeLogic.js';
import { addDays } from '../rules.js';
import { exportBackup, importBackup } from '../backup.js';
import { esc, formatDateShort } from './dom.js';
import { miniRing } from './today.js';
import { openStepEditor } from './stepEditor.js';
import { closeSheet } from './sheet.js';

const LAST_EXPORT_KEY = 'tracker:lastExportAt';

// ---------- backup helpers ----------

// Ported from the v1 app (git show edbfae9:js/app.js, lines 718-727): same
// localStorage key, wording and 7-day threshold.
function lastExportInfo() {
  let iso = null;
  try {
    iso = localStorage.getItem(LAST_EXPORT_KEY);
  } catch (_) {
    iso = null;
  }
  if (!iso) return { text: 'Never exported. Export a backup soon.', warn: true };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days >= 7) return { text: `Last export was ${days} days ago. Consider exporting again.`, warn: true };
  return { text: `Last export: ${days === 0 ? 'today' : days + ' day(s) ago'}.`, warn: false };
}

function markExported() {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString());
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

// Hidden file input + confirm() + importBackup, shared by the Challenges
// screen's Import button and app.js's empty-state "Import backup" stub.
// Self-contained: doesn't depend on any particular screen being mounted.
//
// One input is created lazily and reused for every call — a cancelled file
// picker never fires a usable event on some browsers, so an input created
// fresh per tap and only removed from its own 'change' handler would leak
// an abandoned hidden <input> into the document on every cancel.
let importInputEl = null;

function getImportInput() {
  if (importInputEl) return importInputEl;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.hidden = true;
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!confirm('This replaces ALL data on this device with the backup. Continue?')) return;
    try {
      const text = await file.text();
      await importBackup(text);
      await store.loadAll();
      // A stale pre-import form draft (e.g. left over from editing a
      // challenge that no longer exists post-import) must never reappear
      // over the freshly-imported data. The hashchange below also clears it,
      // but clear it here too since the hash may already read '#/today'.
      formKey = null;
      formDraft = null;
      formError = '';
      location.hash = '#/today';
      // store.loadAll() doesn't itself notify listeners, and if the hash was
      // already '#/today' (e.g. imported from the empty state, which has no
      // tabbar to navigate away with) setting it again wouldn't fire
      // hashchange. Force a render either way.
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  importInputEl = input;
  return input;
}

export function importBackupFlow() {
  getImportInput().click();
}

// ---------- challenges list (#/challenges) ----------

let challengesCurrent = null; // { root }

function challengeProgress(challenge) {
  const totalDays = challenge.totalDays;
  const evaluation = store.state.evaluations[challenge.id];
  if (!evaluation || !evaluation.weeks.length) {
    return { dayNumber: 1, totalDays, weekNum: 1, green: 0, weekTarget: Math.min(challenge.weeklyTarget, totalDays) };
  }
  const currentWeek = evaluation.weeks[evaluation.weeks.length - 1];
  const green = currentWeek.dayStatuses.filter((s) => s === 'green').length;
  const weekTarget = Math.min(challenge.weeklyTarget, currentWeek.dayStatuses.length);
  return { dayNumber: evaluation.currentDayNumber, totalDays, weekNum: evaluation.weeks.length, green, weekTarget };
}

function challengeRowHtml(challenge, selectedId) {
  const { dayNumber, totalDays, weekNum, green, weekTarget } = challengeProgress(challenge);
  const dot = challenge.id === selectedId ? '<span class="dot"></span>' : '';
  return `<div class="row chevron" data-role="challenge-row" data-id="${esc(challenge.id)}">
    ${miniRing(dayNumber, totalDays, 32)}
    <div class="row-label">
      <div>${esc(challenge.name)}${dot}</div>
      <div class="item-sub">Day ${dayNumber} of ${totalDays} · Week ${weekNum} ${green}/${weekTarget}</div>
    </div>
  </div>`;
}

function wireChallengesDelegation(root) {
  if (root.__challengesWired) return;
  root.__challengesWired = true;

  root.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-role="challenge-row"]');
    if (row) {
      location.hash = `#/challenges/${row.dataset.id}`;
      return;
    }
    if (e.target.closest('[data-role="new-challenge"]')) {
      location.hash = '#/challenges/new';
      return;
    }
    if (e.target.closest('[data-role="export-btn"]')) {
      try {
        const result = await exportBackup();
        if (result.method === 'share' || result.method === 'download') {
          markExported();
          if (challengesCurrent) await renderChallenges(challengesCurrent.root);
        }
      } catch (err) {
        alert('Export failed: ' + err.message);
      }
      return;
    }
    if (e.target.closest('[data-role="import-btn"]')) {
      importBackupFlow();
    }
  });
}

export async function renderChallenges(root) {
  challengesCurrent = { root };

  const challenges = store.state.challenges;
  const rowsHtml = challenges.map((c) => challengeRowHtml(c, store.state.selectedId)).join('');
  const exportInfo = lastExportInfo();

  root.innerHTML = `
    <h1 class="large-title">Challenges</h1>
    <div class="group">${rowsHtml}</div>
    <button type="button" class="btn btn-primary" data-role="new-challenge">New challenge</button>
    <div class="section">
      <h2 class="section-header">Backup</h2>
      <div class="btn-pair">
        <button type="button" class="btn btn-primary" data-role="export-btn">Export</button>
        <button type="button" class="btn btn-secondary" data-role="import-btn">Import</button>
      </div>
      <p class="section-footer">${esc(exportInfo.text)} Add to Home Screen for reliable offline storage.</p>
    </div>
  `;

  wireChallengesDelegation(root);
}

// ---------- challenge form (#/challenges/new, #/challenges/:id) ----------

// Module-scope draft, keyed by route ('new' or a challenge id). Only ever
// one form is on screen at a time, so a single slot (rather than a Map) is
// enough: a route-key change resets it, per the module doc comment above.
let formKey = null;
let formDraft = null;
let formError = '';
let current = null; // { root, idParam, isNew, rerender }
// True while a Save/Create or Delete request is in flight, so a double-tap
// can't fire it twice (e.g. create two challenges, or delete-then-delete).
let saving = false;

// The hash the currently-drafted form corresponds to ('#/challenges/new' or
// '#/challenges/<id>'), or null when there's no draft. Used below to detect
// "the user actually navigated to a different form" vs. "a store-driven
// re-render just replaced the container" (which never changes the hash).
function currentFormRoute() {
  if (formKey === null) return null;
  return formKey === 'new' ? '#/challenges/new' : `#/challenges/${formKey}`;
}

// Registered once at module load. Real navigation (tapping another tab,
// leaving the form, coming back) always changes location.hash; a
// store-driven re-render of the same form never does. So this only fires
// when the user has actually left the form the draft belongs to, and is the
// single place that discards a stale draft — closing any step-editor sheet
// left open (it belongs to whichever form is being left) at the same time,
// so it can't later push an edit into a different form's draft.
window.addEventListener('hashchange', () => {
  closeSheet();
  const route = currentFormRoute();
  if (route !== null && location.hash !== route) {
    formKey = null;
    formDraft = null;
    formError = '';
  }
});

function cloneStepForDraft(s) {
  return { id: s.id, name: s.name, mandatory: !!s.mandatory, photo: s.photo, number: s.number ? { ...s.number } : null, note: s.note };
}

function parseIntStrict(s) {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

function stepSummary(step) {
  const parts = [step.mandatory ? 'Required' : 'Optional'];
  if (step.photo === 'required') parts.push('Photo');
  else if (step.photo === 'optional') parts.push('Photo optional');
  if (step.number) {
    const label = step.number.label || 'Value';
    parts.push(step.number.unit ? `${label} (${step.number.unit})` : label);
  }
  if (step.note === 'optional') parts.push('Note');
  return parts.join(' · ');
}

function stepRowHtml(step) {
  return `<div class="row chevron" data-role="step-row" data-id="${esc(step.id)}">
    <div class="row-label">
      <div>${esc(step.name)}</div>
      <div class="item-sub">${esc(stepSummary(step))}</div>
    </div>
  </div>`;
}

function attemptPillInfo(status) {
  if (status === 'complete') return ['green', 'Complete'];
  if (status === 'reset') return ['red', 'Reset'];
  return ['pending', 'Active'];
}

function historyHtml(challengeId) {
  const attempts = (store.state.attempts[challengeId] || []).slice().sort((a, b) => (a.startDate > b.startDate ? -1 : 1));
  if (!attempts.length) return '';
  const rows = attempts.map((a) => {
    const [cls, label] = attemptPillInfo(a.status);
    const endText = a.endDate ? formatDateShort(a.endDate) : 'Now';
    return `<div class="row">
      <span class="row-label">${esc(formatDateShort(a.startDate))} → ${esc(endText)}</span>
      <span class="pill ${cls}">${label}</span>
    </div>`;
  }).join('');
  return `<div class="section">
    <h2 class="section-header">History</h2>
    <div class="group">${rows}</div>
  </div>`;
}

function buildFormHtml({ draft, error, isNew, challenge, saving }) {
  const title = isNew ? 'New Challenge' : esc(challenge.name);

  const startDateRow = isNew ? `<div class="row">
      <span class="field-label">Start date</span>
      <input type="date" data-role="startDate" value="${esc(draft.startDate)}" min="${esc(addDays(store.today(), -1))}" />
    </div>` : '';

  const detailsHtml = `<div class="section">
    <h2 class="section-header">Details</h2>
    <div class="group">
      <div class="row">
        <span class="field-label">Name</span>
        <input type="text" data-role="name" value="${esc(draft.name)}" placeholder="Challenge name" />
      </div>
      <div class="row">
        <span class="field-label">Days</span>
        <input type="text" inputmode="numeric" data-role="totalDays" value="${esc(draft.totalDays)}" />
      </div>
      <div class="row">
        <span class="field-label">Green days per week</span>
        <input type="text" inputmode="numeric" data-role="weeklyTarget" value="${esc(draft.weeklyTarget)}" />
      </div>
      ${startDateRow}
    </div>
  </div>`;

  const stepsHtml = `<div class="section">
    <h2 class="section-header">Steps</h2>
    <div class="group">
      ${draft.steps.map(stepRowHtml).join('')}
      <div class="row" data-role="add-step"><span class="add-step-label">Add step</span></div>
    </div>
  </div>`;

  const errorHtml = error ? `<div class="section-footer error">${esc(error)}</div>` : '';
  const disabledAttr = saving ? 'disabled' : '';
  const saveHtml = `<button type="button" class="btn btn-primary" data-role="save" ${disabledAttr}>${isNew ? 'Create challenge' : 'Save'}</button>`;

  const historyAndDelete = isNew ? '' : `${historyHtml(challenge.id)}
    <button type="button" class="btn btn-danger" data-role="delete-challenge" ${disabledAttr}>Delete challenge</button>`;

  return `<h1 class="large-title">${title}</h1>
    ${detailsHtml}
    ${stepsHtml}
    ${errorHtml}
    ${saveHtml}
    ${historyAndDelete}`;
}

async function handleSave() {
  if (!current || !formDraft || saving) return;
  const { idParam, isNew } = current;
  const input = {
    name: formDraft.name.trim(),
    totalDays: parseIntStrict(formDraft.totalDays),
    weeklyTarget: parseIntStrict(formDraft.weeklyTarget),
    steps: formDraft.steps,
  };
  if (isNew) input.startDate = formDraft.startDate;

  const errors = validateChallengeInput(input, store.today());
  if (errors.length) {
    formError = errors.join(' ');
    current.rerender();
    return;
  }

  saving = true;
  current.rerender();
  try {
    if (isNew) {
      await store.createChallenge(input);
    } else {
      await store.updateChallenge({ ...input, id: idParam });
    }
    formKey = null;
    formDraft = null;
    formError = '';
    saving = false;
    location.hash = '#/challenges';
  } catch (err) {
    formError = err.message;
    saving = false;
    current.rerender();
  }
}

async function handleDeleteChallenge() {
  if (!current || saving) return;
  const { idParam } = current;
  const challenge = store.state.challenges.find((c) => c.id === idParam);
  if (!challenge) return;
  if (!confirm(`Delete "${challenge.name}"? This removes all its days and photos and can't be undone.`)) return;

  saving = true;
  current.rerender();
  try {
    await store.deleteChallenge(idParam);
    formKey = null;
    formDraft = null;
    formError = '';
    saving = false;
    location.hash = '#/challenges';
  } catch (err) {
    saving = false;
    alert('Delete failed: ' + err.message);
    current.rerender();
  }
}

function wireFormDelegation(root) {
  if (root.__formWired) return;
  root.__formWired = true;

  root.addEventListener('input', (e) => {
    if (!formDraft) return;
    const role = e.target.dataset.role;
    if (role === 'name') formDraft.name = e.target.value;
    else if (role === 'totalDays') formDraft.totalDays = e.target.value;
    else if (role === 'weeklyTarget') formDraft.weeklyTarget = e.target.value;
    else if (role === 'startDate') formDraft.startDate = e.target.value;
  });

  root.addEventListener('click', (e) => {
    if (!current || !formDraft) return;

    if (e.target.closest('[data-role="add-step"]')) {
      openStepEditor(null, (step) => {
        formDraft.steps.push(step);
        current.rerender();
      });
      return;
    }

    const stepRow = e.target.closest('[data-role="step-row"]');
    if (stepRow) {
      const id = stepRow.dataset.id;
      const step = formDraft.steps.find((s) => s.id === id);
      if (!step) return;
      openStepEditor(
        step,
        (updated) => {
          const idx = formDraft.steps.findIndex((s) => s.id === id);
          if (idx !== -1) formDraft.steps[idx] = updated;
          current.rerender();
        },
        () => {
          formDraft.steps = formDraft.steps.filter((s) => s.id !== id);
          current.rerender();
        },
      );
      return;
    }

    if (e.target.closest('[data-role="save"]')) {
      handleSave();
      return;
    }

    if (e.target.closest('[data-role="delete-challenge"]')) {
      handleDeleteChallenge();
    }
  });
}

export async function renderChallengeForm(root, idParam) {
  const isNew = idParam === 'new';
  const key = isNew ? 'new' : idParam;
  const challenge = isNew ? null : store.state.challenges.find((c) => c.id === idParam);

  if (!isNew && !challenge) {
    root.innerHTML = `
      <h1 class="large-title">Challenge not found</h1>
      <button type="button" class="btn btn-primary" data-role="back-to-challenges">Back to Challenges</button>
    `;
    root.querySelector('[data-role="back-to-challenges"]').addEventListener('click', () => {
      location.hash = '#/challenges';
    });
    if (formKey === key) {
      formKey = null;
      formDraft = null;
    }
    return;
  }

  if (formKey !== key) {
    formKey = key;
    formError = '';
    formDraft = isNew
      ? { name: '', totalDays: '', weeklyTarget: '', startDate: store.today(), steps: [] }
      : {
        name: challenge.name,
        totalDays: String(challenge.totalDays),
        weeklyTarget: String(challenge.weeklyTarget),
        steps: challenge.steps.map(cloneStepForDraft),
      };
  }

  current = { root, idParam, isNew, rerender: () => renderChallengeForm(root, idParam) };

  root.innerHTML = buildFormHtml({ draft: formDraft, error: formError, isNew, challenge, saving });
  wireFormDelegation(root);
}
