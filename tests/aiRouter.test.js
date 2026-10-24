import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const { askAI, MODELS } = await import('../js/ai/router.js');
const { toJsonSchema } = await import('../js/ai/schema.js');

const GEMINI = 'tracker:geminiKey';
const GROQ = 'tracker:groqKey';
const OR = 'tracker:openrouterKey';
const keys = { [GEMINI]: 'AIzaTESTKEY_xxxxxxxxxxxxxxxx', [GROQ]: 'gsk_' + 'a'.repeat(24), [OR]: 'sk-or-' + 'b'.repeat(24) };
const setKeys = (...names) => {
  for (const k of Object.keys(store)) delete store[k];
  for (const n of names) store[n] = keys[n];
};

const SCHEMA = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
const geminiOk = (obj = { a: 'x' }) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), text: async () => '' });
const oaiOk = (content = '{"a":"x"}') => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });
const err = (status, text = '') => ({ ok: false, status, json: async () => ({}), text: async () => text });

let calls;
// `route(url, body, n)` returns the response for each call.
function stub(route) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    const r = route(url, body, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
}
const isGemini = (u) => u.includes('googleapis');
const isGroq = (u) => u.includes('groq.com');
const IMG = { inline_data: { mime_type: 'image/jpeg', data: 'eA==' } };

beforeEach(() => { calls = []; console.info = () => {}; console.warn = () => {}; });

test('Gemini 429 falls back to Groq', async () => {
  setKeys(GEMINI, GROQ);
  stub((u) => (isGemini(u) ? err(429, 'PerMinute') : oaiOk()));
  const r = await askAI([{ text: 'hi' }], SCHEMA);
  assert.deepEqual(r, { a: 'x' });
  assert.equal(calls.filter((c) => isGemini(c.url)).length, MODELS.gemini.text.length);
  const groq = calls.find((c) => isGroq(c.url));
  assert.equal(groq.headers.Authorization, 'Bearer ' + keys[GROQ]);
  assert.equal(groq.body.response_format.json_schema.schema.type, 'object');
});

test('only a Groq key: Gemini is never called', async () => {
  setKeys(GROQ);
  stub(() => oaiOk());
  await askAI([{ text: 'hi' }], SCHEMA);
  assert.ok(calls.every((c) => isGroq(c.url)));
});

test('image call uses only the vision models', async () => {
  setKeys(GROQ);
  stub((u, b) => (b.model === MODELS.groq.vision[0] ? oaiOk() : err(500)));
  await askAI([IMG, { text: 'hi' }], SCHEMA);
  assert.deepEqual(calls.map((c) => c.body.model), MODELS.groq.vision);
  assert.equal(calls[0].body.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,eA==');
  setKeys(GROQ);
  stub(() => err(500));
  await assert.rejects(askAI([{ inlineData: { mimeType: 'image/png', data: 'eA==' } }], SCHEMA));
  assert.ok(calls.every((c) => !MODELS.groq.text.includes(c.body.model)));
});

test('parse throwing moves on to the next model', async () => {
  setKeys(GROQ);
  stub((u, b, n) => oaiOk(n === 1 ? '{"a":"bad"}' : '{"a":"good"}'));
  const r = await askAI([{ text: 'hi' }], SCHEMA, { parse: (j) => { if (j.a === 'bad') throw new Error('nope'); return j; } });
  assert.equal(r.a, 'good');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.model, calls[1].body.model);
});

test('401 on Groq skips its other models and tries OpenRouter', async () => {
  setKeys(GROQ, OR);
  stub((u) => (isGroq(u) ? err(401) : oaiOk()));
  await askAI([{ text: 'hi' }], SCHEMA);
  assert.equal(calls.filter((c) => isGroq(c.url)).length, 1);
  const or = calls.find((c) => c.url.includes('openrouter'));
  assert.equal(or.headers['X-OpenRouter-Title'], 'FueLoop');
});

test('every provider failing names each one', async () => {
  setKeys(GEMINI, GROQ);
  stub((u) => (isGemini(u) ? err(429, 'PerDay') : err(503)));
  await assert.rejects(askAI([{ text: 'hi' }], SCHEMA), (e) => {
    assert.match(e.message, /^No AI answered\. /);
    assert.match(e.message, /Gemini: daily limit reached/);
    assert.match(e.message, /Groq: busy/);
    assert.ok(e.message.length < 200);
    return true;
  });
});

test('only Gemini with a daily 429 keeps today\'s message', async () => {
  setKeys(GEMINI);
  stub(() => err(429, 'GenerateRequestsPerDayPerProjectPerModel'));
  await assert.rejects(askAI([{ text: 'hi' }], SCHEMA), { message: 'Gemini free-tier daily limit reached. Try again tomorrow.' });
});

test('no key and offline messages', async () => {
  setKeys();
  await assert.rejects(askAI([{ text: 'hi' }], SCHEMA), { message: 'Add an AI key in Challenges → AI keys.' });
  setKeys(GEMINI, GROQ);
  stub(() => new Error('net'));
  await assert.rejects(askAI([{ text: 'hi' }], SCHEMA, { offlineMessage: 'Offline!' }), { message: 'Offline!' });
  assert.equal(calls.length, 2); // one try per provider, not per model
});

test('json_schema 400 is resent once with json_object', async () => {
  setKeys(GROQ);
  stub((u, b) => (b.response_format.type === 'json_schema' ? err(400, '{"error":{"message":"response_format json_schema unsupported"}}') : oaiOk()));
  const r = await askAI([{ text: 'hi' }], SCHEMA);
  assert.equal(r.a, 'x');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.response_format.type, 'json_object');
  assert.equal(calls[0].body.reasoning_effort, 'low');
});

test('a code fence around the JSON is stripped', async () => {
  setKeys(GROQ);
  stub(() => oaiOk('```json\n{"a":"fenced"}\n```'));
  assert.equal((await askAI([{ text: 'hi' }], SCHEMA)).a, 'fenced');
});

test('toJsonSchema lowercases types deeply and drops non-JSON-Schema keys', () => {
  const out = toJsonSchema({
    type: 'OBJECT',
    required: ['x'],
    nullable: true,
    properties: { x: { type: 'ARRAY', items: { type: 'OBJECT', properties: { y: { type: 'STRING', enum: ['a'], format: 'foo' } } } } },
  });
  assert.deepEqual(out, {
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'array', items: { type: 'object', properties: { y: { type: 'string', enum: ['a'] } } } } },
  });
});
