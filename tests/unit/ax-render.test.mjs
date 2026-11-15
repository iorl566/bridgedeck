// AX 兜底观察渲染：缩进、交互标记、几何、截断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAxObservation } from '../../extension/src/lib/ax-render.js';

const facts = new Map([
  [7, { bounds: { x: 10, y: 20, width: 100, height: 30 }, visible: true }],
  [8, { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }],
]);

const nodes = [
  { role: 'WebArea', name: '示例', depth: 0 },
  { role: 'button', name: '提交 查询', depth: 1, backendNodeId: 7 },
  { role: 'textbox', name: '搜索', value: '桥', required: true, depth: 1, backendNodeId: 8 },
  { role: 'none', name: 'x', depth: 1 },
];

test('渲染缩进、交互标记与可见几何', () => {
  const text = renderAxObservation(nodes, facts);
  const lines = text.split('\n');
  assert.equal(lines[0], '- WebArea "示例"');
  assert.match(lines[1], /^ {2}- button "提交 查询" \(interactive, @10,20 100x30\)$/);
  assert.match(lines[2], /^ {2}- textbox "搜索" value="桥" \(interactive, required\)$/);
  assert.equal(lines.length, 3, 'none 角色应跳过');
});

test('maxNodes / maxChars 截断带提示', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ role: 'button', name: 'b' + i, depth: 1 }));
  const limited = renderAxObservation(many, null, { maxNodes: 5 });
  assert.match(limited, /AX 观察已截断/);
  assert.equal(limited.split('\n').length, 6);
  const chars = renderAxObservation(many, null, { maxChars: 200 });
  assert.match(chars, /AX 观察已截断/);
});

test('空输入返回空字符串', () => {
  assert.equal(renderAxObservation(null, facts), '');
  assert.equal(renderAxObservation([], facts), '');
});
