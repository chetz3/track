# Plan: 10-second AI cap + meal-style picker before suggesting

Branch: `meal-style-picker` (from `main`). Don't commit; the user tests first.

## Context (already true on main)

- `js/gemini.js` `callGemini` already sends `thinkingConfig: { thinkingBudget: 0 }` plus
  `FAST_INSTRUCTION` ("answer immediately"), with a resend-without-thinkingConfig fallback.
  Thinking is off everywhere. What's missing is a hard **time cap**.
- Per-slot meal styles exist (`MEAL_STYLES` in `js/mealPlan.js`, saved as
  `profile.mealStyles`), but they're only editable deep inside the challenge profile
  (Challenges → Meal schedule). The suggest sheet's pick stage (`mealPlanBodyHtml`,
  `stage === 'pick'` in `js/ui/today.js`) only asks Meal preference (veg/non-veg) and Variety.
  So in practice users are never asked what kind of meal they want.

## Part 1: 10-second cap on every Gemini call (`js/gemini.js`)

1. In `callGemini`, add an option `timeoutMs = 10000` and an overall deadline
   `const deadline = Date.now() + timeoutMs`.
2. `send(model, body, ms)` uses an `AbortController` with `setTimeout(() => ctrl.abort(), ms)`;
   always `clearTimeout` in `finally`. On an `AbortError`, throw a marker error
   (for example `err.timedOut = true`), not the offline message.
3. Model loop:
   - First model (Flash) gets `min(6500, remaining)` ms.
   - If Flash times out **or** returns a retryable status, try Lite with whatever is left
     until the deadline. Skip it if less than 1500 ms remain.
   - The thinking-config resend (400 with /thinking/) uses the remaining time of the same
     model attempt.
4. If everything times out, throw `new Error('Gemini took too long (over 10 s). Try again.')`.
5. Leave `FAST_INSTRUCTION`, the thinking-off config, temperatures, prompts and schemas
   unchanged.
6. `reviewPlateau`'s output is longer, so pass `timeoutMs: 15000` there only. Every other
   caller (calories, suggest, body check) uses the 10 s default.
7. Also cap output length: `maxOutputTokens` 2048 for suggest and review, 1024 for calories
   and body. This is a guard, not a squeeze; current answers are well below it.

## Part 2: meal-style picker in the suggest sheet

### Styles (`js/mealPlan.js` `MEAL_STYLES`)
Keep the existing keys so saved profiles still work. Relabel them to the user's own words and
add one key:

| key | chip label | prompt hint |
|---|---|---|
| rice | Rice + gravy | rice + gravy/sambar/curry + a side like poriyal |
| roti | Roti + curry | chapati/roti + gravy/curry |
| onepot | Single item | one dish on its own, no side curry, e.g. bisibele bath, pulao, upma, khichdi, biryani |
| single_curry (new) | Single + curry | one main item with a curry/raita/chutney on the side, e.g. pulao + raita, dosa + sambar |
| tiffin | Tiffin | tiffin like idli/dosa + chutney/sambar |
| light | Light | light: fruit, sprouts, sundal, buttermilk or a snack |

The chips stay multi-select (any of the picked = OR, as today). No chip = "Any", which leaves
the prompt unchanged. `cleanMealStyles` already keeps only valid keys, so the new key just
works.

### Pick stage (`js/ui/today.js`)
1. New `state.mealStyles` = deep copy of `cleanMealStyles(challenge.profile.mealStyles) || {}`
   when the sheet opens.
2. New `mealStylePickerHtml(state, schedule)`, shown in the pick stage **above** Meal
   preference. Section header "What do you feel like?" and one block per schedule slot
   (`currentSchedule.slots`):
   - Slot name and time as the label.
   - The `MEAL_STYLES` chips (checkboxes in a `segmented segmented-wrap segmented-3`, same
     markup and classes as `slotStyleInputs` in `js/ui/challenges.js`):
     `data-role="meal-style"`, `data-slot`, `value=key`.
   - A short text input `data-role="meal-style-note"` (max 80 chars, placeholder
     "Anything specific? e.g. curd rice"), prefilled from the saved note.
   - Footer: "Leave blank for any. Saved for next time."
3. Wire `change`/`input` the same way `meal-pref`/`meal-variety` are wired (around line 1739):
   update `state.mealStyles[slotKey(slot)]` without re-rendering, so typing doesn't lose focus.
4. On **Suggest** (`meal-plan-go`) and **New ideas**: before `runGenerate`, save
   `cleanMealStyles(state.mealStyles)` to the challenge profile
   (`store.patchChallenge(id, { profile: { ...profile, mealStyles } })`, or remove the key when
   it's null) only if it changed. That way the choice is remembered and the challenges editor
   shows the same values. `buildSuggestionInput` then reads it from the fresh challenge, as
   it does today, so no prompt-path change is needed.
5. The plan view (after suggestions) gets a small link-style button "Change meal types"
   (`data-role="meal-plan-restyle"`) that sets `state.stage = 'pick'` and re-renders, so the user
   can adjust and ask again without closing the sheet.
6. The Plan tab (`js/ui/planner.js` → `openMealPlanSheet(..., { generate: true })`) already goes
   through the same pick stage, so it gets the picker for free.

### Challenges editor (`js/ui/challenges.js`)
No logic change. It renders from `MEAL_STYLES`, so it picks up the new labels and chip
automatically. Just check the 6 chips wrap well in `segmented-3`.

## Don't break
- Users with no styles set: the prompt is byte-identical to today (`hasStyles` false).
- Existing saved keys (rice/roti/onepot/tiffin/light) keep working.
- Dev mock path (`tracker:mockGemini`) is untouched.
- `npm test` passes. Update `tests/mealStyles.test.js` for the new key and labels, and add a
  `callGemini` timeout test if it can be done with a stubbed `fetch` and fake timers;
  otherwise test a pure helper (e.g. `attemptBudgets(now, deadline)`).
- Bump `sw.js` `CACHE_NAME` to `tracker-shell-v54`.
