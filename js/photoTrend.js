// Pure helpers for the body-photo trend (docs/superpowers/plans/2026-10-10-body-photo-trend.md §1).

import { diffDays } from './rules.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One body photo per 7-day bucket (counted back from today), the latest in
// each bucket, over the last `weeks` weeks. Oldest first, at most `weeks`.
// -> [{ date, photoId, kg|null }]
export function pickWeeklyBodyPhotos(challenge, daysMap, today, { weeks = 4 } = {}) {
  const body = ((challenge && challenge.steps) || []).find((s) => s.type === 'body');
  if (!body) return [];
  const best = new Map(); // bucket -> pick
  for (const [date, day] of Object.entries(daysMap || {})) {
    if (!DATE_RE.test(date)) continue;
    const e = day && day.steps && day.steps[body.id];
    if (!e || !e.photoId) continue;
    const ago = diffDays(date, today);
    if (ago < 0 || ago >= weeks * 7) continue;
    const bucket = Math.floor(ago / 7);
    const cur = best.get(bucket);
    if (!cur || date > cur.date) {
      best.set(bucket, { date, photoId: e.photoId, kg: typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null });
    }
  }
  return [...best.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-weeks);
}

export function photoTrendReady(picks) {
  return Array.isArray(picks) && picks.length >= 2;
}
