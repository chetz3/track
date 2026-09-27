export const MIGRATED_CHALLENGE_ID = 'c-main';

export function dayKey(challengeId, date) {
  return `${challengeId}|${date}`;
}

const BODY_STEP = {
  id: 'body', name: 'Body check-in', mandatory: true, photo: 'required',
  number: { label: 'Weight', unit: 'kg', required: true }, note: 'none',
};

export function migrateStep(s) {
  return {
    id: s.id, name: s.name, mandatory: !!s.mandatory,
    photo: s.requiresPhoto ? 'required' : 'none', number: null,
    note: s.allowsNote ? 'optional' : 'none',
  };
}

export function migrateV1({ config, attempts = [], days = [] }) {
  if (!config) return { challenges: [], attempts: [], days: [] };
  const challengeId = MIGRATED_CHALLENGE_ID;
  const challenge = {
    id: challengeId, name: config.name, totalDays: config.totalDays,
    weeklyTarget: config.weeklyTarget,
    steps: [{ ...BODY_STEP, number: { ...BODY_STEP.number } }, ...(config.steps || []).map(migrateStep)],
    createdAt: 0,
  };
  const newDays = days.map((d) => {
    const steps = {};
    for (const [id, e] of Object.entries(d.steps || {})) steps[id] = { ...e };
    const hasWeight = typeof d.weight === 'number' && Number.isFinite(d.weight);
    if (hasWeight || d.bodyPhotoId) {
      steps.body = { done: hasWeight && !!d.bodyPhotoId };
      if (hasWeight) steps.body.value = d.weight;
      if (d.bodyPhotoId) steps.body.photoId = d.bodyPhotoId;
    }
    return {
      key: dayKey(challengeId, d.date), challengeId, date: d.date,
      mandatoryStepIds: Array.isArray(d.mandatoryStepIds) ? [...d.mandatoryStepIds] : null,
      steps,
    };
  });
  return {
    challenges: [challenge],
    attempts: attempts.map((a) => ({ ...a, challengeId })),
    days: newDays,
  };
}
