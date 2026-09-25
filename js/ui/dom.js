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

// Object URLs handed out by hydratePhotos, tracked so they can be revoked
// before the next render (they're only valid for the lifetime of the DOM
// nodes that used them).
let objectUrls = [];

export function revokePhotoUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

export async function hydratePhotos(root) {
  const imgs = root.querySelectorAll('img[data-photo-id]');
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

// Reads the first selected File off a file input, or null if none chosen.
export function readFileAsPhoto(inputEl) {
  return (inputEl && inputEl.files && inputEl.files[0]) || null;
}
