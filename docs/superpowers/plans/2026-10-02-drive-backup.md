# Google Drive backup (snapshot backup + restore)

This is the simple first step of 2026-09-27-drive-sync.md: whole-app snapshot backups, not per-challenge sync. It reuses the existing backup format, so a Drive backup is the same file as Challenges → Export.

## User setup (once)
- Enable the **Google Drive API** in the same Cloud project: https://console.cloud.google.com/apis/library/drive.googleapis.com
- The app already requests the `drive.file` scope at sign-in. With it, Habitly can only see files it created.

## Behaviour
- **Where:** a folder **"Habitly Backups"** in the user's My Drive, holding files `habitly-backup-YYYY-MM-DD-HHmm.json` (the `buildBackupJson()` output, photos included).
- **Back up now:** a button in Challenges → Google Drive. It shows "Last backup: <date time>", or the error.
- **Auto backup:**
  - when the app opens or comes to the foreground, if signed in with a valid token, **data changed since the last backup** and the last backup is **more than 24 h old**;
  - it's silent, shows a small status line, and never blocks the UI.
- **Retention:** keep the newest **10** backup files and delete older ones that Habitly created.
- **Restore:**
  - "Restore from Drive" lists the backups (date, size), newest first;
  - picking one shows a confirm ("Replaces all data on this device");
  - it then runs the existing `importBackup(text)`, which validates the backup before replacing anything.
- **Token expired / not signed in:**
  - the buttons show "Sign in with Google" (the existing `connect()` redirect);
  - auto backup simply skips.
- **Offline:** skip, with the message "You're offline."

## Code
- **`js/drive.js` (new):** fetch helpers that use `getAccessToken()`:
  - `findOrCreateFolder(name)`, which caches the folder id in localStorage `tracker:driveFolderId` and re-finds it if it gets a 404;
  - `uploadJson(name, text)`, a **resumable** upload, because backups with photos can exceed 5 MB;
  - `listBackups()`, `downloadText(id)` and `deleteFile(id)`;
  - friendly errors for 401 (sign in again), 403 with accessNotConfigured ("Enable the Google Drive API" plus the link), 403 storage quota, and network/offline.
- **`js/driveBackup.js` (new):**
  - `backupNow()`;
  - `maybeAutoBackup()`;
  - `listDriveBackups()` and `restoreFromDrive(id)`;
  - `getBackupStatus()`, which returns `{ lastAt, lastError, busy }` and is stored in localStorage `tracker:driveBackup`;
  - a dirty flag, set by subscribing to `store.onChange`, with a guard so restore/boot don't mark it dirty;
  - `onBackupStatus(fn)`.
- **Pure helpers, with tests:**
  - `backupFileName(date)`;
  - `pickOldBackups(files, keep)`;
  - `shouldAutoBackup({ connected, dirty, lastAt, now, online })`.
- **`js/ui/challenges.js`:** the Google Drive section gets:
  - the signed-in email;
  - Back up now, Restore from Drive and the last-backup line;
  - the restore picker sheet.
- **`js/app.js`:** call `maybeAutoBackup()` after boot and on `visibilitychange` → visible.
- **`sw.js`:** add the new files and bump the cache.
- Cross-origin Google API requests already bypass the service worker. Verify this and keep it.

## Not in this step
Per-challenge sync, sharing with friends, and photo files as separate Drive files.
