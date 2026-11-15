// 观察管线双跑汇总：覆盖率、字符/行数、耗时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectsViewport, summarizePipeline } from '../../extension/src/lib/pipeline-compare.js';

test('汇总 page-lib / AX 指标与覆盖率', () => {
  const out = summarizePipeline({
    pageLib: { ms: 123.4, refs: 7, text: '- a\n- b\n- c' },
    ax: { ms: 87.6, nodes: 120, text: '- Root\n  - button' },
    interactiveTotal: 10,
    matched: 7,
  });
  assert.deepEqual(out.pageLib, { ms: 123, refs: 7, chars: 11, lines: 3 });
  assert.deepEqual(out.ax, { ms: 88, nodes: 120, chars: 17, lines: 2 });
  assert.equal(out.interactiveTotal, 10);
  assert.equal(out.matched, 7);
  assert.equal(out.unmappedInteractive, 3);
  assert.equal(out.axCoverage, 0.7);
});

test('空输入与越界 matched 安全处理', () => {
  const out = summarizePipeline({});
  assert.equal(out.axCoverage, null);
  assert.equal(out.unmappedInteractive, 0);
  const clamped = summarizePipeline({ interactiveTotal: 2, matched: 9 });
  assert.equal(clamped.matched, 2);
  assert.equal(clamped.unmappedInteractive, 0);
});

test('intersectsViewport 判断相交/视口外/缺省', () => {
  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(intersectsViewport({ x: 10, y: 10, width: 20, height: 20 }, viewport), true);
  assert.equal(intersectsViewport({ x: 0, y: 500, width: 20, height: 20 }, viewport), false);
  assert.equal(intersectsViewport(null, viewport), true);
  assert.equal(intersectsViewport({ x: 200, y: 0, width: 10, height: 10 }, viewport), false);
});
