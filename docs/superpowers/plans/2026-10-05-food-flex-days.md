# Food flex days (+200 kcal, 2 per challenge week)

**Rule:**
- On up to **2 days per challenge week** (7-day blocks from attempt.startDate), a food step whose goal dir isn't `atLeast` also counts as complete when `t < value ≤ t + 200`.
- Flex is used automatically, in date order, but **only on days that would otherwise be non-green and would become green with flex.**
- Everything else is unchanged: the 50% floor, gain goals, the 5-of-7 rule and the fitness reset.

## rules.js (pure)

**Constants:** `export const FLEX_KCAL = 200; export const FLEX_PER_WEEK = 2;`

**`isStepComplete(stepDef, entry, target, opts = {})`:**
- In the food branch, the upper bound becomes `t + (opts.flex ? FLEX_KCAL : 0)`.
- Nothing else changes.

**`isDayGreen(day, challenge, opts = {})`:** passes `opts` through to `isStepComplete`.

**`dayStatus(date, day, challenge, today, flex = null)`:**
- `flex` is an optional Set of dates.
- The day is green if `isDayGreen(day, challenge)` **or** (`flex && flex.has(date) && isDayGreen(day, challenge, { flex: true })`).

**`export function flexDates(challenge, startDate, daysMap, today)` → Set:**
- It returns an empty Set when `!startDate` or the challenge has no food step with a goal dir other than `atLeast`.
- For each challenge week (dayNumber 1..totalDays, 7 at a time, dates ≤ today only), walk the dates in order.
- For a date where `!isDayGreen(day, challenge)` but `isDayGreen(day, challenge, { flex: true })`, add it while that week's used count is below `FLEX_PER_WEEK`.

**`evaluateAttempt`:**
- compute `const flex = flexDates(challenge, startDate, daysMap, today)` once;
- pass it to every `dayStatus` call.

## Callers: pass the flex set wherever a day's status is shown

**store.js:** `export function flexDatesFor(challengeId)` → `flexDates(challenge, displayAttempt(id)?.startDate, state.days[id] || {}, today())`.

**Call sites:** compute the set **once per render** and pass it as the 5th argument to `dayStatus`:
- today.js: the week-progress loop (around line 185) and the status (line 188);
- calendar.js: lines 86 and 153;
- summary.js: `computeStatus`.

**today.js food step display** (`stepSummaryHtml`, the goal check in the step row, `readOnlyStepRowHtml`):
- When the step is food (dir not `atLeast`), the date is in the flex set, and the value is over target, treat it as met. Pass `{ flex: true }` to `isStepComplete`.
- Append a small badge `<span class="flex-badge">Flex +${value - target}</span>` (amber: background #FFF4E0, text #8A4B00, 12px/600, radius 999, padding 2px 8px, margin-left 6px).
- The row helpers get the date via `fieldCtx.date`, or a passed-in date.
- `readOnlyStepRowHtml` needs the flex set and the date threaded through from its caller.

**Food section footer on Today:**
- Show one line of `.section-footer` text under the food step's macro/target lines (where the existing food extras render): "Flex days this week: N of 2 used (up to +200 kcal over target)".
- Count = the flex dates inside the current challenge week.
- Show it only for fitness challenges with a food goal that isn't gain.

## Not changing
- reminders.js: a step over target still counts as not complete for reminders, which is fine.
- summaryModel.js
- backup.js
- stored data: nothing new is stored, since flex is derived.

## Tests (tests for rules)
- `isStepComplete` food: target + 150 is false without flex and true with `{ flex: true }`; target + 250 is false either way.
- `flexDates`: 3 over-by-100 days in one week → only the first 2 are included; a day already green isn't counted; a day over by 300 isn't counted; a new week resets the count.
- `evaluateAttempt` fitness (weeklyTarget 5): a week with 2 flex days + 2 red days + 3 green days doesn't reset; a 3rd over-by-100 day counts as red.
- `npm test` must pass.

## SW
Bump `CACHE_NAME` to `tracker-shell-v43`.
