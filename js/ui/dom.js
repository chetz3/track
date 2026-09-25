// Small DOM/formatting helpers shared by screen renderers. Moved out of the
// old monolithic app.js so screen modules (Tasks 6-9) can import just this.

import { getPhotoUrl } from '../photos.js';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_ABBR[dt.getDay()]}, ${d} ${MONTH_ABBR[m - 1]} ${y}`;
}

export function formatMonthLong(y, m) {
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// "Thu, 25 Sep" — like formatDateLong but without the year, for messages
// that name a specific day inline (photo-date mismatch warning).
export function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_ABBR[dt.getDay()]}, ${d} ${MONTH_ABBR[m - 1]}`;
}

// Object URLs handed out by hydratePhotos, tracked per render/sheet scope
// (the nearest `[data-render-root]` ancestor of the element hydratePhotos
// was called on) rather than in one global list. A screen's own photos must
// never be revoked by a *different* screen's render finishing later, so
// each scope owns and revokes only the URLs it created.
const urlsByScope = new WeakMap();

export async function hydratePhotos(root) {
  const scope = root.closest('[data-render-root]') || root;
  const imgs = root.querySelectorAll('img[data-photo-id]');
  for (const img of imgs) {
    const id = img.dataset.photoId;
    if (!id) continue;
    const url = await getPhotoUrl(id);
    if (!url) continue;
    if (!scope.isConnected) {
      // The scope was torn down (superseded render, closed sheet) while
      // this photo was loading — never let it leak.
      URL.revokeObjectURL(url);
      continue;
    }
    img.src = url;
    let urls = urlsByScope.get(scope);
    if (!urls) urlsByScope.set(scope, (urls = []));
    urls.push(url);
  }
}

// Revokes every object URL recorded for `scope` (a `[data-render-root]`
// element) and forgets it. Callers: the router, when a screen's container
// is superseded by the next render; the sheet, when it's removed.
export function revokePhotosIn(scope) {
  const urls = urlsByScope.get(scope);
  if (!urls) return;
  for (const url of urls) URL.revokeObjectURL(url);
  urlsByScope.delete(scope);
}

// Reads the first selected File off a file input, or null if none chosen.
export function readFileAsPhoto(inputEl) {
  return (inputEl && inputEl.files && inputEl.files[0]) || null;
}
