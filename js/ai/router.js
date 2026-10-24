// Sends one AI request to the first provider that answers: Gemini, then Groq,
// then OpenRouter, skipping any without a saved key. Prompts, schemas and
// parsers stay with the callers; this only picks the transport. No client-side
// timeout — the API is left to answer.

import { providersWithKeys, getKey } from './keys.js';
import { geminiCall } from './geminiProvider.js';
import { openaiCall } from './openaiCompat.js';

// Tried in order. Gemini: Flash-Lite first, the fastest free model, and every
// answer here is an approximate estimate. Gemini 3.x models take
// thinkingLevel (thinkingBudget is deprecated there, and sending both is a
// 400); "minimal" is the lowest level they accept — 3.x can't switch
// thinking fully off. The alias is a last resort with no thinking config, in
// case Google retires a pinned id.
const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', thinking: { thinkingLevel: 'minimal' } },
  { id: 'gemini-3.6-flash', thinking: { thinkingLevel: 'minimal' } },
  { id: 'gemini-flash-lite-latest', thinking: null },
];

export const MODELS = {
  gemini: { text: GEMINI_MODELS, vision: GEMINI_MODELS },
  groq: { text: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], vision: ['qwen/qwen3.8-27b'] },
  openrouter: {
    text: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    vision: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free'],
  },
};

const hasImage = (parts) => parts.some((p) => p.inline_data || p.inlineData);
const modelId = (m) => (typeof m === 'string' ? m : m.id);

// `parts` are Gemini-native: { text }, { inline_data } or { inlineData }.
// `parse` runs on each answer; if it throws, the next model gets a turn.
export async function askAI(parts, schema, { temperature = 0.2, offlineMessage = "You're offline.", parse = (j) => j } = {}) {
  const providers = providersWithKeys();
  if (!providers.length) throw new Error('Add an AI key in Challenges → AI keys.');
  if (!navigator.onLine) throw new Error(offlineMessage);

  const kind = hasImage(parts) ? 'vision' : 'text';
  const failures = []; // one { label, message, short, network } per provider tried

  for (const p of providers) {
    const key = getKey(p.id);
    let last = null;
    for (const model of MODELS[p.id][kind]) {
      const started = Date.now();
      const call = p.id === 'gemini' ? geminiCall : (a) => openaiCall({ ...a, provider: p.id });
      const r = await call({ key, model, parts, schema, temperature });
      console.info(`[ai] ${p.id} ${modelId(model)} ${r.status} in ${Date.now() - started} ms`);
      if (r.ok) {
        try {
          return parse(r.json);
        } catch (e) {
          last = { message: e.message, short: 'unexpected answer' };
          continue;
        }
      }
      last = r;
      // A bad key or a dead connection fails every model of this provider.
      if (r.badKey || r.network) break;
    }
    failures.push({ label: p.label.replace('Google ', ''), ...last });
  }

  if (failures.every((f) => f.network)) throw new Error(offlineMessage);
  if (failures.length === 1) throw new Error(failures[0].message);
  throw new Error('No AI answered. ' + failures.map((f) => `${f.label}: ${f.short}`).join(' · '));
}
