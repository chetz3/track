import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSelectedId, applyStepPatch, resnapshotToday, validateChallengeInput } from '../js/storeLogic.js';

const body = { id: 'body', name: 'Body', mandatory: true, photo: 'required', number: { label: 'Weight', unit: 'kg', required: true }, note: 'none' };
const read = { id: 'read', name: 'Read', mandatory: true, photo: 'none', number: null, note: 'none' };

test('nextSelectedId keeps current unless it was deleted', () => {
  const cs = [{ id: 'a' }, { id: 'b' }];
  assert.equal(nextSelectedId(cs, 'b', 'a'), 'a');
  assert.equal(nextSelectedId(cs, 'a', 'a'), 'b');
  assert.equal(nextSelectedId([{ id: 'a' }], 'a', 'a'), null);
});

test('applyStepPatch auto-ticks when the last required field is filled', () => {
  const e1 = applyStepPatch(body, undefined, { value: 78.4 });
  assert.deepEqual(e1, { value: 78.4 });
  const e2 = applyStepPatch(body, e1, { photoId: 'p1' });
  assert.deepEqual(e2, { value: 78.4, photoId: 'p1', done: true });
});

test('applyStepPatch never auto-ticks steps without required fields, and respects explicit untick', () => {
  assert.deepEqual(applyStepPatch(read, undefined, { note: 'x' }), { note: 'x' });
  assert.deepEqual(applyStepPatch(body, { value: 1, photoId: 'p', done: true }, { done: false }), { value: 1, photoId: 'p', done: false });
});

test('applyStepPatch clears a number when value is undefined', () => {
  assert.deepEqual(applyStepPatch(body, { value: 5, done: false }, { value: undefined }), { done: false });
});

test('resnapshotToday follows the new mandatory list and ignores missing day', () => {
  const ch = { steps: [body, { ...read, mandatory: false }] };
  assert.deepEqual(resnapshotToday({ date: 'd', mandatoryStepIds: ['body', 'read'], steps: {} }, ch).mandatoryStepIds, ['body']);
  assert.equal(resnapshotToday(undefined, ch), undefined);
});

test('validateChallengeInput catches every invalid field', () => {
  const ok = { name: 'X', totalDays: 30, weeklyTarget: 5, startDate: '2026-09-25', steps: [read] };
  assert.deepEqual(validateChallengeInput(ok, '2026-09-25'), []);
  assert.ok(validateChallengeInput({ ...ok, name: '  ' }, '2026-09-25').length);
  assert.ok(validateChallengeInput({ ...ok, totalDays: 0 }, '2026-09-25').length);
  assert.ok(validateChallengeInput({ ...ok, weeklyTarget: 8 }, '2026-09-25').length);
  assert.ok(validateChallengeInput({ ...ok, startDate: '2026-09-20' }, '2026-09-25').length);
  assert.ok(validateChallengeInput({ ...ok, steps: [] }, '2026-09-25').length);
  assert.ok(validateChallengeInput({ ...ok, steps: [{ ...read, mandatory: false }] }, '2026-09-25').length);
});
