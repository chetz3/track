# Body photo trend in the AI review (one-collage, low-token)

Opus plans, Sonnet implements and Opus verifies; then we push (the user asked for implement + push). **Don't break existing features.**

## Goal
- The 4 weekly body photos from the last ~28 days go to Gemini as **one 768×768 collage (one image tile, ~258 tokens)**.
- This happens **inside the existing plateau review call** (`reviewPlateau`), not as a new call.
- The review then also reports how the visible belly/waist area changed, and links that to the risk signals as *signs consistent with*, never a diagnosis.
- A button on Stats → Photo progress starts it.

## 1. Pure helpers (`js/coach.js` or a new pure `js/photoTrend.js`, tested)

**`pickWeeklyBodyPhotos(challenge, daysMap, today, {weeks = 4})`** → `[{date, photoId, kg|null}]`, oldest first.
- Only the body step's `entry.photoId`, in the last `weeks × 7` days, ending yesterday or today.
- One photo per 7-day bucket counted back from today: the **latest** photo in each bucket.
- Empty buckets are skipped. The result has at most 4 entries.

**`photoTrendReady(picks)`**: true when there are at least 2 photos.

## 2. Collage builder (`js/ui/collage.js`, DOM)

**`buildBodyCollage(picks)`** → `Promise<Blob>` (JPEG, quality 0.7).
- **Canvas:** 768×768 in a 2×2 grid. Each cell is 384×384, a centre-cropped "cover" fit of the photo.
- **Image loading:** loaded via `getPhotoBlob` (js/photos.js), then `createImageBitmap`, falling back to an `Image` element plus an object URL. Revoke URLs afterwards.
- **Labels:** each cell gets a small label at the bottom-left, "8 Sep · 129.4 kg" (the kg part only if known), white text on a dark translucent strip. Use the system font at 18px.
- **Fewer than 4 photos:** remaining cells are left neutral grey.
- **Size:** the 768×768 output must not change. That size is one Gemini tile.

## 3. Review input + prompt + schema (`js/coach.js`, `js/gemini.js`)

**Input:** `buildReviewInput` gains `opts.photoDates` (an array of the collage dates). When present, add `photos: {dates: [...], note: "collage 2x2, oldest top-left"}` to the input JSON.

**`reviewPrompt`:** only when `input.photos` exists, append one rule (keep it this short):

```
10. Image = body photos (dates in photos.dates, oldest top-left). Compare only the visible belly/waist and face puffiness across dates. Report it in photo_trend. Never diagnose; link to risk signals only as "signs consistent with". If lighting, pose or clothing differ too much to compare, say so.
```

**`REVIEW_SCHEMA`:** add an optional `photo_trend: { belly: enum[smaller, same, larger, unclear], note: STRING }`.

**`parseReview`:**
- keeps `photo_trend` only when photos were sent (`ctx.photosSent`);
- validates the enum;
- caps the note at 160 chars;
- runs the same "you have" → "signs consistent with" rule as for the existing strings, if such a sanitiser exists. If not, drop any note that contains "you have".

**`reviewPlateau(input, ctx, imageBlob?)`:**
- When a blob is passed, the parts become `[{ text }, { inlineData: { mimeType: 'image/jpeg', data: base64 } }]`. Reuse the existing `blobToBase64` (used by `checkBody`).
- Temperature stays 0.4.
- The dev mock (`mockReview`) returns `photo_trend: {belly: 'same', note: 'Belly area looks about the same across 4 weeks.'}` when `input.photos` is present.
- The dev prompt-size log also logs "image: 1 tile ≈258 tokens".

## 4. Consent and UI

**Consent:**
- Photos are sent **only if `profile.shareBodyPhoto === true`** (an existing switch) **and** the user confirms on the preview.
- If `shareBodyPhoto` is off, the button explains: "Turn on 'Share body photo' in the challenge profile to include photos." It offers to open the profile (`#/challenges/<id>`), and the review still runs text-only.

**Stats → Photo progress section:**
- **Button:** **"Analyse body trend (AI)"**, shown only for fitness challenges that have a body step.
- **Disabled state:** greyed out, with the hint "Needs 2+ weekly body photos", when `photoTrendReady` is false.
- **AI key gate:** same as the review: `aiAvailable()` decides, otherwise `openAiKeySheet()`.

**Preview sheet:** it shows:
- the built collage, `<img>` from an object URL, revoked on close;
- "This 1 image goes to Google Gemini on your own key, with your last 28 days of data. Nothing is stored.";
- **Analyse** and **Cancel** buttons.

Analyse runs the review flow with the photos, with the same loader, sheet and storage as `openReviewEntry`.

**Review sheet (`js/ui/reviewSheet.js`):**
- When a stored review has `photo_trend`, show a "What the photos show" block near the top: a belly pill (Smaller / Same / Larger / Unclear) and the note.
- Export a function, e.g. `runReview(challenge, { photos })`, so the Stats button can reuse the existing run path.
- "Re-run review" keeps photos if the last run used them and they are still available and allowed.

## 5. Tests
- **`pickWeeklyBodyPhotos`:** buckets, the latest photo per bucket, empty weeks, the cap of 4, and ignoring non-body photos.
- **Review input:** `buildReviewInput` adds `photos` only with `photoDates`; prompt rule 10 is present only then.
- **`parseReview`:** `photo_trend` is kept only when `photosSent`, and a bad enum becomes `unclear`.
- **Budget:** the text prompt stays under the existing budget with photos.
- `npm test` must pass.

## 6. Guardrails
- **Unchanged:** existing review behaviour without photos, `checkBody`, and the body-check opt-in.
- **Storage:** no new localStorage keys besides what's needed, all wrapped in try/catch.
- **Service worker:** bump `CACHE_NAME`, and add `js/ui/collage.js` (and `photoTrend.js` if created) to SHELL_FILES.
- **UI:** 44px targets, light and dark themes, works at 360px wide, and no re-render on input.
