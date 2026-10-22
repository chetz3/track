import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMealStyles, slotKey, slotStyle, buildSuggestionInput } from '../js/mealPlan.js';
import { suggestPrompt } from '../js/gemini.js';

const TODAY = '2026-10-10';
const SCHEDULE = { pattern: 'regular', meals: 2, fast: '16:8', windowStart: '12:00', slots: [{ name: 'Breakfast', time: '08:00' }, { name: 'Lunch', time: '13:00' }] };
const STYLES = {
  breakfast: { styles: ['roti', 'onepot'], note: 'chapati gravy or bisibele bath' },
  lunch: { styles: ['rice'], note: '' },
};

function input(mealStyles, withKey = true) {
  const profile = { cuisine: 'South Indian', location: 'Bengaluru', diet: 'veg', avoid: '', schedule: SCHEDULE };
  if (withKey) profile.mealStyles = mealStyles;
  return { month: 'October', variety: 'balanced', pref: 'veg', targets: { kcal: 1800, protein: 90, fiber: 30 }, profile, yesterday: { meals: [], gaps: [] }, dishFrequency: [], recentPlans: [] };
}

test('cleanMealStyles: drops invalid keys, dedups, trims and slices note, drops empties', () => {
  const out = cleanMealStyles({
    breakfast: { styles: ['onepot', 'bogus', 'roti', 'roti'], note: `  ${'x'.repeat(100)}  ` },
    lunch: { styles: [], note: '   ' },
    dinner: { styles: ['bogus'], note: '' },
    snack: { styles: [], note: ' fruit ' },
    junk: 'nope',
  });
  assert.deepEqual(out.breakfast.styles, ['roti', 'onepot']);
  assert.equal(out.breakfast.note.length, 80);
  assert.deepEqual(out.snack, { styles: [], note: 'fruit' });
  assert.deepEqual(Object.keys(out).sort(), ['breakfast', 'snack']);
});

test('cleanMealStyles: null for {} and non-objects', () => {
  for (const v of [{}, null, undefined, 'x', 5, [], { a: { styles: [], note: '' } }]) assert.equal(cleanMealStyles(v), null);
});

test('slotKey and slotStyle', () => {
  assert.equal(slotKey('  Breakfast '), 'breakfast');
  assert.deepEqual(slotStyle(STYLES, 'Breakfast'), STYLES.breakfast);
  assert.deepEqual(slotStyle(null, 'Lunch'), { styles: [], note: '' });
});

test('suggestPrompt: slot preferences and rule 9', () => {
  const p = suggestPrompt(input(STYLES));
  assert.match(p, /Breakfast \(08:00\) = chapati\/roti \+ gravy\/curry OR one dish on its own/);
  assert.ok(p.includes('("chapati gravy or bisibele bath")'));
  assert.ok(p.includes('Lunch (13:00) = rice + gravy'));
  assert.ok(p.includes('9. A slot with "="'));
});

test('suggestPrompt: note-only slot', () => {
  const p = suggestPrompt(input({ lunch: { styles: [], note: 'gravy rice' } }));
  assert.ok(p.includes('Lunch (13:00) = "gravy rice"'));
});

test('suggestPrompt: no styles is identical to no key', () => {
  const base = suggestPrompt(input(undefined, false));
  assert.equal(suggestPrompt(input(null)), base);
  assert.equal(suggestPrompt(input(undefined)), base);
  assert.ok(!base.includes('9. A slot'));
  assert.ok(!base.includes('(08:00) ='));
});

test('buildSuggestionInput passes cleaned mealStyles through', () => {
  const challenge = { id: 'c', profile: { sex: 'male', age: 30, heightCm: 170, startWeightKg: 70, diet: 'veg', mealStyles: { lunch: { styles: ['rice', 'zzz'], note: ' hi ' } } }, steps: [] };
  assert.deepEqual(buildSuggestionInput(challenge, {}, TODAY, 'mix').profile.mealStyles, { lunch: { styles: ['rice'], note: 'hi' } });
  assert.equal(buildSuggestionInput({ ...challenge, profile: { ...challenge.profile, mealStyles: {} } }, {}, TODAY, 'mix').profile.mealStyles, null);
});

test('single_curry is a valid style key and reaches the prompt', () => {
  assert.deepEqual(cleanMealStyles({ lunch: { styles: ['single_curry', 'rice'], note: '' } }).lunch.styles, ['rice', 'single_curry']);
  assert.ok(suggestPrompt(input({ lunch: { styles: ['single_curry'], note: '' } })).includes('Lunch (13:00) = one main item with a curry/raita/chutney on the side'));
});
