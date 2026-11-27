import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PARTS = 'extension/injected/parts';
const TARGET = 'extension/injected/page-lib.js';

test('page-lib 分块按序合并与产物一致', () => {
  const files = fs.readdirSync(PARTS).filter((name) => name.endsWith('.part')).sort();
  assert.ok(files.length >= 8, '分块数量太少：' + files.length);
  const built = files.map((name) => fs.readFileSync(path.join(PARTS, name), 'utf8')).join('');
  assert.equal(built, fs.readFileSync(TARGET, 'utf8'), 'page-lib.js 与 parts 不一致，运行 npm run build:page-lib');
});

test('单个 page-lib 分块不超过 1100 行', () => {
  for (const name of fs.readdirSync(PARTS).filter((item) => item.endsWith('.part'))) {
    const lines = fs.readFileSync(path.join(PARTS, name), 'utf8').split('\n').length;
    assert.ok(lines <= 1100, name + ' 过大：' + lines + ' 行');
  }
});
