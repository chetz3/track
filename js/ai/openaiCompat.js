// One client for Groq and OpenRouter (both speak the OpenAI chat-completions
// API and allow browser calls). Same result shape as geminiCall.

import { FAST_INSTRUCTION } from './geminiProvider.js';
import { toJsonSchema } from './schema.js';

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

// Gemini-native parts -> OpenAI message content.
function toContent(parts) {
  return parts.map((p) => {
    const img = p.inline_data || p.inlineData;
    if (img) {
      const mime = img.mime_type || img.mimeType;
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${img.data}` } };
    }
    return { type: 'text', text: p.text };
  });
}

// Models sometimes wrap the JSON in a ```json fence.
function parseAnswer(text) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return JSON.parse(m ? m[1] : text);
}

function errorMessage(status, bodyText) {
  if (status === 429) return 'limit reached';
  if (status === 401 || status === 403) return 'key is invalid';
  if (status >= 500) return 'busy';
  let detail = '';
  try { detail = JSON.parse(bodyText).error.message || ''; } catch (_) { /* not JSON */ }
  return `error ${status}${detail ? ': ' + String(detail).slice(0, 120) : ''}`;
}

export async function openaiCall({ provider, key, model, parts, schema, temperature }) {
  const jsonSchema = toJsonSchema(schema);
  const makeBody = (responseFormat) => JSON.stringify({
    model,
    temperature,
    messages: [
      { role: 'system', content: `${FAST_INSTRUCTION} Reply with only JSON matching this schema: ${JSON.stringify(jsonSchema)}` },
      { role: 'user', content: toContent(parts) },
    ],
    response_format: responseFormat,
    // The least thinking gpt-oss allows, so answers come back fast.
    ...(provider === 'groq' && model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
  });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://chetz3.github.io/track/', 'X-OpenRouter-Title': 'FueLoop' } : {}),
  };
  const send = (body) => fetch(ENDPOINTS[provider], { method: 'POST', headers, body });

  let res;
  let errText = null;
  try {
    res = await send(makeBody({ type: 'json_schema', json_schema: { name: 'answer', strict: false, schema: jsonSchema } }));
    if (res.status === 400) {
      errText = await res.text().catch(() => '');
      if (/response_format|json_schema|structured/i.test(errText)) {
        errText = null;
        res = await send(makeBody({ type: 'json_object' }));
      }
    }
  } catch (_) {
    return { ok: false, status: 'network', network: true, message: 'network error', short: 'offline' };
  }

  if (!res.ok) {
    const bodyText = errText ?? await res.text().catch(() => '');
    const message = errorMessage(res.status, bodyText);
    return { ok: false, status: res.status, message, short: message, badKey: res.status === 401 || res.status === 403 };
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  try {
    return { ok: true, status: res.status, json: parseAnswer(content) };
  } catch (_) {
    return { ok: false, status: res.status, message: 'Unexpected response', short: 'unexpected answer' };
  }
}
