// tools/make-icons.mjs —— 零依赖生成扩展图标（圆角蓝底 + 白色桥形）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inRing(x, y, cx, cy, radius, thickness) {
  const d = Math.hypot(x - cx, y - cy);
  return Math.abs(d - radius) <= thickness;
}

function sample(u, v) {
  // u,v ∈ [0,1]；返回 [r,g,b,a] 0-255
  const r = 0.19 + 0.12 * (1 - v);
  const g = 0.36 + 0.12 * (1 - v);
  const b = 0.92;
  const base = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255];
  const white = [255, 255, 255, 255];
  const deckY = 0.60;
  const pillarTop = 0.40;
  const pillarBottom = 0.76;
  const inDeck = inRoundedRect(u, v, 0.16, deckY - 0.035, 0.84, deckY + 0.035, 0.03);
  const arch = inRing(u, v, 0.5, 0.62, 0.26, 0.05) && v <= deckY;
  const leftPillar = inRoundedRect(u, v, 0.245, pillarTop, 0.325, pillarBottom, 0.03);
  const rightPillar = inRoundedRect(u, v, 0.675, pillarTop, 0.755, pillarBottom, 0.03);
  if (inDeck || arch || leftPillar || rightPillar) return white;
  return base;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rs = 0, gs = 0, bs = 0, as = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const inside = inRoundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22);
          if (!inside) continue;
          const [r, g, b, a] = sample(u, v);
          rs += r; gs += g; bs += b; as += a;
        }
      }
      const total = SS * SS;
      const i = (y * size + x) * 4;
      if (as === 0) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(rs / (as / 255));
        rgba[i + 1] = Math.round(gs / (as / 255));
        rgba[i + 2] = Math.round(bs / (as / 255));
        rgba[i + 3] = Math.round(as / total);
      }
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, 'icon' + size + '.png');
  fs.writeFileSync(file, render(size));
  console.log('wrote', file);
}
