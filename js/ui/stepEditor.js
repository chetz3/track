// Step editor sheet: create/edit a single challenge step (name, mandatory,
// photo/number/note requirements) and optionally delete it.
//
// This is a self-contained sheet component: all draft state lives in this
// module's closure for the lifetime of one openStepEditor() call. It is
// never touched by the router's store-driven re-renders (the sheet is
// appended to document.body, outside #app), so — unlike the screen modules
// — it doesn't need module-scope state keyed by route.

import { openSheet } from './sheet.js';
import { esc } from './dom.js';

function makeStepId() {
  return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function cloneStep(step) {
  return {
    id: step.id,
    name: step.name || '',
    mandatory: !!step.mandatory,
    photo: step.photo || 'none',
    number: step.number ? { label: step.number.label || '', unit: step.number.unit || '', required: !!step.number.required, showSum: !!step.number.showSum, showDiff: !!step.number.showDiff, showAvg: !!step.number.showAvg } : null,
    note: step.note === 'optional' ? 'optional' : 'none',
  };
}

function defaultStep() {
  return { id: makeStepId(), name: '', mandatory: true, photo: 'none', number: null, note: 'none' };
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

function bodyHtml(draft, error, editing) {
  const groupHtml = `<div class="group">
    <div class="row">
      <span class="field-label">Name</span>
      <input type="text" data-role="name" value="${esc(draft.name)}" placeholder="Step name" />
    </div>
    ${switchRow('Mandatory', 'mandatory', draft.mandatory)}
    ${segmentedRow(draft)}
    ${switchRow('Number', 'number-toggle', !!draft.number)}
    ${numberSubRows(draft)}
    ${switchRow('Note', 'note-toggle', draft.note === 'optional')}
  </div>`;

  const errorHtml = error ? `<div class="section-footer error">${esc(error)}</div>` : '';

  const footerHtml = `<div class="btn-pair">
    <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
    <button type="button" class="btn btn-primary" data-role="save">Save</button>
  </div>
  ${editing ? '<button type="button" class="btn btn-danger" data-role="delete">Delete step</button>' : ''}`;

  return `${groupHtml}${errorHtml}${footerHtml}`;
}

export function openStepEditor(step, onSave, onDelete) {
  const editing = !!step;
  const draft = editing ? cloneStep(step) : defaultStep();
  let error = '';

  const render = () => `<div id="step-editor-root">${bodyHtml(draft, error, editing)}</div>`;
  let currentSheetEl = null;

  const close = openSheet({
    title: editing ? 'Edit step' : 'New step',
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
    const finalStep = {
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
    };
    onSave(finalStep);
    closeFn();
  }

  function wire(sheetEl, closeFn) {
    currentSheetEl = sheetEl;

    sheetEl.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (role === 'name') draft.name = e.target.value;
      else if (role === 'number-label') draft.number.label = e.target.value;
      else if (role === 'number-unit') draft.number.unit = e.target.value;
    });

    sheetEl.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'mandatory') {
        draft.mandatory = e.target.checked;
      } else if (role === 'photo-option') {
        draft.photo = e.target.value;
      } else if (role === 'number-toggle') {
        draft.number = e.target.checked ? { label: 'Value', unit: '', required: false, showSum: false, showDiff: false, showAvg: false } : null;
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
      }
    });

    sheetEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="cancel"]')) {
        closeFn();
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
