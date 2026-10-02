# UI refresh: light, colourful, animated (v2, revised with ui-ux-pro-max)

Status: plan for the user's review. Opus plans, Sonnet implements, Opus verifies, and the user tests. No browser automation.

## Goal

The app works, but it looks developer-made: dark iOS-settings grey, one orange accent, system font and almost no motion. This turns it into a bright, friendly fitness app. **No behaviour or data changes.**

## What the skill recommended (and what we take from it)

`--design-system "fitness habit tracker mobile app playful light pastel" --motion 5 --density 5`:

| Skill output | Decision |
|---|---|
| Style **Claymorphism**: soft 3D, rounded 16–24px, double soft shadows, chunky and playful | **Take it, toned down ("soft clay")**: 20px cards and inner + outer soft shadows, but **no** thick 3–4px borders. Those read as a kids' app. |
| Palette "streak amber + habit green" on a warm cream background (`#FFFBEB`) | **Take the structure:** a warm light background, an energy colour for streaks and a green for done. The brand hue is the user's pick (below). |
| Fonts Fredoka + Nunito (playful) | Offered as option B. **Default: Plus Jakarta Sans**, the skill's "Friendly SaaS" pairing: friendly but adult. |
| Motion: stagger 300–450ms, `back.out(1.4)` | Done in **CSS only**, with no GSAP: `cubic-bezier(.34,1.56,.64,1)` for entrances; exits faster than entrances. |
| Avoid: muted colours, low energy | ✔ |
| Chart guidance for "performance vs target": a gauge/bullet **with the number and the target written beside it**; colour alone isn't enough | Rings and bars always show "1,378 / 1,940 kcal" text. |
| UX: success feedback, skeletons for async, **no infinite decorative animation** | The ✓ pop and the Gemini skeleton are fine. Nothing loops except the loading shimmer. |
| Pro-rules checklist: 44px touch targets, `aria-hidden` on decorative icons, colour never the only signal, contrast ≥ 4.5:1 checked separately per theme, safe areas, reduced motion | Adopted as **acceptance criteria** (§7). |

## 1. Colour system (semantic tokens only; no raw hex in components)

| Token | Light value | Use |
|---|---|---|
| `--bg` | `#FFFBF5` warm cream | page |
| `--card` | `#FFFFFF` | cards, sheets |
| `--shadow-clay` | `0 1px 2px rgba(60,40,20,.06), 0 8px 24px rgba(60,40,20,.08), inset 0 1px 0 rgba(255,255,255,.8)` | cards |
| `--text` / `--text2` | `#0F172A` / `#475569` (≥ 7:1 / ≥ 7:1 on cream) | text |
| `--brand-1` → `--brand-2` | user pick (below) | hero card, primary button, active tab |
| `--on-brand` | chosen per pick to keep ≥ 4.5:1 | text on brand |
| `--success` / `--success-soft` | `#059669` / `#D1FAE5` | done, green day (darker green for text contrast) |
| `--danger` / `--danger-soft` | `#DC2626` / `#FEE2E2` | missed |
| `--streak` | `#D97706` amber | week dots, "today", pending |
| `--focus` | brand-1 | 2px focus ring |

**Step colours** are used for the icon chip, ring, bar and chart. Text on them always uses `--text`, never the colour itself.

| Step | Colour |
|---|---|
| Food | `#F97316` |
| Workout | `#8B5CF6` |
| Steps | `#14B8A6` |
| Water | `#0EA5E9` |
| Body | `#EC4899` |
| Sleep | `#6366F1` |
| Custom | `#64748B` |

### Brand options (user picks one)

| | Gradient | Feel |
|---|---|---|
| **A (recommended)** | coral `#FF6B4A` → amber `#F59E0B` | energy and warmth; matches the skill's amber streak and green done |
| B | violet `#7C3AED` → cyan `#06B6D4` | fresh, techy |
| C | emerald `#10B981` → teal `#0EA5E9` | calm, classic health; but it clashes with "green = done" |

### Dark mode

The same tokens are redefined under `prefers-color-scheme: dark`, and **contrast is checked independently**, as the skill requires. Light is the default look.

## 2. Type

- **Option A (default):**
  - **Fonts:** Plus Jakarta Sans 500/600/700/800 for everything; Inter is dropped.
  - **Sizes:** large title 30/800; card title 17/700; body 16/1.5; caption 13; minimum 12.
- **Option B (more playful):** Fredoka for headings and big numbers, Nunito for body.
- **Numbers:** `tabular-nums` everywhere, so counters don't jump.

## 3. Shape, spacing and icons

- **Radii:** cards 20px, buttons 14px, chips and pills 999px.
- **Spacing:** a 4/8 rhythm, with 16px gutters and 24px between sections.
- **Touch targets:** at least 44×44px. This includes the water + buttons, the meal ×, the switches and the tab items.
- **Icons:** one consistent SVG family (Lucide, ISC licence), inlined as a sprite in `index.html` so it works offline. They're `aria-hidden` when next to text, and any icon-only button gets an `aria-label`. No emoji as icons.

## 4. Screens

### Today
1. **Hero card (brand gradient + clay shadow):**
   - a big ring for "mandatory steps done", with the text "4 of 5 done";
   - "Day 12 of 100";
   - 7 week dots, each also carrying a ✓/✕ glyph so colour isn't the only signal, with "5 of 7 needed";
   - a one-line nudge ("1 step to a green day").
2. **Step cards** replace the grey list:
   - **Left:** the step-colour icon chip.
   - **Middle:** the name and "actual / target unit".
   - **Right:** a mini ring that becomes a ✓ when met.
   - **Below:** a thin bar.
   - Tapping a card expands it in place, as now.
3. **Food card:**
   - **Calories:** a ring with the green band (50–100%) shaded and the over-the-target part in red, plus the number and target text.
   - **Macros:** 4 macro bullet bars with a target marker.
   - **Meals:** meal photos as 64px rounded tiles; Planned placeholders are dashed tiles.
   - **Buttons:** a camera "Add food" button and a sparkles "Suggest tomorrow's meals" button.
   - **Eating window:** a pill.
4. **Water:** round +0.25 / +0.5 L buttons (44px); the bar fills.

### Stats
- **Charts:** in the step colour, with a soft gradient under the line, and target lines labelled.
- **KPI tiles:** 2 columns (avg kcal, avg protein, weight change, green-day %), each a number + label.

### Challenges and the form
- **Challenge cards:** a brand/slate top stripe and a progress bar with text.
- **Form fields:** grouped in soft cards, with visible labels and errors next to the field.

### Global
- **Sheets:** white, 24px radius, scrim measured for legibility.
- **Primary button:** the brand gradient.
- **Tab bar:** a floating white bar with icon + label; the active tab gets a brand pill. It respects the safe area, and content padding is kept so nothing hides behind it.

## 5. Motion (CSS + ≤ 30 lines of JS; everything off under `prefers-reduced-motion`)

| Moment | Spec |
|---|---|
| Screen load | Cards stagger: fade + 12px rise + scale .96→1; 380ms; 50ms steps; `cubic-bezier(.34,1.56,.64,1)` |
| Ring / bar change | stroke-dashoffset / transform: scaleX, 600ms ease-out. Never animate width/height |
| Numbers | count-up 500ms on change (kcal, steps, water) |
| Step met | ring completes → ✓ pops (scale .6→1.15→1, 300ms) → soft success glow 600ms, once |
| Day turns green | ~24 CSS confetti pieces from the hero ring, 1.2s, once per day per challenge (flag in localStorage) |
| Gemini analysing | skeleton shimmer in the meal tile (the only looping animation) |
| Sheet | enter 320ms spring, exit 200ms ease-in (exit faster than enter) |
| Press | scale(.97) + shadow shrink, 120ms; no layout shift |
| Tab change | the active pill slides 250ms |

## 6. Implementation (Sonnet), in 4 steps; Opus verifies after each

1. **Foundation:**
   - tokens, fonts, light/dark;
   - the shared components (card, row, button, switch, segmented, pill, sheet, tab bar, focus ring);
   - `theme-color` and the manifest;
   - the hard-coded colours in `stats.js` moved to tokens.
2. **Today:**
   - the hero, step cards and food card;
   - the water buttons;
   - the icon sprite.
3. **Motion:** everything in §5.
4. **Stats and Challenges:** the charts, KPI tiles, challenge cards and form polish.

**Rules for the implementation:**
- No logic or data changes.
- Keep every `data-role` hook and `esc()`.
- No new JS libraries.
- Bump the service-worker cache each step.
- `npm test` must stay green.

## 7. Opus verification after each step (acceptance criteria from the skill's pro-rules)

- **Behaviour:** the diff shows no behaviour change and no removed `data-role`.
- **Tests:** `npm test` passes.
- **Contrast:** the token pairs are computed with a script: text ≥ 4.5:1, in light **and** dark.
- **Touch targets** are at least 44px; decorative icons are `aria-hidden`; icon buttons are labelled.
- **Colour is never the only signal:** a ✓/✕ or text always accompanies it.
- **Reduced motion:** a `prefers-reduced-motion` block disables everything except instant state changes.
- **No horizontal scroll at 375px** is checked by CSS review. The user does the visual test on the phone.

## 8. Questions for the user

1. **Brand:** A coral→amber (recommended), B violet→cyan, or C emerald→teal?
2. **Fonts:** A Plus Jakarta Sans (friendly, adult) or B Fredoka + Nunito (more playful)?
3. **Dark mode:** keep it for phones set to dark, or light only?
4. **Confetti** on a green day: yes or no?
