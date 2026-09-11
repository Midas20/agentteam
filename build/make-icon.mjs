#!/usr/bin/env node
// make-icon.mjs - writes build/icon.png and build/icon.ico.
//
// electron-builder normally converts the PNG to an ICO itself, but its icon tool is a
// WebAssembly build that cannot allocate on every machine. Producing a real multi-size
// ICO here removes that step entirely. The glyph is drawn at each size rather than
// resampled, so the small ones stay crisp.
//
//   node build/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const BG = [0x14, 0x1a, 0x22], ACC = [0x4d, 0x8f, 0xc9], HI = [0xe8, 0xee, 0xf4];

function draw(S) {
  const px = Buffer.alloc(S * S * 4);
  const k = S / 512;                                  // every measurement is in 512-space
  const set = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    for (let n = 0; n < 3; n++) px[i + n] = Math.round(px[i + n] * (1 - a) + c[n] * a);
    px[i + 3] = 255;
  };
  const cover = (d, r) => Math.max(0, Math.min(1, r + 0.5 - d));

  const R = 96 * k, m = 26 * k;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.max(m + R - x, 0, x - (S - m - R)), dy = Math.max(m + R - y, 0, y - (S - m - R));
    set(x, y, BG, cover(Math.hypot(dx, dy), R));
  }
  const cy = S / 2, nodes = [148 * k, 256 * k, 364 * k], rad = 46 * k, bar = 11 * k, gap = 4 * k;
  for (let n = 0; n < 2; n++)
    for (let y = Math.floor(cy - bar); y <= Math.ceil(cy + bar); y++)
      for (let x = Math.floor(nodes[n] + rad + gap); x <= Math.ceil(nodes[n + 1] - rad - gap); x++)
        set(x, y, ACC, cover(Math.abs(y - cy), bar));
  nodes.forEach((nx, i) => {
    const ring = Math.max(2, 15 * k);
    for (let y = Math.floor(cy - rad - 2); y <= Math.ceil(cy + rad + 2); y++)
      for (let x = Math.floor(nx - rad - 2); x <= Math.ceil(nx + rad + 2); x++) {
        const d = Math.hypot(x - nx, y - cy);
        if (i === 2) set(x, y, HI, cover(d, rad));
        else { const a = Math.min(cover(d, rad), 1 - cover(d, rad - ring)); if (a > 0) set(x, y, ACC, a); }
      }
  });
  return px;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff; for (const b of body) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(S) {
  const px = draw(S);
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ICO: a 6-byte header, one 16-byte directory entry per size, then the PNG blobs.
// A size of 0 in the directory means 256. PNG-in-ICO is valid from Vista onwards.
function ico(sizes) {
  const imgs = sizes.map(s => ({ s, buf: png(s) }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  const dir = Buffer.alloc(16 * imgs.length);
  let offset = head.length + dir.length;
  imgs.forEach(({ s, buf }, i) => {
    const o = i * 16;
    dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...imgs.map(i => i.buf)]);
}

writeFileSync(join(OUT, 'icon.png'), png(512));
const sizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(join(OUT, 'icon.ico'), ico(sizes));
console.log(`icon.png 512x512, icon.ico with ${sizes.join('/')}`);
