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

async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
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
export async function importBackup(jsonText) {
  const backup = JSON.parse(jsonText);
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.days)) {
    throw new Error('Invalid backup file');
  }
  await clearAll();
  for (const c of backup.config || []) await put('config', c);
  for (const a of backup.attempts || []) await put('attempts', a);
  for (const d of backup.days || []) await put('days', d);
  for (const p of backup.photos || []) {
    const blob = await base64ToBlob(p.data);
    await put('photos', { id: p.id, blob, createdAt: p.createdAt });
  }
  return backup;
}
