import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTiktoken, setO200kData, encodeO200k, decodeO200k, countO200k, isO200kLoaded } from '../../extension/src/lib/o200k.js';

function syntheticTable() {
  const lines = [];
  for (let byte = 0; byte < 256; byte += 1) lines.push(Buffer.from([byte]).toString('base64') + ' ' + byte);
  lines.push(Buffer.from('ab').toString('base64') + ' 300');
  lines.push(Buffer.from('abc').toString('base64') + ' 301');
  return lines.join('\n');
}

test('o200k 解析与 BPE 合并', () => {
  const parsed = parseTiktoken(syntheticTable());
  assert.equal(parsed.ranks.size, 258);
  assert.equal(setO200kData(syntheticTable()), 258);
  assert.equal(isO200kLoaded(), true);
  assert.deepEqual(encodeO200k('abc'), [301]);
  assert.equal(decodeO200k([301]), 'abc');
});

test('o200k 空文本返回空数组', () => {
  assert.deepEqual(encodeO200k(''), []);
});

test('o200k 真实词表加载与 roundtrip', () => {
  const data = readFileSync(new URL('../../extension/vendor/o200k/o200k_base.tiktoken', import.meta.url), 'utf8');
  const size = setO200kData(data);
  assert.ok(size > 190000, '词表条目过少：' + size);
  const text = 'hello 世界 😀';
  const tokens = encodeO200k(text);
  assert.ok(tokens.length > 0);
  assert.equal(decodeO200k(tokens), text);
  assert.equal(countO200k(text), tokens.length);
  assert.equal(countO200k('hello world'), 2);
  assert.equal(countO200k('提交'), 1);
  assert.equal(countO200k('😀'), 1);
});
