// Dev-only mock data: open the app with ?mock=1 on localhost / a LAN IP to
// (re)seed a 10-day "Mock challenge" with photos, weights and notes.
// Never runs on the live site.

import { putMany } from '../db.js';
import { addDays } from '../rules.js';
import { dayKey } from '../migrate.js';

const ID = 'c-mock';

export function isDevHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || /^192\.168\.|^10\./.test(h);
}

function fakePhoto(label, hue) {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 800;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 600, 800);
  grad.addColorStop(0, `hsl(${hue},60%,45%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360},60%,20%)`);
  g.fillStyle = grad; g.fillRect(0, 0, 600, 800);
  g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center';
  g.fillText(label, 300, 420);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
}

export async function seedMock(todayStr) {
  const start = addDays(todayStr, -9);
  const challenge = {
    id: ID, name: 'Mock challenge', totalDays: 30, weeklyTarget: 5, createdAt: Date.now(),
    steps: [
      { id: 'm-body', name: 'Body check-in', mandatory: true, photo: 'required', number: { label: 'Weight', unit: 'kg', required: true }, note: 'none' },
      { id: 'm-meal', name: 'Healthy meal', mandatory: false, photo: 'optional', number: null, note: 'optional' },
      { id: 'm-run', name: 'Run', mandatory: true, photo: 'none', number: { label: 'Distance', unit: 'km', required: false }, note: 'none' },
    ],
  };
  const entries = [
    { store: 'challenges', value: challenge },
    { store: 'attempts', value: { id: ID, challengeId: ID, startDate: start, status: 'active', greenWeeks: 0 } },
  ];
  for (let i = 0; i < 10; i++) {
    const date = addDays(start, i);
    const missed = i === 3; // one red day
    const steps = {};
    const bodyId = `photo-mock-body-${i}`;
    entries.push({ store: 'photos', value: { id: bodyId, blob: await fakePhoto(`Body · Day ${i + 1}`, i * 30), createdAt: Date.now() } });
    steps['m-body'] = { done: true, photoId: bodyId, value: +(80 - i * 0.3).toFixed(1) };
    if (i % 2 === 0) {
      const mealId = `photo-mock-meal-${i}`;
      entries.push({ store: 'photos', value: { id: mealId, blob: await fakePhoto(`Meal · Day ${i + 1}`, 200 + i * 10), createdAt: Date.now() } });
      steps['m-meal'] = { done: true, photoId: mealId, note: 'Salad + eggs' };
    }
    if (!missed) steps['m-run'] = { done: true, value: 3 + (i % 3) };
    entries.push({ store: 'days', value: { key: dayKey(ID, date), challengeId: ID, date, mandatoryStepIds: ['m-body', 'm-run'], steps } });
  }
  await putMany(entries);
}
