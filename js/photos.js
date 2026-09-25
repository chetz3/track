// Photo capture/storage helpers. Resizes images down to a max dimension
// before storing them as JPEG blobs in the `photos` IndexedDB store.

import { put, get, del } from './db.js';

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
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode image'));
        },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function makePhotoId() {
  return `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function savePhoto(file) {
  const blob = await resizeImage(file);
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
