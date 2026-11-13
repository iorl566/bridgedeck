import test from 'node:test';
import assert from 'node:assert/strict';
import { applyObservationPatch, diffObservation, observationLines } from '../../lib/observation-delta.mjs';

const base = ['- [@e1] button "Save"', '- [@e2] textbox "Name"', '- [@e3] text "Hello"'];

test('文本原地替换 → text 补丁，只带变化行', () => {
  const next = ['- [@e1] button "Save"', '- [@e2] textbox "Name"', '- [@e3] text "Hello world"'];
  const diff = diffObservation(base.join('\n'), next.join('\n'));
  assert.equal(diff.kind, 'text');
  assert.deepEqual(diff.patch, [{ line: 2, value: '- [@e3] text "Hello world"' }]);
  const merged = applyObservationPatch(base.join('\n'), diff.patch);
  assert.equal(merged, next.join('\n'));
});

test('没有变化 → same，补丁为空', () => {
  const diff = diffObservation(base.join('\n'), base.join('\n'));
  assert.equal(diff.kind, 'same');
  assert.equal(diff.patch.length, 0);
});

test('行数变化 → structural，要求回退整页', () => {
  const diff = diffObservation(base.join('\n'), base.slice(0, 2).join('\n'));
  assert.equal(diff.kind, 'structural');
  assert.equal(diff.reason, 'line-count');
});

test('ref 序列变化 → structural，避免张冠李戴', () => {
  const next = ['- [@e9] button "Save"', '- [@e2] textbox "Name"', '- [@e3] text "Hello"'];
  const diff = diffObservation(base.join('\n'), next.join('\n'));
  assert.equal(diff.kind, 'structural');
  assert.equal(diff.reason, 'refs');
});

test('applyObservationPatch 忽略越界与非法行号', () => {
  const merged = applyObservationPatch(base.join('\n'), [{ line: 99, value: 'x' }, { line: -1, value: 'y' }, null]);
  assert.equal(merged, base.join('\n'));
});

test('observationLines 处理空文本', () => {
  assert.deepEqual(observationLines(''), []);
  assert.deepEqual(observationLines(null), []);
});
