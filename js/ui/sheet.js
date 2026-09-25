// Bottom sheet used for forms/pickers layered over the current screen.
// Only one sheet may be open at a time; opening a new one closes the
// previous immediately (no exit animation, since it's being replaced).

import { esc, revokePhotosIn } from './dom.js';

let current = null; // { id, backdrop, sheet, onKeydown, previousFocus }
let seq = 0;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openSheet({ title, bodyHtml, onMount }) {
  closeSheet(true);

  const id = ++seq;
  const titleId = `sheet-title-${id}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', titleId);
  sheet.setAttribute('tabindex', '-1');
  sheet.dataset.renderRoot = ''; // hydratePhotos() inside the sheet scopes its object URLs to this element
  sheet.innerHTML = `<div class="sheet-grabber"></div><h2 class="sheet-title" id="${titleId}">${esc(title)}</h2>${bodyHtml}`;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open'); });

  // `close` is bound to this sheet's id: once this sheet is no longer
  // `current` (already closed, or replaced by a later openSheet call),
  // calling it is a no-op. Only bare closeSheet() always hits whichever
  // sheet is current.
  const close = () => {
    if (current && current.id === id) closeSheet();
  };

  backdrop.addEventListener('click', close);

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKeydown);

  const previousFocus = document.activeElement;
  current = { id, backdrop, sheet, onKeydown, previousFocus };

  const target = sheet.querySelector(FOCUSABLE_SELECTOR) || sheet;
  target.focus();

  onMount?.(sheet, close);
  return close;
}

export function closeSheet(immediate = false) {
  if (!current) return;
  const { backdrop, sheet, onKeydown, previousFocus } = current;
  current = null;
  document.removeEventListener('keydown', onKeydown);
  if (previousFocus && document.contains(previousFocus)) {
    previousFocus.focus();
  }
  if (immediate) { backdrop.remove(); sheet.remove(); revokePhotosIn(sheet); return; }
  backdrop.classList.remove('open');
  sheet.classList.remove('open');
  setTimeout(() => { backdrop.remove(); sheet.remove(); revokePhotosIn(sheet); }, 300);
}
