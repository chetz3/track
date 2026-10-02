# Step reminders (on-device notifications)

Scope is exactly what the user asked for: per-step reminder times, sound and vibrate options, and a permission prompt. Existing challenges get it too. Decision: **no server**. Reminders fire while the app is open or still alive in the background, and on reopen the latest missed reminder for each step fires once.

## Data (additive)

`step.reminders = { times: ['09:00', '13:00', …], sound: true, vibrate: true }`

- The field is optional; a missing field means no reminders.
- `times` are sorted, unique and in HH:MM format, with at most 12 per step.
- The backup validator accepts the field as optional, with a loose shape check.

## Step editor (`js/ui/stepEditor.js`)

**A "Reminders" group** appears in **both** the full editor and the goals-only editor, so existing challenges get it:
- one row per time: `<input type="time" data-role="reminder-time" data-index=i>` with a 44px × remove button;
- an "Add reminder" row, which adds the next full hour after the last time, or 09:00;
- **Sound** and **Vibrate** switches. The footer says: "Vibration works on Android. On iPhone, add Habitly to the Home Screen to get notifications."

**Permission:** the **"Add reminder" tap** calls `Notification.requestPermission()`, so the request comes from a user gesture.
- If permission is `denied`, a footer shows: "Notifications are blocked. Allow them in your browser/phone settings."
- If `Notification` doesn't exist, it shows: "This browser can't show notifications here (on iPhone, open Habitly from the Home Screen)."
- **Times are still saved either way.**

**Saving:**
- the full editor includes `reminders` in the new step;
- the goals-only editor saves `{ ...step, goal, macros, reminders }`;
- if there are no times, `reminders` is removed.

## Scheduler

**`js/reminders.js` (pure, tested):**
- `dueReminders({ challenges, daysByChallenge, now, fired })` returns `[{ challengeId, stepId, stepName, challengeName, time, sound, vibrate }]`.
- It includes only challenges with an active attempt where today is a challenge day, and only reminder times ≤ now that aren't in `fired`.
- It **skips a step that is already complete today** (`isStepComplete` with today's target), for example when the water goal is met.
- If several times are due for one step, it returns only the latest. The caller marks all of them as fired.
- `firedKey(date, challengeId, stepId, time)`.

**`js/reminderRunner.js` (side effects):**
- It checks every 30 s and on `visibilitychange` → visible.
- It keeps the fired log in localStorage `tracker:remindersFired`, as `{ date, keys[] }`, and resets it on a new day.
- It fires with `registration.showNotification(title, { body, tag, icon: './icons/icon-192.png', silent: !sound, vibrate: vibrate ? [200, 100, 200] : [], data: { url: './#/today' } })`. The title is the step name; the body reads "Time for Water · 1.5 / 4 L" when there's a target, otherwise the challenge name.
- It falls back to `new Notification` if there's no service-worker registration.
- It does nothing unless `Notification.permission === 'granted'`.
- `app.js` starts it after boot.

**`sw.js`:** a `notificationclick` handler focuses an open client or opens `data.url`. Bump the cache and add the new files to SHELL_FILES.

## Not doing
Push server, snooze, per-day schedules, or custom sound files (the web can't set them).
