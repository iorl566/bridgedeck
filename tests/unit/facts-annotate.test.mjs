// DOMSnapshot 事实 → 语义树标注：不可见 ref 的 [dom-hidden] 标记。
import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateHiddenRefs, collectHiddenRefs } from '../../extension/src/lib/facts-annotate.js';

test('collectHiddenRefs 只挑带 ref 且 visible=false 的节点', () => {
  const nodes = [
    { ref: '@e1', visible: false },
    { ref: '@e2', visible: true },
    { ref: null, visible: false },
    { ref: '@e3' },
    null,
  ];
  assert.deepEqual(collectHiddenRefs(nodes), ['@e1']);
  assert.deepEqual(collectHiddenRefs(null), []);
});

test('annotateHiddenRefs 在命中行末追加标记', () => {
  const text = [
    '- button "A" [@e1]',
    '- button "B" [@e12]',
    '- text "C"',
  ].join('\n');
  const out = annotateHiddenRefs(text, ['@e1']);
  assert.match(out.split('\n')[0], /\[dom-hidden\]$/);
  assert.doesNotMatch(out.split('\n')[1], /\[dom-hidden\]/, '@e1 不应命中 @e12');
  assert.doesNotMatch(out.split('\n')[2], /\[dom-hidden\]/);
});

test('已标记行不重复追加；空输入原样返回', () => {
  assert.equal(annotateHiddenRefs('- x [@e1] [dom-hidden]', ['@e1']), '- x [@e1] [dom-hidden]');
  assert.equal(annotateHiddenRefs('', ['@e1']), '');
  assert.equal(annotateHiddenRefs('- x [@e1]', []), '- x [@e1]');
});
