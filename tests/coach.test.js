import test from 'node:test';
import assert from 'node:assert/strict';
import {
  riskSignals, buildReviewInput, reviewPrompt, fitReviewInput, reviewContext, parseReview, REVIEW_SCHEMA,
  REVIEW_BUDGET_CHARS, reviewFloorKcal, applyChange, revertChange, rerunInfo, newDataDays, shouldShowExisting, proteinRaiseTarget, newReviewRecord,
} from '../js/coach.js';
import { isDietBreakActive, dietBreakState, eatingPatterns } from '../js/trend.js';
import { normalizeHealth, healthToDraft, draftToHealth } from '../js/health.js';
import { fitnessMockData } from '../js/dev/mock.js';
import { mockReview } from '../js/dev/mockReview.js';
import { addDays } from '../js/rules.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`);

// ---------- riskSignals ----------

const shared = (health, extra = {}) => ({ sex: 'male', heightCm: 180, health: { shareWithAi: true, ...health }, ...extra });
const ids = (sigs) => sigs.map((s) => s.id);

test('riskSignals: waist-to-height 0.5 / 0.6 and the sex-specific waist cut-off', () => {
  assert.deepEqual(ids(riskSignals(shared({ waistCm: 80 }), {}, null)), []);
  const mid = riskSignals(shared({ waistCm: 90 }), {}, null);
  assert.deepEqual(ids(mid), ['whtr', 'waist']);
  assert.equal(mid[0].threshold, '>=0.5');
  assert.equal(riskSignals(shared({ waistCm: 108 }), {}, null)[0].threshold, '>=0.6 (high)');
  // women: 80 cm
  assert.deepEqual(ids(riskSignals({ ...shared({ waistCm: 82 }), sex: 'female', heightCm: 170 }, {}, null)), ['waist']);
  assert.deepEqual(ids(riskSignals({ ...shared({ waistCm: 79 }), sex: 'female', heightCm: 170 }, {}, null)), []);
});

test('riskSignals: HOMA-IR = glucose x insulin / 405 (>= 2.0, high >= 2.9)', () => {
  assert.deepEqual(ids(riskSignals(shared({ labs: { fastingGlucose: 90, fastingInsulin: 8 } }), {}, null)), []); // 1.78
  const s = riskSignals(shared({ labs: { fastingGlucose: 90, fastingInsulin: 10 } }), {}, null); // 2.22
  assert.deepEqual(ids(s), ['homa_ir']);
  assert.equal(s[0].value, 2.2);
  assert.equal(s[0].threshold, '>=2.0');
  assert.equal(riskSignals(shared({ labs: { fastingGlucose: 95, fastingInsulin: 14 } }), {}, null)[0].threshold, '>=2.9 (high)'); // 3.28
});

test('riskSignals: HbA1c and fasting glucose ranges', () => {
  assert.deepEqual(ids(riskSignals(shared({ labs: { hba1c: 5.6 } }), {}, null)), []);
  assert.match(riskSignals(shared({ labs: { hba1c: 6.0 } }), {}, null)[0].label, /prediabetes/);
  assert.match(riskSignals(shared({ labs: { hba1c: 6.5 } }), {}, null)[0].label, /diabetes range/);
  assert.deepEqual(ids(riskSignals(shared({ labs: { fastingGlucose: 99 } }), {}, null)), []);
  assert.deepEqual(ids(riskSignals(shared({ labs: { fastingGlucose: 100 } }), {}, null)), ['glucose']);
  assert.equal(riskSignals(shared({ labs: { fastingGlucose: 130 } }), {}, null)[0].threshold, '>=126 mg/dL');
});

test('riskSignals: TG/HDL, ALT/AST (sex-specific), TSH, CRP, vit D, B12', () => {
  assert.deepEqual(ids(riskSignals(shared({ labs: { triglycerides: 120, hdl: 45 } }), {}, null)), []); // 2.67
  assert.deepEqual(ids(riskSignals(shared({ labs: { triglycerides: 150, hdl: 45 } }), {}, null)), ['tg_hdl']); // 3.33
  assert.deepEqual(ids(riskSignals(shared({ labs: { alt: 40 } }), {}, null)), []);
  assert.deepEqual(ids(riskSignals(shared({ labs: { alt: 41 } }), {}, null)), ['alt_ast']);
  assert.deepEqual(ids(riskSignals({ ...shared({ labs: { alt: 31 } }), sex: 'female' }, {}, null)), ['alt_ast']);
  assert.deepEqual(ids(riskSignals(shared({ labs: { ast: 41 } }), {}, null)), ['alt_ast']);
  assert.deepEqual(ids(riskSignals(shared({ labs: { tsh: 4.5 } }), {}, null)), []);
  assert.deepEqual(ids(riskSignals(shared({ labs: { tsh: 4.6, crp: 3.1, vitD: 19, b12: 199 } }), {}, null)), ['tsh', 'crp', 'vit_d', 'b12']);
  assert.deepEqual(ids(riskSignals(shared({ labs: { crp: 3, vitD: 20, b12: 200 } }), {}, null)), []);
});

test('riskSignals: body check, eating pattern, red flags', () => {
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, {}, { bellyFat: 'high' })), ['belly_fat']);
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, {}, { bellyFat: 'moderate' })), []);
  const pat = { carbPctOfKcal: 62, lateKcalPct: 35, feelTags: { cravings: { count: 3, topDishes: [] } } };
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, pat, null)), ['carb_late_cravings']);
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, { ...pat, feelTags: {} }, null)), []);
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, { ...pat, lateKcalPct: 29 }, null)), []);
  assert.deepEqual(ids(riskSignals(shared({ conditions: ['kidney_heart_edema'] }), {}, null)), ['red_edema']);
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, {}, null, { slopeKgPerWeek: 2.5 })), ['red_gain']);
  assert.deepEqual(ids(riskSignals({ sex: 'male' }, {}, null, { slopeKgPerWeek: 2 })), []);
  assert.ok(ids(riskSignals(shared({ labs: { hba1c: 9 } }), {}, null)).includes('red_glucose'));
  assert.ok(ids(riskSignals(shared({ labs: { fastingGlucose: 250 } }), {}, null)).includes('red_glucose'));
});

test('riskSignals: missing labs give no signal; health is ignored unless shared', () => {
  assert.deepEqual(riskSignals(shared({}), {}, null), []);
  assert.deepEqual(riskSignals(shared({ labs: {} }), {}, null), []);
  assert.deepEqual(riskSignals({ sex: 'male', heightCm: 180 }, {}, null), []);
  const notShared = { sex: 'male', heightCm: 180, health: { shareWithAi: false, waistCm: 120, labs: { hba1c: 9 }, conditions: ['kidney_heart_edema'] } };
  assert.deepEqual(riskSignals(notShared, {}, null), []);
  for (const s of riskSignals(shared({ waistCm: 100 }), {}, null)) {
    assert.deepEqual(Object.keys(s).sort(), ['id', 'label', 'source', 'threshold', 'value']);
    assert.match(s.label, /Signs consistent with/);
  }
});

// ---------- health helpers ----------

test('health: normalize drops junk; draft round-trips; empty -> null', () => {
  assert.equal(normalizeHealth(null), null);
  assert.equal(normalizeHealth({ conditions: ['nope'], shareWithAi: false }), null);
  const h = { conditions: ['pcos'], meds_flags: ['steroids'], waistCm: 95, waistDate: '2026-10-01', labs: { hba1c: 5.8, date: '2026-09-01' }, shareWithAi: true, meds: 'x' };
  assert.deepEqual(normalizeHealth(h), h);
  assert.deepEqual(draftToHealth(healthToDraft(h)), h);
  assert.equal(draftToHealth(healthToDraft(null)), null);
});

// ---------- mock data fixture ----------

const TODAY = '2026-10-10';
function mockFixture() {
  const m = fitnessMockData(TODAY);
  const days = {};
  for (const e of m.entries) if (e.store === 'days') days[e.value.date] = e.value;
  return { challenge: m.challenge, days, start: m.startDate };
}

// ---------- buildReviewInput ----------

test('buildReviewInput: shape, tuples, no photo ids, health only when shared', () => {
  const { challenge, days, start } = mockFixture();
  const input = buildReviewInput(challenge, days, TODAY, { startDate: start });
  assert.equal(input.today, TODAY);
  assert.equal(input.month, 'October');
  assert.equal(input.d.length, 20); // 21-day attempt, today (still being logged) excluded
  const row = input.d[3];
  assert.match(row[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(row[1] === 0 || row[1] === 1);
  assert.ok(Array.isArray(row[4]));
  assert.equal(row[4][0].length, 7); // [dish,kcal,p,c,f,fib,time]
  assert.match(row[4][0][6], /^\d\d:\d\d$/);
  assert.equal(row[4][0][1] % 10, 0);
  const json = JSON.stringify(input);
  assert.equal(/photo/i.test(json), false);
  assert.equal('health' in input.profile, false);
  assert.ok(input.t14 && input.t28 && input.pat && input.targets);
  assert.equal(input.pat.top[0].length, 3);

  const withHealth = { ...challenge, profile: { ...challenge.profile, health: { shareWithAi: true, conditions: ['pcos'], labs: { hba1c: 6 } } } };
  const shared2 = buildReviewInput(withHealth, days, TODAY, { startDate: start });
  assert.deepEqual(shared2.profile.health, { conditions: ['pcos'], labs: { hba1c: 6 } });
  const off = { ...challenge, profile: { ...challenge.profile, health: { shareWithAi: false, conditions: ['pcos'] } } };
  assert.equal('health' in buildReviewInput(off, days, TODAY, { startDate: start }).profile, false);
  assert.equal(JSON.stringify(buildReviewInput(off, days, TODAY, { startDate: start })).includes('pcos'), false);
});

test('buildReviewInput: at most 28 days and never before the attempt start', () => {
  const { challenge, days } = mockFixture();
  const lateStart = addDays(TODAY, -5);
  const a = buildReviewInput(challenge, days, TODAY, { startDate: lateStart });
  assert.equal(a.d.length, 5);
  assert.equal(a.d[0][0], lateStart);
  // a 40-day history still sends 28
  const long = { ...days };
  for (let i = 22; i <= 40; i++) { const date = addDays(TODAY, -i); long[date] = { ...days[addDays(TODAY, -1)], date, key: `x|${date}` }; }
  const b = buildReviewInput(challenge, long, TODAY, { startDate: addDays(TODAY, -40) });
  assert.equal(b.d.length, 28);
  assert.equal(b.d[0][0], addDays(TODAY, -28));
});

test('buildReviewInput: previous review is summarised into prev', () => {
  const { challenge, days, start } = mockFixture();
  const prevReview = { date: '2026-10-01', verdict: 'real_plateau', mistakes: [{ what: 'Late dinners', fix: 'x' }], maintenance: { action: 'keep' }, food_changes: { add: ['eggs'], reduce: [] } };
  const input = buildReviewInput({ ...challenge, plateauReview: prevReview }, days, TODAY, { startDate: start });
  assert.deepEqual(input.prev, { date: '2026-10-01', verdict: 'real_plateau', mistakes: ['Late dinners'], food_changes: { add: ['eggs'] }, maintenance: { action: 'keep' } });
});

// ---------- prompt + budget ----------

test('review prompt for the 3-week mock is within the 16,000 char budget', () => {
  const { challenge, days, start } = mockFixture();
  const input = fitReviewInput(buildReviewInput(challenge, days, TODAY, { startDate: start }));
  const prompt = reviewPrompt(input);
  assert.ok(prompt.length <= REVIEW_BUDGET_CHARS, `prompt is ${prompt.length} chars`);
  assert.equal(input.d.length, 20);
  assert.ok(prompt.length > 3000);
  assert.equal(prompt.includes('\n  '), false); // minified data
});

test('fitReviewInput drops the oldest days first, down to 14', () => {
  const { challenge, days, start } = mockFixture();
  const input = buildReviewInput(challenge, days, TODAY, { startDate: start });
  const oldest = input.d[0][0];
  const newest = input.d[input.d.length - 1][0];
  const tight = fitReviewInput(structuredClone(input), 4000);
  assert.equal(tight.d.length, 14);
  assert.equal(tight.d[tight.d.length - 1][0], newest);
  assert.notEqual(tight.d[0][0], oldest);
  const mid = fitReviewInput(structuredClone(input), reviewPrompt(input).length - 1);
  assert.equal(mid.d.length, 19);
});

test('REVIEW_PROMPT carries the safety rails, the legend and the wiring', () => {
  const { challenge, days, start } = mockFixture();
  const input = buildReviewInput(challenge, days, TODAY, { startDate: start });
  const prompt = reviewPrompt(input);
  assert.match(prompt, /not a diagnosis/);
  assert.match(prompt, /Never invent foods, numbers, dates, labs or symptoms/);
  assert.match(prompt, /kcal never below 1950|kcal never below \d{4}/);
  assert.match(prompt, /loss ≤ 1% body weight per week; no supplements, drugs or detox/);
  assert.match(prompt, /sold in Bengaluru, Karnataka, in season for October/);
  assert.match(prompt, /Legend: weeksOnPlan=.*t14\/t28=trend/);
  assert.match(prompt, /new_local_foods = 6 dishes not in pat\.top or d\./);
  assert.ok(prompt.includes('Data:{"today":"2026-10-10"'));
});

test('REVIEW_SCHEMA: every cause and mistake carries dates and dishes', () => {
  const props = REVIEW_SCHEMA.properties;
  assert.ok(props.likely_causes.items.required.includes('dates'));
  assert.ok(props.likely_causes.items.required.includes('dishes'));
  assert.ok(props.mistakes.items.required.includes('dates'));
  assert.deepEqual(props.maintenance.properties.action.enum, ['keep', 'lower_target', 'raise_protein', 'diet_break', 'recalc']);
});

// ---------- parseReview ----------

const CTX = {
  bmr: 1900, sex: 'male', currentTargetKcal: 1700, maintenanceKcal: 2200,
  historyDishes: ['Curd rice', 'Rice + dal dinner', 'Idli sambar'],
  dates: ['2026-10-01', '2026-10-02', '2026-10-03'],
  healthShared: false, labs: [], signals: [], redFlag: false,
};

function base(extra = {}) {
  return {
    summary: 'Summary.', verdict: 'real_plateau', likely_causes: [], mistakes: [],
    food_changes: { add: [], reduce: [], swap: [] }, new_local_foods: [], maintenance: { action: 'keep', why: 'ok' },
    habits: [], ask_doctor: [], watch_next: 'Watch.', ...extra,
  };
}
const cause = (extra = {}) => ({ category: 'meal_timing', cause: 'Late rice', evidence: 'ate late', confidence: 'medium', dates: ['2026-10-01'], dishes: ['Curd rice'], ...extra });

test('parseReview: lower_target is floored at max(BMR, sex floor) and capped at the current target', () => {
  const low = parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 1200, why: 'x' } }), { ...CTX, bmr: 1550, currentTargetKcal: 2000 });
  assert.equal(low.maintenance.action, 'lower_target');
  assert.equal(low.maintenance.new_kcal, 1550);
  // the floor is above the current target: nothing safe to lower to
  assert.equal(parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 1200, why: 'x' } }), CTX).maintenance.action, 'keep');
  // BMR below the sex floor -> the sex floor (1500 men)
  const f = parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 1300, why: 'x' } }), { ...CTX, bmr: 1400, currentTargetKcal: 1800 });
  assert.equal(f.maintenance.new_kcal, 1500);
  const female = parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 1000, why: 'x' } }), { ...CTX, sex: 'female', bmr: 1100, currentTargetKcal: 1600 });
  assert.equal(female.maintenance.new_kcal, 1200);
  // rounded to 10
  assert.equal(parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 1873, why: 'x' } }), { ...CTX, bmr: 1500, currentTargetKcal: 2000 }).maintenance.new_kcal, 1870);
  // higher than the current target -> nothing lower to apply
  const up = parseReview(base({ maintenance: { action: 'lower_target', new_kcal: 2500, why: 'x' } }), { ...CTX, bmr: 1500 });
  assert.equal(up.maintenance.action, 'keep');
  assert.equal('new_kcal' in up.maintenance, false);
  // no number at all
  assert.equal(parseReview(base({ maintenance: { action: 'lower_target', why: 'x' } }), CTX).maintenance.action, 'keep');
});

test('parseReview: diet_break is >= the current target, <= maintenance, 7-14 days, rounded to 10', () => {
  const p = (m, c = CTX) => parseReview(base({ maintenance: { action: 'diet_break', why: 'x', ...m } }), c).maintenance;
  assert.deepEqual(p({ new_kcal: 2000, duration_days: 10 }), { action: 'diet_break', why: 'x', new_kcal: 2000, duration_days: 10 });
  assert.equal(p({ new_kcal: 1500, duration_days: 10 }).new_kcal, 1700);
  assert.equal(p({ new_kcal: 3000, duration_days: 10 }).new_kcal, 2200);
  assert.equal(p({ new_kcal: 1993, duration_days: 10 }).new_kcal, 1990);
  assert.equal(p({ new_kcal: 2000, duration_days: 3 }).duration_days, 7);
  assert.equal(p({ new_kcal: 2000, duration_days: 30 }).duration_days, 14);
  assert.equal(p({ new_kcal: 2000 }).duration_days, 10);
  assert.equal(p({ new_kcal: 2000, duration_days: 'x' }).duration_days, 10);
  // no kcal given -> maintenance
  assert.equal(p({ duration_days: 8 }).new_kcal, 2200);
  assert.equal(p({ duration_days: 8 }, { ...CTX, maintenanceKcal: null }).action, 'keep');
});

test('parseReview: other actions carry no numbers; unknown action -> keep', () => {
  for (const action of ['keep', 'raise_protein', 'recalc']) {
    const m = parseReview(base({ maintenance: { action, new_kcal: 1500, duration_days: 9, why: 'x' } }), CTX).maintenance;
    assert.deepEqual(m, { action, why: 'x' });
  }
  assert.equal(parseReview(base({ maintenance: { action: 'starve', why: 'x' } }), CTX).maintenance.action, 'keep');
});

test('parseReview: enum filtering, verdict fallback, confidence fallback', () => {
  const r = parseReview(base({
    verdict: 'who_knows',
    likely_causes: [cause({ category: 'magic' }), cause({ confidence: 'certain' })],
  }), CTX);
  assert.equal(r.verdict, 'not_enough_data');
  assert.equal(r.likely_causes.length, 1);
  assert.equal(r.likely_causes[0].confidence, 'low');
});

test('parseReview: lengths and counts are capped', () => {
  const long = 'x'.repeat(1000);
  const many = Array.from({ length: 9 }, (_, i) => cause({ cause: `Cause ${i}` }));
  const r = parseReview(base({
    summary: long, watch_next: long, likely_causes: many,
    mistakes: Array.from({ length: 9 }, (_, i) => ({ what: `M${i}`, since: '2026-10-01', how_often: 'x', fix: 'y', dates: [], dishes: [] })),
    food_changes: { add: Array(9).fill('a'), reduce: Array(9).fill('b'), swap: Array(9).fill({ from: 'a', to: 'b' }) },
    habits: Array(9).fill('h'), ask_doctor: Array(9).fill({ test: 't', why: 'w' }),
  }), CTX);
  assert.ok(r.summary.length <= 300);
  assert.ok(r.watch_next.length <= 200);
  assert.equal(r.likely_causes.length, 5);
  assert.equal(r.mistakes.length, 5);
  assert.equal(r.food_changes.add.length, 5);
  assert.equal(r.food_changes.reduce.length, 5);
  assert.equal(r.food_changes.swap.length, 5);
  assert.equal(r.habits.length, 4);
  assert.equal(r.ask_doctor.length, 4);
});

test('parseReview: new_local_foods drops history dishes, duplicates, empties; max 6; dish <= 60 chars', () => {
  const foods = ['Curd rice', 'idli sambars', 'Pesarattu', 'pesarattu!', 'Kosambari', 'Ragi dosa', 'Bisi bele bath', 'Akki rotti', 'Foxtail pongal', '', 'x'.repeat(100)];
  const r = parseReview(base({ new_local_foods: foods.map((dish) => ({ dish, why: 'w', where: 'home' })) }), CTX);
  const names = r.new_local_foods.map((f) => f.dish);
  assert.deepEqual(names.slice(0, 6), ['Pesarattu', 'Kosambari', 'Ragi dosa', 'Bisi bele bath', 'Akki rotti', 'Foxtail pongal']);
  assert.equal(r.new_local_foods.length, 6);
  assert.ok(r.new_local_foods.every((f) => f.dish.length <= 60));
});

test('parseReview: causes and mistakes with a fake date or a fake dish are dropped', () => {
  const r = parseReview(base({
    likely_causes: [
      cause({ cause: 'good' }),
      cause({ cause: 'fake date', dates: ['2026-09-09'] }),
      cause({ cause: 'fake dish', dishes: ['Pizza'] }),
      cause({ cause: 'one real one fake date', dates: ['2026-10-01', '2026-09-09'] }),
      cause({ cause: 'no refs at all', dates: [], dishes: [] }),
    ],
    mistakes: [
      { what: 'good', since: '2026-10-01', how_often: 'x', fix: 'y', dates: ['2026-10-02'], dishes: ['idli sambar'] },
      { what: 'fake date', since: '2026-10-01', how_often: 'x', fix: 'y', dates: ['2026-12-25'], dishes: [] },
      { what: 'fake dish', since: '2026-10-01', how_often: 'x', fix: 'y', dates: [], dishes: ['Burger'] },
    ],
  }), CTX);
  assert.deepEqual(r.likely_causes.map((c) => c.cause), ['good', 'one real one fake date', 'no refs at all']);
  assert.deepEqual(r.likely_causes[1].dates, ['2026-10-01']);
  assert.deepEqual(r.mistakes.map((m) => m.what), ['good']);
});

test('parseReview: since must be a valid date, otherwise it is dropped', () => {
  const m = (since) => parseReview(base({ mistakes: [{ what: 'w', since, how_often: 'x', fix: 'y', dates: [], dishes: [] }] }), CTX).mistakes[0];
  assert.equal(m('2026-10-01').since, '2026-10-01');
  assert.equal('since' in m('last week'), false);
  assert.equal('since' in m('2026-13-45'), false);
});

test('parseReview: a lab cause is dropped when that lab was not provided', () => {
  const hba = cause({ category: 'insulin_resistance_signs', cause: 'HbA1c shows prediabetes', evidence: 'HbA1c 6.0' });
  const ctx = { ...CTX, signals: ['whtr'], healthShared: true };
  assert.equal(parseReview(base({ likely_causes: [hba] }), { ...ctx, labs: [] }).likely_causes.length, 0);
  assert.equal(parseReview(base({ likely_causes: [hba] }), { ...ctx, labs: ['hba1c'] }).likely_causes.length, 1);
  const tsh = cause({ category: 'condition_or_meds', cause: 'TSH is high', evidence: 'TSH 6' });
  assert.equal(parseReview(base({ likely_causes: [tsh] }), { ...ctx, labs: ['hba1c'] }).likely_causes.length, 0);
  assert.equal(parseReview(base({ likely_causes: [tsh] }), { ...ctx, labs: ['tsh'] }).likely_causes.length, 1);
});

test('parseReview: condition_or_meds causes need shared health', () => {
  const c = cause({ category: 'condition_or_meds', cause: 'Thyroid condition may slow loss', evidence: 'reported hypothyroid' });
  assert.equal(parseReview(base({ likely_causes: [c] }), { ...CTX, healthShared: false }).likely_causes.length, 0);
  assert.equal(parseReview(base({ likely_causes: [c] }), { ...CTX, healthShared: true }).likely_causes.length, 1);
});

test('parseReview: a risk category without a matching signal becomes an ask_doctor item', () => {
  const c = cause({ category: 'insulin_resistance_signs', cause: 'Signs consistent with insulin resistance', evidence: 'late carbs' });
  const none = parseReview(base({ likely_causes: [c] }), { ...CTX, signals: [] });
  assert.equal(none.likely_causes.length, 0);
  assert.equal(none.ask_doctor.length, 1);
  assert.match(none.ask_doctor[0].test, /HbA1c/);
  assert.equal(none.ask_doctor[0].why, 'Signs consistent with insulin resistance');
  const some = parseReview(base({ likely_causes: [c] }), { ...CTX, signals: ['whtr'] });
  assert.equal(some.likely_causes.length, 1);
  assert.equal(some.ask_doctor.length, 0);
  // an unrelated signal does not unlock it
  assert.equal(parseReview(base({ likely_causes: [c] }), { ...CTX, signals: ['crp'] }).likely_causes.length, 0);
  const sens = cause({ category: 'sensitivity_inflammation', cause: 'Bloating after curd rice', evidence: 'feel tags' });
  assert.equal(parseReview(base({ likely_causes: [sens] }), { ...CTX, signals: [], feelOrBumps: true }).likely_causes.length, 1);
  assert.equal(parseReview(base({ likely_causes: [sens] }), { ...CTX, signals: [], feelOrBumps: false }).likely_causes.length, 0);
});

test('parseReview: a red flag forces "See a doctor:" at the start of the summary', () => {
  assert.match(parseReview(base({ summary: 'Weight is flat.' }), { ...CTX, redFlag: true }).summary, /^See a doctor: Weight is flat\.$/);
  assert.equal(parseReview(base({ summary: 'See a doctor: swelling.' }), { ...CTX, redFlag: true }).summary, 'See a doctor: swelling.');
  assert.equal(parseReview(base({ summary: 'Weight is flat.' }), CTX).summary, 'Weight is flat.');
});

test('parseReview: bad shapes throw; garbage inside is tolerated', () => {
  assert.throws(() => parseReview(null, CTX), /Unexpected response from Gemini/);
  assert.throws(() => parseReview([], CTX), /Unexpected response from Gemini/);
  const r = parseReview({ likely_causes: 'no', mistakes: [null, 3], food_changes: 5, new_local_foods: [null], maintenance: 'x', habits: 'a', ask_doctor: [1] }, CTX);
  assert.equal(r.verdict, 'not_enough_data');
  assert.deepEqual(r.likely_causes, []);
  assert.deepEqual(r.food_changes, { add: [], reduce: [], swap: [] });
  assert.equal(r.maintenance.action, 'keep');
});

// ---------- the dev mock passes the reference checks ----------

test('mockReview: cites real dates and dishes, so parseReview keeps all of it', async () => {
  const { challenge, days, start } = mockFixture();
  const input = fitReviewInput(buildReviewInput(challenge, days, TODAY, { startDate: start }));
  const raw = await mockReview(input);
  const parsed = parseReview(raw, reviewContext(input));
  assert.equal(parsed.likely_causes.length, raw.likely_causes.length);
  assert.equal(parsed.mistakes.length, raw.mistakes.length);
  assert.equal(parsed.new_local_foods.length, 6);
  assert.equal(parsed.maintenance.action, 'raise_protein');
  assert.equal("new_kcal" in parsed.maintenance, false); // raise_protein carries no kcal
  assert.ok(parsed.likely_causes.every((c) => c.dates.every((d) => input.d.some((r) => r[0] === d))));
  assert.ok(parsed.ask_doctor.length >= 1);
});

test('reviewContext: floor, history and shared flags come from the input that was sent', () => {
  const { challenge, days, start } = mockFixture();
  const input = buildReviewInput({ ...challenge, profile: { ...challenge.profile, health: { shareWithAi: true, labs: { hba1c: 6.1 } } } }, days, TODAY, { startDate: start });
  const ctx = reviewContext(input);
  assert.equal(ctx.healthShared, true);
  assert.deepEqual(ctx.labs, ['hba1c']);
  assert.ok(ctx.signals.includes('hba1c'));
  assert.ok(ctx.historyDishes.includes('Curd rice'));
  assert.equal(ctx.currentTargetKcal, 1660);
  assert.equal(ctx.sex, 'male');
  assert.ok(ctx.bmr > 1700);
  assert.ok(ctx.maintenanceKcal > 1660);
  assert.equal(ctx.dates.length, input.d.length);
});

// ---------- feel tags feed eatingPatterns ----------

test('eatingPatterns: day-level entry.feel counts per day with that day\'s dishes', () => {
  const { challenge, days, start } = mockFixture();
  const foodId = challenge.steps.find((s) => s.type === 'food').id;
  const dates = Object.keys(days).sort();
  const tagged = { ...days };
  for (const d of dates.slice(3, 6)) tagged[d] = { ...days[d], steps: { ...days[d].steps, [foodId]: { ...days[d].steps[foodId], feel: ['bloated'] } } };
  const p = eatingPatterns(challenge, tagged, TODAY, { startDate: start });
  assert.equal(p.feelTags.bloated.count, 3);
  assert.ok(p.feelTags.bloated.topDishes.length >= 1 && p.feelTags.bloated.topDishes.length <= 3);
});

// ---------- diet break + Apply / Undo ----------

function fitChallenge() {
  const { challenge } = mockFixture();
  return { ...challenge, plateauReview: { date: TODAY, verdict: 'real_plateau', maintenance: { action: 'diet_break', new_kcal: 2000, duration_days: 10, why: 'x' }, useInSuggestions: true, applied: null } };
}
const kcalOf = (c) => c.steps.find((s) => s.type === 'food').goal.target;

test('applyChange diet_break: new target, applied record, exact undo', () => {
  const c = fitChallenge();
  const before = kcalOf(c);
  const applied = applyChange(c, TODAY, { kind: 'kcal', to: 2000, durationDays: 10 });
  assert.equal(kcalOf(applied), 2000);
  assert.deepEqual(applied.plateauReview.applied, { action: 'diet_break', field: 'kcal', from: before, to: 2000, date: TODAY, untilDate: addDays(TODAY, 10) });
  assert.equal(kcalOf(c), before); // input untouched
  const back = revertChange(applied);
  assert.equal(kcalOf(back), before);
  assert.equal(back.plateauReview.applied, null);
  assert.deepEqual(back.steps, c.steps);
});

test('applyChange lower_target has no end date; re-applying keeps the original "from"', () => {
  const c = { ...fitChallenge(), plateauReview: { ...fitChallenge().plateauReview, maintenance: { action: 'lower_target', new_kcal: 1500, why: 'x' } } };
  const before = kcalOf(c);
  const a1 = applyChange(c, TODAY, { kind: 'kcal', to: 1500 });
  assert.equal(a1.plateauReview.applied.untilDate, null);
  const a2 = applyChange(a1, addDays(TODAY, 1), { kind: 'kcal', to: 1400 });
  assert.equal(a2.plateauReview.applied.from, before);
  assert.equal(kcalOf(revertChange(a2)), before);
});

test('applyChange raise_protein edits macros.protein.target and undo restores it', () => {
  const c = fitChallenge();
  const food = c.steps.find((s) => s.type === 'food');
  const before = food.macros.protein.target;
  const a = applyChange(c, TODAY, { kind: 'protein', to: before + 20 });
  assert.equal(a.steps.find((s) => s.type === 'food').macros.protein.target, before + 20);
  assert.equal(a.plateauReview.applied.action, 'raise_protein');
  assert.equal(kcalOf(a), kcalOf(c));
  assert.equal(revertChange(a).steps.find((s) => s.type === 'food').macros.protein.target, before);
  assert.throws(() => applyChange({ ...c, plateauReview: null }, TODAY, { to: 1 }), /Nothing to apply/);
});

test('proteinRaiseTarget: 1.6 g/kg rounded to 5, null when already met', () => {
  assert.equal(proteinRaiseTarget(100, 90), 160);
  assert.equal(proteinRaiseTarget(100, 160), null);
  assert.equal(proteinRaiseTarget(null, 90), null);
});

test('isDietBreakActive / dietBreakState: running, done, none', () => {
  const c = applyChange(fitChallenge(), '2026-10-10', { kind: 'kcal', to: 2000, durationDays: 10 }); // until 2026-10-20
  assert.equal(isDietBreakActive(c, '2026-10-10'), true);
  assert.equal(isDietBreakActive(c, '2026-10-20'), true);
  assert.equal(isDietBreakActive(c, '2026-10-21'), false);
  assert.deepEqual(dietBreakState(c, '2026-10-12'), { phase: 'running', day: 3, of: 10, kcal: 2000 });
  assert.deepEqual(dietBreakState(c, '2026-10-19'), { phase: 'running', day: 10, of: 10, kcal: 2000 });
  assert.deepEqual(dietBreakState(c, '2026-10-20'), { phase: 'done', backTo: c.plateauReview.applied.from });
  assert.deepEqual(dietBreakState(c, '2026-11-02'), { phase: 'done', backTo: c.plateauReview.applied.from });
  assert.equal(dietBreakState(revertChange(c), '2026-10-12'), null);
  assert.equal(isDietBreakActive({}, '2026-10-12'), false);
  const lower = applyChange({ ...fitChallenge(), plateauReview: { ...fitChallenge().plateauReview, maintenance: { action: 'lower_target', new_kcal: 1500, why: 'x' } } }, TODAY, { kind: 'kcal', to: 1500 });
  assert.equal(dietBreakState(lower, TODAY), null);
  assert.equal(isDietBreakActive(lower, TODAY), false);
});

// ---------- re-run / show existing ----------

test('rerunInfo: >= 3 days old or >= 3 new data days; otherwise the date it opens', () => {
  const { challenge, days } = mockFixture();
  const withReview = (date) => ({ ...challenge, plateauReview: { date, verdict: 'real_plateau' } });
  assert.deepEqual(rerunInfo(challenge, days, TODAY), { available: true, onDate: null });
  assert.equal(rerunInfo(withReview(addDays(TODAY, -3)), days, TODAY).available, true);
  const r = rerunInfo(withReview(addDays(TODAY, -1)), days, TODAY);
  assert.equal(r.available, false);
  assert.equal(r.onDate, addDays(TODAY, 2));
  assert.equal(newDataDays(withReview(addDays(TODAY, -4)), days, addDays(TODAY, -4)), 4);
  assert.equal(rerunInfo(withReview(addDays(TODAY, -2)), days, TODAY).available, false);
  assert.equal(rerunInfo(withReview(TODAY), days, TODAY).available, false);
});

test('shouldShowExisting: shown while an apply is in effect or a re-run is not yet available', () => {
  const { challenge, days } = mockFixture();
  const rv = (date, applied = null) => ({ ...challenge, plateauReview: { date, verdict: 'real_plateau', applied } });
  assert.equal(shouldShowExisting(challenge, days, TODAY), false);
  assert.equal(shouldShowExisting(rv(TODAY), days, TODAY), true);
  assert.equal(shouldShowExisting(rv(addDays(TODAY, -10)), days, TODAY), false);
  assert.equal(shouldShowExisting(rv(addDays(TODAY, -10), { action: 'lower_target', from: 1, to: 2 }), days, TODAY), true);
});

test('newReviewRecord: keeps the parsed review, defaults on, carries applied', () => {
  const rec = newReviewRecord({ verdict: 'real_plateau' }, TODAY, { status: 'fluctuating', slopeKgPerWeek: 0.01, endKg: 129.3, rangeKg: 2, adherencePct: 85, expectedLossKg: 2.4, actualLossKg: 0, extra: 1 }, { action: 'x' });
  assert.equal(rec.date, TODAY);
  assert.equal(rec.useInSuggestions, true);
  assert.deepEqual(rec.applied, { action: 'x' });
  assert.equal(rec.trendAtReview.status, 'fluctuating');
  assert.equal('extra' in rec.trendAtReview, false);
  near(rec.trendAtReview.endKg, 129.3);
});

test('review floor never sits above a current target that is already below BMR', () => {
  const p = { sex: 'male', age: 32, heightCm: 180, startWeightKg: 129.5 };
  assert.equal(reviewFloorKcal(p, 1660), 1660);       // BMR ≈ 1940 > target → the target is the floor
  assert.equal(reviewFloorKcal(p, 2400) > 1660, true); // target above BMR → BMR is the floor
  assert.equal(reviewFloorKcal({ ...p, sex: 'female' }, 1000), 1200); // never below the sex floor
});

test('review input stops at yesterday and carries weeksOnPlan', () => {
  const { challenge, days, start } = mockFixture();
  const input = buildReviewInput(challenge, days, TODAY, { startDate: start });
  assert.equal(input.d[input.d.length - 1][0], addDays(TODAY, -1));
  assert.equal(input.weeksOnPlan, 2);
  assert.match(reviewPrompt(input), /6b\. maintenance: diet_break only if weeksOnPlan ≥ 8/);
});

test('parseReview: a diet break before 8 weeks on plan becomes keep', () => {
  const asked = base({ maintenance: { action: 'diet_break', new_kcal: 2100, duration_days: 10, why: 'x' } });
  assert.equal(parseReview(asked, { ...CTX, weeksOnPlan: 2 }).maintenance.action, 'keep');
  assert.equal(parseReview(asked, { ...CTX, weeksOnPlan: 9 }).maintenance.action, 'diet_break');
});
