import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: (k) => (k === 'tracker:geminiKey' ? 'AIzaTESTKEY_xxxxxxxxxxxxxxxx' : null),
  setItem() {},
  removeItem() {},
};
if (!globalThis.navigator || globalThis.navigator.onLine === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
}
globalThis.location = { hostname: 'example.com' };
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,eA==';
      setImmediate(() => this.onloadend && this.onloadend());
    }
  };
}

const { checkBody, attemptBudget } = await import('../js/gemini.js');

const okRes = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ bmi: 24, build: 'average', bellyFat: 'low', note: 'n', focus: ['a'] }) }] } }],
  }),
  text: async () => '',
});
const errRes = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });

let calls;
function stubFetch(responses) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return responses[calls.length - 1];
  };
}
const blob = () => new Blob(['x'], { type: 'image/jpeg' });

beforeEach(() => { calls = []; });

test('first request disables thinking and sets a fast instruction', async () => {
  stubFetch([okRes()]);
  const r = await checkBody(blob(), {});
  assert.equal(calls.length, 1);
  const b = calls[0].body;
  assert.equal(b.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.ok(b.systemInstruction.parts[0].text.length > 0);
  assert.ok(b.generationConfig.responseSchema);
  assert.equal(r.build, 'average');
});

test('400 mentioning thinking resends once without thinkingConfig', async () => {
  stubFetch([errRes(400, 'Budget 0 is invalid. This model only works in thinking mode.'), okRes()]);
  const r = await checkBody(blob(), {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  assert.equal(r.build, 'average');
});

test('other 400 is not resent and keeps its friendly message', async () => {
  stubFetch([errRes(400, 'API_KEY_INVALID')]);
  await assert.rejects(checkBody(blob(), {}), { message: 'Gemini API key is invalid.' });
  assert.equal(calls.length, 1);
});

test('503 on first model falls back to the lite model', async () => {
  stubFetch([errRes(503, ''), okRes()]);
  await checkBody(blob(), {});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('flash-lite'));
});

test('attemptBudget: first model capped at 6500, fallback gets the rest, tiny remainder skipped', () => {
  assert.equal(attemptBudget(0, 10000), 6500);
  assert.equal(attemptBudget(0, 4000), 4000);
  assert.equal(attemptBudget(1, 3500), 3500);
  assert.equal(attemptBudget(1, 1499), 0);
  assert.equal(attemptBudget(0, 0), 0);
});

const flush = () => new Promise((r) => setImmediate(r));

// A fetch that never answers until its signal aborts.
const hangFetch = () => {
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    calls.push({ url });
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
};

test('timeout on every model gives the too-long message, not offline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  calls = [];
  hangFetch();
  const p = checkBody(blob(), {});
  const done = assert.rejects(p, { message: /took too long/ });
  await flush(); t.mock.timers.tick(6500); await flush(); t.mock.timers.tick(3500);
  await done;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('flash-lite'));
});

test('flash timeout falls back to lite which succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  calls = [];
  let n = 0;
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    calls.push({ url });
    if (++n === 1) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    else resolve(okRes());
  });
  const p = checkBody(blob(), {});
  await flush(); t.mock.timers.tick(6500); await flush();
  const r = await p;
  assert.equal(r.build, 'average');
  assert.equal(calls.length, 2);
});
