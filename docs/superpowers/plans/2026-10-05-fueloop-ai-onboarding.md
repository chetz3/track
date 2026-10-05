# FueLoop rename, ∞ loader, AI-key onboarding

To-the-point scope. Opus plans, Sonnet implements, the user tests on the dev server. **Don't break existing features.**

## 1. Rename Habitly → FueLoop (user-visible text only)

**Change the visible name in:**
- index.html: `<title>`, `apple-mobile-web-app-title`, the appbar;
- manifest.webmanifest: `name` and `short_name`;
- privacy.html and terms.html: every "Habitly";
- js/ui/stepEditor.js: the two notification strings;
- the sw.js comment and the icons/generate_icons.py docstring.

**Keep unchanged:** every `tracker:*` localStorage key, the IndexedDB name, and the `tracker-*` cache-name prefix. Changing these would wipe user data.

**Wordmark:**
- "FueLoop" with the **oo drawn as an infinity symbol**.
- index.html appbar markup:
  `<span class="appbar-name" aria-label="FueLoop"><span aria-hidden="true">FueL</span><svg class="wordmark-inf" aria-hidden="true" viewBox="0 0 48 24"><use href="#i-infinity"/></svg><span aria-hidden="true">p</span></span>`.
- Add to the sprite:
  `<symbol id="i-infinity" viewBox="0 0 48 24"><path d="M24 12c-4-6-8-9-12.5-9a9 9 0 0 0 0 18c4.5 0 8.5-3 12.5-9s8-9 12.5-9a9 9 0 0 1 0 18c-4.5 0-8.5-3-12.5-9z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></symbol>`.
- Style the infinity glyph like a pair of lowercase o's:
  - height ≈ 0.62em, width ≈ 1.24em;
  - `vertical-align: baseline`, sitting on the x-height;
  - colour: the brand gradient isn't possible with `<use>`, so use `color: var(--accent-ink)` or the coral #FF6B4A. The text stays solid for contrast.

**Logo:**
- **icons/logo.svg:** same coral→amber rounded square, with a white infinity loop centred in it (stroke 5, round caps) instead of the ring and check.
- **icons/generate_icons.py:** draw the same lemniscate.
  - Sample the parametric curve `x = a·cos t / (1+sin²t)`, `y = a·sin t·cos t / (1+sin²t)`, with a ≈ 22 in the 64-unit space, centred at 32,32.
  - Draw it as the distance to the polyline ≤ 2.5.
  - Re-run it to regenerate icon-192.png, icon-512.png and logo-120.png. Check the script for how logo-120 is made.

## 2. ∞ loader for all busy states

**`js/ui/dom.js`:**
- export `loaderHtml(label = '')` →
  `<span class="loop-loader" role="status"><svg viewBox="0 0 48 24" aria-hidden="true"><path class="loop-track" d="(same path)"/><path class="loop-run" d="(same path)"/></svg>${label ? `<span>${esc(label)}</span>` : '<span class="sr-only">Loading</span>'}</span>`.
- Inline the path rather than using `<use>` so it can be animated.

**CSS:**
- `.loop-loader`: inline-flex, centred, gap 8px.
- svg: 36×18, or 64×32 for the `.loop-loader.lg` variant.
- `.loop-track`: stroke currentColor, opacity .2, width 4.
- `.loop-run`: stroke currentColor, width 4, round caps, `pathLength="100"`, `stroke-dasharray: 25 75`, animated via `@keyframes loop-run { to { stroke-dashoffset: -100 } }` at 1.2s linear infinite.
- `@media (prefers-reduced-motion: reduce)`: no animation.
- Add a `.sr-only` utility if one doesn't exist.

**Replace the busy text with `loaderHtml(...)`, keeping the same label words.** Inside buttons, it inherits the button colour.
- challenges.js: 'Connecting…' and 'Checking…'.
- today.js:
  - `photoPairHtml` busyLabel ('Saving…' / 'Analyzing…'): render `loaderHtml(busyLabel)` inside the label and drop the `.is-analyzing` shimmer on it;
  - 'Re-estimating…', 'Estimating…', 'Saving…' (plan-meal), 'Thinking…';
  - "Generating your plan…" uses the large variant, centred: `<div class="loader-block">${loaderHtml('Generating your plan…')}</div>` with class `lg`.
- Check for any other "…" busy strings (`grep -n "…'" js/ui`), but skip placeholders and normal copy.
- Buttons are still disabled exactly as before. Only the label markup changes.

## 3. AI is optional, explained clearly

**Move `GEMINI_KEY_RE` into js/gemini.js** (export it) and import it in challenges.js.

**Key change event:** `setGeminiKey` and `clearGeminiKey` also dispatch `window.dispatchEvent(new Event('fueloop:aikey'))`, wrapped in try.

**New `js/ui/aiKeySheet.js`, which exports `openAiKeySheet()`:**
- It uses `openSheet` with the title "Turn on AI (free)" and a body wrapped in `<div id="ai-key-root">`.
- **Copy:**
  - "**This key is yours.** FueLoop has no server. The key stays on this phone and uses your own free Google Gemini quota. We never see it."
  - "Takes about 2 minutes, and FueLoop then works to its full potential:" followed by these bullets:
    - photo → calories & macros automatically;
    - meal suggestions that fix yesterday's gaps, plus a grocery list;
    - a weekly body check (only if you opt in).
  - "Without it, everything still works — you'll just type calories yourself."
  - The same 3 steps as the settings section (link to aistudio.google.com/apikey, opening in a new tab).
- **Controls:**
  - a password-type input with `data-role="ai-key-input"`;
  - a primary **Save key** button. It validates with `GEMINI_KEY_RE`. If the key is invalid, show the error inline in a `.section-footer.error` without re-rendering on input. If it's valid, call `setGeminiKey` and close the sheet;
  - a secondary **Continue without AI** button. It sets localStorage `tracker:aiPromptDismissed = '1'` (in try/catch) and closes the sheet.
- **Backdrop or Escape close:** treat it the same as "Continue without AI" for this session only. Don't set the flag, so it shows again next launch.

**Popup on launch, in app.js `boot()`:**
- after the first `await render()`, if `!getGeminiKey()` and `tracker:aiPromptDismissed !== '1'`, call `openAiKeySheet()`;
- not on the `#/summary` route;
- not when `?notify` is set.
- In `?mock` mode it still shows. That's fine, because the mock flag doesn't count as a key.

**Top banner** (shows whenever there's no key, dismissed or not):
- In index.html, directly after the appbar:
  `<div class="ai-banner" id="ai-banner" hidden><span>✨ AI is off — add your free key (2 min) for automatic calories and meal ideas.</span><button type="button" class="ai-banner-btn" data-role="ai-banner-add">Add key</button></div>`.
  Use the `i-sparkles` icon rather than an emoji (`<svg class="icon"><use href="#i-sparkles"/></svg>`).
- In app.js, `updateAiBanner()` sets `banner.hidden = !!getGeminiKey()`, and also hides it on the summary route. Call it after render on every route change and on the `fueloop:aikey` event. A click on the button calls `openAiKeySheet()`.
- **Styling:**
  - max-width 640px, margin 8px 16px 0, radius 12;
  - a soft amber background (e.g. #FFF4E0) with dark text, meeting AA;
  - 14px text, flex with gap 10px;
  - a 44px-min-height button using the accent ink.

**Settings (challenges.js `geminiSectionHtml`):**
- Rename the header to "Gemini AI (your key)".
- Change the first footer to: "Optional, but FueLoop works best with it: automatic calories from photos, meal ideas and a grocery list. It's free and takes about 2 minutes:".
- Keep the last line about the key staying on this device.

## 4. Service worker
- Bump `CACHE_NAME` to `tracker-shell-v41`.
- Add `./js/ui/aiKeySheet.js` to SHELL_FILES, plus any other new file. Keep the existing list.

## 5. Check
- `npm test` must still pass (178).
- Add tiny tests only if pure logic is added; none is expected.
- Don't use the browser plugin. The user tests.

## Not doing
- No backend and no shared key.
- No change to how AI features behave with or without a key; existing no-key fallbacks stay.
