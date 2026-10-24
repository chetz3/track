// Bring-your-own AI keys, one per provider, stored only in this device's
// localStorage (never committed, never sent anywhere but that provider).
// Any one key is enough to turn the AI features on; the router in
// js/ai/router.js tries every provider that has a key, in this order.

export const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    storage: 'tracker:geminiKey', // the original key slot, so saved keys keep working
    // Classic keys look like "AIza…"; newer AI Studio keys like "AQ.…".
    keyRe: /^[A-Za-z0-9._-]{20,}$/,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'starts with AIza or AQ.',
    limits: 'Free, no card. The most generous daily limit.',
  },
  {
    id: 'groq',
    label: 'Groq',
    storage: 'tracker:groqKey',
    keyRe: /^gsk_[A-Za-z0-9]{20,}$/,
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'starts with gsk_',
    limits: 'Free, no card. About 30 a minute and 1,000 a day. Very fast.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    storage: 'tracker:openrouterKey',
    keyRe: /^sk-or-[A-Za-z0-9_-]{20,}$/,
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'starts with sk-or-',
    limits: 'Free models, no card. 50 a day (1,000 a day after a one-time $10 top-up).',
  },
];

const byId = (id) => PROVIDERS.find((p) => p.id === id);

export function getKey(id) {
  const p = byId(id);
  if (!p) return '';
  try {
    return localStorage.getItem(p.storage) || '';
  } catch (_) {
    return '';
  }
}

function notifyKeyChange() {
  try { window.dispatchEvent(new Event('fueloop:aikey')); } catch (_) { /* no window */ }
}

// Returns false (and saves nothing) when the key doesn't look like that
// provider's key.
export function setKey(id, key) {
  const p = byId(id);
  const value = String(key || '').trim();
  if (!p || !p.keyRe.test(value)) return false;
  try {
    localStorage.setItem(p.storage, value);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
  notifyKeyChange();
  return true;
}

export function clearKey(id) {
  const p = byId(id);
  if (!p) return;
  try {
    localStorage.removeItem(p.storage);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
  notifyKeyChange();
}

export function isValidKey(id, key) {
  const p = byId(id);
  return !!p && p.keyRe.test(String(key || '').trim());
}

// Providers that have a saved key, in fallback order.
export function providersWithKeys() {
  return PROVIDERS.filter((p) => getKey(p.id));
}

export function anyKey() {
  return providersWithKeys().length > 0;
}
