// One Gemini generateContent call (with its thinking-config resend), called
// straight from the browser. The key is sent as the x-goog-api-key header,
// never in the URL. Resolves { ok:true, status, json } or
// { ok:false, status, message, short, badKey, network }; the router decides
// what to try next.

// Speed beats depth: the model is told to answer at once and thinking is
// kept at its minimum.
export const FAST_INSTRUCTION = 'Answer immediately with your best estimate. Approximate values are fine — do not deliberate, double-check or explain. Keep every string short.';

const endpoint = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// A 429 body carries google.rpc.QuotaFailure details naming the exact limit
// hit, e.g. { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
// quotaValue: '250', quotaDimensions: { model: 'gemini-2.5-flash' } }.
// Google doesn't publish free-tier numbers, so this is the only concrete
// source — surfaced in the error text as "(limit 250/day on gemini-2.5-flash)".
function quotaLimitText(bodyText) {
  try {
    const details = JSON.parse(bodyText).error.details || [];
    const v = details.flatMap((d) => d.violations || []).find((x) => x.quotaValue);
    if (!v) return '';
    const per = /PerDay/i.test(v.quotaId) ? 'day' : /PerMinute/i.test(v.quotaId) ? 'min' : '';
    const model = v.quotaDimensions && v.quotaDimensions.model;
    return ` (limit ${v.quotaValue}${per ? '/' + per : ''}${model ? ' on ' + model : ''})`;
  } catch (_) {
    return '';
  }
}

function friendlyError(status, bodyText) {
  if (status === 429) console.warn('Gemini quota hit:', bodyText);
  if (status === 429 && /PerDay/i.test(bodyText || '')) return `Gemini free-tier daily limit reached${quotaLimitText(bodyText)}. Try again tomorrow.`;
  if (status === 429) return `Gemini free-tier limit reached${quotaLimitText(bodyText)}. Try again in a minute.`;
  if (status === 401 || status === 403) return 'Gemini API key is invalid.';
  if (status === 400 && /API_KEY_INVALID/.test(bodyText || '')) return 'Gemini API key is invalid.';
  // Google's own message says which parameter or model it rejected.
  let detail = '';
  try { detail = JSON.parse(bodyText).error.message || ''; } catch (_) { /* not JSON */ }
  return `Gemini error (${status})${detail ? ': ' + detail.slice(0, 160) : ''}`;
}

// The short form for "No AI answered. Gemini: …" when several providers fail.
function shortError(status, bodyText) {
  if (status === 429) return /PerDay/i.test(bodyText || '') ? 'daily limit reached' : 'limit reached';
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID/.test(bodyText || ''))) return 'key is invalid';
  if (status >= 500) return 'busy';
  return `error ${status}`;
}

// `model` is { id, thinking } (thinking = thinkingConfig or null).
export async function geminiCall({ key, model, parts, schema, temperature }) {
  const makeBody = (thinking) => JSON.stringify({
    systemInstruction: { parts: [{ text: FAST_INSTRUCTION }] },
    contents: [{ parts }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  });
  const send = (body) => fetch(endpoint(model.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body,
  });

  let res;
  let errText = null;
  try {
    res = await send(makeBody(model.thinking));
    if (res.status === 400) {
      // A model that rejects our thinkingConfig gets one resend without
      // it. res.text() consumes the body, so keep it for below.
      errText = await res.text().catch(() => '');
      if (model.thinking && /thinking/i.test(errText)) {
        errText = null;
        res = await send(makeBody(null));
      }
    }
  } catch (_) {
    // fetch rejects on a genuine network failure (offline mid-request, DNS,
    // connection reset) — navigator.onLine already caught the common case.
    return { ok: false, status: 'network', network: true, message: 'network error', short: 'offline' };
  }

  if (!res.ok) {
    const bodyText = errText ?? await res.text().catch(() => '');
    const badKey = res.status === 401 || res.status === 403 || (res.status === 400 && /API_KEY_INVALID/.test(bodyText));
    const message = res.status === 503 ? 'Gemini is busy right now. Try again in a minute.' : friendlyError(res.status, bodyText);
    return { ok: false, status: res.status, message, short: shortError(res.status, bodyText), badKey };
  }

  const json = await res.json().catch(() => null);
  // Thinking models may return thought parts first; keep only answer text.
  const rawText = (json?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  try {
    return { ok: true, status: res.status, json: JSON.parse(rawText) };
  } catch (_) {
    return { ok: false, status: res.status, message: 'Unexpected response from Gemini', short: 'unexpected answer' };
  }
}
