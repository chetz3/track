// Google sign-in only (Phase 1a of Google Drive sync). Full-page redirect
// OAuth 2.0 implicit flow (no popup, no GIS library) so it also works in an
// iOS home-screen PWA; the access token lives in memory only, never persisted.

import { GOOGLE_CLIENT_ID } from './config.js';

const ACCOUNT_KEY = 'tracker:google';
// `drive.file` is requested now (not just `email`) so the one consent
// screen the user sees covers Drive access too — nothing new to approve
// when Drive sync itself lands.
const SCOPES = 'email https://www.googleapis.com/auth/drive.file';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_KEY = 'tracker:oauthState';

let accessToken = null;
let tokenExpiresAt = 0;
let busy = false;
let lastError = null;
const listeners = new Set();

function readAccount() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNT_KEY));
    return raw && raw.connected === true && typeof raw.email === 'string' ? raw : null;
  } catch (_) {
    return null;
  }
}

function writeAccount(acct) {
  try {
    if (acct) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acct));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }
}

let account = readAccount();

function notify() {
  for (const fn of listeners) fn();
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAuthState() {
  return { connected: !!account, email: account?.email ?? null, busy, error: lastError };
}

export function clearAuthError() {
  lastError = null;
  notify();
}

// Hook for a later Drive-sync phase; unused for now.
export function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;
  return null;
}

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function connect() {
  const state = randomState();
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ state, returnHash: location.hash || '#/challenges' }));
  } catch (_) {
    // ignore (private mode, quota, etc.)
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state,
    prompt: 'select_account',
  });
  if (account?.email) params.set('login_hint', account.email);

  location.assign(AUTH_ENDPOINT + '?' + params.toString());
}

const AUTO_KEY = 'tracker:autoAuthAt';
const AUTO_COOLDOWN_MS = 60_000;
let returnedFromGoogle = false;

// Sends a not-yet-connected user straight to Google on load. Skipped right
// after a round trip (e.g. they cancelled), offline, and within a cooldown so
// a failing flow can never become a redirect loop. Returns true if redirecting.
export function autoConnectIfNeeded() {
  if (account || returnedFromGoogle || !navigator.onLine) return false;
  // Only origins registered in Google Cloud Console; elsewhere (e.g. a LAN IP
  // for phone testing) Google would reject the redirect with redirect_uri_mismatch.
  if (!['http://localhost:8090', 'https://chetz3.github.io'].includes(location.origin)) return false;
  try {
    const last = Number(sessionStorage.getItem(AUTO_KEY));
    if (last && Date.now() - last < AUTO_COOLDOWN_MS) return false;
    sessionStorage.setItem(AUTO_KEY, String(Date.now()));
  } catch (_) {
    return false; // no sessionStorage → can't guard against loops, so don't auto-redirect
  }
  connect();
  return true;
}

// Must be called synchronously, before the router's first render, so the
// access token never lingers in the URL and the router sees a normal route.
export function consumeAuthRedirect() {
  const hash = location.hash;
  if (!hash.includes('access_token=') && !hash.includes('error=')) return;
  returnedFromGoogle = true;

  const params = new URLSearchParams(hash.slice(1));

  let saved = null;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch (_) {
    saved = null;
  }

  history.replaceState(null, '', location.pathname + location.search + (saved?.returnHash || '#/challenges'));

  const state = params.get('state');
  if (!state || !saved || state !== saved.state) {
    lastError = 'Sign-in could not be verified. Please try again.';
    notify();
    return;
  }

  const error = params.get('error');
  if (error) {
    lastError = error === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed: ' + error;
    notify();
    return;
  }

  accessToken = params.get('access_token');
  tokenExpiresAt = Date.now() + Number(params.get('expires_in')) * 1000;

  const scope = params.get('scope') || '';
  if (!scope.includes('userinfo.email') && !scope.includes('email')) {
    lastError = 'Email permission is needed to show which account is connected.';
  } else {
    lastError = null;
  }

  busy = true;
  notify();

  return (async () => {
    try {
      const res = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + accessToken } });
      if (!res.ok) throw new Error('Could not read Google account (' + res.status + ')');
      const { email } = await res.json();
      account = { connected: true, email };
      writeAccount(account);
      lastError = null;
    } catch (err) {
      accessToken = null;
      tokenExpiresAt = 0;
      lastError = err.message || 'Google sign-in failed.';
    } finally {
      busy = false;
      notify();
    }
  })();
}

export function disconnect() {
  if (accessToken) {
    // Fire-and-forget; after a reload there's no in-memory token to revoke,
    // so a disconnect then only clears local state, which is acceptable.
    fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(accessToken), {
      method: 'POST',
      mode: 'no-cors',
    }).catch(() => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  account = null;
  writeAccount(null);
  notify();
}
