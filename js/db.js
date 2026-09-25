// Thin promise wrapper over IndexedDB. No rules/business logic here.

import { migrateV1 } from './migrate.js';

const DB_NAME = 'tracker';
const DB_VERSION = 2;
const STORES = ['challenges', 'attempts', 'days', 'photos'];

function createDaysStore(db) {
  const s = db.createObjectStore('days', { keyPath: 'key' });
  s.createIndex('challengeId', 'challengeId');
}

// Runs inside the versionchange transaction. Uses callbacks (not promises)
// so the transaction can't auto-commit between reads.
function migrateFromV1(db, tx) {
  tx.objectStore('config').get('main').onsuccess = (e1) => {
    const config = e1.target.result;
    tx.objectStore('attempts').getAll().onsuccess = (e2) => {
      const attempts = e2.target.result;
      tx.objectStore('days').getAll().onsuccess = (e3) => {
        const out = migrateV1({ config, attempts, days: e3.target.result });
        db.deleteObjectStore('days');
        createDaysStore(db);
        db.deleteObjectStore('config');
        const ch = tx.objectStore('challenges');
        const at = tx.objectStore('attempts');
        const ds = tx.objectStore('days');
        out.challenges.forEach((c) => ch.put(c));
        out.attempts.forEach((a) => at.put(a));
        out.days.forEach((d) => ds.put(d));
      };
    };
  };
}

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('challenges')) db.createObjectStore('challenges', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('attempts')) db.createObjectStore('attempts', { keyPath: 'id' });
      const attempts = tx.objectStore('attempts');
      if (!attempts.indexNames.contains('challengeId')) attempts.createIndex('challengeId', 'challengeId');
      if (event.oldVersion === 1) migrateFromV1(db, tx);
      else if (!db.objectStoreNames.contains('days')) createDaysStore(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of this app and reload.'));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(storeName, key) {
  const db = await openDB();
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.get(key));
}

export async function getAll(storeName) {
  const db = await openDB();
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.getAll());
}

export async function put(storeName, value) {
  const db = await openDB();
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
  return reqToPromise(store.put(value));
}

export async function del(storeName, key) {
  const db = await openDB();
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
  return reqToPromise(store.delete(key));
}

export async function clear(storeName) {
  const db = await openDB();
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
  return reqToPromise(store.clear());
}

export async function getAllByChallenge(storeName, challengeId) {
  const db = await openDB();
  const idx = db.transaction(storeName, 'readonly').objectStore(storeName).index('challengeId');
  return reqToPromise(idx.getAll(challengeId));
}

export async function putMany(entries) {
  const db = await openDB();
  const names = [...new Set(entries.map((e) => e.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const { store, value } of entries) tx.objectStore(store).put(value);
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export async function deleteChallengeCascade(challengeId) {
  const db = await openDB();
  const tx = db.transaction(STORES, 'readwrite');
  const days = tx.objectStore('days');
  days.index('challengeId').getAll(challengeId).onsuccess = (e) => {
    for (const d of e.target.result) {
      for (const entry of Object.values(d.steps || {})) {
        if (entry && entry.photoId) tx.objectStore('photos').delete(entry.photoId);
      }
      days.delete(d.key);
    }
  };
  const attempts = tx.objectStore('attempts');
  attempts.index('challengeId').getAllKeys(challengeId).onsuccess = (e) => {
    for (const k of e.target.result) attempts.delete(k);
  };
  tx.objectStore('challenges').delete(challengeId);
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export async function clearAll() {
  for (const name of STORES) await clear(name);
}
