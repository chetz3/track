// Dev-only canned meal suggestion (see js/gemini.js's suggestMeals). Loaded
// only when isDevHost() and localStorage 'tracker:mockGemini' === '1'; never
// on the live site. Returns raw Gemini-shaped JSON after 600 ms and honours
// input.pref (veg / vegan vs. egg / mix / nonveg).

const ing = (name, qty, unit, category) => ({ name, qty, unit, category });

// South Indian, to match the mock profile (Bengaluru, South Indian).
const VEG = [
  { slot: 'Breakfast', dish: 'Pesarattu + coconut chutney', portion: '2 pesarattu', kcal: 400, protein_g: 24, carbs_g: 50, fat_g: 10, fiber_g: 9,
    ingredients: [ing('Green moong', 80, 'g', 'pulses'), ing('Grated coconut', 30, 'g', 'other'), ing('Green chilli', 2, 'pcs', 'vegetables'), ing('Ginger', 10, 'g', 'vegetables')] },
  { slot: 'Lunch', dish: 'Ragi mudde + bassaru + palya', portion: '1 ball + 1 bowl', kcal: 560, protein_g: 26, carbs_g: 85, fat_g: 10, fiber_g: 16,
    ingredients: [ing('Ragi flour', 80, 'g', 'grains'), ing('Toor dal', 50, 'g', 'pulses'), ing('Beans', 150, 'g', 'vegetables'), ing('Spinach', 1, 'bunch', 'vegetables')] },
  { slot: 'Dinner', dish: 'Paneer sukka + 2 chapati + curd', portion: '120 g paneer', kcal: 520, protein_g: 36, carbs_g: 40, fat_g: 24, fiber_g: 6,
    ingredients: [ing('Paneer', 120, 'g', 'dairy'), ing('Wheat flour', 60, 'g', 'grains'), ing('Curd', 100, 'g', 'dairy'), ing('Onion', 1, 'pcs', 'vegetables')] },
];

const NONVEG = [
  { slot: 'Breakfast', dish: 'Egg dosa + sambar', portion: '2 dosa, 2 eggs', kcal: 430, protein_g: 26, carbs_g: 48, fat_g: 14, fiber_g: 5,
    ingredients: [ing('Dosa batter', 200, 'g', 'grains'), ing('Eggs', 2, 'pcs', 'meat_fish_eggs'), ing('Toor dal', 30, 'g', 'pulses'), ing('Drumstick', 1, 'pcs', 'vegetables')] },
  { slot: 'Lunch', dish: 'Chicken sukka + small rice + rasam', portion: '180 g chicken, 1 cup rice', kcal: 620, protein_g: 48, carbs_g: 58, fat_g: 18, fiber_g: 5,
    ingredients: [ing('Chicken', 180, 'g', 'meat_fish_eggs'), ing('Rice', 60, 'g', 'grains'), ing('Tomato', 2, 'pcs', 'vegetables'), ing('Coconut oil', 1, 'tbsp', 'spices_oils')] },
  { slot: 'Dinner', dish: 'Fish curry + 2 neer dosa + salad', portion: '150 g fish', kcal: 480, protein_g: 36, carbs_g: 45, fat_g: 14, fiber_g: 6,
    ingredients: [ing('Fish (anjal)', 150, 'g', 'meat_fish_eggs'), ing('Rice', 60, 'g', 'grains'), ing('Cucumber', 150, 'g', 'vegetables'), ing('Tomato', 1, 'pcs', 'vegetables')] },
];

export async function mockSuggest(input) {
  await new Promise((r) => setTimeout(r, 600));
  const pref = input && input.pref;
  let meals = (pref === 'veg' || pref === 'vegan') ? VEG : NONVEG;
  if (pref === 'mix') meals = [VEG[0], NONVEG[1], VEG[2]]; // one per slot: at least 1 veg + 1 non-veg
  return {
    meals: JSON.parse(JSON.stringify(meals)),
    why: ['Built around your last 7 days of eating.'],
    tips: ['Have dinner before 8:30 pm.'],
    fixes: ['Protein: 70 → 150 g with dal, paneer, eggs or chicken', 'Fiber: ragi, moong and greens instead of white rice'],
  };
}
