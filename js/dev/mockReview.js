// Dev-only canned plateau review (see js/gemini.js's reviewPlateau). Loaded
// only when isDevHost() and localStorage 'tracker:mockGemini' === '1'; never
// on the live site. Returns raw Gemini-shaped JSON after 800 ms, built from
// the review input itself so every date and dish it cites is real (it passes
// parseReview's reference checks): late dinners, the curd-rice next-day bump
// and low protein from the 3-week mock in js/dev/mock.js.

const NEW_FOODS = [
  { dish: 'Pesarattu with ginger chutney', why: 'Moong protein at breakfast instead of plain idli or dosa.', where: 'Home or any Andhra mess in Bengaluru' },
  { dish: 'Kollu (horse gram) saaru', why: 'High-fibre, high-protein pulse in place of a rice-heavy dal.', where: 'Home; horse gram sold in any kirana store' },
  { dish: 'Sprouted moong usli', why: 'A protein and fibre snack that replaces a late carb dinner.', where: 'Home; sprouts at local vegetable shops' },
  { dish: 'Foxtail millet pongal', why: 'Slower carbs than white rice, familiar flavours.', where: 'Millet stores and Zepto in Bengaluru' },
  { dish: 'Egg curry with ragi roti', why: 'Adds protein to dinner and keeps carbs moderate.', where: 'Home; ragi flour at any supermarket' },
  { dish: 'Kosambari with cucumber', why: 'Raw lentil salad that adds fibre and protein to lunch.', where: 'Home; common at Karnataka temple and mess meals' },
];

const clock = (t) => (typeof t === 'string' ? t : '');

export async function mockReview(input) {
  await new Promise((r) => setTimeout(r, 800));
  const rows = Array.isArray(input.d) ? input.d : [];

  const lateDates = [];
  const lateDishes = new Set();
  const curdDates = [];
  const curdDishes = new Set();
  for (const row of rows) {
    const meals = Array.isArray(row[4]) ? row[4] : [];
    let late = false;
    for (const m of meals) {
      if (clock(m[6]) >= '20:00') { late = true; lateDishes.add(m[0]); }
      if (/curd rice/i.test(m[0])) { curdDishes.add(m[0]); if (!curdDates.includes(row[0])) curdDates.push(row[0]); }
    }
    if (late) lateDates.push(row[0]);
  }
  const anyDates = rows.slice(-3).map((r) => r[0]);
  const anyDishes = rows.length && rows[rows.length - 1][4] && rows[rows.length - 1][4][0] ? [rows[rows.length - 1][4][0][0]] : [];

  const causes = [];
  if (lateDates.length) {
    causes.push({
      category: 'meal_timing',
      cause: 'Large rice dinners eaten after 8 pm.',
      evidence: `${lateDates.length} dinners ended after 8 pm, and ${input.pat && input.pat.lateKcalPct != null ? input.pat.lateKcalPct + '% of calories' : 'a big share of calories'} came late in the day.`,
      confidence: 'medium',
      dates: lateDates.slice(-6),
      dishes: [...lateDishes].slice(0, 3),
    });
  }
  if (curdDates.length) {
    causes.push({
      category: 'water_retention',
      cause: 'Weight reads higher the morning after curd rice, which looks like water, not fat.',
      evidence: 'The scale is higher the day after curd rice dinners, so the daily readings bounce.',
      confidence: 'medium',
      dates: curdDates.slice(-4),
      dishes: [...curdDishes].slice(0, 2),
    });
  }
  const protein = input.pat && input.pat.proteinGPerKg;
  const targetProtein = input.targets && input.targets.protein;
  causes.push({
    category: 'low_protein_fiber',
    cause: 'Protein is low for the amount of weight to lose.',
    evidence: `Protein averages ${protein != null ? protein + ' g per kg' : 'low'}${targetProtein ? ` against a ${targetProtein} g target` : ''}.`,
    confidence: 'medium',
    dates: anyDates,
    dishes: anyDishes,
  });
  const irSignal = (input.risk || []).find((r) => ['whtr', 'waist', 'homa_ir', 'tg_hdl', 'belly_fat'].includes(r.id));
  if (irSignal) {
    causes.push({
      category: 'insulin_resistance_signs',
      cause: 'Signs consistent with insulin resistance and central fat.',
      evidence: `${irSignal.label}: ${irSignal.value} (cut-off ${irSignal.threshold}).`,
      confidence: 'low',
      dates: [],
      dishes: [],
    });
  }

  const mistakes = [];
  if (lateDates.length) {
    mistakes.push({
      what: 'Rice-heavy dinner late in the evening',
      since: lateDates[0],
      how_often: `${lateDates.length} of ${rows.length} days`,
      fix: 'Move dinner before 8 pm and halve the rice, adding dal or egg.',
      dates: lateDates.slice(-6),
      dishes: [...lateDishes].slice(0, 3),
    });
  }
  mistakes.push({
    what: 'Low-protein breakfasts and lunches',
    since: rows.length ? rows[0][0] : '',
    how_often: 'most days',
    fix: 'Add eggs, sprouts or paneer to breakfast and lunch.',
    dates: anyDates,
    dishes: anyDishes,
  });

  const kcal = input.targets && input.targets.kcal;
  return {
    summary: 'Your weight is bouncing around the same level even though you follow the plan. Late rice dinners and low protein are the likeliest reasons.',
    verdict: 'real_plateau',
    likely_causes: causes,
    mistakes,
    food_changes: {
      add: ['Eggs or sprouts at breakfast', 'A bowl of dal or sambar at lunch'],
      reduce: ['Rice at dinner', 'Curd rice late in the evening'],
      swap: [{ from: 'Curd rice dinner', to: 'Veg soup with chapati and a boiled egg' }],
    },
    new_local_foods: NEW_FOODS,
    maintenance: kcal
      ? { action: 'diet_break', new_kcal: Math.round((kcal + 300) / 10) * 10, duration_days: 10, why: 'A short stretch at maintenance can settle water and hunger before you go back to the deficit.' }
      : { action: 'keep', why: 'Keep the current target while you fix the dinners.' },
    habits: ['Weigh in at the same time each morning', 'Dinner before 8 pm', 'Sleep at least 7 hours'],
    ask_doctor: [
      { test: 'HbA1c and fasting insulin', why: 'To check for insulin resistance.' },
      { test: 'Liver function test with an ultrasound', why: 'To check for fatty liver.' },
    ],
    watch_next: 'Compare your 14-day trend after two weeks of earlier dinners.',
  };
}
