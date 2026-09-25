# Tracker v2 — Multiple challenges, configurable steps, Apple-style UI, D3 stats

## Goal
Make the tracker feel professionally built: Apple-style dark design, compact forms with no wasted space, every step fully user-configured (no built-in "body check-in"), several challenges running at once, and interactive D3 stats. Existing data on devices must carry over without loss.

## Decisions (confirmed with user)
- Several challenges at once; each can be switched to and deleted.
- No built-in steps. Every step is user-configured (photo / number / note fields).
- Theme: Apple dark with an orange accent.
- Stats: streak & progress ring, and number trends. (Heat-map and step-completion bars are out of scope.)
- Stack unchanged: static HTML/CSS/JS PWA on GitHub Pages, data in IndexedDB on the device. D3 v7 added, vendored into the repo so it works offline.

## Steps (fully configurable)
Each step: `{ id, name, mandatory, photo: 'none'|'optional'|'required', number: null | { label, unit, required }, note: 'none'|'optional' }`.
- Example the user can create: "Body check" — mandatory, photo required, number {label "Weight", unit "kg", required}.
- **Step complete** = its required fields are filled (required photo present, required number present) AND it is ticked. Filling the last required field auto-ticks it; a step with no required fields is completed by ticking.
- **Green day** = every mandatory step in the day's snapshot is complete. All other rules unchanged (weekly target X, failed week resets to Day 1, today + yesterday editable, passed weeks frozen).

## Data model (IndexedDB `tracker` v2)
- `challenges`: `{ id, name, totalDays, weeklyTarget, steps:[Step], createdAt }`
- `attempts`: `{ id, challengeId, startDate, endDate?, status, greenWeeks }`
- `days` keyed by `key = challengeId + '|' + date`: `{ key, challengeId, date, mandatoryStepIds, steps: { [stepId]: { done, photoId?, value?, note? } } }`
- `photos`: unchanged.
- Selected challenge id kept in localStorage (UI convenience only).

### Migration v1 → v2 (in `onupgradeneeded`, and reused for importing old backups)
Pure function in `js/migrate.js`, unit-tested:
- v1 `config` → one challenge.
- The old body check-in becomes a normal step with id `body`: "Body check-in", mandatory, photo required, number {Weight, kg, required}.
- Each day's `weight`/`bodyPhotoId` → `steps.body = { value, photoId, done: both present }`, re-keyed to `challengeId|date`.
- Attempts get `challengeId`. Photos untouched. Old stores dropped only after the new ones are written.

## UI — Apple dark
- **Type:** `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Helvetica Neue", Arial, sans-serif`. Inter (Google Fonts) is the fallback on non-Apple devices. Large titles 34px/700, tracking −0.02em. Body 17px. Secondary 15px.
- **Colours:** background #000, grouped surface #1c1c1e, raised #2c2c2e, hairline separator rgba(84,84,88,.6), text #f5f5f7, secondary #86868b, accent orange #ff9f0a, green #30d158, red #ff453a.
- **Layout language:** iOS inset-grouped lists. Rows 44–52px with the label left and the value/control right, hairline separators inset 16px, 10px radius groups, 16px side margins, section headers in small caps. No labels stacked above inputs, no loose text between sections.
- **Tab bar** (frosted, blur): Today · Calendar · Stats · Challenges.
- **Today:** large title = challenge name, with a horizontal pill switcher when there's more than one challenge. A compact header row with a D3 mini progress ring (day k/N), "Week 2 · 3/5" and a status pill. The steps form a grouped list. Tapping a step with fields expands it inline (photo thumbnail + Take photo, number input with unit, note). Required-field markers are subtle.
- **Calendar:** unchanged behaviour, restyled. "View full challenge" opens the overview.
- **Stats (D3):**
  - *Progress ring*: animated arc tween. The outer arc is day k/N, the inner arc is weeks passed / total weeks, and the centre shows the current streak in days. Tap an arc for a tooltip.
  - *Number trends*: one chart per number field, e.g. weight: a line with a gradient area and points. Touch/hover shows a crosshair with a value tooltip, pinch/drag zooms and pans the x-axis (d3.zoom), and a transition plays on load. Empty state when there's no data.
- **Challenges:** a grouped list (name, "Day k of N", mini ring) with **+ New challenge**. Tapping a challenge opens its detail: name, days, weekly target, steps (tap → step editor sheet), attempt history, and a red **Delete challenge** at the bottom with a confirmation that removes its attempts, days and photos. The Backup (export/import) section lives on the Challenges screen.
- **Step editor:** a bottom sheet with grouped rows: Name; Mandatory (switch); Photo (segmented: None / Optional / Required); Number (switch → Label, Unit, Required); Note (switch).
- **Buttons on phones (< 600px):** every action button fills the width available to it. A single action spans the full content width. Paired actions (e.g. Export / Import, Cancel / Save) sit in equal-width columns that together fill the row. Buttons are 50px tall with 12px radius and centred text, never shrink-wrapped to their label. Inside grouped rows, a trailing button (e.g. "Take photo") fills the space right of the label and thumbnail. Sheets end with a full-width primary button pinned above the safe area. Checked at 360 and 390px.
- **Motion:** 250ms ease-out screen transitions, sheet slide-up, D3 transitions on charts, and respect for prefers-reduced-motion.

## Backup
Export v2 contains all challenges. Import accepts v1 (converted with the migration) and v2, and validates everything before wiping (existing behaviour).

## Files
- New: `js/migrate.js`, `js/stats.js` (D3 charts), `vendor/d3.v7.min.js`, `tests/migrate.test.js`.
- Changed: `js/rules.js` (generic step completion, no body special case), `js/db.js` (v2 schema + migration), `js/backup.js`, `js/app.js`, `css/styles.css`, `index.html`, `sw.js` (cache v5 incl. vendor + font).

## Testing
- `node --test`: rules (generic completion, photo/number required, auto-tick), migration (v1 → v2 equivalence: same green days before and after), existing streak rules.
- Opus verification: seed real v1 data, then upgrade and confirm nothing is lost. Screenshots at 360/390px of every screen. D3 tooltip/zoom interactions. No overflow. Lighthouse-style offline check.

## Out of scope
Heat-map, step-completion bars, light theme, cloud sync, notifications.
