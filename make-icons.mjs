// アイコン（PNG）を作る道具: node travel/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 紙飛行機（0〜1の座標）
const wing = [[0.20, 0.50], [0.80, 0.24], [0.44, 0.60]];
const body = [[0.44, 0.60], [0.80, 0.24], [0.58, 0.78]];
const fold = [[0.44, 0.60], [0.80, 0.24], [0.48, 0.74]];
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      const t = (u + v) / 2;
      let cr = 10 + (48 - 10) * t, cg = 132 + (205 - 132) * t, cb = 255 + (190 - 255) * t;
      if (inPoly(u, v, fold)) { cr = 205; cg = 228; cb = 245; }
      else if (inPoly(u, v, wing) || inPoly(u, v, body)) { cr = 255; cg = 255; cb = 255; }
      // 下の点線（旅の道のり）
      const dx = u - 0.30, dy = v - 0.80;
      if (Math.hypot(dx, dy) < 0.035 || Math.hypot(u - 0.18, v - 0.70) < 0.03) { cr = 255; cg = 255; cb = 255; }
      r += cr; g += cg; b += cb;
    }
    const i = (y * size + x) * 4;
    px[i] = r / S / S; px[i + 1] = g / S / S; px[i + 2] = b / S / S; px[i + 3] = 255;
  }
  return png(size, px);
}
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(DIR, `icon-${s}.png`), draw(s));
console.log('icons written');
