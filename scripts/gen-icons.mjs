import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const toCrc = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPng(width, height, rgbaBuffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None
    rgbaBuffer.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// Precompute LUT for the center lens shape
// SVG: M12 9C13 9.8 13.6 10.8 13.6 12C13.6 13.2 13 14.2 12 15C11 14.2 10.4 13.2 10.4 12C10.4 10.8 11 9.8 12 9Z
const LENS_LUT_STEPS = 1000;
const lensLut = new Float64Array(LENS_LUT_STEPS + 1);
for (let i = 0; i <= LENS_LUT_STEPS; i++) {
  const y = 9 + (i / LENS_LUT_STEPS) * 3; // y from 9 to 12
  let t0 = 0, t1 = 1;
  for (let iter = 0; iter < 16; iter++) {
    const tm = (t0 + t1) / 2;
    const u = 1 - tm;
    const yt = u * u * u * 9 + 3 * u * u * tm * 9.8 + 3 * u * tm * tm * 10.8 + tm * tm * tm * 12;
    if (yt < y) t0 = tm; else t1 = tm;
  }
  const t = (t0 + t1) / 2;
  const u = 1 - t;
  const xt = u * u * u * 12 + 3 * u * u * t * 13 + 3 * u * t * t * 13.6 + t * t * t * 13.6;
  lensLut[i] = xt - 12; // half-width from center x=12
}

function isInsideLens(px, py) {
  const dy = Math.abs(py - 12);
  if (dy > 3.0) return false;
  const idx = Math.min(LENS_LUT_STEPS, Math.max(0, Math.round((1 - dy / 3) * LENS_LUT_STEPS)));
  return Math.abs(px - 12) <= lensLut[idx];
}

// Distance to rounded rectangle
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

// Render Stitch Interlocking Prismatic Logo Mark
// Colors:
// Background: #101014 (16, 16, 20)
// Outline:    #27272E (39, 39, 46)
// Left ring:  #00E5FF (0, 229, 255)
// Right ring: #EC4899 (236, 72, 153)
// Lens:       #FBBF24 (251, 191, 36)
function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SAMPLES = size <= 48 ? 8 : 4;
  const totalSamples = SAMPLES * SAMPLES;
  const borderWidth = Math.max(1.0 / size, 0.02);
  const scale = 28;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, samplesInside = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;

          const cx = u - 0.5;
          const cy = v - 0.5;

          const dBox = sdRoundedBox(cx, cy, 0.44, 0.44, 0.12);
          if (dBox > 0) {
            continue; // Outside rounded icon background
          }

          samplesInside++;

          let r = 16, g = 16, b = 20; // #101014 surface
          if (dBox > -borderWidth) {
            r = 39; g = 39; b = 46; // #27272E outline
          }

          // Map icon space [-0.5, 0.5] to SVG 24x24 space centered at (12, 12)
          const px = 12 + cx * scale;
          const py = 12 + cy * scale;

          // Left ring: cx=8, cy=12, r=5, stroke-width=2.5
          const d1 = Math.hypot(px - 8, py - 12);
          const inLeftRing = Math.abs(d1 - 5) <= 1.25;

          // Right ring: cx=16, cy=12, r=5, stroke-width=2.5
          const d2 = Math.hypot(px - 16, py - 12);
          const inRightRing = Math.abs(d2 - 5) <= 1.25;

          // Stitch Interlocking Prismatic SVG painting order:
          // 1. Left circle (cyan #00E5FF)
          if (inLeftRing) {
            r = 0; g = 229; b = 255;
          }
          // 2. Right circle (magenta #EC4899)
          if (inRightRing) {
            r = 236; g = 72; b = 153;
          }
          // 3. Center lens (amber #FBBF24)
          if (isInsideLens(px, py)) {
            r = 251; g = 191; b = 36;
          }

          rSum += r;
          gSum += g;
          bSum += b;
        }
      }

      const idx = (y * size + x) * 4;
      if (samplesInside > 0) {
        buf[idx] = Math.round(rSum / samplesInside);
        buf[idx + 1] = Math.round(gSum / samplesInside);
        buf[idx + 2] = Math.round(bSum / samplesInside);
        buf[idx + 3] = Math.round((samplesInside / totalSamples) * 255);
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }

  return createPng(size, size, buf);
}

const outDir = 'extension/icons';
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = renderIcon(size);
  const filePath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`[icons] Generated ${filePath} (${size}x${size}, ${png.length} bytes)`);
}
