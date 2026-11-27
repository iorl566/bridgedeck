import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'cooperation.js'), 'utf8');

test('归因：时间戳容差 1.5ms 与双计数', () => {
  assert.match(SOURCE, /ATTRIBUTION_TIME_TOLERANCE_MS = 1\.5/, '缺少 1.5ms 容差常量');
  assert.match(SOURCE, /Math\.abs\(skewMs\) <= ATTRIBUTION_TIME_TOLERANCE_MS/, '时间戳匹配没有使用容差');
  assert.match(SOURCE, /perfAt: performance\.now\(\)/, 'expectation 没有记录 performance 时基');
  assert.match(SOURCE, /Number\(event\.timeStamp\)/, '事件没有读 timeStamp');
  assert.match(SOURCE, /agentAttributedByTimestamp/, '缺少时间戳归因计数');
  assert.match(SOURCE, /agentAttributedByCoordinate/, '缺少坐标归因计数');
  assert.match(SOURCE, /owner: 'agent',\s*reason,/, '归因结果缺少 owner/reason');
});

test('归因：坐标 ±2px 与按键匹配仍保留（时间戳是优先信号，不是唯一信号）', () => {
  assert.match(SOURCE, /<= 2 && Math\.abs\(Number\(event\.clientY\) - expectation\.y\) <= 2/, '坐标容差被移除');
  assert.match(SOURCE, /String\(event\.key \|\| ''\) === String\(expectation\.key\)/, '按键匹配被移除');
  assert.match(SOURCE, /\(timeOk \|\| \(pointOk && keyOk\)\)/, '时间戳与坐标/按键的组合条件不对');
  assert.match(SOURCE, /owner: 'human'/, '不匹配时应标记 human');
});

test('归因：frameState 暴露容差、计数与最近归因', () => {
  assert.match(SOURCE, /timeToleranceMs: ATTRIBUTION_TIME_TOLERANCE_MS/, 'frameState 没有暴露容差');
  assert.match(SOURCE, /attribution: lastAttribution/, 'frameState 没有暴露最近归因');
  assert.match(SOURCE, /agentAttributedByTimestamp: frameState\.agentAttributedByTimestamp \|\| 0/, '时间戳计数没有透出');
});
