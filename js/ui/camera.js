// In-app camera capture, behind an explicit permission explainer. A bottom
// sheet (see sheet.js) walks through three possible views:
//   explainer -> live preview -> (capture | error)
// `onClose` (sheet.js) guarantees the getUserMedia stream is stopped on
// every close path: Cancel, Escape, backdrop tap, or being superseded by
// another sheet.

import { openSheet } from './sheet.js';
import { esc } from './dom.js';

const CAMERA_ICON = `<svg class="camera-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" stroke-linejoin="round" stroke-linecap="round" />
  <circle cx="12" cy="14" r="3.5" />
</svg>`;

const BLOCKED_MESSAGE =
  'Camera access is blocked. On iPhone: Settings → Safari → Camera → Allow. On Android: tap the lock icon in the address bar → Permissions → Camera.';
const NO_CAMERA_MESSAGE = 'No camera available on this device.';

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
    <div class="btn-pair">
      <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
      <button type="button" class="btn btn-secondary" data-role="switch-camera">Switch camera</button>
    </div>
    <button type="button" class="btn btn-primary" data-role="capture">Capture</button>`;
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

  const stopStream = () => {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  };

  const sheetClose = openSheet({
    title: 'Take photo',
    bodyHtml: '<div class="camera-body" data-role="camera-body"></div>',
    onMount: async (sheetEl) => {
      const body = sheetEl.querySelector('[data-role="camera-body"]');
      if (await cameraPermissionGranted()) startCamera(body);
      else showExplainer(body);
    },
    onClose: stopStream,
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
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const err = new Error('mediaDevices unavailable');
        err.name = 'NotFoundError';
        throw err;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 } },
        audio: false,
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) showError(body, BLOCKED_MESSAGE);
      else showError(body, NO_CAMERA_MESSAGE);
      return;
    }
    video.srcObject = stream;

    body.querySelector('[data-role="cancel"]').addEventListener('click', () => sheetClose());
    body.querySelector('[data-role="switch-camera"]').addEventListener('click', () => {
      stopStream();
      facing = facing === 'environment' ? 'user' : 'environment';
      startCamera(body);
    });
    body.querySelector('[data-role="capture"]').addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => {
        if (b) onCapture(new File([b], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        sheetClose();
      }, 'image/jpeg', 0.9);
    });
  }
}
