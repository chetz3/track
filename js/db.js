// Thin promise wrapper over IndexedDB. No rules/business logic here.

const DB_NAME = 'tracker';
const DB_VERSION = 1;

export const CONFIG_KEY = 'main';

const STORE_KEYPATHS = {
  config: 'id',
  attempts: 'id',
  days: 'date',
  photos: 'id',
};

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORE_KEYPATHS)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

export async function clearAll() {
  for (const name of Object.keys(STORE_KEYPATHS)) {
    await clear(name);
  }
}

export async function getConfig() {
  return get('config', CONFIG_KEY);
}

export async function setConfig(config) {
  return put('config', { ...config, id: CONFIG_KEY });
}
