import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 直接从 page-lib 的标记块里取纯函数，确保测试的是随扩展发布的那份逻辑。
const source = fs.readFileSync(new URL('../../extension/injected/page-lib.js', import.meta.url), 'utf8');
const block = source.match(/\/\/ <mutation-summary>([\s\S]*?)\/\/ <\/mutation-summary>/);
assert.ok(block, 'page-lib 里要有 mutation-summary 标记块');
const { summarizeMutations, shouldFastUnchanged, canIncremental } = new Function(
  block[1] + '\nreturn { summarizeMutations, shouldFastUnchanged, canIncremental };',
)();

test('没有任何 mutation / 布局 / 交互 → 可以走 unchanged 快路径', () => {
  const snapshot = summarizeMutations([], {});
  assert.deepEqual(snapshot, {
    text: 0, added: 0, removed: 0, attributes: 0, total: 0, structural: false, layout: false, interaction: false,
  });
  assert.equal(shouldFastUnchanged(snapshot), true);
  assert.equal(shouldFastUnchanged(summarizeMutations([], { layout: true })), false);
  assert.equal(shouldFastUnchanged(summarizeMutations([], { interaction: true })), false);
});

test('属性变化不能被 unchanged 快路径吞掉', () => {
  const records = [{ type: 'attribute', target: {}, name: 'aria-expanded' }];
  const snapshot = summarizeMutations(records, {});
  assert.equal(snapshot.attributes, 1);
  assert.equal(snapshot.total, 1);
  assert.equal(shouldFastUnchanged(snapshot), false);
  // 属性变化可能改 accessible name / 状态，不适用只重渲染文本子树的增量补丁。
  assert.equal(canIncremental(snapshot, records), false);
});

test('纯文本变化才允许增量补丁', () => {
  const records = [{ type: 'characterData', target: {} }];
  const snapshot = summarizeMutations(records, {});
  assert.equal(snapshot.text, 1);
  assert.equal(shouldFastUnchanged(snapshot), false);
  assert.equal(canIncremental(snapshot, records), true);
  assert.equal(canIncremental(snapshot, [{ type: 'attribute', target: {} }]), false);
  assert.equal(canIncremental(snapshot, [{ type: 'characterData', target: {} }, { type: 'attribute', target: {} }]), false);
});

test('新增/删除节点算结构变化，回退整页', () => {
  const records = [{ type: 'childList', target: {}, added: 2, removed: 1 }];
  const snapshot = summarizeMutations(records, {});
  assert.equal(snapshot.added, 2);
  assert.equal(snapshot.removed, 1);
  assert.equal(snapshot.structural, true);
  assert.equal(canIncremental(snapshot, records), false);
});
