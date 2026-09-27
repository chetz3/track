// Pure model for the green-day summary viewer (Task 8A). No DOM access —
// takes a challenge + day record and returns the ordered items/photos the
// viewer renders.

import { isStepComplete, isNumberValue } from './rules.js';

export function buildDaySummary(challenge, day) {
  const steps = (day && day.steps) || {};
  const photos = [];
  const items = challenge.steps.map((s) => {
    const e = steps[s.id];
    const item = { stepId: s.id, name: s.name, mandatory: !!s.mandatory, complete: isStepComplete(s, e) };
    if (s.number && e && isNumberValue(e.value)) item.value = `${s.number.label}: ${e.value}${s.number.unit ? ' ' + s.number.unit : ''}`;
    if (e && e.note) item.note = e.note;
    item.hasPhoto = !!(e && e.photoId);
    if (item.hasPhoto) photos.push({ stepId: s.id, stepName: s.name, photoId: e.photoId });
    return item;
  });
  return { photos, items };
}
