#!/usr/bin/env node
// tools/pack-o200k.mjs —— 把 o200k_base.tiktoken 打包成前缀压缩二进制，减小发布包体积。
//
// 格式（小端）：
//   magic "O2KB" | version u8=1 | count u32
//   entries（按 token 字节字典序排序）：
//     prefixLen varint（与上一条 token 的公共前缀字节数）
//     suffixLen varint | suffix bytes
//     rank varint
// 运行期由 extension/src/lib/o200k.js 的 setO200kBinary 解码；语义与文本词表一致（BPE rank 不变）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension', 'vendor', 'o200k', 'o200k_base.tiktoken');
const OUT = path.join(ROOT, 'extension', 'vendor', 'o200k', 'o200k_base.bin');
const MAGIC = Buffer.from('O2KB', 'ascii');
const VERSION = 1;

function decodeBase64(value) {
  return Buffer.from(value, 'base64');
}

export function parseTiktokenLines(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const token = decodeBase64(line.slice(0, space));
    const rank = Number(line.slice(space + 1));
    if (!Number.isInteger(rank) || rank < 0) continue;
    entries.push({ token, rank });
  }
  return entries;
}

function writeVarint(out, value) {
  let n = Number(value) >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

export function packEntries(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.token, b.token));
  const body = [];
  const header = Buffer.alloc(9);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header.writeUInt32LE(sorted.length, 5);
  let previous = Buffer.alloc(0);
  for (const entry of sorted) {
    const prefix = commonPrefix(previous, entry.token);
    const suffix = entry.token.subarray(prefix);
    writeVarint(body, prefix);
    writeVarint(body, suffix.length);
    for (const byte of suffix) body.push(byte);
    writeVarint(body, entry.rank);
    previous = entry.token;
  }
  return Buffer.concat([header, Buffer.from(body)]);
}

function build() {
  const text = fs.readFileSync(SRC, 'utf8');
  const entries = parseTiktokenLines(text);
  if (entries.length < 100000) throw new Error('词表条目异常：' + entries.length);
  const packed = packEntries(entries);
  fs.writeFileSync(OUT, packed);
  console.log(`o200k packed: ${entries.length} entries, ${text.length} bytes text -> ${packed.length} bytes binary (${(packed.length / text.length * 100).toFixed(1)}%)`);
}

function check() {
  if (!fs.existsSync(OUT)) throw new Error('缺少 ' + path.relative(ROOT, OUT) + '，先运行 node tools/pack-o200k.mjs');
  const text = fs.readFileSync(SRC, 'utf8');
  const expected = packEntries(parseTiktokenLines(text));
  const actual = fs.readFileSync(OUT);
  if (!expected.equals(actual)) throw new Error('o200k_base.bin 与 tiktoken 词表不一致（请重新运行 node tools/pack-o200k.mjs）');
  console.log('o200k packed: clean (' + actual.length + ' bytes)');
}

if (process.argv.includes('--check')) check();
else build();
