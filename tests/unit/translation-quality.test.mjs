import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const langs = ['ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he'];
const worklist = JSON.parse(fs.readFileSync(path.join(ROOT, 'translation', 'worklist.json'), 'utf8'));
const missingWorklist = JSON.parse(fs.readFileSync(path.join(ROOT, 'translation', 'missing-worklist.json'), 'utf8'));
const keys = Object.keys(worklist);
const missingKeys = Object.keys(missingWorklist);

function tokens(value) {
  return [...String(value).matchAll(/\$1|\{\w+\}|wss?:|--browser|bridge\s+[a-z.]+/g)]
    .map((match) => match[0])
    .sort();
}

test('10 个翻译文件键集完整、无空值、技术 token 保留', () => {
  for (const lang of langs) {
    const file = path.join(ROOT, 'translation', lang + '.json');
    assert.ok(fs.existsSync(file), lang + ' 缺翻译文件');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.startsWith('\uFEFF'), lang + ' 含 BOM');
    const data = JSON.parse(text);
    assert.deepEqual(Object.keys(data), keys, lang + ' 键集/顺序不一致');
    const missingData = JSON.parse(fs.readFileSync(path.join(ROOT, 'translation', 'missing-' + lang + '.json'), 'utf8'));
    assert.deepEqual(Object.keys(missingData), missingKeys, lang + ' 补充键集/顺序不一致');
    for (const key of missingKeys) {
      const value = missingData[key];
      assert.equal(typeof value, 'string', lang + ' 的补充 ' + key + ' 不是字符串');
      assert.ok(value.trim().length > 0, lang + ' 的补充 ' + key + ' 为空');
      assert.deepEqual(tokens(value), tokens(key), lang + ' 的补充 ' + key + ' 技术 token 不一致：' + value);
    }
    for (const key of keys) {
      const value = data[key];
      assert.equal(typeof value, 'string', lang + ' 的 ' + key + ' 不是字符串');
      assert.ok(value.trim().length > 0, lang + ' 的 ' + key + ' 为空');
      assert.deepEqual(tokens(value), tokens(key), lang + ' 的 ' + key + ' 技术 token 不一致：' + value);
    }
  }
});
