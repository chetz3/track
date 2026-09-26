// Pure chart-math helpers for the Stats screen (Task 9). No DOM, no D3 —
// kept separate and pure so they're trivially unit-testable (tests/chart.test.js).

export function collectNumberSeries(challenge, daysMap) {
  return challenge.steps.filter((s) => s.number).map((step) => ({
    step,
    points: Object.values(daysMap)
      .map((d) => ({ date: d.date, value: d.steps && d.steps[step.id] ? d.steps[step.id].value : undefined }))
      .filter((p) => typeof p.value === 'number' && Number.isFinite(p.value))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  }));
}

export function trendDomain(values) {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) {
    const pad = Math.max(1, Math.abs(lo) * 0.05);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.15;
  return [lo - pad, hi + pad];
}

export function ringStats(challenge, evaluation, attempt, today) {
  const weeksPassed = evaluation.weeks.filter((w) => w.status === 'green').length;
  return {
    day: evaluation.currentDayNumber,
    totalDays: challenge.totalDays,
    weeksPassed,
    totalWeeks: Math.ceil(challenge.totalDays / 7),
    streakDays: today < attempt.startDate ? 0 : evaluation.currentDayNumber,
  };
}
