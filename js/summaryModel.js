// Pure model for the green-day summary viewer (Task 8A). No DOM access —
// takes a challenge + day record and returns the ordered items/photos the
// viewer renders.

import { isStepComplete, isNumberValue, diffDays } from './rules.js';

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

// Pure model for the Stats "Photo progress" tile grid. Picks every day (of
// `daysMap`) that has a photo recorded for `photoStepId`, oldest first, and
// pairs each with the `numberStepId` value for that same day (if any).
// `numberStepId` may be null/undefined to skip labelling tiles with a
// number. Returns { tiles, change } where `change` summarises the first vs.
// latest number value among the returned tiles (only present when a number
// step is chosen and at least two tiles have a value for it).
export function buildPhotoProgress(challenge, daysMap, attempt, photoStepId, numberStepId) {
  const numberStep = numberStepId ? challenge.steps.find((s) => s.id === numberStepId) : null;
  const unit = (numberStep && numberStep.number && numberStep.number.unit) || '';

  const tiles = Object.values(daysMap || {})
    .filter((d) => d.steps && d.steps[photoStepId] && d.steps[photoStepId].photoId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => {
      const numberEntry = numberStepId ? d.steps[numberStepId] : null;
      const value = numberEntry && isNumberValue(numberEntry.value) ? numberEntry.value : undefined;
      return {
        date: d.date,
        dayNumber: diffDays(attempt.startDate, d.date) + 1,
        photoId: d.steps[photoStepId].photoId,
        value,
        unit,
      };
    });

  let change = null;
  if (numberStepId) {
    const withValue = tiles.filter((t) => typeof t.value === 'number');
    if (withValue.length >= 2) {
      const first = withValue[0].value;
      const latest = withValue[withValue.length - 1].value;
      change = { first, latest, diff: Math.round((latest - first) * 100) / 100, unit };
    }
  }

  return { tiles, change };
}
