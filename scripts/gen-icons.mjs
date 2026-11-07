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

// Render emerald-on-zinc icon
// Colors:
// Background: #09090b (9, 9, 11)
// Surface:    #121215 (18, 18, 21)
// Border:     #27272a (39, 39, 42)
// Emerald:    #10b981 (16, 185, 129)
function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SAMPLES = 4; // 4x4 supersampling for crisp edges

  // Distance to rounded rectangle
  function sdRoundedBox(px, py, bx, by, r) {
    const qx = Math.abs(px) - bx + r;
    const qy = Math.abs(py) - by + r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  }

  // Point in triangle test
  function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;

          // Centered coords [-0.5, 0.5]
          const cx = u - 0.5;
          const cy = v - 0.5;

          // Rounded container
          const dBox = sdRoundedBox(cx, cy, 0.44, 0.44, 0.12);

          if (dBox > 0.01) {
            // Outside
            continue;
          }

          let r = 18, g = 18, b = 21, a = 255; // #121215 surface
          if (dBox > -0.02) {
            r = 39; g = 39; b = 42; // #27272a border
          }

          // Two synchronized playback chevrons (Lockstep dual-play)
          // Triangle 1: left chevron
          const inT1 = pointInTriangle(
            cx, cy,
            -0.28, -0.22, // top-left
            -0.28,  0.22, // bot-left
             0.02,  0.0   // right apex
          );

          // Triangle 2: right chevron
          const inT2 = pointInTriangle(
            cx, cy,
            -0.02, -0.22, // top-left
            -0.02,  0.22, // bot-left
             0.28,  0.0   // right apex
          );

          if (inT1 || inT2) {
            r = 16; g = 185; b = 129; // #10b981 Signal Emerald
          }

          rSum += r;
          gSum += g;
          bSum += b;
          aSum += a;
        }
      }

      const totalSamples = SAMPLES * SAMPLES;
      const idx = (y * size + x) * 4;
      buf[idx] = Math.round(rSum / totalSamples);
      buf[idx + 1] = Math.round(gSum / totalSamples);
      buf[idx + 2] = Math.round(bSum / totalSamples);
      buf[idx + 3] = Math.round(aSum / totalSamples);
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
