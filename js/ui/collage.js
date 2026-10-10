// Builds the one 768x768 JPEG collage of weekly body photos sent to Gemini
// (one image tile). Never stored: the caller owns the returned Blob.

import { getPhotoBlob } from '../photos.js';

const SIZE = 768;
const CELL = SIZE / 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelFor(p) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.date || '');
  const d = m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
  return Number.isFinite(p.kg) ? `${d} · ${p.kg} kg` : d;
}

// -> { src, w, h, release() } or null when the photo can't be decoded.
async function loadImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { src: bmp, w: bmp.width, h: bmp.height, release: () => { try { bmp.close(); } catch (_) { /* ignore */ } } };
    } catch (_) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (_) {
    URL.revokeObjectURL(url);
    return null;
  }
}

export async function buildBodyCollage(picks) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.font = '18px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < Math.min(4, picks.length); i++) {
    const p = picks[i];
    const x = (i % 2) * CELL;
    const y = Math.floor(i / 2) * CELL;
    const blob = await getPhotoBlob(p.photoId);
    const img = blob ? await loadImage(blob) : null;
    if (img && img.w && img.h) {
      // centre-cropped "cover" fit
      const scale = Math.max(CELL / img.w, CELL / img.h);
      const sw = CELL / scale;
      const sh = CELL / scale;
      ctx.drawImage(img.src, (img.w - sw) / 2, (img.h - sh) / 2, sw, sh, x, y, CELL, CELL);
    }
    if (img) img.release();
    const text = labelFor(p);
    if (text) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y + CELL - 32, Math.min(CELL, ctx.measureText(text).width + 20), 32);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 10, y + CELL - 16);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't build the photo collage."))), 'image/jpeg', 0.7);
  });
}
