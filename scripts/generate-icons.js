// SUPERSEDED (Sept 21, 2026): public/icons now ships the InkHearth badge art
// (derived from docs/inkhearth-logo.jpg — cropped + downscaled, source kept in
// the private tree). Running this script would overwrite the badge with the
// old spine motif; kept only as a reference for hand-rolled PNG generation.
//
// Regenerates the PWA icons (public/icons/icon-*.png): a dark rounded square
// with three colored book spines (S/A/B tier colors). Pure Node — an RGBA
// buffer, zlib, and hand-rolled PNG chunks, no image dependency.
//   node scripts/generate-icons.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [192, 512];

let table;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRounded = (x, y, size, radius, px, py) => {
  if (px < x || px >= x + size || py < y || py >= y + size) return false;
  const cx = Math.max(x + radius, Math.min(px, x + size - radius));
  const cy = Math.max(y + radius, Math.min(py, y + size - radius));
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
};

for (const size of SIZES) {
  const pad = Math.round(size * 0.07);
  const radius = Math.round(size * 0.2);
  const bg = [16, 19, 26], panel = [31, 37, 50], line = [42, 49, 66];
  const spines = [
    { c: [230, 184, 76], h: 0.4 },   // S
    { c: [127, 176, 105], h: 0.48 }, // A
    { c: [91, 155, 213], h: 0.34 },  // B
  ];
  const spineW = Math.round(size * 0.11);
  const gap = Math.round(size * 0.045);
  const baseline = Math.round(size * 0.7);
  const startX = Math.round((size - (spines.length * spineW + (spines.length - 1) * gap)) / 2);

  const data = png(size, (x, y) => {
    if (!inRounded(0, 0, size, radius, x, y)) return [0, 0, 0, 0];
    if (!inRounded(pad, pad, size - 2 * pad, Math.round(radius * 0.84), x, y)) return [...line, 255];
    let sx = startX;
    for (const sp of spines) {
      const top = baseline - Math.round(size * sp.h);
      if (x >= sx && x < sx + spineW && y >= top && y < baseline) return [...sp.c, 255];
      sx += spineW + gap;
    }
    return [...panel, 255];
  });

  mkdirSync('public/icons', { recursive: true });
  writeFileSync(`public/icons/icon-${size}.png`, data);
  console.log(`wrote public/icons/icon-${size}.png (${(data.length / 1024).toFixed(1)} KB)`);
}
