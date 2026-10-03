#!/usr/bin/env node
"use strict";

// Generates PNG icons (16/48/128) for the extension with NO external deps.
// Writes minimal valid PNGs by hand: a rounded red square with a white
// downward arrow, encoded via a tiny PNG writer (RGBA, deflate stored blocks
// so we don't need a zlib dependency).
//
// Output: extension/icons/icon16.png, icon48.png, icon128.png

const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type, data) {
  const len = u32(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = u32(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Deflate using only stored (uncompressed) blocks — valid, just larger.
function deflateStored(raw) {
  const blocks = [];
  const MAX = 65535;
  let off = 0;
  while (off < raw.length) {
    const n = Math.min(MAX, raw.length - off);
    const last = off + n >= raw.length ? 1 : 0;
    const hdr = Buffer.alloc(5);
    hdr.writeUInt8(last, 0);
    hdr.writeUInt16LE(n, 1);
    hdr.writeUInt16LE(n ^ 0xffff, 3);
    blocks.push(Buffer.concat([hdr, raw.subarray(off, off + n)]));
    off += n;
  }
  if (blocks.length === 0) {
    const hdr = Buffer.alloc(5);
    hdr.writeUInt8(1, 0); // final empty
    blocks.push(hdr);
  }
  const body = Buffer.concat(blocks);
  // zlib wrapper: 0x78 0x01 + body + adler32
  return Buffer.concat([Buffer.from([0x78, 0x01]), body, u32(adler32(raw))]);
}

function makePng(size, pixels) {
  // pixels: Uint8Array length size*size*4 (RGBA)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // color type RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // raw image data: each row prefixed with filter byte 0
  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const di = y * rowLen + 1 + x * 4;
      raw[di] = pixels[si];
      raw[di + 1] = pixels[si + 1];
      raw[di + 2] = pixels[si + 2];
      raw[di + 3] = pixels[si + 3];
    }
  }
  const idat = deflateStored(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const radius = Math.round(size * 0.18);
  // colors
  const bgR = 217, bgG = 46, bgB = 46;     // red
  const fgR = 255, fgG = 255, fgB = 255;    // white arrow

  function setRGBA(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // simple alpha over
    const aa = a / 255;
    const ia = 1 - aa;
    px[i] = Math.round(r * aa + px[i] * ia);
    px[i + 1] = Math.round(g * aa + px[i + 1] * ia);
    px[i + 2] = Math.round(b * aa + px[i + 2] * ia);
    px[i + 3] = Math.min(255, px[i + 3] + a);
  }

  // rounded square background
  function insideRounded(x, y) {
    // distance from nearest corner
    let dx = 0, dy = 0;
    if (x < radius) dx = radius - x;
    else if (x > size - 1 - radius) dx = x - (size - 1 - radius);
    if (y < radius) dy = radius - y;
    else if (y > size - 1 - radius) dy = y - (size - 1 - radius);
    return Math.hypot(dx, dy) <= radius + 0.5;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRounded(x, y)) setRGBA(x, y, bgR, bgG, bgB, 255);
    }
  }

  // draw a downward arrow in white, centered
  const cx = size / 2;
  const topY = size * 0.26;
  const botY = size * 0.72;
  const shaftW = size * 0.16;
  const headW = size * 0.30;
  const headTopY = size * 0.54;

  function inArrow(x, y) {
    // shaft: rectangle from topY..headTopY
    if (y >= topY && y <= headTopY && Math.abs(x - cx) <= shaftW) return true;
    // head: triangle from headTopY..botY
    if (y > headTopY && y <= botY) {
      const t = (y - headTopY) / (botY - headTopY);
      const half = shaftW + (headW - shaftW) * t;
      return Math.abs(x - cx) <= half;
    }
    return false;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inArrow(x + 0.0, y + 0.0)) setRGBA(x, y, fgR, fgG, fgB, 255);
    }
  }

  return makePng(size, px);
}

const outDir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) {
  const buf = render(s);
  const file = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(file, buf);
  console.log(`wrote ${file} (${buf.length} bytes)`);
}
