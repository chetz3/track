// Export/import the whole database as a single JSON backup file.
// Photos are embedded as base64 data URLs so the backup is one portable file.

import { getAll, clearAll, put } from './db.js';

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const PHOTO_DATA_URL_RE = /^data:image\/[a-z+.-]+;base64,/;
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function hasStringId(record) {
  return !!record && typeof record.id === 'string' && record.id.length > 0;
}

function hasDateKey(day) {
  return !!day && typeof day.date === 'string' && DATE_STR_RE.test(day.date);
}

// Decodes a data: URL to a Blob by hand (atob), never via fetch() — fetch()
// treats a malformed/non-data-URL string as a relative URL and will
// silently fetch and store an unrelated page as the "photo".
function decodePhotoDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' && PHOTO_DATA_URL_RE.exec(dataUrl);
  if (!match) throw new Error('Invalid backup file');
  const mime = dataUrl.slice('data:'.length, dataUrl.indexOf(';'));
  let binary;
  try {
    binary = atob(dataUrl.slice(match[0].length));
  } catch (_) {
    throw new Error('Invalid backup file');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function downloadFile(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function buildBackupJson() {
  const [config, attempts, days, photos] = await Promise.all([
    getAll('config'),
    getAll('attempts'),
    getAll('days'),
    getAll('photos'),
  ]);
  const photosEncoded = await Promise.all(
    photos.map(async (p) => ({ id: p.id, createdAt: p.createdAt, data: await blobToBase64(p.blob) })),
  );
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    config,
    attempts,
    days,
    photos: photosEncoded,
  };
  return JSON.stringify(backup);
}

// Shares the backup as a file where supported (mobile), otherwise triggers
// a plain download. Returns { method: 'share' | 'download' | 'cancelled' }.
export async function exportBackup() {
  const json = await buildBackupJson();
  const filename = `tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], filename, { type: 'application/json' });

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return { method: 'share' };
    } catch (err) {
      if (err && err.name === 'AbortError') return { method: 'cancelled' };
      // fall through to download on any other share failure
    }
  }
  downloadFile(json, filename);
  return { method: 'download' };
}

// Replaces ALL data in the database with the contents of the backup.
// Caller is responsible for confirming with the user first.
// Everything is validated and decoded BEFORE any existing data is cleared,
// so a corrupt/partial file fails loudly without wiping the user's data.
export async function importBackup(jsonText) {
  const backup = JSON.parse(jsonText);
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.days)) {
    throw new Error('Invalid backup file');
  }
  const config = Array.isArray(backup.config) ? backup.config : [];
  const attempts = Array.isArray(backup.attempts) ? backup.attempts : [];
  const days = backup.days;
  const photos = Array.isArray(backup.photos) ? backup.photos : [];

  if (!config.every(hasStringId)) throw new Error('Invalid backup file');
  if (!attempts.every(hasStringId)) throw new Error('Invalid backup file');
  if (!days.every(hasDateKey)) throw new Error('Invalid backup file');
  if (!photos.every(hasStringId)) throw new Error('Invalid backup file');

  const photoRecords = photos.map((p) => ({
    id: p.id,
    blob: decodePhotoDataUrl(p.data),
    createdAt: p.createdAt,
  }));

  await clearAll();
  for (const c of config) await put('config', c);
  for (const a of attempts) await put('attempts', a);
  for (const d of days) await put('days', d);
  for (const p of photoRecords) await put('photos', p);
  return backup;
}
