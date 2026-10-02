// Side effects for step reminders: polls the pure scheduler (reminders.js),
// keeps the fired log in localStorage and shows the notifications. Only runs
// while the app is open/alive; on reopen the latest missed reminder per step
// fires once.

import * as store from './store.js';
import { dueReminders, firedKey } from './reminders.js';
import { targetFor } from './fitness.js';

const FIRED_KEY = 'tracker:remindersFired';
const CHECK_MS = 30000;

function readFired(date) {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY));
    if (raw && raw.date === date && Array.isArray(raw.keys)) return raw.keys;
  } catch (_) {
    // unreadable — start fresh
  }
  return [];
}

function writeFired(date, keys) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify({ date, keys }));
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

function bodyFor(item, challenge, date) {
  const step = challenge && challenge.steps.find((s) => s.id === item.stepId);
  const day = store.state.days[item.challengeId] && store.state.days[item.challengeId][date];
  const target = step ? targetFor(day || null, step) : null;
  if (step && target !== null) {
    const entry = day && day.steps && day.steps[step.id];
    const value = entry && Number.isFinite(entry.value) ? entry.value : 0;
    const unit = step.number && step.number.unit ? ' ' + step.number.unit : '';
    return `Time for ${item.stepName} · ${value} / ${target}${unit}`;
  }
  return item.challengeName;
}

async function show(item, body) {
  const options = {
    body,
    tag: `${item.challengeId}-${item.stepId}`,
    renotify: true, // same tag later in the day must still alert, not silently replace
    icon: './icons/icon-192.png',
    silent: !item.sound,
    vibrate: item.vibrate ? [200, 100, 200] : [],
    data: { url: './#/today' },
  };
  let reg = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      reg = await navigator.serviceWorker.getRegistration();
    }
  } catch (_) {
    reg = null;
  }
  try {
    if (reg && reg.showNotification) await reg.showNotification(item.stepName, options);
    else new Notification(item.stepName, options);
  } catch (_) {
    // notification failed — nothing more to do
  }
}

function check() {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const now = new Date();
    const date = store.today();
    const fired = readFired(date);
    const due = dueReminders({
      challenges: store.state.challenges,
      attempts: store.state.attempts,
      daysByChallenge: store.state.days,
      now,
      fired,
    });
    if (!due.length) return;
    const keys = fired.slice();
    for (const item of due) {
      const challenge = store.state.challenges.find((c) => c.id === item.challengeId);
      // Mark every due time for this step as fired, not just the latest.
      for (const t of item.dueTimes) keys.push(firedKey(date, item.challengeId, item.stepId, t));
      show(item, bodyFor(item, challenge, date));
    }
    writeFired(date, keys);
  } catch (err) {
    console.error(err);
  }
}

export function startReminders() {
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
