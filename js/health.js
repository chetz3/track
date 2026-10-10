// Health-profile constants and (de)normalisation for the Plateau Coach (R2,
// docs/superpowers/plans/2026-10-10-plateau-coach.md §4). A leaf module (no
// imports) so the profile form, the review model, the backup validator and the
// summary viewer can all share it without an import cycle.

export const CONDITIONS = [
  ['insulin_resistance', 'Insulin resistance'],
  ['prediabetes', 'Prediabetes'],
  ['type2_diabetes', 'Type 2 diabetes'],
  ['pcos', 'PCOS'],
  ['hypothyroid', 'Hypothyroid'],
  ['fatty_liver', 'Fatty liver'],
  ['high_bp', 'High BP'],
  ['sleep_apnea', 'Sleep apnea'],
  ['high_cholesterol', 'High cholesterol / triglycerides'],
  ['high_cortisol', "Cushing's / long-term steroids"],
  ['menopause', 'Peri/menopause'],
  ['low_testosterone', 'Low testosterone'],
  ['ibs_gut', 'IBS / gut issues'],
  ['kidney_heart_edema', 'Kidney/heart issue or swelling (oedema)'],
  ['depression_anxiety', 'Depression / anxiety'],
];

export const MEDS_FLAGS = [
  ['steroids', 'Steroids'],
  ['insulin_sulfonylurea', 'Insulin / sulfonylureas'],
  ['antidepressants', 'Antidepressants'],
  ['antipsychotics', 'Antipsychotics'],
  ['beta_blockers', 'Beta-blockers'],
  ['antihistamines', 'Antihistamines (daily)'],
  ['hormonal_contraceptive', 'Hormonal contraceptive'],
  ['anticonvulsants', 'Anticonvulsants'],
];

// [key, label, unit]
export const LAB_FIELDS = [
  ['hba1c', 'HbA1c', '%'],
  ['fastingGlucose', 'Fasting glucose', 'mg/dL'],
  ['fastingInsulin', 'Fasting insulin', 'µIU/mL'],
  ['tsh', 'TSH', 'mIU/L'],
  ['vitD', 'Vitamin D', 'ng/mL'],
  ['b12', 'Vitamin B12', 'pg/mL'],
  ['crp', 'CRP', 'mg/L'],
  ['triglycerides', 'Triglycerides', 'mg/dL'],
  ['hdl', 'HDL', 'mg/dL'],
  ['alt', 'ALT', 'U/L'],
  ['ast', 'AST', 'U/L'],
];
export const LAB_KEYS = LAB_FIELDS.map((f) => f[0]);

export const FEEL_TAGS = [
  ['bloated', 'Bloated'],
  ['acidity', 'Acidity'],
  ['cravings', 'Cravings'],
  ['low_energy', 'Low energy'],
  ['good_digestion', 'Good digestion'],
  ['poor_sleep_hunger', 'Poor sleep, hungry'],
];
const FEEL_VALUES = new Set(FEEL_TAGS.map((t) => t[0]));
const CONDITION_VALUES = new Set(CONDITIONS.map((t) => t[0]));
const MEDS_FLAG_VALUES = new Set(MEDS_FLAGS.map((t) => t[0]));

export function feelLabel(tag) {
  const f = FEEL_TAGS.find((t) => t[0] === tag);
  return f ? f[1] : String(tag);
}

// A day's feel tags, filtered to known values, de-duplicated.
export function cleanFeel(feel) {
  if (!Array.isArray(feel)) return [];
  return [...new Set(feel.filter((t) => FEEL_VALUES.has(t)))];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function pick(list, values) {
  return Array.isArray(list) ? [...new Set(list.filter((v) => values.has(v)))] : [];
}

// Tidies a stored profile.health: unknown tags, wrong types and non-finite
// numbers are dropped; empty groups are omitted. Returns null when nothing is
// left (so a profile without health info stays exactly as it was).
export function normalizeHealth(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const out = {};
  const conditions = pick(h.conditions, CONDITION_VALUES);
  if (conditions.length) out.conditions = conditions;
  const flags = pick(h.meds_flags, MEDS_FLAG_VALUES);
  if (flags.length) out.meds_flags = flags;
  if (typeof h.sensitivities === 'string' && h.sensitivities.trim()) out.sensitivities = h.sensitivities.trim().slice(0, 300);
  if (typeof h.meds === 'string' && h.meds.trim()) out.meds = h.meds.trim().slice(0, 300);
  if (isNum(h.waistCm) && h.waistCm > 0) {
    out.waistCm = h.waistCm;
    if (typeof h.waistDate === 'string' && DATE_RE.test(h.waistDate)) out.waistDate = h.waistDate;
  }
  if (h.labs && typeof h.labs === 'object' && !Array.isArray(h.labs)) {
    const labs = {};
    for (const k of LAB_KEYS) if (isNum(h.labs[k]) && h.labs[k] > 0) labs[k] = h.labs[k];
    if (Object.keys(labs).length) {
      if (typeof h.labs.date === 'string' && DATE_RE.test(h.labs.date)) labs.date = h.labs.date;
      out.labs = labs;
    }
  }
  if (h.shareWithAi === true) out.shareWithAi = true;
  return Object.keys(out).length ? out : null;
}

// ---- profile form <-> health ----

export function emptyHealthDraft() {
  const labs = { date: '' };
  for (const k of LAB_KEYS) labs[k] = '';
  return { conditions: [], meds_flags: [], sensitivities: '', meds: '', waistCm: '', waistDate: '', labs, shareWithAi: false };
}

export function healthToDraft(h) {
  const d = emptyHealthDraft();
  const n = normalizeHealth(h);
  if (!n) return d;
  d.conditions = [...(n.conditions || [])];
  d.meds_flags = [...(n.meds_flags || [])];
  d.sensitivities = n.sensitivities || '';
  d.meds = n.meds || '';
  d.waistCm = n.waistCm !== undefined ? String(n.waistCm) : '';
  d.waistDate = n.waistDate || '';
  for (const k of LAB_KEYS) d.labs[k] = n.labs && n.labs[k] !== undefined ? String(n.labs[k]) : '';
  d.labs.date = (n.labs && n.labs.date) || '';
  d.shareWithAi = !!n.shareWithAi;
  return d;
}

function num(s) {
  if (typeof s === 'number') return s;
  const v = parseFloat(String(s == null ? '' : s).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

// Draft strings -> stored shape (or null when the whole section is empty).
export function draftToHealth(d) {
  if (!d) return null;
  const labs = {};
  for (const k of LAB_KEYS) labs[k] = num(d.labs && d.labs[k]);
  labs.date = d.labs && d.labs.date;
  return normalizeHealth({
    conditions: d.conditions,
    meds_flags: d.meds_flags,
    sensitivities: d.sensitivities,
    meds: d.meds,
    waistCm: num(d.waistCm),
    waistDate: d.waistDate,
    labs,
    shareWithAi: !!d.shareWithAi,
  });
}
