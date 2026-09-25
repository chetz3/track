# N-Day Challenge Tracker — Design & Implementation Plan

## Context
User wants a simple, mobile-first website to run a personal N-day challenge (e.g. 100 days): daily body photo + weight, user-defined daily steps (some mandatory, some requiring a photo), green days/weeks, and a streak that resets to Day 1 when a week fails. Must be self-sufficient: no server, no database, data stays on the device. Repo: `/Users/chetz/dev/track` (empty, remote `git@github.com:chetz3/track.git`, branch `main`).

Workflow requested: plan by Opus 5.5 (this doc), implementation by Sonnet (subagent `model: sonnet`), verification by Opus 5.5.

## Decisions (confirmed with user)
- **Devices:** iPhone + Android → browser storage + export/import backup file (a website cannot create a real folder, esp. on iOS).
- **Reset rule:** a failed *week* resets to Day 1. Individual missed days only turn red.
- **Editing window:** today and yesterday are editable; older days are locked.
- **Stack:** plain HTML/CSS/JS PWA, no framework, no build step, no dependencies. IndexedDB for data + photo blobs. Hosted on GitHub Pages.

## Rules
- **Setup (first run, editable later in Settings):** challenge name, N days, start date (default today), X = green days needed per week (1–7), list of steps. Each step: name, `mandatory` (bool), `requiresPhoto` (bool), `allowsNote` (bool — the "facts" field).
- **Built-in step "Body check-in":** always mandatory, requires photo + weight (kg).
- **Green day:** every mandatory step is complete (photo present if `requiresPhoto`; weight present for body check-in). Optional steps never affect colour.
- **Day status:** `green` | `pending` (today/yesterday, not yet green) | `red` (locked, not green) | `future`.
- **Step changes:** each day entry snapshots the list of mandatory step IDs the first time it is opened/saved; editing steps affects today onward, never past days.
- **Weeks:** counted from the current attempt's start date (Days 1–7, 8–14, …). A week is evaluated once its last day is locked. Green week = green days ≥ X. Final partial week (N not multiple of 7) needs ≥ min(X, days in that week).
- **Reset:** when a week finalises red → current attempt ends; a new attempt starts on the day after the failed week ended (so already-logged later days count toward the new Day 1, 2…). Attempts history kept (start, end, reason).
- **Completion:** Day N reached with all weeks green → "Challenge complete" screen.

## Data model (IndexedDB `tracker`, v1)
- `config` (single record): `{ name, totalDays, weeklyTarget, steps:[{id,name,mandatory,requiresPhoto,allowsNote}] }`
- `attempts`: `{ id, startDate, endDate?, status:'active'|'reset'|'complete' }`
- `days` keyed by `YYYY-MM-DD` (local date): `{ date, mandatoryStepIds:[], weight?, bodyPhotoId?, steps:{ [stepId]: { done, photoId?, note? } } }`
- `photos`: `{ id, blob, createdAt }`
Dates are always local `YYYY-MM-DD` strings (avoid UTC off-by-one).

## Files to create (in `/Users/chetz/dev/track`)
- `index.html` — single page; screens: Setup, Today, Calendar, Challenge overview, Day detail, Settings.
- `css/styles.css` — mobile-first, large tap targets, green/red/grey status colours, safe-area insets.
- `js/rules.js` — **pure functions only** (no DOM/DB): `isDayGreen`, `dayStatus`, `weekStatus`, `evaluateAttempt` (returns current day number, week results, reset/complete decision), `isEditable(date, today)`.
- `js/db.js` — thin promise wrapper over IndexedDB (get/put/delete/getAll per store).
- `js/photos.js` — capture via `<input type="file" accept="image/*" capture="environment">`, resize with canvas to max 1080px, JPEG q≈0.7 (~200KB).
- `js/backup.js` — export all stores to one JSON (photos base64) → `navigator.share` with file on mobile, fallback download; import replaces all data after confirm.
- `js/app.js` — hash router, screen rendering, wires rules + db; on load runs `evaluateAttempt` and applies resets.
- `manifest.webmanifest`, `sw.js` (cache app shell for offline), `icons/` (192/512 PNG).
- `tests/rules.test.js` — Node built-in test runner (`node --test`), no npm deps.
- `docs/superpowers/specs/2026-09-25-tracker-design.md` — copy of this design (committed).

## Screens
- **Today:** "Day k of N", streak/week progress (e.g. "Week 3: 4/5 green"), body check-in card (photo + weight), step checklist with photo/note inputs; mandatory marked; day goes green live.
- **Calendar:** month grid coloured by day status; tap header/zoom → **Challenge overview**: all N days as a compact grid, one row per week with week badge (green/red/in-progress). Tap any day → Day detail (read-only if locked).
- **Settings:** edit challenge config/steps, export backup, import backup, attempt history, "persist storage" status.
- On first load call `navigator.storage.persist()`; show a tip to "Add to Home Screen" (iOS may evict data for non-installed sites) and a weekly "Export backup" reminder.

## Implementation steps (Sonnet)
1. Commit the spec to `docs/superpowers/specs/`.
2. TDD `js/rules.js` with `tests/rules.test.js`: green day, optional steps ignored, photo-required enforcement, editable window (today/yesterday only), week pass/fail at threshold, partial final week, reset start date = day after failed week, completion at Day N, step-change snapshot respected.
3. `db.js`, `photos.js`, `backup.js`.
4. `app.js` + `index.html` + `styles.css` screens.
5. PWA: manifest, service worker, icons.
6. Commit to `main`, push, enable GitHub Pages (after user confirms push).

## Verification (Opus)
- `node --test tests/` passes.
- Serve locally (`python3 -m http.server 8080` in repo) and walk through in a mobile-sized browser (claude-in-chrome): setup → log today (body photo + weight + mandatory steps) → day turns green → calendar + overview colours correct → export → clear data → import restores everything including photos.
- Simulate time by seeding IndexedDB with past days: a week below X resets to Day 1 on the correct date; older-than-yesterday days are read-only.
- After Pages deploy, test on real iPhone and Android: install to home screen, camera capture, offline reload.

## Out of scope for v1 (later)
Weight chart, before/after photo comparison, notifications/reminders, multiple concurrent challenges, cloud sync.
