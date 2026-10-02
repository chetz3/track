# Meal suggestions v2: fix gaps, diet preference, grocery list

Precise scope from the user. Opus plans, Sonnet implements, the user tests on the dev server with mocked suggestions, and we push after that.

## 1. Bug: Suggest button missing
- `mealPlanSectionHtml` (js/ui/today.js) returns **only** a "Today's plan" row when `mealPlan.forDate === today`, which hides the Suggest button.
- **Fix:** render the "Today's plan" row (when one exists) **and** the "Suggest tomorrow's meals" button, always. All other conditions stay the same: today only, fitness only, diet set, and ≥ 3 meals on some day in the last 7.

## 2. Preference before suggesting (in the suggest sheet, before calling Gemini)

Choices by `profile.diet`:

| profile.diet | Choices (default first) |
|---|---|
| nonveg | **Mix** / Non-veg / Veg |
| eggetarian | **Egg** / Veg |
| vegetarian | Veg only (no selector) |
| vegan | Vegan only (no selector) |

- The sheet opens with this selector plus a **Suggest** button.
- "New ideas" reuses the chosen preference.
- The choice is remembered in `challenge.mealPlan.pref` and pre-selected next time.
- The prompt states it as a hard rule. For example, Veg means no meat, fish or egg; Egg means veg + eggs; Mix means at least 1 veg and at least 1 non-veg meal.

## 3. Fix yesterday's gaps, don't copy yesterday

**Pure `dayGaps(entry, foodStep, kcalTarget)` in js/mealPlan.js:**
- It works from yesterday's food entry.
- It returns `[{ key: 'kcal'|'protein'|'carbs'|'fat'|'fiber', target, actual, status: 'short'|'over'|'ok' }]`.
  - For atLeast goals (protein, fiber), the status is short when actual < 90% of target.
  - For atMost goals (kcal, carbs, fat), it's over when actual > target.
  - Macros without a target are skipped.

**The input gets:**
- `yesterday: { dishes: [...], gaps: [...] }`;
- `recentDishes`: the unique dishes from the last 7 days, given as **style reference only**.

**Prompt rules (replacing the old "reuse your own dishes" priority):**
1. Close yesterday's gaps first, e.g. "protein was 70 of 155 g, so every meal must be protein-forward".
2. **Never repeat any of yesterday's dishes.** At most one dish may come from `recentDishes`.
3. Use foods that are locally available in `profile.location`, in the user's cuisine style.
4. Follow the diet preference and the avoid list strictly.
5. Fit the schedule's slots and times, and hit the calorie and macro targets.

**The output adds** `fixes: [≤3 strings]`, such as "Protein: 70 → 150 g with eggs, chicken, dal". These appear in the sheet as a **"Fixes from yesterday"** list, replacing "Why this plan" when present.

## 4. Ingredients in the same call + grocery list

**Ingredients:**
- Each meal in the schema adds `ingredients: [{ name, qty (number), unit: 'g'|'ml'|'pcs'|'tbsp'|'tsp'|'cup'|'bunch', category: 'vegetables'|'fruits'|'dairy'|'meat_fish_eggs'|'grains'|'pulses'|'spices_oils'|'other' }]`, for 1 serving and in raw/uncooked quantities.
- `parseMealPlan` validates, clamps and keeps them.

**Pure `groceryList(meals)` in js/mealPlan.js:**
- It sums by lower-cased name + unit, then groups by category in a fixed order.
- It returns `[{ category, label, items: [{ name, qty, unit }] }]`.

**Plan sheet → a "Grocery list for <tomorrow>" section:**
- grouped rows reading "Chicken breast · 300 g";
- a "have it" checkbox per item, persisted in `challenge.mealPlan.have` as a list of keys;
- a **Share list** button using the Web Share API, falling back to copying the text, which lists the unchecked items grouped by category.

**Storage:** the saved `challenge.mealPlan` keeps `meals` (with ingredients), `pref`, `fixes` and `have`. There's no new store.

## 5. Dev-only mock (for UI testing without Gemini)

- **Turning it on:** `?mock=1` (dev host only) sets localStorage `tracker:mockGemini=1`.
- **Faked call:** in js/gemini.js, `suggestMeals` returns a canned fixture after 600 ms when `isDevHost()` and that flag are set.
  - The fixture lives in `js/dev/mockSuggest.js`.
  - It has 3 slot meals with ingredients and fixes, and it honours the pref: a Veg fixture versus a Mix/Non-veg one.
  - It's dynamically imported, so it never loads on the live site.
- **Mock data:** today's existing mock data already has yesterday's protein short, so the fixes make sense.

## 6. Tests
- `dayGaps`: short / over / ok, and no targets.
- `groceryList`: summing the same item across meals, different units kept separate, and category order.
- `parseMealPlan` with ingredients, and without them (an old saved plan → `[]`).
- `prefOptions(diet)` → the choices and default from the table in §2.

## Not doing
Ordering integration, quantities for multiple servings, and persisting the grocery list beyond the latest plan.
