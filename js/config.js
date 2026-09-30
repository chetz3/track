// Google Cloud project identifiers. The OAuth Client ID is PUBLIC-SAFE: it's
// meant to ship in client code and is locked to our origins
// (https://chetz3.github.io, http://localhost:8090) in Google Cloud Console.
// Never put the OAuth client secret or any API key in this repo — this app's
// browser-only token flow doesn't use them, and each user's Gemini key lives
// only in their own device's localStorage.
export const GOOGLE_CLIENT_ID = '565913674539-0cbvo1osuoqiouqsc3aeabqp7f81cram.apps.googleusercontent.com';
