# Summary viewer redesign (#/summary/:date)

The user's requests:
- "Hide details / Show details", overlaid on the photo;
- every meal of the day shown;
- all details shown;
- each step's details can be shown or hidden individually.

**Root cause of the missing meals:** `buildDaySummary` only reads `entry.photoId`/`value`/`note`. Food meals (`entry.meals[]`, each `{ id, photoId, dish, calories, macros, items, at }`) and workout sessions (`entry.sessions[]`, each `{ type, minutes, intensity, kcal }`) are never shown, and meal photos are never in the slideshow.

## 1. Model (js/summaryModel.js, pure, tested)

**`buildDaySummary(challenge, day)`:** keep the existing return shape and fields exactly as they are, because the existing tests deepEqual them. Additionally, **append meal photos** to `photos`:
- for each step with `Array.isArray(e.meals)`, for each meal with a `photoId`, push `{ stepId, stepName, photoId, caption: \`${meal.dish || 'Meal'} · ${meal.calories} kcal\` }`;
- this goes after that step's own photo, if any, keeping step order;
- the existing test has no meals, so it's unaffected.

**New `buildDayDetails(challenge, day, { flexOn = false } = {})`:**
- It returns one entry per challenge step, in order:
  `{ stepId, name, mandatory, complete, headline, rows: [{ title, sub, photoId? }], note? }`.
  - `complete` = `isStepComplete(s, e, targetFor(day, s), { flex: flexOn })`. Import `targetFor` from fitness.js; check for import cycles, and copy the one-liner if there's a cycle.
- **Headline:**
  - goal steps: `"<value> / <target> <unit>"`, or `"Target <t> <unit>"` when there's no value;
  - otherwise: the number value with its label, `"Done"`, or `"—"`.
- **Rows:**
  - food: one row per meal, `title = dish || 'Meal'` and `sub = "<calories> kcal · " + macroInlineLine(meal.macros)` (from foodLogic.js; check its exact output and adapt), with `photoId`. Then a final row, "Total", showing kcal and the day's `macroInlineLine(mealsMacros(meals))`;
  - workout: one row per session, `title = type` and `sub = "<minutes> min · <intensity> · <kcal> kcal"`;
  - other steps: a row with the number label and value, if present.
- `note` is copied from `e.note`.

**Tests in tests/summary.test.js:**
- meal photos are appended with captions;
- food details list every meal plus the total;
- workout sessions;
- the headline with a target;
- a step with no entry.

## 2. View (js/ui/summary.js + css)

**Layout:**
- Photos stay full-screen.
- **Remove the 30% right side panel.** Move `.summary-pic-nav.next` to `right: 12px` and drop the `calc(70% − 60px)`. The dots span the full width.

**Details toggle:**
- A pill button sits top-right at the safe area, in the same glass style as `.summary-edit`: **"Hide details"** / **"Show details"**, with `data-role="toggle-details"` and `aria-expanded`.
- The state is remembered in localStorage `tracker:summaryDetails` (`'0'` = hidden; default shown), with try/catch.

**Details overlay** (`.summary-details`):
- Absolute, positioned bottom 0, left 0, right 0, with `max-height: 62vh` and its own scroll (`overscroll-behavior: contain`).
- Background: `linear-gradient(to top, rgba(0,0,0,.82), rgba(0,0,0,.55))` with blur 16px. Radius 20 on the top corners. Padding 14px 16px plus the bottom safe area.
- White text. The photo stays visible above it.
- When hidden it slides down (`transform: translateY(100%)`, .25s) and only the toggle stays visible. Respect `prefers-reduced-motion`.

**Overlay content:**
1. **Header row:** the date (`formatDateShort`), the status pill, and the "Photo i / n · caption-or-stepName" text. Update this text on swipe, replacing the old counter and name in `updateNavUi`.
2. **One card per step** (`.summary-step`):
   - **Header button** (`data-role="toggle-step"`, `data-step-id`, `aria-expanded`): the ✓/○ check, the name, the headline on the right, and a chevron that rotates when open.
   - **Body:** the rows (title in bold 14px; sub in 12px at rgba(255,255,255,.7)) and the note.
     - A row with a `photoId` gets a small 40×40 rounded thumbnail (`<img data-photo-id>`, hydrated by `hydratePhotos`).
     - **Tapping that row** (`data-role="goto-photo"` `data-photo-index`) scrolls the strip to that photo.
   - **Default open state:** open for the food and workout steps (type `food`/`workout`), closed for the rest.
   - **Toggle behaviour:** toggling only flips `hidden` on the body, `aria-expanded` and a class. No re-render.
   - Remember open steps in a module-level Set keyed by stepId, so the state survives store re-renders within the session.
   - Mandatory steps keep the left accent border.
3. **Tap behaviour:** tapping the photo (the existing left-third back / else forward) must not fire when the tap lands inside `.summary-details`. The slide handler already uses `closest('.summary-slide')`; the overlay is not inside the slide, so check this stays true.

**Flex:** pass `flexOn = store.flexDatesFor(challenge.id).has(date)` to `buildDayDetails`.

**Unchanged:** close and Edit day (top-left), Escape, the ‹ › rolling into adjacent days, swipe, `hydratePhotos`, the empty state ("No photos for this day" still shows the details).

**Cleanup:** remove the CSS that's now unused (`.summary-panel*`, `.summary-photo-nav*`, `.summary-nav-btn`, `.summary-item*`, `.summary-photo-tag`) only if it's no longer referenced anywhere.

**SW:** bump `CACHE_NAME` to `tracker-shell-v44`.

## Checks
`npm test` passes. The user tests on the dev server; don't use the browser plugin.
