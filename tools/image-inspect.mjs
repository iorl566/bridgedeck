#!/usr/bin/env node
// tools/image-inspect.mjs —— 离线看图工具（零依赖，纯 Node）
//
// 为什么要它：桥的 screenshot 每改一次都要重载扩展、还要连页面；而"看图取坐标"
// 往往是反复试的活。这个脚本直接吃已经存下来的 PNG，做裁剪/放大/网格/剖面，
// 不碰浏览器、不重载扩展。
//
// 用法：
//   node tools/image-inspect.mjs crop.png --in shot.png --crop 300,690,310,190 --zoom 4 --grid 25
//   node tools/image-inspect.mjs profile --in shot.png --axis x --range 300-600 --top 6
//
// 输出：crop 模式写出 PNG（默认 <in>.inspect.png），profile 模式打印 JSON。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------- PNG 解码（8-bit，非隔行，RGB/RGBA/灰度） ----------
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
      if (bitDepth !== 8) throw new Error('只支持 8-bit PNG，收到 ' + bitDepth);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('不支持的 colorType=' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const line = raw.subarray(offset, offset + stride);
    offset += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const rawByte = line[i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error('未知 PNG filter ' + filter);
      }
      cur[i] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------- PNG 编码（RGBA，filter 0） ----------
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ---------- 工具 ----------
const gray = (img, x, y) => {
  const i = (y * img.width + x) * img.channels;
  const r = img.data[i];
  const g = img.channels > 1 ? img.data[i + 1] : r;
  const b = img.channels > 2 ? img.data[i + 2] : r;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(token);
    }
  }
  return out;
}

// ---------- crop / zoom / grid ----------
function cropZoomGrid(img, opts) {
  const [cx, cy, cw, ch] = String(opts.crop || `0,0,${img.width},${img.height}`).split(',').map(Number);
  const zoom = Math.max(1, Math.min(8, Number(opts.zoom) || 1));
  const x0 = Math.max(0, Math.min(img.width - 1, cx));
  const y0 = Math.max(0, Math.min(img.height - 1, cy));
  const w = Math.max(1, Math.min(img.width - x0, cw));
  const h = Math.max(1, Math.min(img.height - y0, ch));
  const outW = Math.round(w * zoom);
  const outH = Math.round(h * zoom);
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const sy = y0 + Math.floor(y / zoom);
    for (let x = 0; x < outW; x += 1) {
      const sx = x0 + Math.floor(x / zoom);
      const si = (sy * img.width + sx) * img.channels;
      const di = (y * outW + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.channels > 1 ? img.data[si + 1] : img.data[si];
      out[di + 2] = img.channels > 2 ? img.data[si + 2] : img.data[si];
      out[di + 3] = 255;
    }
  }
  const step = Number(opts.grid) || 0;
  if (step > 0) {
    const gridPx = Math.max(2, Math.round(step * zoom));
    const put = (x, y, r, g, b) => {
      if (x < 0 || y < 0 || x >= outW || y >= outH) return;
      const di = (y * outW + x) * 4;
      out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = 255;
    };
    for (let gx = 0; gx < outW; gx += gridPx) {
      const major = gx % (gridPx * 2) === 0;
      for (let y = 0; y < outH; y += 1) { put(gx, y, 220, 38, 38); if (major) put(gx + 1, y, 220, 38, 38); }
    }
    for (let gy = 0; gy < outH; gy += gridPx) {
      const major = gy % (gridPx * 2) === 0;
      for (let x = 0; x < outW; x += 1) { put(x, gy, 37, 99, 235); if (major) put(x, gy + 1, 37, 99, 235); }
    }
  }
  return { buffer: encodePng(outW, outH, out), width: outW, height: outH, crop: { x: x0, y: y0, width: w, height: h }, zoom };
}

// ---------- 剖面 ----------
function profile(img, opts) {
  const axis = opts.axis === 'y' ? 'y' : 'x';
  const range = String(opts.range || '').split('-').map(Number);
  const along = axis === 'x' ? img.width : img.height;
  const across = axis === 'x' ? img.height : img.width;
  const from = Number.isFinite(range[0]) ? Math.max(1, range[0]) : 1;
  const to = Number.isFinite(range[1]) ? Math.min(along - 1, range[1]) : along - 1;
  const scores = [];
  for (let a = from; a <= to; a += 1) {
    let sum = 0;
    for (let b = 0; b < across; b += 1) {
      const prev = axis === 'x' ? gray(img, a - 1, b) : gray(img, b, a - 1);
      const cur = axis === 'x' ? gray(img, a, b) : gray(img, b, a);
      sum += Math.abs(cur - prev);
    }
    scores.push({ pos: a, score: Math.round((sum / across) * 100) / 100 });
  }
  const peaks = [];
  for (let i = 0; i < scores.length; i += 1) {
    const prev = i > 0 ? scores[i - 1].score : 0;
    const next = i < scores.length - 1 ? scores[i + 1].score : 0;
    if (scores[i].score > prev && scores[i].score >= next) peaks.push(scores[i]);
  }
  peaks.sort((a, b) => b.score - a.score);
  return { axis, width: img.width, height: img.height, range: [from, to], top: peaks.slice(0, Number(opts.top) || 8) };
}

// ---------- 模板匹配（同一张图里找"这块图出现在哪"） ----------
// 输入：模板矩形 + 搜索范围；输出：按 SAD 排序的候选偏移。
// 这是通用 CV 原语，不含任何站点/验证码知识。
function match(img, opts) {
  const [tx, ty, tw, th] = String(opts.template || '').split(',').map(Number);
  if (![tx, ty, tw, th].every(Number.isFinite) || tw <= 0 || th <= 0) {
    throw new Error('--template 需要 x,y,w,h');
  }
  const [sx0, sy0, sx1, sy1] = String(opts.search || `0,0,${img.width},${img.height}`).split(',').map(Number);
  const stride = Number(opts.stride) || 1;
  const results = [];
  for (let y = Math.max(0, sy0); y + th <= Math.min(img.height, sy1); y += stride) {
    for (let x = Math.max(0, sx0); x + tw <= Math.min(img.width, sx1); x += stride) {
      if (Math.abs(x - tx) < 4 && Math.abs(y - ty) < 4) continue; // 跳过模板自身位置
      let sad = 0;
      for (let j = 0; j < th; j += 1) {
        for (let i = 0; i < tw; i += 1) {
          sad += Math.abs(gray(img, tx + i, ty + j) - gray(img, x + i, y + j));
        }
      }
      results.push({ x, y, dx: x - tx, dy: y - ty, sad: Math.round((sad / (tw * th)) * 100) / 100 });
    }
  }
  results.sort((a, b) => a.sad - b.sad);
  return { template: { x: tx, y: ty, width: tw, height: th }, top: results.slice(0, Number(opts.top) || 5) };
}

// ---------- main ----------
const argv = process.argv.slice(2);
const opts = parseArgs(argv);
const mode = opts._[0] || 'crop';
const input = opts.in || opts._[1];
if (!input) {
  console.error('用法：node tools/image-inspect.mjs <crop|profile> --in <png> [...]');
  process.exit(1);
}
const img = decodePng(fs.readFileSync(input));

if (mode === 'profile') {
  console.log(JSON.stringify(profile(img, opts), null, 2));
} else if (mode === 'match') {
  console.log(JSON.stringify(match(img, opts), null, 2));
} else if (mode === 'crop' || mode === 'zoom') {
  const result = cropZoomGrid(img, opts);
  const outPath = opts.out || input.replace(/\.png$/i, '') + '.inspect.png';
  fs.writeFileSync(outPath, result.buffer);
  console.log(JSON.stringify({ out: outPath, width: result.width, height: result.height, crop: result.crop, zoom: result.zoom, bytes: result.buffer.length }, null, 2));
} else {
  console.error('未知模式：' + mode + '（可用 crop / profile）');
  process.exit(1);
}
void path;
