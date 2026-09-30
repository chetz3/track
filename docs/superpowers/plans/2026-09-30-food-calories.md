# Food Calories via Gemini: Implementation Plan

Planned by Opus, executed by Sonnet in a single pass on `main`. Commit only when the user asks.

- **Checks:** `node --check` plus `npm test` (`node --test tests/`). No browser testing; the user tests on `http://localhost:8090`.
- **Stack:** plain JS with no build step. Gemini is called from the browser with `fetch`, and there is no server.

## User setup (not code)

1. Create a free Gemini API key at **https://aistudio.google.com/apikey** (choose "Create API key", then the existing tracker Google Cloud project).
2. Optional hardening: in **https://console.cloud.google.com/apis/credentials**, open that key and set:
   - **Application restrictions:** Websites, with `http://localhost:8090/*` and `https://chetz3.github.io/*`.
   - **API restrictions:** Generative Language API.
3. Paste the key into the app under **Challenges → Gemini AI**.

**The key is never committed.** The repo is published on public GitHub Pages, so the key lives only in the device's `localStorage` (`tracker:geminiKey`).

## Data model

### Step definition
A food step is an ordinary step with `type: 'food'`, and it always has this fixed shape:
```js
{ id, name, mandatory, type: 'food', photo: 'none', note: 'none',
  number: { label: 'Calories', unit: 'kcal', required: false, showSum: false, showDiff: false, showAvg: true } }
```
- Because it includes `number`, the existing Stats trend chart, average, day summaries and the backup validator all work unchanged.
- Steps without `type` behave exactly as before.

### Day entry for a food step
```js
{ done, value /* total kcal = sum of meals */, meals: [
  { id, photoId, dish, calories /* int */, items: [{ name, portion, calories }], at /* ms */ }
] }
```
- `value` is always recomputed from `meals`, so it is never set on its own.

## Files

### 1. `js/foodLogic.js` (new, pure, no DOM)
- `FOOD_NUMBER`: the constant `number` object above.
- `makeFoodStep(base)`: takes `{ id, name, mandatory }` and returns the fixed shape.
- `isFoodStep(step)`: `step?.type === 'food'`.
- `mealsTotal(meals)`: sum of `calories`, rounded to an integer. Returns 0 for an empty or missing list.
- `parseCalorieResult(json)`:
  - validates the Gemini JSON and returns `{ isFood, dish, items, total }`;
  - clamps each item's calories to integers in 0–5000;
  - sets `total` to the sum of the items, or `total_calories` if there are no items;
  - throws `Error('Unexpected response from Gemini')` if the shape is wrong.
- `buildFoodPatch(entry, meals)`: returns `{ meals, value: mealsTotal(meals), done: meals.length > 0 }`.

### 2. `js/gemini.js` (new)
- `KEY_STORAGE = 'tracker:geminiKey'` with `getGeminiKey()`, `setGeminiKey(k)` and `clearGeminiKey()`. Every localStorage access is wrapped in try/catch.
- `MODEL = 'gemini-flash-latest'`. This alias tracks the current free-tier Flash model. Keep it in one constant.
- `export async function estimateCalories(blob, note)`:
  - Convert the JPEG blob to base64 with FileReader and strip the `data:` prefix.
  - `POST https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` with headers `Content-Type: application/json` and `x-goog-api-key: <key>`. **Do not** put the key in the URL.
  - Request body:
    ```js
    { contents: [{ parts: [
        { inline_data: { mime_type: blob.type || 'image/jpeg', data } },
        { text: PROMPT + (note ? `\nUser note about this meal: ${note}` : '') } ] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA } }
    ```
  - `SCHEMA` (OpenAPI subset, uppercase types):
    - an OBJECT with required `is_food` BOOLEAN, `dish` STRING, `total_calories` INTEGER, `confidence` STRING with enum `low|medium|high`, and `items` ARRAY;
    - each item is an OBJECT with required `name` STRING, `portion` STRING and `calories` INTEGER.
  - Parse the result: take `candidates[0].content.parts[0].text`, run it through `JSON.parse`, then return `parseCalorieResult(...)`.
  - Map errors to friendly messages:
    - no key: "Add your Gemini API key in Challenges → Gemini AI."
    - 400 or 403 with `API_KEY_INVALID` (or any 401/403): "Gemini API key is invalid."
    - 429: "Gemini free-tier limit reached. Try again in a minute."
    - `!navigator.onLine` or a network failure: "You're offline. Connect to add food."
    - anything else: `"Gemini error (" + status + ")"`.
- `PROMPT`, to the point:
  ```
  You are a nutrition estimator. Estimate the calories of the food in this photo.
  - List each distinct food or drink with its visible portion (use plates, cutlery, hands for scale).
  - Use standard nutrition values; include visible oil, butter, sauces and dressings.
  - Give one best integer estimate per item, never a range. total_calories = sum of items.
  - dish: a short name for the whole meal (max 5 words).
  - If there is no food or drink, set is_food=false, items=[], total_calories=0.
  Respond only with JSON matching the schema.
  ```

### 3. `js/ui/stepEditor.js`
- At the top of the sheet, add a segmented **Type** row with the options `Regular` and `Food`. It is bound to `draft.type`, where `'regular'` means no type.
- When Food is selected, hide the Photo, Number and Note rows. Show a footer instead: "Add meals by photo; calories are estimated by Gemini and totalled per day."
- `cloneStep` carries `type`.
- In `doSave`, for food call `makeFoodStep({ id, name, mandatory })`. Otherwise keep the current behavior and never write a `type` key.

### 4. `js/ui/today.js` (food rows)
- In `expandedRowsHtml`, if `isFoodStep(step)`, render `foodRowsHtml(step, entry, fieldCtx)` **instead of** the photo, number and note rows. That function renders:
  - one row per meal: an `img.thumb` with `data-photo-id`, the dish, and `${calories} kcal`. Add a small `×` button (`data-role="meal-delete"`, `data-meal-id`) when the day is editable.
  - a total row: "Total · N kcal".
  - an "Add food" label/button that wraps `<input type="file" accept="image/*" hidden data-role="food-input" data-step-id>`, styled like `photoRowHtml`. While analyzing, disable it and change its text to "Analyzing…". Track that state in `savingByKey`, the same map the photo flow uses.
  - errors, shown through the existing `photoErrorByKey` slot.
- `stepSummaryHtml` already shows `value + unit`. For food steps, show `N kcal` and no thumbnail.
- **Add food flow** (`handleFoodFile(ctx, stepId, file)`, modeled on `handlePhotoFile`):
  1. Run `savePhoto(file)` to get `photoId`, then `getPhotoBlob(photoId)` to get the resized JPEG.
  2. Call `estimateCalories(blob)`.
     - If `!isFood`, delete the photo and set the error "No food found in that photo."
  3. Open a confirm sheet (`openSheet`) with:
     - the dish, as an editable text input;
     - the item list as read-only lines, `name · portion · kcal`;
     - the total, as an editable numeric input prefilled with `total`;
     - an optional note input with a "Re-estimate" button. It calls `estimateCalories(blob, note)` again and refreshes the fields.
     - Save and Cancel buttons.
  4. **Save** appends the meal `{ id: 'm-'+Date.now().toString(36)+rand, photoId, dish, calories: parsed int, items, at: Date.now() }`, then runs `store.updateStep(challengeId, date, stepId, buildFoodPatch(entry, meals))`.
     **Cancel** (or dismissing the sheet) calls `deletePhoto(photoId)`.
  5. On any error, clear the Analyzing state, delete the photo, and set the error message.
- **Delete meal:** `confirm('Remove this meal?')`, then `updateStep` with the meals filtered out (through `buildFoodPatch`), then `deletePhoto(meal.photoId)`.
- The read-only row (past days) should list meals too, or at least the total. Showing `N kcal` through `stepSummaryHtml` is enough.

### 5. `js/db.js` (`deleteChallengeCascade`, line ~147)
- Also delete `entry.meals[*].photoId` for every day entry, so no photos are orphaned.

### 6. `js/ui/challenges.js`: "Gemini AI" section (after Google Drive)
- **No key saved:**
  - a password input (`data-role="gemini-key"`, placeholder "Paste API key") and a Save button (`data-role="gemini-save"`);
  - a footer: "Needed for food calorie estimates. Get a free key at aistudio.google.com/apikey." Make it a link with `target="_blank" rel="noopener"`.
- **Key saved:** show "Key saved · ••••" plus its last 4 characters, and a Remove button (`data-role="gemini-remove"`).
- Save trims the input and validates it with `/^[A-Za-z0-9_\-]{20,}$/`; if it fails, `alert`.
- The store doesn't notify for this, so re-render with `renderChallenges(challengesCurrent.root)`.

### 7. `js/ui/stats.js`
- Food steps already appear as a number series (Calories, kcal, average).
- In the series section header, when `isFoodStep(s.step)`, add a line above the chart: **"Today · N kcal"**, where N is `mealsTotal` of today's entry (`daysMap[store.today()]?.steps[step.id]?.meals`). Show 0 if there are none.

### 8. `sw.js`
- Add `./js/foodLogic.js` and `./js/gemini.js` to `SHELL_FILES`.
- Bump `CACHE_NAME` to `tracker-shell-v13`. Requests to Gemini are cross-origin and already go straight to the network.

### 9. Tests: `tests/food.test.js`
- `mealsTotal`: empty, missing, and rounding.
- `parseCalorieResult`: valid input, clamping of negative and huge values, the no-food case, and throwing on a bad shape.
- `buildFoodPatch`: `done` is true only when there are meals.
- `makeFoodStep` output passes the existing backup step validation. Build a minimal `validateV2` payload containing a challenge with a food step.

## Out of scope
- Daily calorie goals.
- Macros.
- Editing a saved meal (delete and re-add instead).
- Drive sync of meals.
- Any server-side proxy.
