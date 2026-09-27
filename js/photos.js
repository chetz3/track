// Photo capture/storage helpers. Resizes images down to a max dimension
// before storing them as JPEG blobs in the `photos` IndexedDB store.

import { put, get, del } from './db.js';
import { exifDate, localDateFromMs } from './exif.js';

// First 128KiB is enough to cover a JPEG's Exif APP1 segment (it always sits
// right after the SOI marker) without reading the whole file into memory.
const EXIF_SNIFF_BYTES = 131072;

const MAX_DIMENSION = 1080;
const JPEG_QUALITY = 0.7;

function resizeImage(file, maxDim = MAX_DIMENSION, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) {
            resolve(blob);
          } else {
            const e = new Error('Failed to encode image');
            e.code = 'IMAGE_ENCODE_FAILED';
            reject(e);
          }
        },
        'image/jpeg',
        quality,
      );
    };
    // The browser couldn't decode this as an image at all — most commonly a
    // HEIC file on desktop Chrome/Firefox (no built-in decoder), or a
    // corrupt/truncated file.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const e = new Error('Unsupported image format');
      e.code = 'UNSUPPORTED_IMAGE';
      reject(e);
    };
    img.src = url;
  });
}

function makePhotoId() {
  return `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function savePhoto(file) {
  let blob;
  try {
    blob = await resizeImage(file);
  } catch (err) {
    // resizeImage fails for images the browser's <img>/canvas pipeline can't
    // handle (HEIC on desktop Chrome/Firefox, a corrupt file) even though the
    // file itself is a perfectly good photo — store it as-is rather than
    // losing the upload outright.
    const isImage = file.type === '' || file.type.startsWith('image/');
    if (isImage && file.size <= 15 * 1024 * 1024) {
      blob = file;
    } else {
      throw err;
    }
  }
  const id = makePhotoId();
  await put('photos', { id, blob, createdAt: Date.now() });
  return id;
}

export async function getPhotoBlob(id) {
  if (!id) return null;
  const record = await get('photos', id);
  return record ? record.blob : null;
}

export async function getPhotoUrl(id) {
  const blob = await getPhotoBlob(id);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function deletePhoto(id) {
  if (!id) return;
  await del('photos', id);
}

// The local calendar date a photo was actually taken on: Exif
// DateTimeOriginal/DateTime when present (camera photos, most library
// photos), falling back to the file's lastModified (screenshots, camera
// captures we mint ourselves, Exif-stripped files).
export async function photoDateOf(file) {
  const buffer = await file.slice(0, EXIF_SNIFF_BYTES).arrayBuffer();
  return exifDate(buffer) ?? localDateFromMs(file.lastModified);
}
