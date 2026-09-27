// Export/import the whole database as a single JSON backup file.
// Photos are embedded as base64 data URLs so the backup is one portable file.

import { getAll, replaceAll } from './db.js';
import { migrateV1, dayKey } from './migrate.js';

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const PHOTO_DATA_URL_RE = /^data:image\/[a-z+.-]+;base64,/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const [challenges, attempts, days, photos] = await Promise.all([
    getAll('challenges'),
    getAll('attempts'),
    getAll('days'),
    getAll('photos'),
  ]);
  const photosEncoded = await Promise.all(
    photos.map(async (p) => ({ id: p.id, createdAt: p.createdAt, data: await blobToBase64(p.blob) })),
  );
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    challenges,
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

// Upgrades a v1-shaped backup (or passes through a v2 one) to the v2 shape
// using the same pure migration the IndexedDB in-upgrade path uses.
export function toV2(backup) {
  if (backup.version === 2) return backup;
  if (Array.isArray(backup.config) || backup.version === 1) {
    const v1config = Array.isArray(backup.config) ? backup.config[0] : undefined;
    const out = migrateV1({ config: v1config, attempts: backup.attempts || [], days: backup.days || [] });
    return { version: 2, ...out, photos: backup.photos || [] };
  }
  throw new Error('Invalid backup file');
}

function isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

const STEP_PHOTO_VALUES = new Set(['none', 'optional', 'required']);
const STEP_NOTE_VALUES = new Set(['none', 'optional']);

// A step's `number` field is either null or an object describing a numeric
// input (weight, reps, ...): { label: string, unit: string, required: boolean }.
function isValidNumberField(n) {
  if (n === null) return true;
  if (!isObject(n)) return false;
  return typeof n.label === 'string' && typeof n.unit === 'string' && typeof n.required === 'boolean';
}

// Matches exactly the shape migrate.js and js/ui/stepEditor.js produce (see
// BODY_STEP/migrateStep and doSave): id/name are strings, photo/note are one
// of a small fixed set of values (never missing — both migration paths and
// the step editor always set them), and number is null or a well-shaped object.
function isValidStep(s) {
  if (!isObject(s)) return false;
  if (typeof s.id !== 'string' || s.id.length === 0) return false;
  if (typeof s.name !== 'string') return false;
  if ('mandatory' in s && typeof s.mandatory !== 'boolean') return false;
  if (!STEP_PHOTO_VALUES.has(s.photo)) return false;
  if (!STEP_NOTE_VALUES.has(s.note)) return false;
  if (!isValidNumberField(s.number)) return false;
  return true;
}

// Rejects anything that would let a crafted backup smuggle a non-numeric
// totalDays/weeklyTarget (stored XSS once interpolated into innerHTML
// elsewhere) or an out-of-range one (e.g. 1e9, which hangs evaluateAttempt's
// day-by-day walk on every boot).
function isValidChallenge(c) {
  if (!isObject(c)) return false;
  if (typeof c.id !== 'string' || c.id.length === 0) return false;
  if (typeof c.name !== 'string' || c.name.length === 0) return false;
  if (!Number.isInteger(c.totalDays) || c.totalDays < 1 || c.totalDays > 1000) return false;
  if (!Number.isInteger(c.weeklyTarget) || c.weeklyTarget < 1 || c.weeklyTarget > 7) return false;
  if (!Array.isArray(c.steps) || !c.steps.every(isValidStep)) return false;
  return true;
}

export function validateV2(b) {
  const bad = () => { throw new Error('Invalid backup file'); };
  if (!Array.isArray(b.challenges) || !Array.isArray(b.attempts) || !Array.isArray(b.days) || !Array.isArray(b.photos)) bad();
  const ids = new Set();
  for (const c of b.challenges) {
    if (!isValidChallenge(c)) bad();
    ids.add(c.id);
  }
  for (const a of b.attempts) {
    if (!isObject(a) || typeof a.id !== 'string' || !ids.has(a.challengeId) || !DATE_RE.test(a.startDate)) bad();
    if ('greenWeeks' in a && !(Number.isInteger(a.greenWeeks) && a.greenWeeks >= 0)) bad();
  }
  for (const d of b.days) {
    if (!isObject(d) || !DATE_RE.test(d.date) || !ids.has(d.challengeId) || d.key !== dayKey(d.challengeId, d.date)) bad();
    // steps must be a plain object (not null, not an array) — loadAll/reevaluate
    // iterate it with Object.entries/Object.values and crash on anything else.
    if (!isObject(d.steps)) bad();
  }
  for (const p of b.photos) {
    if (!isObject(p) || typeof p.id !== 'string' || p.id.length === 0) bad();
  }
}

// Replaces ALL data in the database with the contents of the backup.
// Caller is responsible for confirming with the user first.
// Everything is validated and decoded BEFORE any existing data is cleared,
// so a corrupt/partial file fails loudly without wiping the user's data.
// The clear + write itself is one atomic IndexedDB transaction (replaceAll),
// so a mid-write failure (e.g. QuotaExceededError restoring a photo) aborts
// the whole transaction and leaves the previous data intact.
export async function importBackup(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid backup file');

  const backup = toV2(parsed);
  validateV2(backup);

  const photoRecords = backup.photos.map((p) => ({
    id: p.id,
    blob: decodePhotoDataUrl(p.data),
    createdAt: p.createdAt,
  }));

  await replaceAll([
    ...backup.challenges.map((value) => ({ store: 'challenges', value })),
    ...backup.attempts.map((value) => ({ store: 'attempts', value })),
    ...backup.days.map((value) => ({ store: 'days', value })),
    ...photoRecords.map((value) => ({ store: 'photos', value })),
  ]);
  return backup;
}
