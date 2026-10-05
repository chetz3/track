// Step editor sheet: create/edit a single challenge step (name, mandatory,
// photo/number/note requirements, and — for a typed fitness step — a Target
// + direction) and optionally delete it.
//
// This is a self-contained sheet component: all draft state lives in this
// module's closure for the lifetime of one openStepEditor() call. It is
// never touched by the router's store-driven re-renders (the sheet is
// appended to document.body, outside #app), so — unlike the screen modules
// — it doesn't need module-scope state keyed by route.

import { openSheet } from './sheet.js';
import { esc } from './dom.js';
import { STEP_TYPES, TYPE_META, FIXED_DIR, dirLabel, makeTypedStep } from '../fitness.js';
import { MACRO_KEYS, MACRO_META } from '../foodLogic.js';

const KNOWN_TYPES = new Set(STEP_TYPES);

// Fixed direction per macro — see docs §9 and js/fitness.js's macroTargets.
// Shown as a label (never editable), same spirit as typedGoalRowHtml's
// direction for the other typed steps.
const MACRO_DIRS = { protein: 'atLeast', fiber: 'atLeast', carbs: 'atMost', fat: 'atMost' };

// { protein: '', carbs: '', ... } draft strings from a step.macros object
// (or null/missing — every key starts blank).
function macroTargetsToDraft(macros) {
  const draft = {};
  for (const key of MACRO_KEYS) draft[key] = macros && macros[key] ? String(macros[key].target) : '';
  return draft;
}

const MAX_REMINDERS = 12;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Draft copy of step.reminders (missing = no times; sound/vibrate default on).
function remindersToDraft(r) {
  return {
    times: r && Array.isArray(r.times) ? r.times.filter((t) => TIME_RE.test(t)) : [],
    sound: r ? r.sound !== false : true,
    vibrate: r ? r.vibrate !== false : true,
  };
}

// step.reminders from the draft: sorted, unique, valid HH:MM; null when no times.
function buildRemindersFromDraft(r) {
  const times = [...new Set(r.times.filter((t) => TIME_RE.test(t)))].sort().slice(0, MAX_REMINDERS);
  return times.length ? { times, sound: r.sound, vibrate: r.vibrate } : null;
}

// Next full hour after the latest time, or 09:00 when there are none.
function nextReminderTime(times) {
  const valid = times.filter((t) => TIME_RE.test(t)).sort();
  if (!valid.length) return '09:00';
  const hour = Math.min(Number(valid[valid.length - 1].slice(0, 2)) + 1, 23);
  return `${String(hour).padStart(2, '0')}:00`;
}

// Footer note under the Reminders group, from the current permission state.
// Every Notification access is guarded — iOS Safari outside a Home Screen
// app has no Notification global at all.
function reminderPermissionNote() {
  try {
    if (typeof Notification === 'undefined') return "This browser can't show notifications here (on iPhone, open FueLoop from the Home Screen).";
    if (Notification.permission === 'denied') return 'Notifications are blocked. Allow them in your browser/phone settings.';
  } catch (_) {
    return "This browser can't show notifications here (on iPhone, open FueLoop from the Home Screen).";
  }
  return '';
}

// Reminders group, shared by the full and goals-only editors.
function remindersGroupHtml(draft) {
  const rows = draft.reminders.times.map((t, i) => `<div class="row">
    <span class="field-label">Reminder</span>
    <input type="time" data-role="reminder-time" data-index="${i}" value="${esc(t)}" />
    <button type="button" class="reminder-remove" data-role="reminder-remove" data-index="${i}" aria-label="Remove reminder">×</button>
  </div>`).join('');
  const addRow = draft.reminders.times.length < MAX_REMINDERS
    ? `<div class="row"><button type="button" class="reminder-add" data-role="reminder-add">Add reminder</button></div>`
    : '';
  const note = reminderPermissionNote();
  const noteHtml = note ? `<div class="section-footer error">${esc(note)}</div>` : '';
  return `<div class="group">
    ${rows}${addRow}
    ${switchRow('Sound', 'reminder-sound', draft.reminders.sound)}
    ${switchRow('Vibrate', 'reminder-vibrate', draft.reminders.vibrate)}
  </div>
  ${noteHtml}<div class="section-footer">Vibration works on Android. On iPhone, add FueLoop to the Home Screen to get notifications.</div>`;
}

const TYPE_OPTIONS = [
  ['regular', 'Custom'], ['food', 'Food'], ['workout', 'Workout'],
  ['steps', 'Steps'], ['water', 'Water'], ['body', 'Body'], ['sleep', 'Sleep'],
];

function makeStepId() {
  return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// A typed step's default draft direction when there's no existing goal to
// carry over: fixed for every type except food (aim-dependent — "else
// atMost" per the Phase A spec) and body (no goal at all).
function defaultDirFor(type) {
  if (type === 'food') return 'atMost';
  return FIXED_DIR[type] || 'atLeast';
}

function cloneStep(step) {
  const type = step.type && KNOWN_TYPES.has(step.type) ? step.type : 'regular';
  const goal = step.goal || null;
  return {
    id: step.id,
    name: step.name || '',
    mandatory: !!step.mandatory,
    type,
    photo: step.photo || 'none',
    number: step.number ? { label: step.number.label || '', unit: step.number.unit || '', required: !!step.number.required, showSum: !!step.number.showSum, showDiff: !!step.number.showDiff, showAvg: !!step.number.showAvg } : null,
    note: step.note === 'optional' ? 'optional' : 'none',
    hasGoal: type === 'regular' && !!goal,
    target: goal ? String(goal.target) : '',
    dir: goal ? goal.dir : defaultDirFor(type),
    macroTargets: macroTargetsToDraft(type === 'food' ? step.macros : null),
    reminders: remindersToDraft(step.reminders),
  };
}

function defaultStep() {
  return { id: makeStepId(), name: '', mandatory: true, type: 'regular', photo: 'none', number: null, note: 'none', hasGoal: false, target: '', dir: 'atLeast', macroTargets: macroTargetsToDraft(null), reminders: remindersToDraft(null) };
}

function switchRow(label, role, checked) {
  return `<div class="row">
    <span class="row-label">${esc(label)}</span>
    <input type="checkbox" class="switch" data-role="${role}" ${checked ? 'checked' : ''} />
  </div>`;
}

function segmentedRow(draft) {
  const options = [['none', 'None'], ['optional', 'Optional'], ['required', 'Required']];
  const inputs = options.map(([value, label]) =>
    `<label><input type="radio" name="step-photo" value="${value}" data-role="photo-option" ${draft.photo === value ? 'checked' : ''}><span>${esc(label)}</span></label>`
  ).join('');
  return `<div class="row">
    <span class="row-label">Photo</span>
    <div class="segmented">${inputs}</div>
  </div>`;
}

function typeRow(draft) {
  const inputs = TYPE_OPTIONS.map(([value, label]) =>
    `<label><input type="radio" name="step-type" value="${value}" data-role="type-option" ${draft.type === value ? 'checked' : ''}><span>${esc(label)}</span></label>`
  ).join('');
  return `<div class="row">
    <span class="row-label">Type</span>
    <div class="segmented segmented-wrap">${inputs}</div>
  </div>`;
}

function numberSubRows(draft) {
  if (!draft.number) return '';
  return `<div class="row">
      <span class="field-label">Label</span>
      <input type="text" data-role="number-label" value="${esc(draft.number.label)}" placeholder="Value" />
    </div>
    <div class="row">
      <span class="field-label">Unit</span>
      <input type="text" data-role="number-unit" value="${esc(draft.number.unit)}" placeholder="e.g. kg" />
    </div>
    ${switchRow('Required', 'number-required', draft.number.required)}
    ${switchRow('Stats: show total', 'number-sum', draft.number.showSum)}
    ${switchRow('Stats: show change (start → now)', 'number-diff', draft.number.showDiff)}
    ${switchRow('Stats: show average', 'number-avg', draft.number.showAvg)}`;
}

// Optional Goal row for a custom step with Number on — "at least"/"at most"
// plus a target. Off by default; toggled with the same switch pattern as
// Photo/Number/Note above.
function goalSubRowHtml(draft) {
  const dirOptions = [['atLeast', 'At least'], ['atMost', 'At most']];
  const dirSelect = `<select data-role="goal-dir">${dirOptions.map(([v, l]) => `<option value="${v}" ${draft.dir === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const fieldsHtml = draft.hasGoal
    ? `<div class="row">
        <span class="field-label">Target</span>
        <input type="text" inputmode="decimal" data-role="goal-target" value="${esc(draft.target)}" />
      </div>
      <div class="row"><span class="field-label">Direction</span>${dirSelect}</div>`
    : '';
  return `${switchRow('Goal', 'goal-toggle', draft.hasGoal)}${fieldsHtml}`;
}

// The Target row shown for every typed (non-custom) step except Body, which
// never has a goal — it's just logged from Today, tracked in Stats.
function typedGoalRowHtml(draft) {
  if (draft.type === 'body') {
    return `<div class="section-footer">Weight is logged from Today. No target — tracked in Stats.</div>`;
  }
  const meta = TYPE_META[draft.type];
  return `<div class="row">
    <span class="field-label">Target</span>
    <input type="text" inputmode="decimal" data-role="goal-target" value="${esc(draft.target)}" />
    <span class="field-unit">${esc(meta.unit)}</span>
  </div>
  <div class="row"><span class="field-label">Direction</span><span class="row-value">${esc(dirLabel(draft.dir))}</span></div>`;
}

// Four target rows (Protein/Carbs/Fat/Fiber, in g) shown only for a food
// step, prefilled from draft.macroTargets. Direction is fixed per macro
// (MACRO_DIRS) and shown as a label, never editable — see docs §9.
function macroRowsHtml(draft) {
  if (draft.type !== 'food') return '';
  return MACRO_KEYS.map((key) => `<div class="row">
    <span class="field-label">${esc(MACRO_META[key].label)} (${esc(dirLabel(MACRO_DIRS[key]))})</span>
    <input type="text" inputmode="decimal" data-role="macro-target" data-macro-key="${key}" value="${esc(draft.macroTargets[key])}" />
    <span class="field-unit">g</span>
  </div>`).join('');
}

// Goals-only body for a step of an existing challenge: the step itself
// (type, name, mandatory, photo/number/note) is fixed once the challenge
// exists — only its targets can change.
function goalsOnlyBodyHtml(draft, error) {
  const isCustom = draft.type === 'regular';
  let rowsHtml;
  if (draft.type === 'body') rowsHtml = typedGoalRowHtml(draft);
  else if (isCustom) rowsHtml = draft.number ? goalSubRowHtml(draft) : '';
  else rowsHtml = `${typedGoalRowHtml(draft)}${macroRowsHtml(draft)}`;
  const emptyHtml = rowsHtml ? '' : '<div class="section-footer">This step has no number, so it has no goal to edit.</div>';
  const errorHtml = error ? `<div class="section-footer error">${esc(error)}</div>` : '';
  return `<div class="group">
    <div class="row"><span class="field-label">Step</span><span class="row-value">${esc(draft.name)}</span></div>
    ${rowsHtml}
  </div>
  ${emptyHtml}${remindersGroupHtml(draft)}${errorHtml}
  <div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
    <button type="button" class="btn btn-primary" data-role="save">Save</button>
  </div>`;
}

function bodyHtml(draft, error, editing) {
  const isCustom = draft.type === 'regular';
  const isFood = draft.type === 'food';
  const customRowsHtml = isCustom ? `
    ${segmentedRow(draft)}
    ${switchRow('Number', 'number-toggle', !!draft.number)}
    ${numberSubRows(draft)}
    ${draft.number ? goalSubRowHtml(draft) : ''}
    ${switchRow('Note', 'note-toggle', draft.note === 'optional')}` : '';
  const typedRowsHtml = isCustom ? '' : `${typedGoalRowHtml(draft)}${macroRowsHtml(draft)}`;
  const foodFooterHtml = isFood
    ? `<div class="section-footer">Add meals by photo; calories are estimated by Gemini and totalled per day.</div>`
    : '';

  const groupHtml = `<div class="group">
    ${typeRow(draft)}
    <div class="row">
      <span class="field-label">Name</span>
      <input type="text" data-role="name" value="${esc(draft.name)}" placeholder="Step name" />
    </div>
    ${switchRow('Mandatory', 'mandatory', draft.mandatory)}
    ${typedRowsHtml}
    ${customRowsHtml}
  </div>
  ${foodFooterHtml}
  ${remindersGroupHtml(draft)}`;

  const errorHtml = error ? `<div class="section-footer error">${esc(error)}</div>` : '';

  const footerHtml = `<div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
    <button type="button" class="btn btn-primary" data-role="save">Save</button>
  </div>
  ${editing ? '<button type="button" class="btn btn-danger" data-role="delete">Delete step</button>' : ''}`;

  return `${groupHtml}${errorHtml}${footerHtml}`;
}

// Parses a Target field: '' or junk -> null (caller treats as "not set").
function parseTargetOrNull(str) {
  const t = String(str ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Builds step.macros from the four draft target fields: empty/invalid input
// omits that macro entirely; null (not {}) once all four are empty — see
// docs §9.
function buildMacrosFromDraft(macroTargets) {
  const macros = {};
  let any = false;
  for (const key of MACRO_KEYS) {
    const target = parseTargetOrNull(macroTargets[key]);
    if (target !== null && target > 0) {
      macros[key] = { target, dir: MACRO_DIRS[key] };
      any = true;
    }
  }
  return any ? macros : null;
}

// `opts.goalsOnly`: editing a step of an existing challenge — only its
// goal/target fields are shown and saved (see goalsOnlyBodyHtml).
export function openStepEditor(step, onSave, onDelete, opts = {}) {
  const goalsOnly = !!(opts.goalsOnly && step);
  const editing = !!step;
  const draft = editing ? cloneStep(step) : defaultStep();
  let error = '';
  // The step's own original type/goal (if any), so toggling the Type radio
  // back to what it started as restores the original target/direction
  // instead of resetting to the type's bare default.
  const originalType = editing ? (step.type && KNOWN_TYPES.has(step.type) ? step.type : 'regular') : null;
  const originalGoal = editing ? (step.goal || null) : null;
  const originalMacros = editing && originalType === 'food' ? (step.macros || null) : null;

  const render = () => `<div id="step-editor-root">${goalsOnly ? goalsOnlyBodyHtml(draft, error) : bodyHtml(draft, error, editing)}</div>`;
  let currentSheetEl = null;

  const close = openSheet({
    title: goalsOnly ? 'Edit goal' : editing ? 'Edit step' : 'New step',
    bodyHtml: render(),
    onMount: (sheetEl, closeFn) => wire(sheetEl, closeFn),
  });

  function rerender(sheetEl) {
    const root = sheetEl.querySelector('#step-editor-root');
    if (root) root.outerHTML = render();
  }

  function doSave(closeFn) {
    const name = draft.name.trim();
    if (!name) {
      error = 'Give the step a name.';
      rerender(currentSheetEl);
      return;
    }

    let finalStep;
    if (draft.type === 'regular') {
      let goal = null;
      if (draft.hasGoal && draft.number) {
        const target = parseTargetOrNull(draft.target);
        if (target === null || target <= 0) {
          error = 'Enter a valid goal target.';
          rerender(currentSheetEl);
          return;
        }
        goal = { target, dir: draft.dir === 'atMost' ? 'atMost' : 'atLeast' };
      }
      finalStep = {
        id: draft.id,
        name,
        mandatory: draft.mandatory,
        photo: draft.photo,
        number: draft.number ? {
          label: draft.number.label.trim() || 'Value',
          unit: draft.number.unit.trim(),
          required: draft.number.required,
          showSum: draft.number.showSum,
          showDiff: draft.number.showDiff,
          showAvg: draft.number.showAvg,
        } : null,
        note: draft.note,
        goal,
      };
    } else if (draft.type === 'body') {
      finalStep = makeTypedStep('body', { id: draft.id, name, mandatory: draft.mandatory, goal: null });
    } else {
      const target = parseTargetOrNull(draft.target);
      if (target === null || target <= 0) {
        error = 'Enter a valid target.';
        rerender(currentSheetEl);
        return;
      }
      const dir = draft.type === 'food' ? draft.dir : FIXED_DIR[draft.type];
      const macros = draft.type === 'food' ? buildMacrosFromDraft(draft.macroTargets) : undefined;
      finalStep = makeTypedStep(draft.type, { id: draft.id, name, mandatory: draft.mandatory, goal: { target, dir }, macros });
    }
    if (goalsOnly) {
      // Only the targets change; everything else about the step is kept.
      const updated = { ...step, goal: finalStep.goal ?? null };
      if (step.type === 'food') updated.macros = finalStep.macros ?? null;
      const reminders = buildRemindersFromDraft(draft.reminders);
      if (reminders) updated.reminders = reminders;
      else delete updated.reminders;
      onSave(updated);
    } else {
      const reminders = buildRemindersFromDraft(draft.reminders);
      if (reminders) finalStep.reminders = reminders;
      onSave(finalStep);
    }
    closeFn();
  }

  function wire(sheetEl, closeFn) {
    currentSheetEl = sheetEl;

    sheetEl.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (role === 'name') draft.name = e.target.value;
      else if (role === 'number-label') draft.number.label = e.target.value;
      else if (role === 'number-unit') draft.number.unit = e.target.value;
      else if (role === 'goal-target') draft.target = e.target.value;
      else if (role === 'macro-target') draft.macroTargets[e.target.dataset.macroKey] = e.target.value;
      // Draft state only — re-rendering here would close the phone keyboard.
      else if (role === 'reminder-time') draft.reminders.times[Number(e.target.dataset.index)] = e.target.value;
    });

    sheetEl.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'mandatory') {
        draft.mandatory = e.target.checked;
      } else if (role === 'type-option') {
        draft.type = e.target.value;
        if (draft.type === originalType && originalGoal) {
          draft.dir = originalGoal.dir;
          draft.target = String(originalGoal.target);
        } else {
          draft.dir = defaultDirFor(draft.type);
        }
        draft.macroTargets = macroTargetsToDraft(draft.type === originalType ? originalMacros : null);
        rerender(sheetEl);
      } else if (role === 'photo-option') {
        draft.photo = e.target.value;
      } else if (role === 'number-toggle') {
        draft.number = e.target.checked ? { label: 'Value', unit: '', required: false, showSum: false, showDiff: false, showAvg: false } : null;
        if (!draft.number) draft.hasGoal = false;
        rerender(sheetEl);
      } else if (role === 'number-required') {
        draft.number.required = e.target.checked;
      } else if (role === 'number-sum') {
        draft.number.showSum = e.target.checked;
      } else if (role === 'number-diff') {
        draft.number.showDiff = e.target.checked;
      } else if (role === 'number-avg') {
        draft.number.showAvg = e.target.checked;
      } else if (role === 'note-toggle') {
        draft.note = e.target.checked ? 'optional' : 'none';
      } else if (role === 'goal-toggle') {
        draft.hasGoal = e.target.checked;
        rerender(sheetEl);
      } else if (role === 'goal-dir') {
        draft.dir = e.target.value;
      } else if (role === 'reminder-sound') {
        draft.reminders.sound = e.target.checked;
      } else if (role === 'reminder-vibrate') {
        draft.reminders.vibrate = e.target.checked;
      }
    });

    sheetEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="cancel"]')) {
        closeFn();
        return;
      }
      if (e.target.closest('[data-role="reminder-add"]')) {
        // The permission request must come from this tap (a user gesture).
        // Times are saved whether or not it's granted.
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            const asked = Notification.requestPermission();
            if (asked && typeof asked.then === 'function') asked.then(() => rerender(sheetEl)).catch(() => {});
          }
        } catch (_) {
          // unsupported — the footer note explains
        }
        if (draft.reminders.times.length < MAX_REMINDERS) draft.reminders.times.push(nextReminderTime(draft.reminders.times));
        rerender(sheetEl);
        return;
      }
      const removeBtn = e.target.closest('[data-role="reminder-remove"]');
      if (removeBtn) {
        draft.reminders.times.splice(Number(removeBtn.dataset.index), 1);
        rerender(sheetEl);
        return;
      }
      if (e.target.closest('[data-role="save"]')) {
        doSave(closeFn);
        return;
      }
      if (e.target.closest('[data-role="delete"]')) {
        onDelete?.();
        closeFn();
      }
    });
  }

  return close;
}
