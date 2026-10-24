# Plan: free AI fallback across Gemini → Groq → OpenRouter

Branch: `ai-fallback` (from `main`). Don't commit. The user tests first.

## Goal

When an AI request fails, the app automatically tries the next free provider whose key the
user has added. Order: Gemini → Groq → OpenRouter. Each user brings their own keys, stored on
the device only, with no server. Both Groq and OpenRouter accept browser calls: preflight
returns `access-control-allow-origin: *` (verified 2026-10-24).

Keep it simple. Prompts, schemas and parsers stay where they are. Only the transport changes.

## Already done: `js/ai/keys.js` (don't change its API)

```js
PROVIDERS            // [{ id:'gemini'|'groq'|'openrouter', label, storage, keyRe, keyUrl, keyHint, limits }]
getKey(id) -> string // '' when unset
setKey(id, key) -> boolean   // false = invalid format, nothing saved; fires 'fueloop:aikey'
clearKey(id)                  // fires 'fueloop:aikey'
isValidKey(id, key) -> boolean
providersWithKeys() -> PROVIDERS[] // with a key, in fallback order
anyKey() -> boolean
```

Gemini still uses its original storage slot `tracker:geminiKey`.

## Part A: router and adapters (subagent A)

Owns: `js/ai/router.js`, `js/ai/geminiProvider.js`, `js/ai/openaiCompat.js`, `js/ai/schema.js`,
`js/gemini.js`, `tests/aiRouter.test.js`, and updates to `tests/geminiFast.test.js`.

### `js/ai/router.js`
```js
export const MODELS = {
  gemini:     { text: [...gemini list], vision: [...same] },   // the current MODELS from gemini.js, unchanged
  groq:       { text: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], vision: ['qwen/qwen3.8-27b'] },
  openrouter: { text: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
                vision: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free'] },
};
export async function askAI(parts, schema, { temperature = 0.2, offlineMessage, parse = (j) => j } = {})
```
- `parts` stays in today's Gemini-native shape: `{ text }`, plus `{ inline_data: { mime_type, data } }`
  or `{ inlineData: { mimeType, data } }`. If any part is an image, use the `vision` list.
  Otherwise use `text`.
- No key at all: throw `'Add an AI key in Challenges → AI keys.'`. Offline: throw `offlineMessage`.
- For each provider in `providersWithKeys()`, for each model:
  1. Call the adapter.
  2. On success, return `parse(json)`.
  3. If `parse` throws, or the adapter fails (network error, non-2xx, empty or invalid JSON),
     record a short reason and move to the next model.
  4. A bad-key error (401/403, or a 400 with `API_KEY_INVALID`) skips the rest of that provider.
- A network failure (fetch rejects) on every attempt: throw `offlineMessage`.
- All failed:
  - If only one provider was tried, throw that provider's own message, so today's Gemini
    messages and tests stay unchanged.
  - Otherwise throw `'No AI answered. ' + reasons.join(' · ')`, one reason per provider, e.g.
    `Gemini: daily limit reached · Groq: busy`. Keep it under about 200 characters.
- Log each attempt with `console.info('[ai] <provider> <model> <status> in <ms> ms')`.
- No client-side timeout (the user removed it on purpose).

### `js/ai/geminiProvider.js`
Move the per-request Gemini code here from `callGemini` with the same behaviour:
- `x-goog-api-key` header, `FAST_INSTRUCTION`, and `thinkingConfig` from the model entry.
- The 400 `/thinking/` resend without `thinkingConfig`.
- Thought parts filtered out of the answer.
- `friendlyError` and `quotaLimitText` messages, including Google's 400 detail.

Expose one function per call, e.g. `geminiCall({ key, model, parts, schema, temperature })`.
It resolves `{ ok: true, json }` or `{ ok: false, status, message, badKey, network }`.
Keep `FAST_INSTRUCTION` defined once and import it where needed.

### `js/ai/openaiCompat.js`
One client for Groq and OpenRouter. It returns the same result shape as `geminiCall`.
- Endpoints: `https://api.groq.com/openai/v1/chat/completions` and
  `https://openrouter.ai/api/v1/chat/completions`. Header `Authorization: Bearer <key>`.
- OpenRouter only: also send `HTTP-Referer: https://chetz3.github.io/track/` and
  `X-OpenRouter-Title: FueLoop`.
- Messages:
  - `system` = `FAST_INSTRUCTION` + `' Reply with only JSON matching this schema: ' + JSON.stringify(jsonSchema)`.
  - `user` content = an array of `{ type:'text', text }` and
    `{ type:'image_url', image_url:{ url:'data:<mime>;base64,<data>' } }`, in the order of `parts`.
- `response_format: { type:'json_schema', json_schema:{ name:'answer', strict:false, schema: jsonSchema } }`,
  plus `temperature`.
- If the provider returns 400 mentioning `response_format`/`json_schema`/`structured`, resend once
  with `response_format: { type:'json_object' }`. The schema is already in the system message.
- Groq `openai/gpt-oss-*` models: add `reasoning_effort: 'low'`. That's the least thinking they
  allow, so answers come back fast.
- Answer: `choices[0].message.content`. Strip a surrounding code fence if present, then
  `JSON.parse`. Failure = `{ ok:false, message:'Unexpected response' }`.
- Error messages, kept short: 429 → `'limit reached'`, 401/403 → `'key is invalid'` (`badKey:true`),
  5xx → `'busy'`, otherwise `'error <status>'` plus the provider's `error.message`
  (≤ 120 characters) when present.

### `js/ai/schema.js`
`toJsonSchema(geminiSchema)` converts the schema deeply:
- Map `type` `'OBJECT'|'ARRAY'|'STRING'|'INTEGER'|'NUMBER'|'BOOLEAN'` to lowercase.
- Keep `properties`, `items`, `required` and `enum`.
- Drop anything else that isn't JSON Schema.
- Pure function, with a unit test.

### `js/gemini.js`
- Replace `callGemini` with `askAI` in `estimateCalories`, `suggestMeals`, `checkBody` and
  `reviewPlateau`.
- Pass each caller's parser as `parse`, so an answer that doesn't parse moves to the next
  provider. Example: `parse: parseCalorieResult`. For suggest, wrap the existing
  `parseMealPlan(...)` call.
- Remove the key/offline checks from those functions; `askAI` does them.
- Keep these exports working, so nothing else breaks while part B lands:
  - `getGeminiKey`, `setGeminiKey`, `clearGeminiKey`, `GEMINI_KEY_RE`, `KEY_STORAGE`, as
    wrappers over `keys.js`.
  - `aiAvailable()`, which now returns `anyKey()` or the dev mock check it already has.
- The dev mock paths stay unchanged.

### Tests (`tests/aiRouter.test.js`, stubbed `fetch`)
- Gemini 429 → Groq is called and succeeds.
- Only a Groq key → Gemini is never called.
- Image call → a Groq text model is never used, only the vision list.
- `parse` throws on the first answer → the next model is tried.
- 401 on Groq → the next Groq model is skipped, and OpenRouter is tried.
- All fail with two providers → the message starts with `No AI answered.` and names both.
- Only a Gemini key with a 429 per-day → the message is exactly today's Gemini message.
- `json_schema` 400 → one resend with `json_object`.
- Fence stripping.
- `toJsonSchema` lowercases types deeply.

The existing `tests/geminiFast.test.js` must keep passing. Adjust only what really moved, such
as URLs or call counts once fallbacks exist.

## Part B: keys screen and UI gates (subagent B)

Owns: `js/ui/challenges.js` (Gemini section only), `js/ui/aiKeySheet.js`, `js/app.js`
(banner and prompt checks only), `js/ui/today.js` (only the two `getGeminiKey()` gates at the
re-estimate button and `noAiReason`), `css/styles.css` if needed.

- **Challenges → "AI keys"** (replaces "Gemini AI (your key)"): one block per `PROVIDERS` entry,
  in order.
  - Saved: `<label> · Key saved ••••last4` and a **Remove** button.
  - Not saved: a password input, a **Save** button, a "Get a free key" link (`keyUrl`), the
    hint, and the `limits` line.
  - Use `data-role="ai-key-save"`, `ai-key-remove` and `ai-key-input`, each with
    `data-provider`.
  - Save calls `setKey()`. If it returns false, show
    `Enter a valid <label> key (<keyHint>).` with the existing alert pattern.
  - Keep the Gemini step-by-step `<ol>` instructions under the Gemini block.
  - One footer for all: "Add one or more. If one is busy or out of free requests, FueLoop
    tries the next. Keys stay on this device."
- **`aiKeySheet.js`** (the launch onboarding): keep its flow and Gemini instructions, and
  validate with `isValidKey('gemini', …)` and `setKey('gemini', …)`. Add one line under it:
  "You can also add free Groq or OpenRouter keys later in Challenges → AI keys, as backups."
- **`app.js`**: the banner and the prompt check use `anyKey()` instead of `getGeminiKey()`.
- **`today.js`**: the two gates use `aiAvailable()` from `../gemini.js`. In the
  no-key `noAiReason` text, replace `Challenges → Gemini AI` with `Challenges → AI keys`.
- **Privacy note** (`challenges.js`, ~line 684, the health-data switch footer): change
  "sent to Google Gemini" to "sent to your AI provider (Gemini, Groq or OpenRouter)". Leave the
  rest of the sentence as it is.
- `sw.js`: bump `CACHE_NAME` to `tracker-shell-v58`. Add `js/ai/*.js` to the shell list if
  `sw.js` lists files explicitly.

## Done when
- `npm test` passes and `node --check` is clean on every edited file.
- With only a Gemini key, behaviour and messages match today's.
- Neither part edits files the other part owns.
