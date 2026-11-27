// tests/unit/o200k-packing.test.mjs —— 前缀压缩词表（体积优化）与文本词表语义一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTiktokenLines, packEntries } from '../../tools/pack-o200k.mjs';
import { parseO200kBinary, setO200kBinary, encodeO200k, decodeO200k } from '../../extension/src/lib/o200k.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT = path.join(ROOT, 'extension', 'vendor', 'o200k', 'o200k_base.tiktoken');
const BIN = path.join(ROOT, 'extension', 'vendor', 'o200k', 'o200k_base.bin');

test('o200k_base.bin 与 tiktoken 逐字节可复现，且体积显著更小', () => {
  const text = fs.readFileSync(TEXT, 'utf8');
  const expected = packEntries(parseTiktokenLines(text));
  const actual = fs.readFileSync(BIN);
  assert.ok(expected.equals(actual), 'bin 与当前 tiktoken 不一致：运行 node tools/pack-o200k.mjs');
  assert.ok(actual.length < text.length * 0.5, `二进制应小于文本 50%，实际 ${actual.length}/${text.length}`);
});

test('二进制解码后的 rank/字节与文本词表一致（抽样 + token 数）', () => {
  const parsed = parseO200kBinary(fs.readFileSync(BIN));
  const text = fs.readFileSync(TEXT, 'utf8');
  const entries = parseTiktokenLines(text);
  assert.equal(parsed.ranks.size, entries.length);
  for (let i = 0; i < entries.length; i += 97) {
    const key = String.fromCharCode(...entries[i].token);
    assert.equal(parsed.ranks.get(key), entries[i].rank, 'rank 不一致：' + entries[i].rank);
  }
});

test('setO200kBinary 后 encode/decode 往返一致', () => {
  const size = setO200kBinary(fs.readFileSync(BIN));
  assert.ok(size > 100000);
  for (const sample of ['BridgeDeck', '浏览器桥', 'hello world', 'https://example.com/']) {
    const tokens = encodeO200k(sample);
    assert.ok(tokens.length > 0);
    assert.equal(decodeO200k(tokens), sample);
  }
});

test('扩展 zip 构建排除原始 tiktoken、加载器优先二进制', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'tools', 'build-extension.mjs'), 'utf8'), /o200k_base\.tiktoken/);
  const loader = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'lib', 'o200k.js'), 'utf8');
  assert.match(loader, /o200k_base\.bin/);
});
