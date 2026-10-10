# Plateau Coach: see the real trend, find out why it's stuck, fix it

The source is `~/Downloads/2026-10-09-plateau-coach.pdf`, verified against the code on 2026-10-10.

Opus plans, Sonnet implements each release, and the user tests on the dev server, then we push. **Don't break existing features.**

---

## 0. The idea in one screen

> "I tick every step, but the scale bounces ±1–2 kg or doesn't move for weeks."

FueLoop answers three questions, in this order:

| # | Question | Where the user sees it | Needs AI? |
|---|---|---|---|
| 1 | **Am I actually stuck?** It reads the trend, not the daily noise. | Stats → **Weight trend**, and a coach card on Today | No |
| 2 | **Why?** It sends everything the app knows and gets causes backed by evidence. | The **"Why isn't it moving?"** review sheet | Yes (bring-your-own key) |
| 3 | **What do I change?** One-tap apply for the new calories, plus meal ideas that fix the mistakes. | Review sheet → Apply; Suggest meals | Yes |

**User journey:**

```
Weigh in 4×/week ──► Stats: "Fluctuating ±1.6 kg · 86 % of days on plan"
                         │
Today coach card ◄───────┘  "Weight flat for 16 days while you hit 86 % of days. Let's find out why."
        │ tap
        ▼
Review sheet (AI): verdict → likely causes (with dates/dishes) → mistakes since… → food changes
                   → 6 new local foods → maintenance [Apply] → habits → ask your doctor [Copy]
        │ Apply diet break / new target            │ "Use in meal suggestions" (on)
        ▼                                          ▼
Today banner "Diet break: day 3 of 10"     Suggest meals: Familiar · Balanced · Explore
"Back to 1,940 kcal" on the end date       "Built to fix: late rice dinners, low protein"
```

---

## 1. Verified against the code (corrections to the PDF)

| PDF assumption | Reality in code | What the plan does |
|---|---|---|
| "tdee(profile at that weight)" | `effectiveWeightKg` reads **`profile.startWeightKg`** (fitness.js:57). `tdee` is capped at the "light" activity factor, and **workouts are not eaten back** into the target (fitness.js:72). | Call `tdee({ ...profile, startWeightKg: trendKg })` for each day. Adding `burn` on top **does not double-count**, because tdee excludes exercise. |
| "Apply via the same path stepEditor uses" | `store.updateChallenge` re-snapshots today's targets (`resnapshotToday`, store.js:295). `patchChallenge` **does not**. | Changing a target goes through `updateChallenge` with the edited food step. Review data itself goes through `patchChallenge`. |
| Backup "doesn't strip health" | `isValidProfile` only checks the numeric fields, so extra keys pass through. `isValidChallenge` loosely accepts mealPlan/bodyCheck. | Accept `plateauReview` and `mealPlanHistory` the same loose way (object or array, otherwise drop the key and don't reject the backup). Add round-trip tests. |
| `callGemini` temperature | Defaults to 0.2. `suggestMeals` passes nothing. | Use 0.4 for the review, 0.8 for suggestions, and keep 0.2 for photo calories. |
| suggestPrompt rule 2 | Literally says "Suggest familiar, similar dishes, not novelty" (gemini.js:279). | Rewrite it (§7). |
| Charts | d3 comes from `window.d3`, and `renderTrendChart(el, {title, unit, points, color})` is in stats.js:305. | Add `renderWeightTrendChart` next to it, with dots plus an EWMA line. |
| Schema lines cut off in the PDF | — | The full schemas are in §5 below. |

**New, missing from the PDF: health-data consent.**
- Conditions, meds and labs are sensitive. They're sent **only in the review call**, and **only if** the profile switch "Share health info with the AI coach" is on. The switch defaults to off.
- The switch text says it goes to Google Gemini on the user's own key, and that free-tier data may be used by Google to improve its models.
- The privacy page gets one line about this.

---

## 2. Ship it in 4 releases (each tested and pushed on its own)

| Release | Contents | Size | Pushable alone? |
|---|---|---|---|
| **R0: Meal times + Planner** | the time on every logged meal, and the new **Plan** tab: view, add (custom or AI), edit and delete planned meals for the next 7 days (§3A) | M | Yes. Useful without AI. |
| **R1: Trend** | trend.js + tests, the Stats "Weight trend" section, the Today coach card (it opens an "AI review coming" placeholder or the add-key flow), 3-week mock data | M | Yes. Useful without AI. |
| **R2: Coach review** | health profile + feel tags, buildReviewInput, the review prompt/schema/parse, the dev mock, the review sheet, apply/undo, the diet-break banner | L | Yes |
| **R3: Fresh meals** | suggestion input additions, prompt rewrite, temperature 0.8, Familiar/Balanced/Explore, the New pill, local_note, coach-driven fixes, mealPlanHistory | M | Yes |

**Order inside each release:** pure logic and tests first, then UI, then `npm test`, then the dev server with `?mock=1`, then a real key, then push.

**Before starting:** the summary photo-tabs change is still uncommitted on `summary-photo-tabs`. Push or park it first, then do each release on its own branch (`plateau-r0` … `plateau-r3`).

---

## 3A. R0: Meal times + Planner tab

### Meal time under each food item
- **Where:** `mealRowHtml` (js/ui/today.js:321). The sub line becomes "8:45 am · P 32 · C 40 · F 12 · Fb 6", with the time first.
  - The time comes from `meal.at` (epoch ms), in local time with `toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})`.
  - Old meals without `at` show no time.
- **Order:** meals sort by `at` ascending. Meals without `at` keep their stored order at the end.
- **Same treatment in two other places:** the summary viewer's food rows (`buildDayDetails` row title, "8:45 am · Dosa") and the read-only day view.

### Planner tab: "Plan"
- **Tab bar:** a 5th tab, **Today · Plan · Calendar · Stats · Challenges**. The route is `#/plan`, with an `i-plan` clipboard-list icon added to the sprite. Five tabs stays within the bottom-nav guideline.
- **Data:** the existing `day.steps[food].planned[]` placeholders (`{id, slot, time, dish, kcal, macros?, ingredients?, source}`). There's no new store.
  - New optional field `source: 'custom' | 'ai'`.
  - `store.updatePlanned` is relaxed from "today or tomorrow" to **today … today + 6**, still inside the attempt. Past days stay read-only.
- **Screen:**
  - A **day strip** of 7 chips (Today, Tomorrow, Mon 13 …), each showing a dot when it has plans.
  - The selected day lists its plan grouped by the schedule's slots (`scheduleOf(profile)`).
  - Each item shows: time · slot · dish · kcal, the pill **Planned** / **Logged** (`placeholderStatus`), and a small **AI** tag when `source === 'ai'`.
  - Item actions: **Edit** opens the existing plan-meal sheet prefilled (dish, slot, time, kcal) and saves in place. **Delete** asks inline: "Delete? Yes / No".
  - A day total line: "Planned 1,780 / 1,940 kcal".
- **Adding:**
  - **+ Add meal** (custom): the existing "Plan a meal" sheet, with the chosen date and `source: 'custom'`.
  - **Suggest with AI**: the existing meal-plan sheet, now with a **target date** (the selected day). Its "Add all" asks how:
    - **Add to existing**: appends, skipping a slot that already has the same dish;
    - **Replace this day's plan**: confirm first, then replace that day's *unlogged* placeholders only. Logged ones are never touched.
  - **Copy to…**: copies a day's plan to another day in the 7-day range.
- **Clear day:** removes unlogged placeholders after confirmation.
- **Fitness only:** the tab shows for a fitness challenge with a food step. Otherwise it shows "Planner works with fitness challenges", and it never errors.
- **Today keeps showing** the same placeholders, unchanged. The Planner is just the place to see and edit several days.

### Overview screen (#/overview): week result icon + alignment
- **The bug:** the week badge is a text pill ("Pass"/"Fail") squeezed into a 44 px grid column (`.ov-week`, css ~218), so it overlaps the 7th day or touches it with no gap.
- **The fix:** `badgeFor` returns an icon instead of a label (calendar.js:111). The badge is a 28 px circle (`.ov-result`):
  - green: a white ✓ (`i-check` sprite) on `--green-fill`;
  - red: a white ✕ (`i-x`) on `--red-fill`;
  - pending: an empty ring in `--text2`.
  - Each carries `role="img"` and an `aria-label`: "Week 3 passed", "Week 3 failed" or "Week 3 in progress".
- **Grid:** `grid-template-columns: 32px repeat(7, minmax(0,1fr)) 32px; column-gap: 8px`, with the result centred in its cell.
- **Legend:** gets `margin: 4px 0 16px`, so it doesn't sit flush against the group. Check at 360 px wide that nothing overlaps.

**Tests:**
- the `updatePlanned` date range (today + 6 allowed, + 7 rejected, past rejected);
- the add-to-existing merge (dedupe by slot + `normDish`);
- replace keeps logged placeholders;
- meal sorting by `at`;
- the time label for missing `at`.

---

## 3. R1: Trend model (`js/trend.js`, pure and tested)

**Imports:**
- `addDays`, `diffDays`, `dayStatus`, `flexDates`, `isEditable` from rules.js;
- `mealsTotal`, `mealsMacros` from foodLogic.js;
- `tdee`, `bmr`, `targetFor` from fitness.js.

There's no DOM, IDB or network. Check that there are no import cycles: trend.js is imported by UI and mealPlan.js only.

**Constants** (all exported and named):

```
EWMA_ALPHA = 0.1                 // per day (Hacker's Diet)
LOSING_PCT_WK = -0.2             // ≤ this %/week → losing
GAINING_PCT_WK = 0.2             // ≥ this → gaining
FLUCT_RANGE_PCT = 0.9            // raw range ≥ 0.9 % of body weight → fluctuating (≈1.2 kg at 129 kg, 0.6 kg at 70 kg)
STALL_BAND_PCT = 0.5             // stalledSince band
MIN_WEIGH_INS = 4, MIN_SPAN_DAYS = 10
WEEK_CHECK_MIN_GREEN = 5, WEEK_CHECK_MAX_CHANGE_PCT = -0.1
KCAL_PER_KG = 7700
LATE_HOUR = 20
```

The PDF's fixed 1.2 kg range is scaled by body weight here, so 129 kg and 70 kg both make sense, as the PDF intended.

**Functions:**

| Function | Returns | Notes |
|---|---|---|
| `weightSeries(challenge, daysMap)` | `[{date, kg}]` sorted | Reads the body step's `entry.value`, finite values only. `[]` if there's no body step. |
| `smoothWeights(series)` | `[{date, kg, trendKg}]` | EWMA. With a gap of g days, `α_eff = 1 − (1−α)^g`. The first point seeds the trend. |
| `trendStatus(challenge, daysMap, today, {windowDays=14})` | `{status, windowDays, weighIns, slopeKgPerWeek, slopePctPerWeek, changeKg, rangeKg, startKg, endKg, adherencePct, greenDays, loggedFoodDays, avgKcal, targetKcal, expectedLossKg, actualLossKg, gapKg, stalledSince}` | The window is clipped to the attempt start. Slope = least squares on trendKg vs day index, × 7. Adherence = green ÷ elapsed days in the window, using `dayStatus(…, flexDates(…))`. Expected loss = Σ over days with ≥ 1 meal of `(tdee({...profile, startWeightKg: trendKg}) + burn − mealsTotal) / 7700`. Actual loss = startKg − endKg on the trend. Gap = expected − actual. |
| `weekCheck(challenge, daysMap, today)` | `{stalled, greenDays, changeKg}` | stalled = ≥ 5 green in the last 7 **and** trend change > −0.1 %. |
| `eatingPatterns(challenge, daysMap, today, {days=28})` | `{topDishes, lateKcalPct, weekendVsWeekdayKcal, proteinGPerKg, carbPctOfKcal, fiberAvgG, avgMealsPerDay, nextDayBumps, feelTags}` | Detailed in the next list. |
| `normDish(name)` | string | Lower-case, trim, collapse spaces, strip punctuation and trailing "s". Used everywhere dishes are compared. |

**The fields of `eatingPatterns`:**
- `topDishes`: the top 15 by count, each `{dish, count, avgKcal}`.
- `lateKcalPct`: the share of kcal from meals with `at` at or after 20:00 local time. Meals without `at` are skipped.
- `weekendVsWeekdayKcal`: `{weekday, weekend}` average kcal. The weekend is Sat + Sun.
- `proteinGPerKg`: average protein ÷ trend kg.
- `carbPctOfKcal`: carbs × 4 ÷ kcal.
- `fiberAvgG` and `avgMealsPerDay`.
- `nextDayBumps`:
  - only dishes eaten ≥ 3 times count;
  - for each, compare the mean **raw** next-day weight change after eating it with the mean on days without it; both days must have a weigh-in;
  - keep those at least +0.3 kg higher, max 6, as `{dish, n, bumpKg}`.
- `feelTags`: `{tag: {count, topDishes: [3]}}`. This is empty in R1, since tags arrive in R2.

**Status:**
- `no-data`: fewer than 4 weigh-ins, or a span of less than 10 days.
- Otherwise:
  - `losing` when slope % ≤ −0.2;
  - `gaining` when it's ≥ +0.2;
  - `fluctuating` when the raw range is ≥ 0.9 % of endKg;
  - `plateau` otherwise.
- `stalledSince`: walk back from the end while trendKg stays within ±0.5 % of endKg. It's null when the status is losing.

**Tests (`tests/trend.test.js`):**
- EWMA with gaps;
- −0.5 kg/week gives `losing`;
- 129 kg ±1.5 kg noise gives `fluctuating`;
- flat and calm gives `plateau`;
- 3 weigh-ins give `no-data`;
- adherence counts flex days;
- expected vs actual gap, using a hand-computed fixture;
- stalledSince;
- weekCheck;
- lateKcalPct;
- the nextDayBumps threshold and the cap of 6;
- `normDish`.

### R1 UI

**Stats → a new first section, "Weight trend"** (only when the challenge has a body step):
- **Chart:** `renderWeightTrendChart(el, {points, trend})`. Raw weigh-ins are dots (40 % opacity) and the trend is a line in the body colour (#EC4899 / `var(--step-body)`). It uses the same axes, tooltip and resize handling as `renderTrendChart`, follows dark-mode tokens and respects reduced motion.
- **Range toggle:** a **14 · 28 · All** segmented control. The choice is stored in localStorage `tracker:trendRange` (try/catch).
- **Status line:**
  - The pill reads one of: **Losing · Plateau since 18 Sep · Fluctuating ±1.6 kg · Gaining · Need more weigh-ins**.
  - Next to it: "−0.4 kg/week", then "86 % of days on plan".
  - Then "Expected −1.9 kg · actual −0.2 kg", shown only when both exist.
- **`no-data` copy:** "Weigh in at least 4× a week — same time, after the toilet, before food — to see your real trend."
- **Button: "Why isn't it moving?"**
  - Hidden when the status is `no-data` or `losing`. For `losing`, show "You're on track" instead.
  - Without an AI key, it opens `openAiKeySheet()`.
  - In R1 it opens a small sheet: "AI review is coming in the next update." This is replaced in R2.

**Today → coach card** above the steps:
- **Shown when** (`status ∈ {plateau, fluctuating, gaining}` and adherence ≥ 70 %) or `weekCheck().stalled`.
- **Copy:** "Weight flat for **16 days** while you hit **86 %** of days. Let's find out why." Use "bouncing ±1.6 kg" for fluctuating and "up 0.8 kg" for gaining.
- **Buttons:** **Find out why** and **Later**. Later dismisses it for 7 days via `tracker:coachDismissedUntil` (try/catch).
- **Placement:** Today only (not past days), and fitness challenges only. Hidden while a diet break is running, since that banner replaces it.

**Mock (`js/dev/mock.js`):** extend "Mock fitness" to 21 days:
- weight 129 ±1.5 kg with no downward trend;
- ≥ 80 % green days;
- late rice dinners on about half the days;
- "curd rice" followed by next-day bumps;
- low protein.

---

## 4. R2: Small data additions (optional and additive)

**`challenge.profile.health`**, set in Challenges → profile, in a collapsible group under Diet: **"Health (optional, helps the AI coach)"**.

The fields:
- `conditions`: multi-select chips. Each value maps to a plain label:

  | Value | Label |
  |---|---|
  | `insulin_resistance` | Insulin resistance |
  | `prediabetes` | Prediabetes |
  | `type2_diabetes` | Type 2 diabetes |
  | `pcos` | PCOS |
  | `hypothyroid` | Hypothyroid |
  | `fatty_liver` | Fatty liver |
  | `high_bp` | High BP |
  | `sleep_apnea` | Sleep apnea |
  | `high_cholesterol` | High cholesterol / triglycerides |
  | `high_cortisol` | Cushing's / long-term steroids |
  | `menopause` | Peri/menopause |
  | `low_testosterone` | Low testosterone |
  | `ibs_gut` | IBS / gut issues |
  | `kidney_heart_edema` | Kidney/heart issue or swelling (oedema) |
  | `depression_anxiety` | Depression / anxiety |
- `sensitivities` (text) and `meds` (text).
- `meds_flags`: chips for the drug groups known to make weight loss harder:

  | Value | Label |
  |---|---|
  | `steroids` | Steroids |
  | `insulin_sulfonylurea` | Insulin / sulfonylureas |
  | `antidepressants` | Antidepressants |
  | `antipsychotics` | Antipsychotics |
  | `beta_blockers` | Beta-blockers |
  | `antihistamines` | Antihistamines (daily) |
  | `hormonal_contraceptive` | Hormonal contraceptive |
  | `anticonvulsants` | Anticonvulsants |
- `waistCm` + `waistDate`: optional, re-measured monthly at the navel. This is the main **belly-fat** signal.
- `labs`: `{hba1c, fastingGlucose, fastingInsulin, tsh, vitD, b12, crp, triglycerides, hdl, alt, ast, date}`. All optional; numbers use `inputmode=decimal`.
- `shareWithAi` (switch, default **off**). See §1 for the consent text.

**Deterministic risk signals: `riskSignals(profile, patterns, bodyCheck)` in trend.js (pure, tested).**

The code computes these from numbers, so the AI never has to guess them. Each signal is `{id, label, value, threshold, source}` and is sent to the AI as facts.

| Signal | Rule (standard cut-offs) | Points to |
|---|---|---|
| Waist-to-height ratio | waistCm / heightCm ≥ 0.5 (≥ 0.6 high) | central / belly fat → insulin resistance, fatty liver |
| Waist | ≥ 90 cm men / ≥ 80 cm women (South Asian cut-offs) | the same |
| HOMA-IR | fastingGlucose (mg/dL) × fastingInsulin ÷ 405 ≥ 2.0 (≥ 2.9 high) | insulin resistance |
| HbA1c | 5.7–6.4 prediabetes range, ≥ 6.5 diabetes range | blood sugar |
| Fasting glucose | 100–125 / ≥ 126 mg/dL | blood sugar |
| TG/HDL | ≥ 3 (mg/dL) | insulin resistance |
| ALT / AST | ALT > 40 men / > 30 women, or AST > 40 | possible fatty liver (point to an ultrasound or FibroScan) |
| TSH | > 4.5 | thyroid |
| CRP | > 3 mg/L | inflammation |
| Vit D / B12 | < 20 ng/mL / < 200 pg/mL | fatigue, low energy |
| Body check | `bellyFat === 'high'` from the existing opt-in photo check | central fat |
| Patterns | carbPctOfKcal ≥ 60 % + lateKcalPct ≥ 30 % + cravings tags | an eating pattern linked to insulin resistance |
| Red flags | swelling/oedema condition, a weight *gain* > 2 kg/week on the trend, or very high readings (HbA1c ≥ 9, glucose ≥ 250) | **see a doctor first.** The review leads with this. |

**Wording rules:**
- Every label says "**signs consistent with** …", never "you have".
- The doctor tests that would confirm each one go in `ask_doctor`, e.g.:
  - HbA1c and fasting insulin for blood sugar;
  - an LFT plus an ultrasound or FibroScan for the liver;
  - a lipid panel, TSH and a sleep study.

Wiring:
- Health uses the same `formDraft.profile` default/draft/save path as `location`/`cuisine`/`avoid` (challenges.js ~855). Chips toggle on click.
- Text fields update the draft on `input` **without re-rendering**, so the phone keyboard stays open.

**Daily feel tags** live on the food step entry: `entry.feel = ['bloated','acidity','cravings','low_energy','good_digestion','poor_sleep_hunger']`.
- **On Today:** a compact chip row under the meal list, "How did your gut / energy feel?". It's shown for editable dates only and saved with `store.updateStep(cid, date, foodStepId, { feel })`.
- **Merging:** `buildFoodPatch` returns only `{meals, value, macros, done}`, and `applyStepPatch` merges onto the entry. Add a test that meal add/delete keeps `feel`.
- **In the summary viewer:** `buildDayDetails` adds a "Feel: bloated, cravings" row to the food card.

**Backup:**
- `validateV2`/`toV2` keep `profile.health`, `entry.feel`, `plateauReview` and `mealPlanHistory`.
- Loose checks: an object or array of the right kind is kept; a wrong type is dropped silently, never rejecting the backup.
- Add round-trip tests.

---

## 5. R2: AI review

**`buildReviewInput(challenge, daysMap, today)` in trend.js (pure):**

```
{ today, month,
  profile: { sex, age, heightCm, currentWeightKg, startWeightKg, targetWeightKg, aim,
             activity, location, cuisine, diet, avoid, schedule,
             health /* only when health.shareWithAi */ },
  trend: { ...trendStatus(14), trend28: trendStatus(28) },
  targets: { kcal, protein, carbs, fat, fiber },
  patterns: eatingPatterns(28),
  days: [ { date, green, flex, kg, totalKcal,
            meals: [[dish, kcal, p, c, f, fib, "HH:MM"]],
            workout: [[type, min, intensity, kcal]],
            steps, waterL, sleepH, feel, note } ],   // last 28 days, ≥ attempt start
  previousReview: { date, verdict, mistakes, food_changes, maintenance } | null,
  bodyCheck: bodyCheckText(challenge, daysMap),
  risk: riskSignals(...) }
```

The output has no photo IDs. Keys with null/empty values are dropped from day objects.

### Token budget and no hallucination (both AI calls, free tier)

**Compact input:**
- Tuples instead of objects, with **short keys** in a legend line (e.g. `m=[dish,kcal,p,c,f,fib,time]`).
- Numbers are rounded: kcal to 10, grams and kg to 1 decimal.
- Empty or null values are dropped.
- Minified `JSON.stringify` with no spaces.

**What each call sends:**

| | Suggestions | Review |
|---|---|---|
| History sent | yesterday's meals in full, plus `dishFrequency` (14 days, top 20 `[dish, n]`). Ingredients, 7-day tuples and `recentDishes` are no longer sent. | 28 days of tuples, plus the precomputed `trend`, `patterns` and `risk`. The AI reads the conclusions instead of re-deriving them. |
| Ingredients | asked for in the output only | never sent |
| **Budget, enforced by a test** | prompt ≤ **6,000 chars (~1.5k tokens)** | prompt ≤ **16,000 chars (~4k tokens)** |
| Over budget | drop the oldest dishFrequency rows | drop day tuples from the oldest first, down to 14 days |

**Prompt style:** numbered rules of ≤ 15 words each, with no examples beyond one short line each. The suggestion rules shrink from about 2.5k chars to about 1k.

**Anti-hallucination, in the prompt and enforced by code:**
1. **Prompt:** "Use only the data given. Do not invent foods, numbers, dates, symptoms or lab values. If the data can't support a point, leave it out." If evidence is thin, the verdict is `not_enough_data`.
2. **Schema:** every cause and mistake carries `dates: [YYYY-MM-DD]` and `dishes: [STRING]` from the data.
3. **`parseReview` checks the references:**
   - It drops any cause or mistake whose `dates` aren't in `days`, or whose `dishes` aren't in the history (`normDish`).
   - It drops a lab-based cause when that lab wasn't provided.
   - It drops a `condition_or_meds` cause when health wasn't shared.
4. **Risk categories** (insulin resistance, fatty liver, thyroid, inflammation) are allowed only when a matching `riskSignals` entry exists. Otherwise they're downgraded to an `ask_doctor` item.
5. **`parseMealPlan`:** dish names must be non-empty and ≤ 60 chars, macros are clamped, and kcal is recomputed and checked against the target (the existing `kcalWarning`).
6. **Temperatures:** the review stays at 0.4. Suggestions use 0.8 for variety; the schema and parse rules stop that from producing invented numbers.
7. **Dev-only token log:** on a dev host, log `chars ≈ tokens` for each call to the console, so we can see real sizes.

**`REVIEW_PROMPT`** is written in the style of `suggestPrompt`, and `reviewPlateau` uses temperature 0.4.

The prompt covers:
- **The role:** a weight-loss coach giving **informational guidance, not a diagnosis**. It never says "you have X", only "signs consistent with X — test Y would confirm".
- **Evidence first:** trend and patterns, quoting real numbers and dates in every cause and mistake.
- **Causes to check, in this order:**
  - (a) under-logging: oil, ghee, chutney, drinks and snacks;
  - (b) water retention: sodium, pickle, papad, restaurant food, high-carb days, new workouts, sleep;
  - (c) signs of insulin resistance, central/belly fat, possible fatty liver: use `risk` only. These include waist-to-height, HOMA-IR, TG/HDL, ALT/AST, the body check's belly fat, and the carb-share/late-eating/cravings pattern;
  - (d) sensitivity or inflammation, via feel tags and next-day bumps. Suggest a **2-week single-food elimination**, never several foods at once;
  - (e) protein and fibre;
  - (f) timing and eating window;
  - (g) sleep and stress;
  - (h) metabolic adaptation, which may call for a diet break;
  - (i) conditions and meds: thyroid, PCOS, high cortisol/steroids, menopause, low testosterone, sleep apnea, and weight-gain medicines from `meds_flags`;
  - (j) low daily movement outside workouts: steps under 6k;
  - (k) red flags from `risk`: these come **first** in the summary with "see a doctor".
- **Condition rules:** diabetes means no fasting advice without a doctor. For hypothyroid, timing with meds is "ask your doctor".
- **Safety rails:**
  - kcal ≥ max(BMR, 1500 for men / 1200 for women);
  - no loss faster than 1 % of body weight a week;
  - no supplements, drugs or detox products;
  - no fasting longer than the existing schedule;
  - red flags (persistent fatigue, swelling, chest pain, very high readings) mean see a doctor.
- **`food_changes`:** regional and available in `profile.location`, in season for `month`.
- **`new_local_foods`:** exactly 6 dishes that are **not** in topDishes or days[].meals.

**`REVIEW_SCHEMA`** (complete):

```
summary: STRING                                  // ≤ 2 sentences
verdict: enum[real_plateau, water_noise, under_logging, gaining, losing_fine, not_enough_data]
likely_causes: [{ category: enum[under_logging, water_retention, insulin_resistance_signs,
                   sensitivity_inflammation, low_protein_fiber, meal_timing, sleep_stress,
                   low_daily_movement, metabolic_adaptation, condition_or_meds, other],
                  cause: STRING, evidence: STRING, confidence: enum[low, medium, high] }]   // ≤ 5
mistakes: [{ what, since: "YYYY-MM-DD", how_often, fix }]                                  // ≤ 5
food_changes: { add: [STRING], reduce: [STRING], swap: [{ from, to }] }                     // ≤ 5 each
new_local_foods: [{ dish, why, where }]                                                     // 6
maintenance: { action: enum[keep, lower_target, raise_protein, diet_break, recalc],
               new_kcal: INTEGER?, duration_days: INTEGER?, why: STRING }
habits: [STRING]                                                                            // ≤ 4
ask_doctor: [{ test, why }]                                                                 // ≤ 4
watch_next: STRING
```

**`parseReview(json, {bmr, sex, currentTargetKcal, historyDishes})`** (pure; code enforces the rules rather than trusting the model):
- It clamps lengths and strings and drops unknown enum values.
- `new_kcal` is kept ≥ max(BMR, sex floor).
- `lower_target` is capped at ≤ current target. `diet_break` is ≥ the current target, `duration_days` is clamped to 7–14, and the result is rounded to 10.
- `new_local_foods` drops any dish whose `normDish` is in the history.
- `since` must be a valid date, otherwise it's dropped.

**`reviewPlateau(input)`** in gemini.js:
- It's a mirror of `suggestMeals`:
  - dev mock when `tracker:mockGemini === '1'` on a dev host (`js/dev/mockReview.js`, built on the mock data);
  - otherwise `callGemini(parts, REVIEW_SCHEMA, {temperature: 0.4, offlineMessage: "You're offline. Connect to run the weight review."})`, then `parseReview`.
- Errors use the existing `friendlyError`.

**Storage:** `patchChallenge(id, { plateauReview: { date, trendAtReview: {status, slopeKgPerWeek, endKg}, ...parsed, useInSuggestions: true, applied: null } })`.
- Only the latest review is kept.
- The previous one is summarised into `previousReview` in the next input.

---

## 6. R2: Review sheet + apply

**`js/ui/reviewSheet.js`** uses `openSheet` and `loaderHtml('Reviewing your last 28 days…', 'lg')`.

**Layout, top to bottom:**
1. **Header:** a verdict pill, the summary, and the trend numbers (slope, range, adherence, expected vs actual).
2. **Collapsible sections:** a button with `aria-expanded` and no re-render, the same pattern as the summary cards. The first two are open by default.
   - **Likely causes**: each with a confidence chip and its evidence.
   - **Mistakes to fix**: "since 18 Sep · 11 of 20 days · fix: …".
   - **Food changes**: add / reduce / swap.
   - **6 new local foods**: dish, why, where.
   - **Maintenance**: see the Apply rules below.
   - **Habits**.
   - **Ask your doctor**: with a **Copy** button that copies the list as plain text, falling back to execCommand.
   - **What to watch next**.
3. **Switch:** "Use in meal suggestions" (default on). It sets `plateauReview.useInSuggestions`.
4. **Footer:**
   - **Re-run review**: enabled when the last review is ≥ 3 days old or there are ≥ 3 new days of data. Otherwise it reads "Available on 13 Oct".
   - The disclaimer: "General guidance, not medical advice. Talk to your doctor before changing medication or if you have a medical condition."

**Apply** ("maintenance should be applied"); nothing changes without a tap.

**What the button says:**
- `lower_target`: **Apply 1,800 kcal**.
- `diet_break`: **Start diet break: 2,250 kcal for 10 days**.
- `keep`, `raise_protein`, `recalc`: no apply button.
  - `raise_protein` shows the protein target hint with a **Raise protein target** button. This edits `macros.protein.target` through the same `updateChallenge` path.
  - `recalc` links to the profile.

**On Apply:**
- The food step goal target is updated via **`store.updateChallenge`**, so today's snapshot is re-taken. Past days keep their own snapshots.
- The app stores `plateauReview.applied = { action, from, to, date, untilDate|null }`.
- **Undo** stays visible in the sheet while `applied` is set. It restores `from` exactly.

**Diet-break banner on Today:**
- During the break it reads "Diet break: day 3 of 10 — eating at maintenance (2,250 kcal)".
- From `untilDate` onwards it reads "Diet break done. **Back to 1,940 kcal**". One tap restores `from` and clears `applied`.
- It replaces the coach card while it's shown.

**Flex days** keep working on the new target as-is, since they're relative to the target.

---

## 7. R3: Meal suggestions that are new, local and fix the mistakes

**`buildSuggestionInput` additions** (additive only; the existing fields stay):
- `month`, e.g. "October".
- `dishFrequency`: `[[dish, count]]` over 14 days. This becomes the "what they eat" signal. `recentDishes` stays in the input, but the prompt stops treating it as a template.
- `recentPlans`: dish names from `challenge.mealPlanHistory`.
  - `mealPlanHistory` is a new array of `{date, dishes:[…]}`, capped at 3.
  - A new entry is pushed whenever a plan is generated and saved.
  - `challenge.mealPlan` keeps its current shape.
- `variety`: `'familiar' | 'balanced' | 'explore'`, default `balanced`.
- `coach`: set when `plateauReview` exists, is less than 21 days old and `useInSuggestions` is on. Then it's `{ mistakes: [what + ' → ' + fix], food_changes, new_local_foods: [dish], maintenance: action, reviewDate }`. Otherwise `null`.

**`suggestPrompt` rewrite** (slots, window, diet preference, gap rules and the JSON shape stay):
- **Rule 2 becomes:**
  - Stay in their regional cuisine family (dishFrequency, profile.cuisine, profile.location).
  - **Variety:**
    - familiar: at most 1 new dish;
    - balanced: at least half the slots absent from dishFrequency and recentPlans;
    - explore: every dish absent from both.
  - New dishes must be routinely eaten or easily bought in profile.location (market, local eateries, quick-commerce), in season for `month`, and realistic for a weekday home cook.
- **New coach rule:** if `coach` is given, the plan must visibly fix `coach.mistakes` and follow `coach.food_changes`. Prefer `coach.new_local_foods` when they fit a slot. `fixes` names the mistake each meal fixes.
- **Rule 4 becomes:** no dish from `recentPlans` or yesterday, in any slot.
- **Schema:** each meal gets optional `is_new` (BOOLEAN) and `local_note` (STRING).
  - `parseMealPlan` keeps `local_note`.
  - **`is_new` is recomputed in code** with `normDish` against dishFrequency + recentPlans.
- `suggestMeals` uses **temperature 0.8**. Photo calorie estimation stays at 0.2.

**UI (`openMealPlanSheet`):**
- In the pick stage, a **Familiar · Balanced · Explore** segmented control sits under the diet preference. It's stored in localStorage `tracker:suggestVariety` (try/catch).
- Plan rows get a small **New** pill when `is_new`, with `local_note` under the portion, e.g. "Any darshini · on Zepto".
- When `coach` is used, a note appears at the top: "Built to fix: late rice dinners, low protein (from your 9 Oct review)".
- Update `js/dev/mockSuggest.js` to return `is_new`/`local_note` and honour variety.

---

## 8. Tests (`npm test`; all existing tests must still pass)

- **`tests/trend.test.js`:** everything listed in §3, plus:
  - the shape of `buildReviewInput`: 28 days at most, tuples, the attempt-start cut-off, no photo IDs, and health only with `shareWithAi`;
  - `parseReview`: the kcal floor, the cap for lower_target, clamping of diet-break days, enum filtering, history dishes dropped, and lengths.
- **`tests/mealPlan.test.js`:**
  - the new fields: `coach` only when fresh and enabled, and `mealPlanHistory` capped at 3;
  - `is_new` recomputed in code, `local_note` kept, and old plans still parse.
- **`tests/food.test.js`:** `feel` survives meal add/delete.
- **R0 tests:** see §3A (planner range, merge/replace, meal-time sort and label).
- **`riskSignals`:** each cut-off, plus missing labs giving no signal.
- **Prompt budget:** with the 3-week mock, the suggest prompt is ≤ 6,000 chars and the review prompt ≤ 16,000.
- **`parseReview` reference checks:** a fake date, a fake dish, a lab that wasn't provided, and a risk category without a signal are all dropped.
- **`tests/backup.test.js`:** `health`, `feel`, `plateauReview` and `mealPlanHistory` survive a round trip, and wrong types are dropped without rejecting the backup.
- **Prompt content:**
  - `suggestPrompt` no longer contains "not novelty" and does contain the variety rule;
  - `REVIEW_PROMPT` contains the safety rails and "not a diagnosis".

---

## 9. Guardrails (unchanged across all releases)

- **Storage and caches:** all `tracker:*` localStorage keys, the IndexedDB name, stores and version, and the `tracker-*` cache prefix.
- **Data shapes:** `mealPlan`, `bodyCheck`, day entries and the backup format stay the same. New fields are optional.
- **Privacy:**
  - There's still no server.
  - The new calls send **no photos**. The opt-in body-check photo flow is untouched.
  - Health data is sent only with `shareWithAi`.
- **No-feature challenges:** a challenge with no body step, no health info or no review behaves exactly as before.
- **UI:** all new UI uses the design tokens and works in light and dark modes, with 44 px tap targets, reduced motion respected, and layouts that work at 360 px wide.
- **Service worker:** bump `CACHE_NAME` in each release and add new files (`js/trend.js`, `js/ui/reviewSheet.js`) to SHELL_FILES. Dev files stay out.

---

## 10. Acceptance (the user checks on the dev server)

1. With 3 mock weeks at about 129 kg ±1.5 kg and ≥ 80 % green, Stats shows **Fluctuating** and Today shows the coach card.
2. The review (mock, then a real key) quotes real dates and dishes, never states a diagnosis, never goes below the kcal floor, and lists doctor tests separately.
3. Applying a diet break changes today's food target and shows the banner. **Back to X kcal** restores it exactly, and Undo works.
4. **Explore** has no dish from the last 14 days or the last 3 plans, and **Balanced** has at least half new dishes. All dishes are regional and local, and `fixes` reference the review's mistakes.
5. Every logged meal shows its time. The Plan tab adds, edits and deletes items, and adding an AI plan to existing items appends or replaces only unlogged ones.
6. Existing challenges without a body step, health info or a review look and behave exactly as before.

---

## 11. Open questions (defaults chosen; change them if you disagree)

| # | Question | Default |
|---|---|---|
| 1 | Should health info be sent to the AI by default? | **Off.** The user turns it on. |
| 2 | Fluctuating threshold | **0.9 % of body weight** (about 1.2 kg at 129 kg) |
| 3 | When does the coach card show? | Plateau / fluctuating / gaining with ≥ 70 % adherence, or the 1-week stall check. 7-day dismiss. |
| 4 | Can a review lower calories automatically? | **Never.** It always needs an Apply tap, with Undo. |
| 5 | Release split | R0 → R1 → R2 → R3, each pushed after the user tests it |
| 6 | Planner range | **Today + 6 days.** Past days are read-only. |
| 7 | Where the Plan tab goes | **2nd tab:** Today · Plan · Calendar · Stats · Challenges |
| 8 | Waist measurement | An optional health-profile field, re-measured monthly (no new daily step) |

---

## 12. Final prompts (Opus-tuned; implement them verbatim, adjusting only the `${}` wiring)

Principles behind them:
- Short numbered rules, and a legend for the compact keys.
- The facts that code computes are labelled "trust it".
- "Use only this data" comes first.
- The schema carries the format, so the prompt doesn't repeat it.
- Every string has a length cap, which also caps the output tokens.

### 12.1 `suggestPrompt(input)` (R3; replaces the current ~2.5k-char text with ~1k chars)

```
Plan meals for ${forDate} (${month}). One dish per slot: ${slotList}.${windowLine}
Legend: y=yesterday [dish,kcal,p,c,f,fib,time]; gaps=yesterday vs target; freq=[dish,times] last 14 days; recent=dishes in last 3 plans; avoid=never use.
Rules:
1. Only dishes of their regional cuisine (freq, cuisine, location). No other cuisines.
2. ${PREF_RULE} Follow diet and avoid strictly.
3. Variety ${variety}: ${VARIETY_RULE}
4. No dish from recent or y. No dish twice in this plan.
5. Any dish not in freq must be commonly eaten or sold in ${location}, in season, cookable on a weekday.
6. Close gaps: short → more of it, over → less.${coachRule}
7. Day total within ±5% of ${kcal} kcal; protein ≥ ${protein} g; fibre ≥ ${fiber} g.
8. Realistic portions; kcal and macros must match the portion. Use only ingredients that are in the dish.
Output: ingredients for 1 serving, raw qty. local_note ≤ 8 words (where to buy/eat). fixes ≤ 3 ("gap → how"). why ≤ 2. tips ≤ 2. Every string ≤ 15 words.
Data:${minifiedJson}
```

**Fragments:**
- **`VARIETY_RULE`:**
  - familiar = "mostly dishes from freq, made healthier; at most 1 new dish."
  - balanced = "at least half the dishes not in freq."
  - explore = "every dish not in freq."
- **`coachRule`**, only when `coach` is present: `\n6b. Fix coach.mistakes and follow coach.changes; prefer coach.foods. Name the mistake fixed in fixes.`
- **`PREF_RULES`** are shortened, e.g. veg = "Veg only: no meat, fish or egg."; mix = "Mix: ≥ 1 veg meal and ≥ 1 meat/fish/egg meal."

**Data keys:** `{y, gaps, freq, recent, avoid, coach?}`. `profile` sends only `{cuisine, location, diet}`, since schedule and targets are already inlined in the rules.

### 12.2 `REVIEW_PROMPT(input)` (R2, ~1.6k chars of rules)

```
You review why someone's weight isn't dropping while they follow a plan. Informational only, not a diagnosis.
Legend: t14/t28=trend (computed, trust it); pat=eating patterns (computed); risk=health signals (computed); d=days [date,green,kg,kcal,meals[[dish,kcal,p,c,f,fib,time]],wo[[type,min,kcal]],steps,waterL,sleepH,feel]; prev=last review.
Rules:
1. Use only this data. Never invent foods, numbers, dates, labs or symptoms. Leave out what the data can't support. Thin data → verdict not_enough_data.
2. Every cause and mistake lists real dates and dishes from d in "dates" and "dishes".
3. Check in this order: under-logging (expected vs actual gap; oil, ghee, snacks, drinks); water retention (salty or restaurant food, carb spikes, poor sleep, new workouts); insulin-resistance, belly-fat and fatty-liver signs; food sensitivity (feel tags, next-day bumps); low protein or fibre; late eating; sleep or stress; low steps; long deficit (adaptation); conditions or medicines.
4. Health causes only when risk has a matching signal. Say "signs consistent with", never "you have". Put confirming tests in ask_doctor.
5. If risk has a red flag, the summary starts with "See a doctor:".
6. Elimination test: one food for 2 weeks, never several at once.
7. Safety: kcal never below ${floorKcal}; loss ≤ 1% body weight per week; no supplements, drugs or detox; no longer fasting than their schedule; diabetes → no fasting change without a doctor.
8. food_changes and new_local_foods: their regional cuisine, sold in ${location}, in season for ${month}. new_local_foods = 6 dishes not in pat.top or d.
9. Every string ≤ 20 words. summary ≤ 2 sentences.
Data:${minifiedJson}
```

`floorKcal = max(round(bmr), 1500 for men / 1200 for women)` is computed in code.

### 12.3 Review process

**Opus reviews:**
- After Sonnet wires each prompt, Opus re-reads the built string from the 3-week mock data.
- Checks: budget, no leftover verbose text, the legend matches the keys actually sent, and no unused data is sent.
- Opus then fine-tunes the wording before the user tests with a real key.
