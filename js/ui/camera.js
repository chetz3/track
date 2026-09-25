// In-app camera capture, behind an explicit permission explainer. A bottom
// sheet (see sheet.js) walks through three possible views:
//   explainer -> live preview -> (capture | error)
// `onClose` (sheet.js) guarantees the getUserMedia stream is stopped on
// every close path: Cancel, Escape, backdrop tap, or being superseded by
// another sheet. Because getUserMedia (and the permission query before it)
// can take an arbitrarily long time to settle, `closed` tracks whether the
// sheet went away *while* one of those was pending — the promise still
// resolves later, and if it handed us a live stream at that point we stop it
// immediately instead of leaving the camera light on.

import { openSheet } from './sheet.js';
import { esc } from './dom.js';

const CAMERA_ICON = `<svg class="camera-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" stroke-linejoin="round" stroke-linecap="round" />
  <circle cx="12" cy="14" r="3.5" />
</svg>`;

const BLOCKED_MESSAGE =
  'Camera access is blocked. On iPhone: Settings → Safari → Camera → Allow. On Android: tap the lock icon in the address bar → Permissions → Camera.';
const NO_CAMERA_MESSAGE = 'No camera available on this device.';
const IN_USE_MESSAGE = 'The camera is being used by another app. Close it and try again.';
const GENERIC_MESSAGE = "Couldn't start the camera. Try again, or choose from your library.";
const CAPTURE_FAILED_MESSAGE = "Couldn't capture the photo. Try again.";

function messageForError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return BLOCKED_MESSAGE;
  if (name === 'NotFoundError') return NO_CAMERA_MESSAGE;
  if (name === 'NotReadableError') return IN_USE_MESSAGE;
  return GENERIC_MESSAGE;
}

function explainerHtml() {
  return `<div class="camera-explainer">
      ${CAMERA_ICON}
      <p class="camera-message">Allow camera to take today's photo</p>
    </div>
    <button type="button" class="btn btn-primary" data-role="allow-camera">Allow camera</button>
    <button type="button" class="btn btn-secondary" data-role="use-library">Choose from library</button>`;
}

function errorHtml(message) {
  return `<div class="camera-explainer">
      <p class="camera-message error">${esc(message)}</p>
    </div>
    <button type="button" class="btn btn-secondary" data-role="use-library">Choose from library</button>`;
}

function liveHtml() {
  return `<video class="camera-video" playsinline muted autoplay></video>
    <p class="camera-message error camera-capture-error" hidden>${esc(CAPTURE_FAILED_MESSAGE)}</p>
    <div class="btn-pair">
      <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
      <button type="button" class="btn btn-secondary" data-role="switch-camera">Switch camera</button>
    </div>
    <button type="button" class="btn btn-primary" data-role="capture" disabled>Capture</button>`;
}

async function cameraPermissionGranted() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    return status?.state === 'granted';
  } catch {
    return false; // unsupported query -> treat as not-yet-granted, show the explainer
  }
}

export function openCamera({ onCapture, onUseLibrary }) {
  let facing = 'environment';
  let stream = null;
  let closed = false;
  let capturing = false;

  const stopStream = () => {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  };

  const sheetClose = openSheet({
    title: 'Take photo',
    bodyHtml: '<div class="camera-body" data-role="camera-body"></div>',
    onMount: async (sheetEl) => {
      const body = sheetEl.querySelector('[data-role="camera-body"]');
      const granted = await cameraPermissionGranted();
      // The sheet may already be gone by the time the permission query
      // settles (Escape/backdrop tap while it was pending) — don't go on to
      // request a camera stream nobody asked for anymore.
      if (closed) return;
      if (granted) startCamera(body);
      else showExplainer(body);
    },
    onClose: () => { closed = true; stopStream(); },
  });

  function wireCommon(body) {
    body.querySelector('[data-role="use-library"]')?.addEventListener('click', () => {
      sheetClose();
      onUseLibrary?.();
    });
    body.querySelector('[data-role="allow-camera"]')?.addEventListener('click', () => startCamera(body));
  }

  function showExplainer(body) {
    body.innerHTML = explainerHtml();
    wireCommon(body);
  }

  function showError(body, message) {
    stopStream();
    body.innerHTML = errorHtml(message);
    wireCommon(body);
  }

  async function startCamera(body) {
    body.innerHTML = liveHtml();
    const video = body.querySelector('.camera-video');
    const captureBtn = body.querySelector('[data-role="capture"]');
    const captureError = body.querySelector('.camera-capture-error');

    // Wired immediately — before getUserMedia is even called — so Cancel
    // works the whole time the permission prompt/device warm-up is pending,
    // instead of forcing the user to Escape or tap the backdrop to get out.
    body.querySelector('[data-role="cancel"]').addEventListener('click', () => sheetClose());
    body.querySelector('[data-role="switch-camera"]').addEventListener('click', () => {
      stopStream();
      facing = facing === 'environment' ? 'user' : 'environment';
      startCamera(body);
    });

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const err = new Error('mediaDevices unavailable');
        err.name = 'NotFoundError';
        throw err;
      }
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 } },
        audio: false,
      });
      if (closed) { newStream.getTracks().forEach((t) => t.stop()); return; }
      stream = newStream;
    } catch (err) {
      if (closed) return; // sheet's gone; nothing left to show an error in
      showError(body, messageForError(err));
      return;
    }
    video.srcObject = stream;

    // Capture stays disabled until there's an actual frame to draw — firing
    // early gives a 0x0 canvas and a null blob (see the toBlob guard below).
    video.addEventListener('loadedmetadata', () => { captureBtn.disabled = false; }, { once: true });

    captureBtn.addEventListener('click', () => {
      if (capturing || captureBtn.disabled) return;
      if (!video.videoWidth || !video.videoHeight) return; // belt and braces alongside the disabled state
      capturing = true;
      captureError.hidden = true;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => {
        capturing = false;
        if (!b) { captureError.hidden = false; return; } // keep the sheet open so the user can retry
        onCapture(new File([b], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        sheetClose();
      }, 'image/jpeg', 0.9);
    });
  }
}
