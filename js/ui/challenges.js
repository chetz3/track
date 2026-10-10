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
import { addDays, parseNumberInput } from '../rules.js';
import { exportBackup, importBackup } from '../backup.js';
import { esc, formatDateShort, loaderHtml } from './dom.js';
import { miniRing, refreshBodyCheckIfDue } from './today.js';
import { openStepEditor } from './stepEditor.js';
import { closeSheet } from './sheet.js';
import { presetSteps, dirLabel, goalPlan, latestBodyPhotoId } from '../fitness.js';
import { connect, disconnect, getAuthState, clearAuthError } from '../googleAuth.js';
import { getGeminiKey, setGeminiKey, clearGeminiKey, GEMINI_KEY_RE } from '../gemini.js';
import { defaultSlots, ifSlots, scheduleOf } from '../mealPlan.js';
import { CONDITIONS, MEDS_FLAGS, LAB_FIELDS, emptyHealthDraft, healthToDraft, draftToHealth } from '../health.js';

// Fitness weeks need 5 green days; the 3rd red day in a week resets.
const FITNESS_WEEKLY_TARGET = 5;

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
      <div class="item-sub">Day ${esc(dayNumber)} of ${esc(totalDays)} · Week ${esc(weekNum)} ${esc(green)}/${esc(weekTarget)}</div>
    </div>
  </div>`;
}

function googleSectionHtml() {
  const { connected, email, busy, error } = getAuthState();

  if (connected) {
    return `<div class="section">
      <h2 class="section-header">Google Drive</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">
            <div>Connected</div>
            <div class="item-sub">${esc(email)}</div>
          </div>
        </div>
      </div>
      <button type="button" class="btn btn-danger" data-role="google-disconnect">Disconnect</button>
    </div>`;
  }

  const errorHtml = error ? `<p class="section-footer error">${esc(error)}</p>` : '';
  return `<div class="section">
    <h2 class="section-header">Google Drive</h2>
    <button type="button" class="btn btn-primary" data-role="google-connect" ${busy ? 'disabled' : ''}>${busy ? loaderHtml('Connecting…') : 'Connect Google account'}</button>
    ${errorHtml}
    <p class="section-footer">Sign in to back up to Google Drive (coming soon).</p>
  </div>`;
}

function geminiSectionHtml() {
  const key = getGeminiKey();

  if (key) {
    const last4 = key.slice(-4);
    return `<div class="section">
      <h2 class="section-header">Gemini AI (your key)</h2>
      <div class="group">
        <div class="row">
          <span class="row-label">Key saved · ••••${esc(last4)}</span>
        </div>
      </div>
      <button type="button" class="btn btn-danger" data-role="gemini-remove">Remove</button>
    </div>`;
  }

  return `<div class="section">
    <h2 class="section-header">Gemini AI (your key)</h2>
    <div class="group">
      <div class="row">
        <input type="password" data-role="gemini-key" placeholder="Paste API key" style="text-align:left" />
      </div>
    </div>
    <button type="button" class="btn btn-primary" data-role="gemini-save">Save</button>
    <p class="section-footer">Optional, but FueLoop works best with it: automatic calories from photos, meal ideas and a grocery list. It's free and takes about 2 minutes:</p>
    <ol class="section-footer gemini-steps">
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with Google.</li>
      <li>Tap <strong>Create API key</strong>. When asked for a project:<ul><li>Pick <strong>Default Gemini Project</strong> (Google creates it for most accounts), or any project you already have.</li><li>No project in the list? Tap <strong>Create project</strong>, name it anything (e.g. FueLoop), then create the key in it.</li></ul></li>
      <li>Copy the key (starts with <code>AIza</code> or <code>AQ.</code>), paste it above, and tap <strong>Save</strong>.</li>
    </ol>
    <p class="section-footer">Your key stays on this device only and uses your own free Gemini quota.</p>
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
      return;
    }
    if (e.target.closest('[data-role="google-connect"]')) {
      clearAuthError();
      connect();
      return;
    }
    if (e.target.closest('[data-role="google-disconnect"]')) {
      if (confirm('Disconnect your Google account on this device?')) disconnect();
      return;
    }
    if (e.target.closest('[data-role="gemini-save"]')) {
      const input = root.querySelector('[data-role="gemini-key"]');
      const value = (input ? input.value : '').trim();
      if (!GEMINI_KEY_RE.test(value)) {
        alert('Enter a valid Gemini API key.');
        return;
      }
      setGeminiKey(value);
      if (challengesCurrent) await renderChallenges(challengesCurrent.root);
      return;
    }
    if (e.target.closest('[data-role="gemini-remove"]')) {
      clearGeminiKey();
      if (challengesCurrent) await renderChallenges(challengesCurrent.root);
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
    ${googleSectionHtml()}
    ${geminiSectionHtml()}
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
    bodyCheckError = '';
  }
});

function cloneStepForDraft(s) {
  return { id: s.id, name: s.name, mandatory: !!s.mandatory, type: s.type || null, photo: s.photo, number: s.number ? { ...s.number } : null, note: s.note, goal: s.goal ? { ...s.goal } : null };
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
  if (step.goal) parts.push(`Goal: ${dirLabel(step.goal.dir)} ${step.goal.target}`);
  return parts.join(' · ');
}

// ---------- fitness profile (category: 'fitness' challenges only) ----------

// Diet values from docs/superpowers/plans/2026-09-30-meal-suggestions.md §2.
const DIET_OPTIONS = [['veg', 'Vegetarian'], ['eggetarian', 'Eggetarian'], ['nonveg', 'Non-veg'], ['vegan', 'Vegan']];

// Meal-schedule option sets (docs §9). Regular allows 2-5 meals; an
// intermittent-fasting window is short enough that only 2-3 makes sense
// (OMAD is always exactly 1 and has no selector at all — see scheduleHtml).
const SCHEDULE_MEALS_OPTIONS = [2, 3, 4, 5];
const IF_MEALS_OPTIONS = [2, 3];
const FAST_OPTIONS = [['16:8', '16:8'], ['18:6', '18:6'], ['20:4', '20:4'], ['omad', 'OMAD']];

function defaultSchedule() {
  const schedule = { pattern: 'regular', meals: 3, fast: '16:8', windowStart: '12:00' };
  return { ...schedule, slots: defaultSlots(schedule) };
}

function defaultProfileDraft() {
  return {
    sex: 'male', age: '30', heightCm: '170', startWeightKg: '70', targetWeightKg: '65', activity: 'sedentary', aim: 'maintain',
    location: '', cuisine: '', diet: '', avoid: '', schedule: defaultSchedule(), shareBodyPhoto: false,
    health: emptyHealthDraft(),
  };
}

function profileToDraft(p) {
  const sched = scheduleOf(p);
  return {
    sex: p.sex === 'female' ? 'female' : 'male',
    age: String(p.age ?? ''),
    heightCm: String(p.heightCm ?? ''),
    startWeightKg: String(p.startWeightKg ?? ''),
    targetWeightKg: String(p.targetWeightKg ?? ''),
    activity: p.activity || 'sedentary',
    aim: p.aim || 'maintain',
    location: p.location || '',
    cuisine: p.cuisine || '',
    diet: p.diet || '',
    avoid: p.avoid || '',
    // scheduleOf migrates a legacy profile.mealsPerDay into a Regular
    // schedule (docs §9: "This replaces mealsPerDay, and old values are
    // migrated") — cloned so editing the draft never mutates the stored
    // challenge's profile in place.
    schedule: { ...sched, slots: sched.slots.map((s) => ({ ...s })) },
    shareBodyPhoto: !!p.shareBodyPhoto,
    health: healthToDraft(p.health),
  };
}

// Turns the (string-valued) profile draft into the numeric shape
// js/fitness.js expects. Invalid/empty numeric fields become NaN, caught by
// validateProfile below before this is ever saved or fed to presetSteps.
// The meal-suggestion fields (location/cuisine/diet/avoid/schedule/
// shareBodyPhoto — docs §2, §9) are loosely typed and never block saving the
// profile itself; canSuggest/js/ui/today.js gate on diet being set instead.
function parseProfileDraft(p) {
  const health = draftToHealth(p.health);
  return {
    sex: p.sex,
    age: parseIntStrict(p.age),
    heightCm: parseNumberInput(p.heightCm),
    startWeightKg: parseNumberInput(p.startWeightKg),
    targetWeightKg: parseNumberInput(p.targetWeightKg),
    activity: p.activity,
    aim: p.aim,
    location: (p.location || '').trim(),
    cuisine: (p.cuisine || '').trim(),
    diet: p.diet || null,
    avoid: (p.avoid || '').trim(),
    schedule: {
      pattern: p.schedule && p.schedule.pattern === 'if' ? 'if' : 'regular',
      meals: p.schedule && Number.isInteger(p.schedule.meals) ? p.schedule.meals : 3,
      fast: (p.schedule && p.schedule.fast) || '16:8',
      windowStart: (p.schedule && p.schedule.windowStart) || '12:00',
      slots: p.schedule && Array.isArray(p.schedule.slots)
        ? p.schedule.slots.map((s) => ({ name: String((s && s.name) || ''), time: String((s && s.time) || '') }))
        : [],
    },
    shareBodyPhoto: !!p.shareBodyPhoto,
    // Optional health info (Plateau Coach): the key is omitted when empty so
    // a profile without it stays exactly as it was.
    ...(health ? { health } : {}),
  };
}

// Regenerates `schedule.slots` from its pattern/meals/fast/windowStart —
// called whenever one of those structural fields changes (docs §9). A
// direct edit of one slot's own time (schedule-slot-time) never calls this,
// so it doesn't clobber the rest of the user's edits.
function regenerateScheduleSlots(schedule) {
  schedule.slots = schedule.pattern === 'if'
    ? ifSlots(schedule.fast, schedule.windowStart, schedule.fast === 'omad' ? 1 : schedule.meals)
    : defaultSlots(schedule);
}

function scheduleHtml(schedule) {
  const patternInputs = [['regular', 'Regular'], ['if', 'Intermittent fasting']].map(([v, l]) =>
    `<label><input type="radio" name="schedule-pattern" value="${v}" data-role="schedule-pattern" ${schedule.pattern === v ? 'checked' : ''}><span>${esc(l)}</span></label>`
  ).join('');

  let patternSpecificHtml;
  if (schedule.pattern === 'if') {
    const fastInputs = FAST_OPTIONS.map(([v, l]) =>
      `<label><input type="radio" name="schedule-fast" value="${v}" data-role="schedule-fast" ${schedule.fast === v ? 'checked' : ''}><span>${esc(l)}</span></label>`
    ).join('');
    const mealsRow = schedule.fast === 'omad' ? '' : `<div class="row">
        <span class="field-label">Meals</span>
        <div class="segmented">${IF_MEALS_OPTIONS.map((n) =>
          `<label><input type="radio" name="schedule-if-meals" value="${n}" data-role="schedule-if-meals" ${schedule.meals === n ? 'checked' : ''}><span>${esc(n)}</span></label>`
        ).join('')}</div>
      </div>`;
    patternSpecificHtml = `
      <div class="row"><span class="field-label">Fast</span><div class="segmented">${fastInputs}</div></div>
      ${mealsRow}
      <div class="row">
        <span class="field-label">Window start</span>
        <input type="time" data-role="schedule-window-start" value="${esc(schedule.windowStart)}" />
      </div>`;
  } else {
    const mealsInputs = SCHEDULE_MEALS_OPTIONS.map((n) =>
      `<label><input type="radio" name="schedule-meals" value="${n}" data-role="schedule-meals" ${schedule.meals === n ? 'checked' : ''}><span>${esc(n)}</span></label>`
    ).join('');
    patternSpecificHtml = `<div class="row"><span class="field-label">Meals</span><div class="segmented">${mealsInputs}</div></div>`;
  }

  const slotsHtml = (schedule.slots || []).map((s, i) => `<div class="row">
    <span class="field-label">${esc(s.name)}</span>
    <input type="time" data-role="schedule-slot-time" data-index="${i}" value="${esc(s.time)}" />
  </div>`).join('');

  return `<div class="row"><span class="field-label">Eating pattern</span><div class="segmented">${patternInputs}</div></div>
    ${patternSpecificHtml}
    ${slotsHtml}`;
}

function validateProfile(p) {
  const errors = [];
  if (!Number.isInteger(p.age) || p.age < 13 || p.age > 100) errors.push('Age must be 13–100.');
  if (!Number.isFinite(p.heightCm) || p.heightCm < 100 || p.heightCm > 250) errors.push('Height must be 100–250 cm.');
  if (!Number.isFinite(p.startWeightKg) || p.startWeightKg < 30 || p.startWeightKg > 300) errors.push('Current weight must be 30–300 kg.');
  if (!Number.isFinite(p.targetWeightKg) || p.targetWeightKg < 30 || p.targetWeightKg > 300) errors.push('Target weight must be 30–300 kg.');
  return errors;
}

// Sizes the weight plan to the Days the user entered. Days is only filled
// in (with the safe minimum) when it's empty; an entered value is never
// changed — if it's too short, the target stays at the safe maximum and the
// note says how much is realistic. Returns { profile, days } or null.
function applyGoalPlan(draft) {
  draft.daysNote = '';
  const profile = parseProfileDraft(draft.profile);
  if (validateProfile(profile).length) return null;
  let days = parseIntStrict(draft.totalDays);
  const probe = goalPlan(profile, 1);
  if (!probe) return { profile, days };

  const minDays = Math.min(probe.minDays, 1000);
  let note = '';
  if (!(Number.isInteger(days) && days > 0)) {
    days = minDays;
    draft.totalDays = String(days);
    note = `Days set to ${minDays}, the safe minimum for this goal. `;
  }
  const plan = goalPlan(profile, days);
  const verb = profile.aim === 'lose' ? 'lose' : 'gain';
  const kind = profile.aim === 'lose' ? 'deficit' : 'surplus';
  const perWeek = Math.round((plan.dailyDelta * 7 / 7700) * 10) / 10;
  const reachable = Math.round((plan.dailyDelta * days / 7700) * 10) / 10;
  draft.daysNote = plan.daysOk
    ? `${note}To ${verb} ${plan.kg} kg in ${days} days: about ${plan.dailyDelta} kcal/day ${kind} (~${perWeek} kg/week).`
    : `${note}${days} days is too short to ${verb} ${plan.kg} kg safely. At the safe maximum (${plan.dailyDelta} kcal/day ${kind}) expect about ${reachable} kg in ${days} days; the full goal needs at least ${plan.minDays} days.`;
  return { profile, days };
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

// Category is fixed after creation: an editable segmented row when creating,
// a plain read-only row when editing an existing challenge.
function categoryRowHtml(draft, isNew) {
  if (!isNew) {
    const label = draft.category === 'fitness' ? 'Fitness' : 'Custom';
    return `<div class="row"><span class="field-label">Category</span><span class="row-value">${esc(label)}</span></div>`;
  }
  const options = [['custom', 'Custom'], ['fitness', 'Fitness']];
  const inputs = options.map(([value, label]) =>
    `<label><input type="radio" name="challenge-category" value="${value}" data-role="category-option" ${draft.category === value ? 'checked' : ''}><span>${esc(label)}</span></label>`
  ).join('');
  return `<div class="row">
    <span class="field-label">Category</span>
    <div class="segmented">${inputs}</div>
  </div>`;
}

// Body check card (docs §3): the latest weekly bodyCheck result plus an
// Update button. Only for an existing (already-saved) fitness challenge —
// there's no photo/day data to check yet on a still-unsaved draft. Disabled
// (with a hint) when the opt-in switch is off or there's no Body-step photo
// to send; `bodyCheckBusy` (module state below) disables it mid-request too.
function bodyCheckCardHtml(challenge, draft) {
  if (!challenge) return '';
  const daysMap = store.state.days[challenge.id] || {};
  const hasPhoto = !!latestBodyPhotoId(challenge, daysMap);
  const sharingOn = !!draft.profile.shareBodyPhoto;
  const bc = challenge.bodyCheck;

  const disabled = bodyCheckBusy || !sharingOn || !hasPhoto;
  const hint = !sharingOn
    ? 'Turn on "Use my body photo" above to enable Update.'
    : !hasPhoto
      ? 'Log a Body step photo to enable Update.'
      : '';

  const resultHtml = bc
    ? `<div class="row">
        <div class="row-label">
          <div>BMI ${esc(bc.bmi ?? '–')}${bc.build ? ' · ' + esc(bc.build) : ''}${bc.bellyFat ? ' · ' + esc(bc.bellyFat) + ' belly fat' : ''}</div>
          ${bc.note ? `<div class="item-sub">${esc(bc.note)}</div>` : ''}
          ${bc.focus && bc.focus.length ? `<div class="item-sub">${esc(bc.focus.join(' · '))}</div>` : ''}
          <div class="item-sub">Checked ${esc(formatDateShort(bc.date))}</div>
        </div>
      </div>`
    : `<div class="row"><span class="row-label">No body check yet.</span></div>`;

  return `<div class="section">
    <h2 class="section-header">Body check</h2>
    <div class="group">${resultHtml}</div>
    <button type="button" class="btn btn-secondary" data-role="body-check-update" ${disabled ? 'disabled' : ''}>${bodyCheckBusy ? loaderHtml('Checking…') : 'Update'}</button>
    ${hint ? `<p class="section-footer">${esc(hint)}</p>` : ''}
    ${bodyCheckError ? `<p class="section-footer error">${esc(bodyCheckError)}</p>` : ''}
  </div>`;
}

// ---- Health (optional, helps the AI coach) ----

let healthOpen = false; // whether the collapsible Health group is expanded

function healthChipsHtml(group, options, selected) {
  return `<div class="health-chips" role="group">${options.map(([v, l]) =>
    `<button type="button" class="feel-chip" data-role="health-chip" data-group="${group}" data-value="${esc(v)}" aria-pressed="${selected.includes(v)}">${esc(l)}</button>`).join('')}</div>`;
}

function healthHtml(h) {
  const labRows = LAB_FIELDS.map(([k, label, unit]) => `<div class="row">
        <span class="field-label">${esc(label)}</span>
        <input type="text" inputmode="decimal" data-role="health-lab" data-lab="${k}" value="${esc(h.labs[k])}" />
        <span class="field-unit">${esc(unit)}</span>
      </div>`).join('');
  return `<div class="section">
    <button type="button" class="health-toggle" data-role="health-toggle" aria-expanded="${healthOpen}" aria-controls="health-panel">
      <span>Health (optional, helps the AI coach)</span><span class="rv-chev" aria-hidden="true">›</span>
    </button>
    <div id="health-panel" class="health-panel"${healthOpen ? '' : ' hidden'}>
      <div class="group">
        <div class="row health-block"><div class="row-label"><div class="field-label">Conditions</div>${healthChipsHtml('conditions', CONDITIONS, h.conditions)}</div></div>
        <div class="row health-block"><div class="row-label"><div class="field-label">Medicine groups</div>${healthChipsHtml('meds_flags', MEDS_FLAGS, h.meds_flags)}</div></div>
        <div class="row">
          <span class="field-label">Sensitivities</span>
          <input type="text" data-role="health-sensitivities" value="${esc(h.sensitivities)}" placeholder="e.g. dairy, gluten" />
        </div>
        <div class="row">
          <span class="field-label">Medicines</span>
          <input type="text" data-role="health-meds" value="${esc(h.meds)}" placeholder="Optional" />
        </div>
        <div class="row">
          <span class="field-label">Waist at the navel</span>
          <input type="text" inputmode="decimal" data-role="health-waist" value="${esc(h.waistCm)}" />
          <span class="field-unit">cm</span>
        </div>
      </div>
      <p class="section-footer">Measure once a month. Waist is the best sign of belly fat.</p>
      <div class="group">
        ${labRows}
        <div class="row">
          <span class="field-label">Lab date</span>
          <input type="date" data-role="health-lab-date" value="${esc(h.labs.date)}" />
        </div>
      </div>
      <p class="section-footer">Lab values are optional. Leave out any you don't have.</p>
      <div class="group">
        <div class="row">
          <span class="row-label">Share health info with the AI coach</span>
          <input type="checkbox" class="switch" data-role="health-share" aria-label="Share health info with the AI coach" ${h.shareWithAi ? 'checked' : ''} />
        </div>
      </div>
      <p class="section-footer">Off by default. When on, your conditions, medicines, waist and labs are sent to Google Gemini with the weight review, using your own API key. On Google's free tier, Google may use this data to improve its models. It is never sent otherwise.</p>
    </div>
  </div>`;
}

function profileHtml(draft, challenge) {
  if (draft.category !== 'fitness') return '';
  const p = draft.profile;
  const sexInputs = [['male', 'M'], ['female', 'F']].map(([v, l]) =>
    `<label><input type="radio" name="profile-sex" value="${v}" data-role="profile-sex" ${p.sex === v ? 'checked' : ''}><span>${esc(l)}</span></label>`
  ).join('');
  const activityOptions = [['sedentary', 'Sedentary'], ['light', 'Light'], ['moderate', 'Moderate'], ['active', 'Active']];
  const activitySelect = `<select data-role="profile-activity">${activityOptions.map(([v, l]) => `<option value="${v}" ${p.activity === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const aimOptions = [['lose', 'Lose'], ['maintain', 'Maintain'], ['gain', 'Gain']];
  const aimSelect = `<select data-role="profile-aim">${aimOptions.map(([v, l]) => `<option value="${v}" ${p.aim === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const dietInputs = DIET_OPTIONS.map(([v, l]) =>
    `<label><input type="radio" name="profile-diet" value="${v}" data-role="profile-diet" ${p.diet === v ? 'checked' : ''}><span>${esc(l)}</span></label>`
  ).join('');

  return `<div class="section">
    <h2 class="section-header">Fitness profile</h2>
    <div class="group">
      <div class="row"><span class="field-label">Sex</span><div class="segmented">${sexInputs}</div></div>
      <div class="row">
        <span class="field-label">Age</span>
        <input type="text" inputmode="numeric" data-role="profile-age" value="${esc(p.age)}" />
      </div>
      <div class="row">
        <span class="field-label">Height</span>
        <input type="text" inputmode="decimal" data-role="profile-height" value="${esc(p.heightCm)}" />
        <span class="field-unit">cm</span>
      </div>
      <div class="row">
        <span class="field-label">Current weight</span>
        <input type="text" inputmode="decimal" data-role="profile-weight" value="${esc(p.startWeightKg)}" />
        <span class="field-unit">kg</span>
      </div>
      <div class="row">
        <span class="field-label">Target weight</span>
        <input type="text" inputmode="decimal" data-role="profile-target-weight" value="${esc(p.targetWeightKg)}" />
        <span class="field-unit">kg</span>
      </div>
      <div class="row"><span class="field-label">Activity</span>${activitySelect}</div>
      <div class="row"><span class="field-label">Aim</span>${aimSelect}</div>
      <div class="row">
        <span class="field-label">Location</span>
        <input type="text" data-role="profile-location" value="${esc(p.location)}" placeholder="City, region" />
      </div>
      <div class="row">
        <span class="field-label">Cuisine</span>
        <input type="text" data-role="profile-cuisine" value="${esc(p.cuisine)}" placeholder="Optional, e.g. South Indian" />
      </div>
      <div class="row"><span class="field-label">Diet</span><div class="segmented segmented-wrap">${dietInputs}</div></div>
      <div class="row">
        <span class="field-label">Avoid</span>
        <input type="text" data-role="profile-avoid" value="${esc(p.avoid)}" placeholder="e.g. peanuts, mushrooms" />
      </div>
      <div class="row">
        <span class="row-label">Use my body photo for AI suggestions</span>
        <input type="checkbox" class="switch" data-role="profile-share-photo" ${p.shareBodyPhoto ? 'checked' : ''} />
      </div>
    </div>
    <button type="button" class="btn btn-secondary" data-role="recalc-targets">Recalculate targets</button>
    <p class="section-footer">Targets use your weight goal and the number of Days. After changing either, tap Recalculate.</p>
    ${draft.daysNote ? `<p class="section-footer">${esc(draft.daysNote)}</p>` : ''}
  </div>
  ${healthHtml(p.health)}
  <div class="section">
    <h2 class="section-header">Meal schedule</h2>
    <div class="group">${scheduleHtml(p.schedule)}</div>
    <p class="section-footer">The AI meal plan uses these exact slots. You can edit any time.</p>
  </div>
  ${bodyCheckCardHtml(challenge, draft)}`;
}

function buildFormHtml({ draft, error, isNew, challenge, saving }) {
  const title = isNew ? 'New Challenge' : esc(challenge.name);
  const isFitness = draft.category === 'fitness';

  const startDateRow = isNew ? `<div class="row">
      <span class="field-label">Start date</span>
      <input type="date" data-role="startDate" value="${esc(draft.startDate)}" min="${esc(addDays(store.today(), -1))}" />
    </div>` : '';

  // Fitness challenges always store weeklyTarget: FITNESS_WEEKLY_TARGET and
  // reset as soon as a week can no longer reach it (see js/rules.js's
  // evaluateAttempt), so the field is shown read-only.
  const weeklyTargetRow = isFitness ? `<div class="row">
        <span class="field-label">Green days per week</span>
        <span class="row-value">${FITNESS_WEEKLY_TARGET} of 7</span>
      </div>` : `<div class="row">
        <span class="field-label">Green days per week</span>
        <input type="text" inputmode="numeric" data-role="weeklyTarget" value="${esc(draft.weeklyTarget)}" />
      </div>`;

  const detailsHtml = `<div class="section">
    <h2 class="section-header">Details</h2>
    <div class="group">
      ${categoryRowHtml(draft, isNew)}
      <div class="row">
        <span class="field-label">Name</span>
        <input type="text" data-role="name" value="${esc(draft.name)}" placeholder="Challenge name" />
      </div>
      <div class="row">
        <span class="field-label">Days</span>
        <input type="text" inputmode="numeric" data-role="totalDays" value="${esc(draft.totalDays)}" />
      </div>
      ${weeklyTargetRow}
      ${startDateRow}
    </div>
  </div>`;

  const stepsHtml = `<div class="section">
    <h2 class="section-header">Steps</h2>
    <div class="group">
      ${draft.steps.map(stepRowHtml).join('')}
      ${isNew ? '<div class="row" data-role="add-step"><span class="add-step-label">Add step</span></div>' : ''}
    </div>
  </div>`;

  const errorHtml = error ? `<div class="section-footer error">${esc(error)}</div>` : '';
  const disabledAttr = saving ? 'disabled' : '';
  const saveHtml = `<button type="button" class="btn btn-primary" data-role="save" ${disabledAttr}>${isNew ? 'Create challenge' : 'Save'}</button>`;

  const historyAndDelete = isNew ? '' : `${historyHtml(challenge.id)}
    <button type="button" class="btn btn-danger" data-role="delete-challenge" ${disabledAttr}>Delete challenge</button>`;

  return `<h1 class="large-title">${title}</h1>
    ${detailsHtml}
    ${profileHtml(draft, challenge)}
    ${stepsHtml}
    ${errorHtml}
    ${saveHtml}
    ${historyAndDelete}`;
}

async function handleSave() {
  if (!current || !formDraft || saving) return;
  const { idParam, isNew } = current;
  const isFitness = formDraft.category === 'fitness';
  const input = {
    name: formDraft.name.trim(),
    totalDays: parseIntStrict(formDraft.totalDays),
    // Fitness challenges always score against a full week (see the hard
    // daily reset in js/rules.js's evaluateAttempt) — the field is hidden
    // in the form and forced to 7 here rather than left to whatever stale
    // value the draft happens to carry.
    weeklyTarget: isFitness ? FITNESS_WEEKLY_TARGET : parseIntStrict(formDraft.weeklyTarget),
    steps: formDraft.steps,
    category: formDraft.category,
  };
  if (isNew) input.startDate = formDraft.startDate;

  let profile = null;
  if (isFitness) {
    profile = parseProfileDraft(formDraft.profile);
    input.profile = profile;
  }

  if (isFitness && !validateProfile(profile).length) {
    const before = formDraft.totalDays;
    applyGoalPlan(formDraft);
    if (formDraft.totalDays !== before) {
      formError = 'Days was empty, so it was set from your weight goal. Tap Recalculate targets, review, then save again.';
      current.rerender();
      return;
    }
  }

  const errors = validateChallengeInput(input, store.today());
  if (isFitness) errors.push(...validateProfile(profile));
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

// Body check "Update" button state (docs §3) — module scope like `saving`
// above, since only one form is ever on screen. `force: true` bypasses both
// the opt-in switch's "off means never" and the 7-day staleness check; the
// button itself is already disabled when sharing is off or there's no photo
// (see bodyCheckCardHtml), so reaching here means both are satisfied.
let bodyCheckBusy = false;
let bodyCheckError = '';

async function handleBodyCheckUpdate() {
  if (!current || bodyCheckBusy) return;
  const challenge = store.state.challenges.find((c) => c.id === current.idParam);
  if (!challenge) return;
  bodyCheckBusy = true;
  bodyCheckError = '';
  current.rerender();
  try {
    await refreshBodyCheckIfDue({ ...challenge, profile: formDraft ? parseProfileDraft(formDraft.profile) : challenge.profile }, { force: true });
  } catch (err) {
    console.error('Body check failed:', err);
    bodyCheckError = err.message || "Couldn't update the body check. Please try again.";
  } finally {
    bodyCheckBusy = false;
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
    else if (role === 'profile-age') formDraft.profile.age = e.target.value;
    else if (role === 'profile-height') formDraft.profile.heightCm = e.target.value;
    else if (role === 'profile-weight') formDraft.profile.startWeightKg = e.target.value;
    else if (role === 'profile-target-weight') formDraft.profile.targetWeightKg = e.target.value;
    else if (role === 'profile-location') formDraft.profile.location = e.target.value;
    else if (role === 'profile-cuisine') formDraft.profile.cuisine = e.target.value;
    else if (role === 'profile-avoid') formDraft.profile.avoid = e.target.value;
    else if (role === 'health-sensitivities') formDraft.profile.health.sensitivities = e.target.value;
    else if (role === 'health-meds') formDraft.profile.health.meds = e.target.value;
    else if (role === 'health-waist') {
      formDraft.profile.health.waistCm = e.target.value;
      formDraft.profile.health.waistDate = store.today(); // re-measured today
    } else if (role === 'health-lab') formDraft.profile.health.labs[e.target.dataset.lab] = e.target.value;
    else if (role === 'health-lab-date') formDraft.profile.health.labs.date = e.target.value;
  });

  root.addEventListener('change', (e) => {
    if (!current || !formDraft) return;
    const role = e.target.dataset.role;
    if (role === 'category-option') {
      formDraft.category = e.target.value;
      // First switch to Fitness on an otherwise-empty step list: seed the
      // draft with the preset steps (see fitness.js's presetSteps). Doesn't
      // re-run on every toggle — only when there's nothing there yet, so it
      // never clobbers steps the user already added.
      if (formDraft.category === 'fitness' && formDraft.steps.length === 0) {
        const g = applyGoalPlan(formDraft);
        formDraft.steps = presetSteps(parseProfileDraft(formDraft.profile), g?.days);
      }
      current.rerender();
    } else if (role === 'profile-sex') {
      formDraft.profile.sex = e.target.value;
    } else if (role === 'profile-activity') {
      formDraft.profile.activity = e.target.value;
    } else if (role === 'profile-aim') {
      formDraft.profile.aim = e.target.value;
    } else if (role === 'profile-diet') {
      formDraft.profile.diet = e.target.value;
    } else if (role === 'schedule-pattern') {
      const schedule = formDraft.profile.schedule;
      schedule.pattern = e.target.value;
      if (schedule.pattern === 'if') {
        if (!schedule.fast) schedule.fast = '16:8';
        if (!schedule.windowStart) schedule.windowStart = '12:00';
        schedule.meals = schedule.fast === 'omad' ? 1 : (IF_MEALS_OPTIONS.includes(schedule.meals) ? schedule.meals : 2);
      } else if (!SCHEDULE_MEALS_OPTIONS.includes(schedule.meals)) {
        schedule.meals = 3;
      }
      regenerateScheduleSlots(schedule);
      current.rerender();
    } else if (role === 'schedule-meals' || role === 'schedule-if-meals') {
      formDraft.profile.schedule.meals = parseInt(e.target.value, 10);
      regenerateScheduleSlots(formDraft.profile.schedule);
      current.rerender();
    } else if (role === 'schedule-fast') {
      const schedule = formDraft.profile.schedule;
      schedule.fast = e.target.value;
      schedule.meals = schedule.fast === 'omad' ? 1 : (IF_MEALS_OPTIONS.includes(schedule.meals) ? schedule.meals : 2);
      regenerateScheduleSlots(schedule);
      current.rerender();
    } else if (role === 'schedule-window-start') {
      formDraft.profile.schedule.windowStart = e.target.value;
      regenerateScheduleSlots(formDraft.profile.schedule);
      current.rerender();
    } else if (role === 'schedule-slot-time') {
      const idx = parseInt(e.target.dataset.index, 10);
      const slot = formDraft.profile.schedule.slots[idx];
      if (slot) slot.time = e.target.value;
    } else if (role === 'health-share') {
      formDraft.profile.health.shareWithAi = e.target.checked;
    } else if (role === 'profile-share-photo') {
      formDraft.profile.shareBodyPhoto = e.target.checked;
      current.rerender(); // toggling it changes the body check card's Update enablement
    }
  });

  root.addEventListener('click', (e) => {
    if (!current || !formDraft) return;

    const healthToggle = e.target.closest('[data-role="health-toggle"]');
    if (healthToggle) {
      healthOpen = healthToggle.getAttribute('aria-expanded') !== 'true';
      healthToggle.setAttribute('aria-expanded', String(healthOpen));
      const panel = document.getElementById('health-panel');
      if (panel) panel.hidden = !healthOpen;
      return;
    }
    const healthChip = e.target.closest('[data-role="health-chip"]');
    if (healthChip) {
      const list = formDraft.profile.health[healthChip.dataset.group];
      if (Array.isArray(list)) {
        const i = list.indexOf(healthChip.dataset.value);
        if (i >= 0) list.splice(i, 1); else list.push(healthChip.dataset.value);
        healthChip.setAttribute('aria-pressed', String(i < 0));
      }
      return;
    }

    if (e.target.closest('[data-role="body-check-update"]')) {
      handleBodyCheckUpdate();
      return;
    }

    if (e.target.closest('[data-role="recalc-targets"]')) {
      const profile = parseProfileDraft(formDraft.profile);
      const g = applyGoalPlan(formDraft);
      const preset = presetSteps(profile, g?.days);
      formDraft.steps = formDraft.steps.map((s) => {
        if (!s.type) return s; // custom steps are untouched
        const match = preset.find((p) => p.type === s.type);
        if (!match) return s;
        const next = { ...s, goal: match.goal };
        if (s.type === 'food') next.macros = match.macros;
        return next;
      });
      current.rerender();
      return;
    }

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
        // An existing challenge's steps are fixed; only their goals change.
        { goalsOnly: !current.isNew },
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
      ? { name: '', totalDays: '', weeklyTarget: '', startDate: store.today(), steps: [], category: 'custom', profile: defaultProfileDraft() }
      : {
        name: challenge.name,
        totalDays: String(challenge.totalDays),
        weeklyTarget: String(challenge.weeklyTarget),
        steps: challenge.steps.map(cloneStepForDraft),
        category: challenge.category === 'fitness' ? 'fitness' : 'custom',
        profile: challenge.profile ? profileToDraft(challenge.profile) : defaultProfileDraft(),
      };
  }

  current = { root, idParam, isNew, rerender: () => renderChallengeForm(root, idParam) };

  root.innerHTML = buildFormHtml({ draft: formDraft, error: formError, isNew, challenge, saving });
  wireFormDelegation(root);
}
