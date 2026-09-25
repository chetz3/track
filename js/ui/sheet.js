// Bottom sheet used for forms/pickers layered over the current screen.
// Only one sheet may be open at a time; opening a new one closes the
// previous immediately (no exit animation, since it's being replaced).

let current = null;

export function openSheet({ title, bodyHtml, onMount }) {
  closeSheet(true);
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.innerHTML = `<div class="sheet-grabber"></div><h2 class="sheet-title">${title}</h2>${bodyHtml}`;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open'); });
  const close = () => closeSheet();
  backdrop.addEventListener('click', close);
  current = { backdrop, sheet };
  onMount?.(sheet, close);
  return close;
}

export function closeSheet(immediate = false) {
  if (!current) return;
  const { backdrop, sheet } = current;
  current = null;
  if (immediate) { backdrop.remove(); sheet.remove(); return; }
  backdrop.classList.remove('open');
  sheet.classList.remove('open');
  setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
}
