// Gemini response schemas use upper-case types ('OBJECT'); OpenAI-style APIs
// (Groq, OpenRouter) want plain JSON Schema. Keeps only what both understand.

export function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (typeof s.type === 'string') out.type = s.type.toLowerCase();
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toJsonSchema(v);
  }
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.required) out.required = s.required;
  if (s.enum) out.enum = s.enum;
  return out;
}
