import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVirtualRow, checkRowAnchor, parseRowTransform } from '../../extension/src/lib/virtual-row-guard.js';

test('稳定行：role=row、aria-rowindex 与 data-index 一致、无 transform', () => {
  const result = classifyVirtualRow({
    role: 'row',
    tag: 'tr',
    ariaRowIndex: 3,
    dataIndex: 3,
    transform: 'none',
    scrollTop: 0,
  });
  assert.equal(result.stable, true);
  assert.equal(result.reason, 'stable');
  assert.equal(result.rowIndex, 3);
  assert.equal(result.kind, 'row');
  assert.deepEqual(result.evidence, {});
  assert.ok(result.checks.every((item) => item.ok === true), '稳定行出现失败检查项');
});

test('索引不一致/位移：判定行被回收复用', () => {
  const mismatch = classifyVirtualRow({ role: 'row', 'aria-rowindex': 12, 'data-index': 3 });
  assert.equal(mismatch.stable, false);
  assert.equal(mismatch.reason, 'index-mismatch');
  assert.equal(mismatch.rowIndex, 12);
  assert.deepEqual(mismatch.evidence, { check: 'index', ariaRowIndex: 12, dataIndex: 3 });

  const shifted = classifyVirtualRow({ role: 'row', ariaRowIndex: 5, previousRowIndex: 4 });
  assert.equal(shifted.stable, false);
  assert.equal(shifted.reason, 'index-shifted');
  assert.deepEqual(shifted.evidence, { check: 'index-shift', previousRowIndex: 4, rowIndex: 5 });
});

test('transform 平移/位移变化：判定虚拟化行平移', () => {
  const translated = classifyVirtualRow({ role: 'row', ariaRowIndex: 1, dataIndex: 1, transform: 'translateY(-80px)' });
  assert.equal(translated.stable, false);
  assert.equal(translated.reason, 'translated');
  assert.equal(translated.evidence.translateY, -80);

  const matrix = classifyVirtualRow({ role: 'row', ariaRowIndex: 1, dataIndex: 1, transform: 'matrix(1, 0, 0, 1, 0, -64)' });
  assert.equal(matrix.reason, 'translated');
  assert.equal(matrix.evidence.translateY, -64);

  const shifted = classifyVirtualRow({
    role: 'row',
    ariaRowIndex: 1,
    dataIndex: 1,
    transform: 'translateY(0px)',
    previousTransform: 'translateY(-32px)',
  });
  assert.equal(shifted.stable, false);
  assert.equal(shifted.reason, 'transform-shifted');

  // 亚像素抖动不算平移。
  const jitter = classifyVirtualRow({ role: 'row', ariaRowIndex: 1, dataIndex: 1, transform: 'translateY(0.2px)' });
  assert.equal(jitter.stable, true, '亚像素抖动被判不稳定');
});

test('行/容器回收、key 变化、detached 给出拒绝证据', () => {
  assert.equal(classifyVirtualRow({ role: 'row', ariaRowIndex: 1, recycled: true }).reason, 'row-recycled');
  assert.equal(classifyVirtualRow({ role: 'row', ariaRowIndex: 1, containerRecycled: true }).reason, 'container-recycled');
  assert.equal(classifyVirtualRow({ role: 'row', ariaRowIndex: 1, rowKey: 'a', previousRowKey: 'b' }).reason, 'row-recycled');
  assert.equal(classifyVirtualRow({ role: 'row', ariaRowIndex: 1, detached: true }).reason, 'detached');
});

test('父容器滚动位移/未知行被拒绝，格按 cell 分类', () => {
  const scroll = classifyVirtualRow({ role: 'row', ariaRowIndex: 2, dataIndex: 2, scrollTop: 120, previousScrollTop: 40 });
  assert.equal(scroll.reason, 'scroll-shifted');
  assert.equal(scroll.evidence.deltaPx, 80);

  const unknown = classifyVirtualRow({ tag: 'div' });
  assert.equal(unknown.stable, false);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.reason, 'unknown-row');

  const cell = classifyVirtualRow({ role: 'gridcell', ariaRowIndex: 7, dataIndex: 7, transform: 'none' });
  assert.equal(cell.kind, 'cell');
  assert.equal(cell.stable, true);
});

test('checkRowAnchor 返回可直接转协议错误的拒绝结构', () => {
  const ok = checkRowAnchor({ role: 'row', ariaRowIndex: 1, dataIndex: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.classification.stable, true);

  const rejected = checkRowAnchor({ role: 'row', ariaRowIndex: 12, dataIndex: 3, transform: 'translateY(-80px)' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'E_TARGET_MISMATCH');
  assert.equal(rejected.classification.reason, 'index-mismatch');
  assert.match(rejected.message, /虚拟列表/);
  assert.equal(rejected.evidence.check, 'index');
  assert.ok(rejected.classification.checks.some((item) => item.ok === false));
});

test('parseRowTransform 覆盖 none/translate/translate3d/matrix/matrix3d', () => {
  assert.deepEqual(parseRowTransform('none'), { x: 0, y: 0, raw: 'none' });
  assert.deepEqual(parseRowTransform(''), { x: 0, y: 0, raw: '' });
  assert.deepEqual(parseRowTransform('translate(12px, -24px)'), { x: 12, y: -24, raw: 'translate(12px, -24px)' });
  assert.deepEqual(parseRowTransform('translateY(36px)'), { x: 0, y: 36, raw: 'translateY(36px)' });
  assert.deepEqual(parseRowTransform('translate3d(1px, 2px, 3px)'), { x: 1, y: 2, raw: 'translate3d(1px, 2px, 3px)' });
  assert.deepEqual(parseRowTransform('matrix(1, 0, 0, 1, 5, -6)'), { x: 5, y: -6, raw: 'matrix(1, 0, 0, 1, 5, -6)' });
  const matrix3d = parseRowTransform('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, -8, 0, 1)');
  assert.equal(matrix3d.x, 7);
  assert.equal(matrix3d.y, -8);
  assert.deepEqual(parseRowTransform('rotate(45deg)'), { x: 0, y: 0, raw: 'rotate(45deg)' });
});
