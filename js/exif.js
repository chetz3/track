// Pure Exif date extraction. No DOM, no I/O: takes an ArrayBuffer, returns a
// local YYYY-MM-DD string or null. Never throws (used to gate photo saves).

export function localDateFromMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function exifDate(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return null;
      const size = v.getUint16(off + 2);
      if (marker === 0xFFE1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
      off += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function readTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(t + o, le);
  const u32 = (o) => v.getUint32(t + o, le);
  const findTag = (ifd, tag) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
    return null;
  };
  const ascii = (e) => {
    const count = u32(e + 4);
    const o = count > 4 ? u32(e + 8) : e + 8;
    let s = '';
    for (let i = 0; i < count - 1; i++) s += String.fromCharCode(v.getUint8(t + o + i));
    return s;
  };
  const toDate = (s) => { const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const ifd0 = u32(4);
  const exifPtr = findTag(ifd0, 0x8769);
  if (exifPtr !== null) {
    const e = findTag(u32(exifPtr + 8), 0x9003);
    if (e !== null) { const d = toDate(ascii(e)); if (d) return d; }
  }
  const dt = findTag(ifd0, 0x0132);
  return dt !== null ? toDate(ascii(dt)) : null;
}
