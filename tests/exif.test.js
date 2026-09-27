import test from 'node:test';
import assert from 'node:assert/strict';
import { exifDate, localDateFromMs } from '../js/exif.js';

function jpegWithExif(tag, dateStr) {
  // TIFF (LE): header(8) + IFD0 at 8 with 1 entry.
  const ascii = new TextEncoder().encode(dateStr + '\0'); // 20 bytes
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + 2 + 12 + 4 + ascii.length);
  const v = new DataView(tiff.buffer);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  const exifIfd = 8 + 2 + 12 + 4;
  const strOff = exifIfd + 2 + 12 + 4;
  if (tag === 0x9003) {
    v.setUint16(8, 1, true); v.setUint16(10, 0x8769, true); v.setUint16(12, 4, true); v.setUint32(14, 1, true); v.setUint32(18, exifIfd, true);
    v.setUint16(exifIfd, 1, true); v.setUint16(exifIfd + 2, 0x9003, true); v.setUint16(exifIfd + 4, 2, true);
    v.setUint32(exifIfd + 6, ascii.length, true); v.setUint32(exifIfd + 10, strOff, true);
  } else {
    v.setUint16(8, 1, true); v.setUint16(10, 0x0132, true); v.setUint16(12, 2, true); v.setUint32(14, ascii.length, true); v.setUint32(18, strOff, true);
  }
  tiff.set(ascii, strOff);
  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(2 + 2 + app1Len + 2);
  const o = new DataView(out.buffer);
  o.setUint16(0, 0xFFD8); o.setUint16(2, 0xFFE1); o.setUint16(4, app1Len);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(tiff, 12);
  o.setUint16(12 + tiff.length, 0xFFD9);
  return out.buffer;
}

test('exifDate reads DateTimeOriginal', () => {
  assert.equal(exifDate(jpegWithExif(0x9003, '2026:09:25 08:14:03')), '2026-09-25');
});

test('exifDate falls back to IFD0 DateTime', () => {
  assert.equal(exifDate(jpegWithExif(0x0132, '2026:09:22 19:00:00')), '2026-09-22');
});

test('exifDate returns null for non-JPEG, truncated, or EXIF-less input', () => {
  assert.equal(exifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(exifDate(new Uint8Array([0xFF, 0xD8]).buffer), null);
  assert.equal(exifDate(jpegWithExif(0x9003, '2026:09:25 08:14:03').slice(0, 30)), null);
  assert.equal(exifDate(new ArrayBuffer(0)), null);
});

test('localDateFromMs uses local calendar date', () => {
  assert.equal(localDateFromMs(new Date(2026, 8, 25, 23, 59).getTime()), '2026-09-25');
});
