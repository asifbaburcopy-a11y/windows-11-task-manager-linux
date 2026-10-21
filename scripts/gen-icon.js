#!/usr/bin/env node
/* Generates a 512x512 PNG icon (blue rounded square + performance line) with no deps. */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;
const px = Buffer.alloc(S * S * 4); // RGBA

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255, ia = 1 - na;
  px[i] = Math.round(r * na + px[i] * ia);
  px[i + 1] = Math.round(g * na + px[i + 1] * ia);
  px[i + 2] = Math.round(b * na + px[i + 2] * ia);
  px[i + 3] = Math.max(px[i + 3], a);
}

const R = 96; // corner radius
// background: dark rounded square with subtle vertical gradient
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded-rect distance
    const dx = Math.max(R - x, x - (S - 1 - R), 0);
    const dy = Math.max(R - y, y - (S - 1 - R), 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > R + 1) continue;
    const edge = Math.min(1, Math.max(0, R - d)); // 1px antialias at edge
    if (edge <= 0) continue;
    const t = y / S;
    const r = Math.round(32 + t * 8), g = Math.round(32 + t * 8), b = Math.round(36 + t * 10);
    set(x, y, r, g, b, Math.round(255 * edge));
  }
}

// grid lines (like the performance graph)
for (let i = 1; i < 5; i++) {
  const y = Math.round(S * 0.18 + (S * 0.64) * i / 5);
  for (let x = 96; x < S - 96; x++) set(x, y, 255, 255, 255, 26);
}
for (let i = 1; i < 6; i++) {
  const x = Math.round(S * 0.14 + (S * 0.72) * i / 6);
  for (let y = 92; y < S - 92; y++) set(x, y, 255, 255, 255, 26);
}

// performance line: ascending zigzag
const pts = [[96, 330], [170, 268], [224, 300], [290, 196], [350, 240], [416, 148]];
function drawLine(x0, y0, x1, y1, w, r, g, b, a) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    for (let dy = -w; dy <= w; dy++) {
      for (let dx = -w; dx <= w; dx++) {
        if (dx * dx + dy * dy > w * w) continue;
        const aa = a * (1 - Math.hypot(dx, dy) / (w + 1));
        set(Math.round(cx + dx), Math.round(cy + dy), r, g, b, Math.round(aa));
      }
    }
  }
}
// fill under the line
for (let i = 0; i < pts.length - 1; i++) {
  const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
  const steps = Math.ceil(x1 - x0);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + (x1 - x0) * t), cy = y0 + (y1 - y0) * t;
    for (let y = cy; y < 416; y++) set(cx, y, 76, 194, 255, 26);
  }
}
for (let i = 0; i < pts.length - 1; i++) {
  drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 9, 76, 194, 255, 70);
  drawLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 5, 140, 216, 255, 255);
}
// dots at vertices
for (const [cx, cy] of pts) {
  for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
    if (x * x + y * y <= 49) set(cx + x, cy + y, 240, 250, 255, 255);
  }
}

// encode PNG
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'app', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
