# Fitness Challenges, Step Goals and AI Daily Review: Plan (for review)

- **Roles:** Opus plans, Sonnet implements, and the user tests. Nothing is implemented until this plan is approved.
- **Stack:** plain JS with no server. Gemini uses each user's own key; see the byok decision.

## 1. What the user gets

- **Creating a challenge:** pick a category, either **Custom** (today's behavior) or **Fitness**.
- **Fitness setup:** a short profile (sex, age, height, current weight, target weight, activity level, aim: lose / maintain / gain).
- **Preset steps:** Food, Workout, Steps, Water, Body and Sleep. Each gets a **goal target** pre-filled from the profile. Every target is editable, and any preset can be made optional or removed. Custom steps can still be added, with an optional target.
- **Today screen:**
  - a "Today's plan" card listing each step's target;
  - each row shows progress as `actual / target`, for example `1,450 / 1,900 kcal` or `1.5 / 2.8 L`.
- **End of day:** an **AI Daily Review**.
  - The AI summarises yesterday and sets **tomorrow's targets** from actual data.
  - Example: if you ate 400 kcal over, it trims tomorrow's calories slightly and raises the workout burn.
- **Scoring:** a day is **green** only if every mandatory step meets its target. The existing reset rule then applies (see question Q1).

## 2. Step types and goals

| Type | Entry UI | Stored value | Goal (direction) | Default target |
|---|---|---|---|---|
| food | meal photos → Gemini (already built) | total kcal | at most (lose) / at least (gain) / ±10% (maintain) | TDEE ± aim (Mifflin-St Jeor) |
| workout | add session: type (Walk, Run, Gym, Yoga, Cycling, Sports, Other), minutes, intensity; kcal burned estimated locally from MET × weight × time, editable | total minutes (+ kcal burned) | minutes at least, optional burn at least | 30 min |
| steps | number input; a PWA can't read Apple Health | step count | at least | 8,000 |
| water | +250 ml / +500 ml buttons, or type a value | litres | at least | 35 ml × kg |
| body | photo + weight (kg) | weight | done when logged; target weight tracked in Stats | log daily |
| sleep | hours slept **last night**, entered on waking. Yesterday stays editable (existing rule), so late fixes work | hours | at least | 7.5 h |
| custom | as today (photo / number / note) | as today | optional: number at least / at most | none |

## 3. Data model (additive; old challenges keep working)

- **challenge:**
  - `category`: `'custom' | 'fitness'`. If it's missing, the challenge is treated as custom.
  - `profile`: `{ sex, age, heightCm, startWeightKg, targetWeightKg, activity, aim }`, for fitness challenges only.
- **step:**
  - `type`: `'food' | 'workout' | 'steps' | 'water' | 'body' | 'sleep'`, or missing for a custom step.
  - `goal`: `{ target: number, dir: 'atLeast' | 'atMost' | 'near' }`, or `null`. This is the **base** target.
- **day record:**
  - `targets`: `{ [stepId]: number }`. The targets that apply that day, snapshotted so later edits never rescore history (same idea as `mandatoryStepIds`).
  - `plan`: `{ summary, wins[], misses[], tips[], generatedAt, source: 'ai' | 'base' }`. The AI review that produced those targets.
- **Entries:**
  - workout: `{ sessions: [{ id, type, minutes, intensity, kcal }], value: minutes, burn: kcal }`
  - water, steps and sleep: `{ value }`
  - body: `{ photoId, value: kg }`
  - food: unchanged.
- **Target for a day:** `day.targets[stepId]`, then `step.goal.target`, then no goal.

## 4. AI Daily Review

- **When it runs.** There's no server, so nothing can run at midnight. It runs in two cases:
  1. The user taps **"End day"** on Today, which reviews today and plans tomorrow.
  2. **Automatically on the first open of a new day**, if yesterday wasn't reviewed. A **"Regenerate"** button covers updating things like yesterday's sleep afterwards.
- **Input** (text only, no photos, so it's cheap on the free tier):
  - the profile;
  - the latest weight;
  - the last 7 days of `{ date, per-step actual vs target, green? }`;
  - the reviewed day's meals (dish, kcal) and workout sessions.
- **Output schema:** `{ summary (≤3 sentences), wins[], misses[], tips[≤3], targets: { calories, workoutMinutes, burnKcal, steps, waterLitres, sleepHours } }`. The targets are mapped onto step ids by `type`.
- **Safety clamps (code, not AI):**
  - calories: min(1,200 women / 1,500 men), max 4,000;
  - water: 1.5–5 L;
  - steps: 3,000–25,000;
  - sleep: 7–9.5 h;
  - workout: 0–120 min;
  - change per day: at most ±15% from the previous target.
  - Add the line "Not medical advice."
- **Fallback:** if there's no key, the device is offline, or Gemini errors, keep the previous targets (`source: 'base'`) and show why.
- **Applying the plan:** AI targets are applied to tomorrow automatically. The user can edit any target on the plan card (see Q2).

## 5. Files

| File | Change |
|---|---|
| `js/fitness.js` (new, pure) | presets, BMR/TDEE, default targets, MET burn, `meetsGoal(value, target, dir)`, `clampPlan(prev, next, profile)` |
| `js/dailyReview.js` (new) | builds the review input, calls Gemini, clamps the result, saves `targets` + `plan` to the next day |
| `js/gemini.js` | pull out a generic `generateJson({ parts, schema })` and use it for both food and review |
| `js/rules.js` | a step with a goal is complete when `meetsGoal`; add the day `targets` snapshot |
| `js/store.js` | `savePlan(challengeId, date, plan, targets)`; snapshot targets on first edit of a day |
| `js/ui/challenges.js` | category picker, fitness profile form, preset steps with editable targets |
| `js/ui/stepEditor.js` | type list (Custom, Food, Workout, Steps, Water, Body, Sleep) and a Goal field |
| `js/ui/today.js` | entry rows for the new types, "Today's plan" card, End day and Regenerate buttons, `actual / target` display |
| `js/ui/stats.js` | goal hit-rate per step, target-vs-actual line on trends, weight vs target weight |
| `js/backup.js` | validator accepts the new fields (all optional) |
| `sw.js` | add the new files, bump the cache |
| `tests/fitness.test.js` | TDEE, targets, `meetsGoal`, clamps, day scoring with targets, backup validation |

## 6. Delivery (a commit after each; the user tests between)

- **A:** categories, profile, typed steps with goals, entry UIs, scoring. No AI; base targets only.
- **B:** AI Daily Review (auto run, End day, Regenerate), plan card, target application with clamps.
- **C:** Stats (hit-rate, targets vs actuals, weight trend).

## 7. Decisions (approved by the user)

- **Q1 Reset rule.** Fitness challenges always use the **hard daily** rule; it isn't configurable. Custom challenges keep the weekly rule.
  - **In `evaluateAttempt`:** when `challenge.category === 'fitness'`, the first day whose status is `'red'` ends the attempt:
    - mark that week `'red'`;
    - set `outcome = 'reset'` and `resetDate = addDays(redDate, 1)`;
    - stop walking the days.
  - **When a day turns red:** only once it's locked (older than yesterday), so yesterday can still be fixed, sleep included, before it counts.
  - **Weekly target:** fitness challenges store `weeklyTarget: 7`. The form hides the field, and the validator stays unchanged.
  - **Week display:** weeks are still grouped for display.
- **Q2 AI targets.** Applied **automatically**, with the clamps, and editable on the plan card.
- **Q3 Maintain.** Food uses a **±10%** band (`dir: 'near'`).

## 8. Phase A spec (exact)

### `js/fitness.js` (pure)

**Energy needs**
- **BMR (Mifflin-St Jeor):**
  - male: `10*kg + 6.25*cm - 5*age + 5`
  - female: `10*kg + 6.25*cm - 5*age - 161`
- **Activity factors:** sedentary 1.2, light 1.375, moderate 1.55, active 1.725. `TDEE = BMR * factor`.
- **Calorie target:**
  - lose: `TDEE - 500`
  - maintain: `TDEE`
  - gain: `TDEE + 300`
  - Round to the nearest 10, with a floor of 1,200 (female) or 1,500 (male).
- **Food goal direction:** lose → `atMost`, gain → `atLeast`, maintain → `near`.

**Other defaults**
- Water: `round1(kg * 0.035)` L, at least.
- Steps: 8,000, at least.
- Sleep: 7.5 h, at least.
- Workout: 30 min, at least.
- Body: `goal: null`, `number.required: true` (done once weight is logged), `photo: 'optional'`.

**Workout burn**
- **MET values:** Walk 3.5, Run 9.8, Gym 5, Yoga 2.5, Cycling 7.5, Sports 7, Other 4.
- **Intensity multiplier:** light 0.8, moderate 1, hard 1.25.
- `kcal = round(MET * mult * kg * minutes / 60)`.
- `kg` is the latest body weight logged in the challenge, or else `profile.startWeightKg`.

**`meetsGoal(value, target, dir)`**
- The value must be a finite number greater than 0.
- `atLeast`: `v >= t`.
- `atMost`: `v <= t`.
- `near`: `|v - t| <= 0.1 * t`.

**`presetSteps(profile)`** returns Food, Workout, Steps, Water, Body and Sleep, all mandatory except Body (optional). Each typed step:
- keeps the existing step fields, so backup and stats keep working: `photo: 'none'`, `note: 'none'`, `number: { label, unit, required: false, showSum: false, showDiff: false, showAvg: true }`;
- uses these labels and units: Food `Calories` / `kcal` (via `makeFoodStep`), Workout `Workout` / `min`, Steps `Steps` / `steps`, Water `Water` / `L`, Body `Weight` / `kg` (`showDiff: true`), Sleep `Sleep` / `h`.

**Other exports**
- `baseTargets(challenge)` returns `{ stepId: goal.target }` for every step that has a goal.
- `targetFor(day, step)` returns `day?.targets?.[step.id] ?? step.goal?.target ?? null`.

### Rules (`js/rules.js`)

**Step completion:** `isStepComplete(stepDef, entry, target)` takes a third argument.
- If `stepDef.goal` exists, the step is complete when `meetsGoal(entry?.value, target ?? stepDef.goal.target, stepDef.goal.dir)`. The done checkbox is ignored.
- Otherwise the step uses today's logic.

**Day colour:** `isDayGreen` passes `day.targets?.[id]` as the target.

**Hard daily reset (fitness):** see §7 Q1.

**Tests:** existing tests must still pass unchanged.

### Store (`js/store.js`)

In `updateStep`, when a day is first created (`mandatoryStepIds == null`), also set `day.targets = baseTargets(challenge)`. `updateChallenge` refreshes today's `targets` the same way `resnapshotToday` does.

### Challenge form (`js/ui/challenges.js`)

**New challenges**
- A **Category** segmented row at the top: Custom | Fitness. The category is fixed after creation and shown read-only when editing.
- For Fitness, a **Profile** group: sex (M/F), age, height (cm), current weight (kg), target weight (kg), activity (4 options) and aim (lose / maintain / gain).
- The first time Fitness is picked with an empty step list, the draft steps are filled with `presetSteps(profile)`.
- A **"Recalculate targets"** button re-derives the preset targets from the profile.
- **"Green days per week"** is hidden and saved as 7.
- **Validation:** age 13–100, height 100–250, weights 30–300.
- The profile is saved on the challenge.

### Step editor (`js/ui/stepEditor.js`)

- **Type list:** Custom, Food, Workout, Steps, Water, Body, Sleep.
- **Typed steps:** hide Photo, Number and Note, and show a **Target** number input with a fixed unit label and a direction label ("at least", "at most" or "within ±10%"). The direction for food comes from the step's existing goal, else `atMost`.
- **Custom steps with Number on:** an optional **Goal** row with an "at least" / "at most" select and a target.
- **Saving a typed step:** build it through the fitness.js factories so its shape is always exact.

### Today (`js/ui/today.js`)

**Row summary:** a typed step with a target shows `actual / target unit`, e.g. `1.5 / 2.8 L`. It turns green (`.met` class) when the goal is met.

**Entry by type**
- **Water:** buttons `+0.25 L` and `+0.5 L` that add to the current value, plus a number input.
- **Steps and Sleep:** a number input.
- **Workout:**
  - a list of sessions (type · minutes · kcal, with a × to delete);
  - an **"Add workout"** sheet: type select, minutes, intensity, and a kcal field auto-filled with `burnKcal` that stays editable;
  - saves as `{ sessions, value: totalMinutes, burn: totalKcal }`;
  - `done` is set by `meetsGoal`.
- **Body:** the existing photo + number rows (generic path).
- **Food:** unchanged.

### Backup (`js/backup.js`)

`isValidStep` also checks:
- `type`, if present, is one of the known types;
- `goal` is null, or `{ target: finite number, dir }` with a valid `dir`.

`isValidChallenge` also checks:
- `category`, if present, is `custom` or `fitness`;
- `profile`, if present, is an object with numeric fields.

### Tests: `tests/fitness.test.js`

Cover BMR/TDEE for both sexes and each aim with the floor, `meetsGoal` for all directions, the MET burn, the hard daily reset in `evaluateAttempt`, a custom challenge still using the weekly rule, and a preset challenge passing `validateV2`.

## Out of scope

- Apple Health or Google Fit sync (a PWA can't access them).
- Macros.
- Drive sync of plans.
- Server or proxy.

## 9. Food macros (protein, carbs, fat, fiber)

The Gemini meal estimate returns macros as well as calories. Food steps get macro targets. The AI Daily Review uses yesterday's macros to suggest foods, for example high-protein foods when protein was short.

**Green is still decided by calories only** (the 50–100% rule). Macro targets are shown with their own checks but don't gate the day. Photo estimates of macros are too rough to trigger a hard reset.

### Data
- `meal.macros = { protein, carbs, fat, fiber }`: integer grams, each clamped to 0–500.
  - Missing on older meals, which count as 0.
- Food day entry: `entry.macros = { protein, carbs, fat, fiber }` (totals). It's always recomputed by `buildFoodPatch`, alongside `value`.
- Food step: `step.macros = { protein: {target, dir:'atLeast'}, fiber: {target, dir:'atLeast'}, carbs: {target, dir:'atMost'}, fat: {target, dir:'atMost'} } | null`. The step has no macros when it's null or missing.

### `js/fitness.js` — `macroTargets(profile, kcal)`
- protein = round(1.6 × effectiveWeightKg(profile)) g
- fat = round(0.25 × kcal / 9) g
- carbs = max(0, round((kcal − protein×4 − fat×9) / 4)) g
- fiber = max(25, round(14 × kcal / 1000)) g
- Returns the `step.macros` shape above.
- `presetSteps` sets the food step's `macros` from `macroTargets(profile, calorieTarget(...).target)`.
- Recalculate targets copies `macros` too, alongside `goal`.

### `js/foodLogic.js`
- `MACRO_KEYS = ['protein','carbs','fat','fiber']`
- `MACRO_META = { protein:{label:'Protein',short:'P'}, carbs:{label:'Carbs',short:'C'}, fat:{label:'Fat',short:'F'}, fiber:{label:'Fiber',short:'Fib'} }`
- `mealsMacros(meals)` returns the summed totals.
- `parseCalorieResult` changes:
  - It reads per-item `protein_g`, `carbs_g`, `fat_g` and `fiber_g`.
  - Returns `items[].macros` and `macros` (the sum over items; when there are no items, the top-level `total_*_g` fields).
- `buildFoodPatch` → `{ meals, value, macros, done }`.

### `js/gemini.js`
- Prompt: "Also estimate protein, carbs, fat and fiber in grams per item (integers); totals are sums."
- Schema:
  - Each item gets required `protein_g`, `carbs_g`, `fat_g` and `fiber_g` (INTEGER).
  - The top level gets optional `total_protein_g`, `total_carbs_g`, `total_fat_g` and `total_fiber_g`.

### Today (`js/ui/today.js`)
- Confirm sheet:
  - Each item line reads `name · portion · kcal · P 30g C 40g F 10g Fib 5g`.
  - A totals line shows the macros.
  - Saved meals store `macros`.
- Meal row: under the dish, a small muted line reading `P 30 · C 40 · F 10 · Fib 5 g`.
- Under the Total row, when `step.macros` is set, there's one compact line per macro: `Protein 80 / 155 g`. It gets the same `.met` class when meetsGoal passes. Without targets, show the totals only.

### Step editor (`js/ui/stepEditor.js`)
- For type food, add four target rows (Protein/Carbs/Fat/Fiber, in g), prefilled from `step.macros`.
- Empty or invalid input → that macro is omitted. The step's `macros` is null when all four are empty.
- Directions are fixed as above, shown as a label.

### Stats (`js/ui/stats.js`)
- The food line becomes `Today · 1450 kcal · P 80 · C 150 · F 50 · Fib 20 g`.

### Backup (`js/backup.js`)
- Accept an optional `step.macros`: null, or an object whose keys are a subset of MACRO_KEYS, each `{target: finite, dir ∈ GOAL_DIR_VALUES}`.
- Meals and entries aren't deeply validated today; keep it that way.

### AI Daily Review (Phase B addition)
- Input gets each day's macro totals vs targets, plus meal dishes with their macros.
- Output gets `foodSuggestions[≤3]`, for example "Add 150 g paneer or 3 eggs at breakfast (+30 g protein)".
  - The suggestions target yesterday's biggest macro gap, usually protein.
- Output gets `targets.proteinG`, clamped to 60–250 g with at most ±15% change per day, the same as the others.

### Tests
- `macroTargets` for a sample profile.
- `parseCalorieResult` with macros, and without them (an older response → 0s).
- `mealsMacros` / `buildFoodPatch`.
- The backup validator accepts `macros`.
