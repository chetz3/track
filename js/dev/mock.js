// Dev-only mock data: open the app with ?mock=1 on localhost / a LAN IP to
// (re)seed two challenges and open Today on the fitness one:
// - "Mock challenge" (custom): 10 days of photos, weights and notes.
// - "Mock fitness" (fitness): profile, schedule, every preset step with goals,
//   10 days of meals (with macros), workouts, steps, water, sleep, weight,
//   today's planned meals, a saved meal plan, and water reminders.
// Never runs on the live site.

import { putMany } from '../db.js';
import { addDays } from '../rules.js';
import { dayKey } from '../migrate.js';
import { presetSteps, baseTargets } from '../fitness.js';
import { buildFoodPatch } from '../foodLogic.js';

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
      { id: 'm-body', name: 'Body check-in', mandatory: true, photo: 'required', number: { label: 'Weight', unit: 'kg', required: true, showDiff: true }, note: 'none' },
      { id: 'm-meal', name: 'Healthy meal', mandatory: false, photo: 'optional', number: null, note: 'optional' },
      { id: 'm-run', name: 'Run', mandatory: true, photo: 'none', number: { label: 'Distance', unit: 'km', required: false, showSum: true, showAvg: true }, note: 'none' },
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
  await putMany(entries.concat(await fitnessEntries(todayStr)));
}

const FIT = 'c-mock-fit';

const MEALS = [
  { dish: 'Idli sambar', calories: 320, macros: { protein: 12, carbs: 58, fat: 5, fiber: 6 } },
  { dish: 'Chicken curry + rice', calories: 610, macros: { protein: 38, carbs: 70, fat: 18, fiber: 4 } },
  { dish: 'Sprouts salad', calories: 180, macros: { protein: 11, carbs: 26, fat: 3, fiber: 8 } },
  { dish: 'Ragi mudde + saaru', calories: 420, macros: { protein: 14, carbs: 72, fat: 7, fiber: 9 } },
];

async function fitnessEntries(todayStr) {
  const start = addDays(todayStr, -9);
  const profile = {
    sex: 'male', age: 32, heightCm: 180, startWeightKg: 129.5, targetWeightKg: 116.5,
    activity: 'light', aim: 'lose', location: 'Bengaluru, Karnataka', cuisine: 'South Indian',
    diet: 'nonveg', avoid: '', shareBodyPhoto: false,
    schedule: { pattern: 'regular', meals: 3, slots: [
      { name: 'Breakfast', time: '08:30' }, { name: 'Lunch', time: '13:30' }, { name: 'Dinner', time: '20:00' },
    ] },
  };
  const steps = presetSteps(profile, 100);
  const water = steps.find((s) => s.type === 'water');
  water.reminders = { times: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'], sound: true, vibrate: true };
  const challenge = {
    id: FIT, name: 'Mock fitness', category: 'fitness', totalDays: 100, weeklyTarget: 5,
    createdAt: Date.now(), profile, steps,
    mealPlan: {
      forDate: addDays(todayStr, 1), createdAt: Date.now(),
      meals: [
        { slot: 'Breakfast', dish: 'Egg bhurji + 2 dosa', portion: '3 eggs', kcal: 420, protein: 28, carbs: 40, fat: 16, fiber: 3 },
        { slot: 'Lunch', dish: 'Chicken sukka + brown rice', portion: '150 g chicken', kcal: 560, protein: 45, carbs: 55, fat: 15, fiber: 5 },
        { slot: 'Dinner', dish: 'Paneer tikka + salad', portion: '120 g paneer', kcal: 430, protein: 30, carbs: 18, fat: 26, fiber: 6 },
      ],
      why: ['Protein was short on most days last week.'],
      tips: ['Have dinner before 8:30 pm.'],
    },
  };
  const targets = baseTargets(challenge);
  const mandatory = steps.filter((s) => s.mandatory).map((s) => s.id);
  const entries = [
    { store: 'challenges', value: challenge },
    { store: 'attempts', value: { id: FIT, challengeId: FIT, startDate: start, status: 'active', greenWeeks: 0 } },
  ];
  for (let i = 0; i < 10; i++) {
    const date = addDays(start, i);
    const isToday = i === 9;
    const daySteps = {};
    // Today: 2 meals logged so far; other days 3.
    const meals = [];
    for (let m = 0; m < (isToday ? 2 : 3); m++) {
      const base = MEALS[(i + m) % MEALS.length];
      const photoId = `photo-mock-fit-${i}-${m}`;
      entries.push({ store: 'photos', value: { id: photoId, blob: await fakePhoto(base.dish, 20 + m * 40), createdAt: Date.now() } });
      meals.push({ id: `meal-mock-${i}-${m}`, photoId, dish: base.dish, calories: base.calories, macros: base.macros, items: [], at: Date.now() });
    }
    daySteps.food = buildFoodPatch({}, meals);
    if (isToday) {
      daySteps.food.planned = [
        { id: 'plan-mock-dinner', slot: 'Dinner', time: '20:00', dish: 'Grilled fish + veg', portion: '200 g fish', kcal: 450,
          macros: { protein: 40, carbs: 20, fat: 18, fiber: 6 }, source: 'ai' },
      ];
    }
    const minutes = i % 4 === 3 ? 0 : 30 + (i % 3) * 10;
    if (minutes) {
      daySteps.workout = { sessions: [{ id: `ws-mock-${i}`, type: i % 2 ? 'Gym' : 'Walk', minutes, intensity: 'moderate', kcal: minutes * 7 }], value: minutes, burn: minutes * 7 };
    }
    daySteps.steps = { value: 6000 + i * 400 };
    daySteps.water = { value: isToday ? 1.5 : 3.5 + (i % 3) * 0.5 };
    if (!isToday) daySteps.sleep = { value: 6.5 + (i % 4) * 0.5 };
    if (i % 3 === 0) {
      const bodyId = `photo-mock-fit-body-${i}`;
      entries.push({ store: 'photos', value: { id: bodyId, blob: await fakePhoto(`Body · Day ${i + 1}`, 300), createdAt: Date.now() } });
      daySteps.body = { value: +(129.5 - i * 0.25).toFixed(1), photoId: bodyId, done: true };
    }
    entries.push({ store: 'days', value: { key: dayKey(FIT, date), challengeId: FIT, date, mandatoryStepIds: mandatory, targets, steps: daySteps } });
  }
  return entries;
}

// Dev-only: ?notify on localhost shows a floating panel to fire a sample
// step reminder (sound on/off, vibrate on/off), 5 s after tapping so you can
// switch tabs/apps first. Uses the same showNotification options as
// js/reminderRunner.js.
export function mountNotifyTester() {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:99;background:var(--card,#fff);color:var(--text,#000);border-radius:16px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.2);display:grid;gap:8px;font:14px/1.4 system-ui';
  box.innerHTML = `<strong>Test notification (dev only)</strong>
    <label><input type="checkbox" id="nt-sound" checked> Sound</label>
    <label><input type="checkbox" id="nt-vibrate" checked> Vibrate (Android only)</label>
    <button type="button" class="btn btn-primary" id="nt-go">Send in 5 seconds</button>
    <div id="nt-status" style="color:var(--text2,#555)"></div>`;
  document.body.appendChild(box);
  const status = box.querySelector('#nt-status');
  box.querySelector('#nt-go').addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      status.textContent = "Notifications aren't available here (needs https or localhost; on iPhone, the Home Screen app).";
      return;
    }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { status.textContent = `Permission: ${perm}. Allow notifications for this site in settings.`; return; }
    const sound = box.querySelector('#nt-sound').checked;
    const vibrate = box.querySelector('#nt-vibrate').checked;
    status.textContent = 'Sending in 5 s… switch away now if you like.';
    setTimeout(async () => {
      const options = {
        body: 'Time for Water · 1.5 / 4.5 L',
        tag: `dev-test-${Date.now()}`,
        icon: './icons/icon-192.png',
        silent: !sound,
        vibrate: vibrate ? [200, 100, 200] : [],
        data: { url: './#/today' },
      };
      try {
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        if (reg) await reg.showNotification('Water', options); else new Notification('Water', options);
        status.textContent = `Sent (sound ${sound ? 'on' : 'off'}, vibrate ${vibrate ? 'on' : 'off'}).`;
      } catch (err) {
        status.textContent = `Failed: ${err.message}`;
      }
    }, 5000);
  });
}
