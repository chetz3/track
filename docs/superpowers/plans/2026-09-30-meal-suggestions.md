# AI meal suggestions (next-day plan + weekly body check)

Status: plan, awaiting user review. This is the food part of Phase B in
2026-09-30-fitness-goals-ai-review.md, built first. The auto-adjusted targets
from Phase B come later.

## 1. What the user gets

On Today's Food step, a **"Suggest tomorrow's meals"** button.

- **Enabled** when the last 7 days contain at least one day with ≥ 3 logged meals.
- **Disabled** otherwise, with the hint "Log 3 meals in a day to get suggestions."

Tapping it opens a **meal plan sheet** for tomorrow:

- **4 meals:** Breakfast, Lunch, Snack, Dinner. Each shows the dish, portion, kcal and P / C / F / Fib.
- **Totals vs targets:** "1480 / 1500 kcal · P 150 / 155 g …".
- **"Why this plan":** 2–3 lines tied to last week, e.g. "Protein was short on 5 of 7 days; swapped white rice at dinner for ragi mudde."
- **Body note** from the weekly check (§3), one line.
- **Buttons:**
  - **New ideas** asks Gemini again for different dishes.
  - **Close** dismisses the sheet.
- "Not medical advice."

The latest plan is saved. Tomorrow, the Food step shows a collapsed **"Today's plan"** row that opens the same sheet, so the user can follow it while logging.

## 2. Profile additions (fitness challenge form)

| Field | Values | Why |
|---|---|---|
| Location | free text city/region, e.g. "Bengaluru, Karnataka" | Suggest only locally available food |
| Cuisine | free text hint, e.g. "South Indian" (optional) | Tie-breaker only |
| Diet | Vegetarian / Eggetarian / Non-veg / Vegan (required for suggestions) | Hard filter |
| Avoid | free text, e.g. "peanuts, mushrooms" | Allergies and dislikes |
| Meals per day | 3 / 4 / 5 (default 4) | Plan shape |

**What the user actually eats drives the plan.** The prompt puts it in this order:
1. The user's own logged dishes from the last 7 days: reuse them, adjusting portions.
2. Foods commonly available and eaten in their Location.
3. The cuisine hint.

The plan must never contain an ingredient that clashes with Diet or Avoid.

## 3. Weekly body check (uses the Body step photo)

- **Once a week** (or when the user taps "Update"), the latest Body photo and the latest weight are sent to Gemini.
- **Output:**
  - `{ bmi, build: lean|average|overweight|obese, bellyFat: low|moderate|high, note (≤2 sentences), focus[≤3] }`
  - Example focus: "cut refined carbs at night", "prioritise protein and fibre".
- **Stored on the challenge** as `bodyCheck: { date, ...result }`. Every meal suggestion reuses it as text, so the photo is sent at most once a week, which saves free-tier calls.
- **Without a Body photo**, the check falls back to BMI from height and weight only, with no photo call.
- **Opt-in switch:** "Use my body photo for AI suggestions", off by default; the user decides. When it's off, no photo is sent, and suggestions use food data plus BMI from the profile.

## 4. What is sent for a meal suggestion (text only, one call)

- **Profile:**
  - sex, age, height;
  - current and target weight, aim, days left;
  - cuisine, diet, avoid, meals/day.
- **Targets:** kcal and the 4 macros.
- **Last 7 days, each day:**
  - date;
  - meals as `[dish, kcal, P, C, F, Fib]`;
  - day totals vs targets;
  - workout minutes/kcal, steps, water, sleep.
- **bodyCheck** (text).
- **On "New ideas":** the dishes from the previous suggestion, as "don't repeat these".

## 5. Gemini output schema

```
{ meals: [{ slot, dish, portion, kcal, protein_g, carbs_g, fat_g, fiber_g, swap_for? }],
  why: [≤3 strings],
  tips: [≤3 strings] }
```

- **Code-side checks (not trusted to the AI):**
  - Recompute totals from the meals.
  - If total kcal is outside target ±10%, show a warning line; don't reject the plan.
  - Clamp each number to a sane range.

## 6. Data & files

- **`js/mealPlan.js` (pure, tested):**
  - `canSuggest(daysMap, foodStepId, today)`
  - `buildSuggestionInput(challenge, daysMap, today)`
  - `parseMealPlan(json)`
  - `planTotals(plan)`
- **`js/gemini.js`:** refactor the fetch/fallback loop into `callGemini(parts, schema)`, then add `suggestMeals(input, avoidDishes)` and `checkBody(photoBlob, profile)`.
- **Storage:** everything is stored on the challenge record, so it's backed up with it.
  - `challenge.mealPlan = { forDate, createdAt, meals, why, tips }` (latest only).
  - `challenge.bodyCheck`.
- **`js/ui/today.js`:**
  - the button;
  - the plan sheet;
  - the "Today's plan" row.
- **`js/ui/challenges.js`:**
  - the 4 profile fields;
  - the body-photo consent switch;
  - the body check card with an Update button.
- **`js/backup.js`:** accept the optional `mealPlan`, `bodyCheck` and new profile fields.
- **Tests:**
  - `canSuggest` (0 / 2 / 3 meals, days older than 7);
  - input builder;
  - `parseMealPlan`;
  - totals.

## 7. Delivery

1. Profile fields, `mealPlan.js`, the suggest button and plan sheet (text-only; BMI stands in for the body check).
2. Weekly body check with the photo (opt-in).
3. The user tests; then the Phase B auto-targets follow.

## 8. Decisions (approved by the user)

1. **Body photo:** sent at most once a week, and only if the user turns on the opt-in switch. When it's off, only food data (plus profile BMI) is used.
2. **Timing:** suggestions are made only when the user taps the button. Nothing runs automatically.
3. **Plan tracking:** the plan is only shown; there's no "mark as eaten". Meals are logged only by the user adding a photo.

## 9. Meal schedule & meal planning (v2 — draft for review)

### Schedule (profile)
- **Eating pattern:**
  - **Regular**, with 2 / 3 / 4 / 5 meals.
  - **Intermittent fasting**, with one of:
    - 16:8
    - 18:6
    - 20:4
    - OMAD (one meal a day)
- **Meal times:**
  - **Regular:** one time per meal slot. Defaults for 3 meals are Breakfast 08:30, Lunch 13:30 and Dinner 20:00; for 2 meals, Lunch 12:30 and Dinner 19:30.
  - **Fasting:** the window start time (e.g. 12:00). Slots are spread evenly inside the window, e.g. 16:8 from 12:00 gives Meal 1 at 12:00 and Meal 2 at 19:30.
  - The user can edit every slot's time.
- `profile.schedule = { pattern: 'regular'|'if', meals: 2..5, fast: '16:8'|'18:6'|'20:4'|'omad', windowStart: 'HH:MM', slots: [{ name, time }] }`
  - This replaces `mealsPerDay`, and old values are migrated.
- **The AI plan uses these slots:** same count, names and times. It fits calories and macros into the window and never suggests food outside it.

### Meal planning (Food step)
- **Planned meals for a day:** `day.steps[food].planned = [{ id, slot, time, dish, portion, kcal, macros, source: 'ai'|'manual', }]` (no `checked` — a placeholder is "Logged" when a meal has `plannedId === id`)
- **Ways to fill them:**
  1. **"Add to tomorrow's plan"** on each meal in the AI suggestion sheet, or **"Add all"**.
  2. **"Plan a meal"**, the default manual option: slot, dish and an optional kcal. It works without AI.
- **Today's Food step** lists the day's slots in time order. Each planned meal shows its dish, planned kcal and a Planned/Logged status.
- **Adding a photo** on a planned meal (or "Add food" normally) runs the Gemini estimate. The logged meal is **linked** to that slot (`meal.plannedId`), and the slot shows "planned 450 · actual 520 kcal".
- **Tomorrow's plan** can be edited today, even though logging for that day stays locked.

### Decisions (user)
1. **Planned meals are placeholders only.** They count nothing toward calories, macros or green.
   - There is **no checkbox**. Each placeholder shows a status: "Planned" (grey), then "Logged" (green) once a photo is added for it.
   - Only a photo completes a meal. The photo runs the Gemini estimate and links the meal to the placeholder (`meal.plannedId`). The row then shows "planned 450 · actual 520 kcal".
   - Placeholders can be deleted or edited.
   - A placeholder left without a photo just stays "Planned"; there's no penalty beyond the calories not being counted.
2. **Eating window:** shown on Today, for intermittent fasting only, e.g. "Eating window 12:00–20:00 · opens in 2h". Computed at render time; no timers or notifications.
