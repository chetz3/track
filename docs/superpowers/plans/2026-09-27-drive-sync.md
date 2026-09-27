# Google Drive Sync & Shared Challenges: Implementation Plan

This plan is executed on Sonnet, one subagent per phase, with one commit per phase on branch `drive`, which is created from `v2`.

- Checks: only `node --check` and `node --test`. There is no browser testing; the user tests.
- Stack: stays plain JS with no build step. Google APIs are called from the browser with `fetch`. There is no server.

## Phase 0: One-time setup (user, about 10 minutes)

Do this in Google Cloud Console:
1. Create a project.
2. Enable the **Google Drive API** and the **Google Picker API**.
3. Set up the OAuth consent screen:
   - choose External, in Testing mode;
   - add yourself and each friend as **test users**. Anyone who is not listed can't sign in.
4. Create an OAuth Client ID (Web application) with these Authorized JS origins:
   - `https://chetz3.github.io`
   - `http://localhost:8090`
5. Create an API key and restrict it to HTTP referrers `https://chetz3.github.io/*` and `http://localhost:8090/*`.
6. Paste the Client ID and the API key into `js/config.js`. Both are public values and safe to commit.

> ⚠️ Google does not allow sign-in from a LAN http address such as 192.168.x.x. For Drive features:
> - on the phone, test on the GitHub Pages site (https);
> - on this Mac, `localhost:8090` works.

## Phase 1: Drive connection + folders

**New file `js/drive.js`:**
- **Auth:** Google Identity Services token client (`https://accounts.google.com/gsi/client`), scope `drive.file`.
  - With `drive.file` the app can only see files it created itself, or files the user picked with the Picker.
  - Keep the access token in memory. When it expires after about one hour, request a new one with `prompt: ''`; if that fails, show "Reconnect".
- **REST helpers:** `findOrCreateFolder(name, parentId)`, `uploadFile({ name, parentId, blob, mime, fileId? })` (multipart; creates or updates), `downloadFile(id)`, `listChildren(folderId)`, `shareWith(fileId, email)`, `moveFile(fileId, from, to)`.

**Folder layout:** `Tracker/Personal/<challenge-name>-<id>/` and `Tracker/Shared/<challenge-name>-<id>/`.

**Sync state (`js/syncState.js`):** kept in localStorage under key `tracker.drive`:
- `{ connected, email, folders:{root,personal,shared}, challenges:{ [id]: { folderId, dataFileId, photoFiles:{photoId:driveId}, dirty, lastSyncedAt } } }`

**Challenges tab:** add a "Google Drive" section with Connect / Disconnect and the signed-in email.

**Other changes:**
- Add `https://accounts.google.com/gsi/client` to `index.html`.
- `sw.js` already lets cross-origin requests go straight to the network. Bump the cache to v8.

## Phase 2: Upload (sync to Drive)

For each challenge, `syncChallenge(id)`:
1. Build `data.json` with `{ challenge, attempts, days }`, reusing the shape from `backup.js`.
2. Gzip it with `CompressionStream('gzip')` and upload it as `data.json.gz`. If the browser has no `CompressionStream`, upload plain `data.json`.
3. Upload every photo that isn't in `photoFiles` yet as `photos/<photoId>.jpg`, then record its Drive file ID.

`syncAll()` loops over the challenges that are marked dirty.

**Dirty tracking:** `store.onChange` marks the changed challenge `dirty`. Add a small hook in `store.js` so it knows which challenge changed.

## Phase 3: Sync prompts (requirements 5 and 6)

- **Connected but not synced:** after any saved change on a *personal* challenge, show a non-blocking bottom banner saying "Changes not in Drive — **Sync now**". It hides once the sync finishes.
- **Never connected:** after the first saved change, a sheet asks "Back up to Google Drive?" with Connect / Not now. It asks again at most once a day.
- ***Shared* challenge that is dirty:** the Today and Calendar screens for it show a blocking sheet saying "Sync required to keep competing — **Sync now**", with no dismiss. It closes when the sync succeeds, or if the user goes offline, in which case it shows "Offline — will ask again".

## Phase 4: Photo compression (requirement 7)

In `photos.js`, change resizing to a maximum of 1280px on the long edge:
- try WebP at quality 0.8;
- if `blob.type` isn't WebP (Safari), fall back to JPEG at quality 0.75.

That gives about 100–180 KB per photo with no visible loss. Existing photos are left untouched.

## Phase 5: Restore on another device ("use anywhere")

- After connecting, if the device has no data locally, or if the user taps "Restore from Drive", list `Personal/` and `Shared/`.
- Download each `data.json(.gz)`, then the photos it references. Write them with `db.replaceAll`, per challenge, using the same `validateV2` checks.
- **Conflict rule:** whichever side changed last wins, per challenge (Drive `modifiedTime` against local `lastSyncedAt`). Local unsynced changes win on the device that made them.

## Phase 6: Share a challenge + friends view

**Share (challenge menu):** "Share challenge" asks for friends' emails, then:
1. moves the challenge folder from `Personal/` to `Shared/`;
2. writes `summary.json` (name, totalDays, currentDay, green dates, week results, updatedAt — no photos);
3. calls `shareWith` for each email as a reader.

`summary.json` is rewritten on every sync of a shared challenge.

**Add a friend:** "Add friend's challenge" opens the Google Picker filtered to files shared with me and named `summary.json`.
- Picking it grants `drive.file` access to that one file.
- Store `{ fileId, ownerName }` in `syncState.friends`.

**Compete view:** on the Calendar tab of a shared challenge, show a row per friend with their name, Day X/N, green-week count and a mini strip of green days. It refreshes on open.

## Delivery order

- **Batch A (data to Drive):** Phases 1–4.
- **Batch B:** Phase 5.
- **Batch C (sharing):** Phase 6.

After each batch, the dev server stays up and the user tests: http://localhost:8090 on this Mac, GitHub Pages on the phone.
