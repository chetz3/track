import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, firedKey } from '../js/reminders.js';

const at = (h, m = 0, d = 25) => new Date(2026, 8, d, h, m);

function setup(times = ['09:00'], stepOver = {}) {
  const challenge = {
    id: 'c1', name: 'Chal', totalDays: 30, weeklyTarget: 5,
    steps: [{ id: 's1', name: 'Water', mandatory: true, photo: 'none', number: null, note: 'none', reminders: { times, sound: true, vibrate: false }, ...stepOver }],
  };
  return {
    challenges: [challenge],
    attempts: { c1: [{ id: 'a', challengeId: 'c1', startDate: '2026-09-20', status: 'active' }] },
    daysByChallenge: {},
    fired: [],
  };
}

test('due once time has passed, not before', () => {
  const s = setup();
  assert.equal(dueReminders({ ...s, now: at(8, 59) }).length, 0);
  const r = dueReminders({ ...s, now: at(9, 0) });
  assert.equal(r.length, 1);
  assert.equal(r[0].stepName, 'Water');
  assert.equal(r[0].sound, true);
  assert.equal(r[0].vibrate, false);
});

test('already-fired is skipped', () => {
  const s = setup();
  s.fired = [firedKey('2026-09-25', 'c1', 's1', '09:00')];
  assert.equal(dueReminders({ ...s, now: at(10) }).length, 0);
});

test('latest only per step', () => {
  const s = setup(['09:00', '12:00', '18:00']);
  const r = dueReminders({ ...s, now: at(13) });
  assert.equal(r.length, 1);
  assert.equal(r[0].time, '12:00');
});

test('completed step is skipped', () => {
  const s = setup();
  s.daysByChallenge = { c1: { '2026-09-25': { steps: { s1: { done: true } } } } };
  assert.equal(dueReminders({ ...s, now: at(10) }).length, 0);
});

test('goal met is skipped', () => {
  const s = setup(['09:00'], { goal: { target: 4, dir: 'atLeast' }, number: { label: 'W', unit: 'L', required: false } });
  s.daysByChallenge = { c1: { '2026-09-25': { steps: { s1: { value: 4 } } } } };
  assert.equal(dueReminders({ ...s, now: at(10) }).length, 0);
});

test('non-active or out-of-range challenge is skipped', () => {
  const s = setup();
  s.attempts.c1[0].status = 'complete';
  assert.equal(dueReminders({ ...s, now: at(10) }).length, 0);
  const s2 = setup();
  assert.equal(dueReminders({ ...s2, now: at(10, 0, 19) }).length, 0); // before start
  assert.equal(dueReminders({ ...s2, now: new Date(2026, 9, 20, 10) }).length, 0); // after last day
});

test('new day resets via firedKey date', () => {
  const s = setup();
  s.fired = [firedKey('2026-09-25', 'c1', 's1', '09:00')];
  assert.equal(dueReminders({ ...s, now: at(10, 0, 26) }).length, 1);
});

test('step without reminders is ignored', () => {
  const s = setup();
  delete s.challenges[0].steps[0].reminders;
  assert.equal(dueReminders({ ...s, now: at(10) }).length, 0);
});
