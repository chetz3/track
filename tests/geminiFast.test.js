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

const { checkBody } = await import('../js/gemini.js');

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

test('first request goes to Flash-Lite with minimal thinking and a fast instruction', async () => {
  stubFetch([okRes()]);
  const r = await checkBody(blob(), {});
  assert.equal(calls.length, 1);
  const b = calls[0].body;
  assert.ok(calls[0].url.includes('gemini-3.5-flash-lite'));
  assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
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

test('503 on first model falls back to the next model', async () => {
  stubFetch([errRes(503, ''), okRes()]);
  await checkBody(blob(), {});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('gemini-3.6-flash'));
});

test('a 400 the model rejects (not thinking, not key) moves on to the next model', async () => {
  stubFetch([errRes(400, '{"error":{"message":"Unknown name"}}'), okRes()]);
  const r = await checkBody(blob(), {});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('gemini-3.6-flash'));
  assert.equal(r.build, 'average');
});

test('400 on every model shows Google\'s message', async () => {
  const bad = () => errRes(400, '{"error":{"message":"Invalid value at response_schema"}}');
  stubFetch([bad(), bad(), bad()]);
  await assert.rejects(checkBody(blob(), {}), { message: /Gemini error \(400\): Invalid value/ });
});
