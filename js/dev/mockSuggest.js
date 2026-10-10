// Dev-only canned meal suggestion (see js/gemini.js's suggestMeals). Loaded
// only when isDevHost() and localStorage 'tracker:mockGemini' === '1'; never
// on the live site. Returns raw Gemini-shaped JSON after 600 ms and honours
// input.pref (veg / vegan vs. egg / mix / nonveg).

import { normDish } from '../dish.js';

const ing = (name, qty, unit, category) => ({ name, qty, unit, category });

// South Indian, to match the mock profile (Bengaluru, South Indian).
const VEG = [
  { slot: 'Breakfast', dish: 'Pesarattu + coconut chutney', portion: '2 pesarattu', kcal: 400, protein_g: 24, carbs_g: 50, fat_g: 10, fiber_g: 9, local_note: 'Moong at any kirana store',
    ingredients: [ing('Green moong', 80, 'g', 'pulses'), ing('Grated coconut', 30, 'g', 'other'), ing('Green chilli', 2, 'pcs', 'vegetables'), ing('Ginger', 10, 'g', 'vegetables')] },
  { slot: 'Lunch', dish: 'Ragi mudde + bassaru + palya', portion: '1 ball + 1 bowl', kcal: 560, protein_g: 26, carbs_g: 85, fat_g: 10, fiber_g: 16, local_note: 'Ragi flour and greens at local shops',
    ingredients: [ing('Ragi flour', 80, 'g', 'grains'), ing('Toor dal', 50, 'g', 'pulses'), ing('Beans', 150, 'g', 'vegetables'), ing('Spinach', 1, 'bunch', 'vegetables')] },
  { slot: 'Dinner', dish: 'Paneer sukka + 2 chapati + curd', portion: '120 g paneer', kcal: 520, protein_g: 36, carbs_g: 40, fat_g: 24, fiber_g: 6, local_note: 'Paneer at Nandini outlets',
    ingredients: [ing('Paneer', 120, 'g', 'dairy'), ing('Wheat flour', 60, 'g', 'grains'), ing('Curd', 100, 'g', 'dairy'), ing('Onion', 1, 'pcs', 'vegetables')] },
];


const NONVEG = [
  { slot: 'Breakfast', dish: 'Egg dosa + sambar', portion: '2 dosa, 2 eggs', kcal: 430, protein_g: 26, carbs_g: 48, fat_g: 14, fiber_g: 5, local_note: 'Home; eggs at any kirana',
    ingredients: [ing('Dosa batter', 200, 'g', 'grains'), ing('Eggs', 2, 'pcs', 'meat_fish_eggs'), ing('Toor dal', 30, 'g', 'pulses'), ing('Drumstick', 1, 'pcs', 'vegetables')] },
  { slot: 'Lunch', dish: 'Chicken sukka + small rice + rasam', portion: '180 g chicken, 1 cup rice', kcal: 620, protein_g: 48, carbs_g: 58, fat_g: 18, fiber_g: 5, local_note: 'Chicken at any local meat shop',
    ingredients: [ing('Chicken', 180, 'g', 'meat_fish_eggs'), ing('Rice', 60, 'g', 'grains'), ing('Tomato', 2, 'pcs', 'vegetables'), ing('Coconut oil', 1, 'tbsp', 'spices_oils')] },
  { slot: 'Dinner', dish: 'Fish curry + 2 neer dosa + salad', portion: '150 g fish', kcal: 480, protein_g: 36, carbs_g: 45, fat_g: 14, fiber_g: 6, local_note: 'Fresh fish at Russell Market',
    ingredients: [ing('Fish (anjal)', 150, 'g', 'meat_fish_eggs'), ing('Rice', 60, 'g', 'grains'), ing('Cucumber', 150, 'g', 'vegetables'), ing('Tomato', 1, 'pcs', 'vegetables')] },
];

// Alternatives per slot (index 0 = the base dish above). Variety picks
// between them by whether the dish is already in input.dishFrequency /
// recentPlans / avoidDishes. South Indian, to match the mock profile.
const ALT_VEG = [
  { slot: 'Breakfast', dish: 'Ragi dosa + tomato chutney', portion: '2 dosa', kcal: 380, protein_g: 18, carbs_g: 54, fat_g: 9, fiber_g: 8, local_note: 'Ragi flour at any supermarket',
    ingredients: [ing('Ragi flour', 70, 'g', 'grains'), ing('Tomato', 2, 'pcs', 'vegetables'), ing('Curd', 50, 'g', 'dairy')] },
  { slot: 'Lunch', dish: 'Kollu saaru + millet rice + beans palya', portion: '1 bowl saaru, 1 cup rice', kcal: 540, protein_g: 28, carbs_g: 80, fat_g: 9, fiber_g: 15, local_note: 'Horse gram at any kirana store',
    ingredients: [ing('Horse gram', 50, 'g', 'pulses'), ing('Foxtail millet', 70, 'g', 'grains'), ing('Beans', 150, 'g', 'vegetables')] },
  { slot: 'Dinner', dish: 'Thotakura pappu + 2 ragi roti', portion: '1 bowl pappu', kcal: 470, protein_g: 28, carbs_g: 62, fat_g: 11, fiber_g: 12, local_note: 'Amaranth leaves at local vegetable shops',
    ingredients: [ing('Amaranth leaves', 1, 'bunch', 'vegetables'), ing('Toor dal', 60, 'g', 'pulses'), ing('Ragi flour', 60, 'g', 'grains')] },
];
const ALT_NONVEG = [
  { slot: 'Breakfast', dish: 'Egg bhurji + 2 ragi dosa', portion: '3 eggs', kcal: 440, protein_g: 30, carbs_g: 40, fat_g: 18, fiber_g: 6, local_note: 'Ragi flour at any supermarket',
    ingredients: [ing('Eggs', 3, 'pcs', 'meat_fish_eggs'), ing('Ragi flour', 60, 'g', 'grains'), ing('Onion', 1, 'pcs', 'vegetables')] },
  { slot: 'Lunch', dish: 'Kori sukka + ragi mudde', portion: '180 g chicken, 1 ball', kcal: 600, protein_g: 46, carbs_g: 60, fat_g: 16, fiber_g: 9, local_note: 'Mangalorean mess or home',
    ingredients: [ing('Chicken', 180, 'g', 'meat_fish_eggs'), ing('Ragi flour', 80, 'g', 'grains'), ing('Coconut', 30, 'g', 'other')] },
  { slot: 'Dinner', dish: 'Mutton soup + 2 phulka + kosambari', portion: '1 bowl soup', kcal: 460, protein_g: 34, carbs_g: 40, fat_g: 16, fiber_g: 7, local_note: 'Meat shops; kosambari at local mess',
    ingredients: [ing('Mutton', 120, 'g', 'meat_fish_eggs'), ing('Wheat flour', 50, 'g', 'grains'), ing('Moong dal', 30, 'g', 'pulses')] },
];

export async function mockSuggest(input, avoidDishes) {
  await new Promise((r) => setTimeout(r, 600));
  const pref = input && input.pref;
  const variety = (input && input.variety) || 'balanced';
  const known = new Set([
    ...((input && input.dishFrequency) || []).map((f) => normDish(f[0])),
    ...((input && input.recentPlans) || []).map(normDish),
    ...(Array.isArray(avoidDishes) ? avoidDishes : []).map(normDish),
  ]);
  const vegSlot = (i) => (pref === 'veg' || pref === 'vegan') || (pref === 'mix' && i !== 1);
  const meals = [0, 1, 2].map((i) => {
    const cands = vegSlot(i) ? [VEG[i], ALT_VEG[i]] : [NONVEG[i], ALT_NONVEG[i]];
    const fresh = cands.filter((c) => !known.has(normDish(c.dish)));
    const old = cands.filter((c) => known.has(normDish(c.dish)));
    let pick;
    if (variety === 'explore') pick = fresh[0] || cands[1];
    else if (variety === 'familiar') pick = old[0] || cands[0];
    else pick = (i === 1 ? (old[0] || fresh[0]) : (fresh[0] || old[0]));
    return JSON.parse(JSON.stringify(pick));
  });
  const coach = input && input.coach;
  return {
    meals,
    why: ['Built around your last 14 days of eating.'],
    tips: ['Have dinner before 8:30 pm.'],
    fixes: coach && coach.mistakes && coach.mistakes.length
      ? coach.mistakes.slice(0, 3)
      : ['Protein: 70 → 150 g with dal, paneer, eggs or chicken', 'Fiber: ragi, moong and greens instead of white rice'],
  };
}
