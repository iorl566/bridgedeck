import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_LIMITS,
  orderFrameIds,
  selectFrameIds,
  mergeDiscoverFrames,
  normalizeExtractBudget,
  summarizeExtractBudget,
} from '../../extension/src/lib/extract-limits.js';

test('orderFrameIds：主文档优先、去重、忽略非法值', () => {
  assert.deepEqual(orderFrameIds([5, 0, 2, 5, -1, 'x', 2]), [0, 2, 5]);
  assert.deepEqual(orderFrameIds([3, 1]), [1, 3]);
  assert.deepEqual(orderFrameIds([]), []);
  assert.deepEqual(orderFrameIds(null), []);
});

test('selectFrameIds：超过 16 帧截断并标记 framesSeen', () => {
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const picked = selectFrameIds(ids, EXTRACT_LIMITS.frames);
  assert.equal(picked.frameIds.length, 16);
  assert.equal(picked.framesSeen, 20);
  assert.equal(picked.truncated, true);
  assert.equal(picked.frameIds[0], 1);
  const few = selectFrameIds([0, 4]);
  assert.deepEqual(few, { frameIds: [0, 4], framesSeen: 2, truncated: false, limit: 16 });
});

test('mergeDiscoverFrames：全局 32 target 上限 + frameId/frameUrl + 截断', () => {
  const frames = [
    { frameId: 0, result: { url: 'https://a/', targets: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: 'table', preview: { columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], sample: [] } })) } },
    { frameId: 3, result: { url: 'https://b/', targets: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: 'list' })) } },
    { frameId: 4, error: 'inject failed' },
  ];
  const merged = mergeDiscoverFrames(frames, { framesSeen: 3 });
  assert.equal(merged.targets.length, EXTRACT_LIMITS.targets);
  assert.equal(merged.truncated, true);
  assert.equal(merged.dropped, 40 - EXTRACT_LIMITS.targets);
  assert.equal(merged.frameCount, 2);
  assert.equal(merged.framesScanned, 2);
  assert.equal(merged.framesSeen, 3);
  assert.equal(merged.targets[0].frameId, 0);
  assert.equal(merged.targets[0].frameUrl, 'https://a/');
  assert.equal(merged.targets[0].preview.columns.length, EXTRACT_LIMITS.previewColumns);
  assert.equal(merged.targets[20].frameId, 3);
  assert.deepEqual(merged.limits, { maxFrames: 16, maxTargets: 32, previewColumns: 8 });
});

test('mergeDiscoverFrames：没有超限时不标 truncated，preview 保持原样', () => {
  const merged = mergeDiscoverFrames([
    { frameId: 0, result: { url: 'https://a/', targets: [{ id: 1, kind: 'table', preview: { columns: ['x'], sample: ['v'] } }] } },
  ]);
  assert.equal(merged.truncated, false);
  assert.equal(merged.dropped, 0);
  assert.deepEqual(merged.targets[0].preview, { columns: ['x'], sample: ['v'] });
  assert.equal(merged.targets[0].frameUrl, 'https://a/');
});

test('mergeDiscoverFrames：空输入与缺失字段安全降级', () => {
  const merged = mergeDiscoverFrames(null, {});
  assert.deepEqual(merged.targets, []);
  assert.equal(merged.frameCount, 0);
  assert.equal(merged.truncated, false);
  assert.equal(merged.limits.maxTargets, 32);
  const trimmed = mergeDiscoverFrames([{ frameId: 0, result: { targets: [{ id: 1, preview: null }] } }], { previewColumns: 2 });
  assert.equal(trimmed.targets[0].preview, null);
});

test('normalizeExtractBudget：默认值与上下界', () => {
  assert.deepEqual(normalizeExtractBudget({}), { maxRows: 500, maxBytes: 256 * 1024, maxCells: 20000 });
  assert.deepEqual(normalizeExtractBudget({ maxRows: 0, maxBytes: 10, maxCells: 0 }), { maxRows: 500, maxBytes: 1024, maxCells: 20000 });
  assert.deepEqual(normalizeExtractBudget({ maxRows: 99999, maxBytes: 99 * 1024 * 1024, maxCells: 9e9 }), { maxRows: 5000, maxBytes: 4 * 1024 * 1024, maxCells: 200000 });
  assert.deepEqual(normalizeExtractBudget({ maxRows: 3, maxBytes: 4096, maxCells: 8 }), { maxRows: 3, maxBytes: 4096, maxCells: 8 });
});

test('summarizeExtractBudget：停止原因与字节/单元格证据', () => {
  const end = summarizeExtractBudget({ rows: [{ a: 1 }] }, { maxRows: 10 });
  assert.equal(end.stopReason, 'end');
  assert.equal(end.rows, 1);
  assert.equal(end.cells, 1);
  assert.ok(end.bytes > 0);
  assert.equal(end.maxRows, 10);
  const byRows = summarizeExtractBudget({ rows: [], truncated: true }, {});
  assert.equal(byRows.stopReason, 'max-rows');
  const byBytes = summarizeExtractBudget({ rows: [{ a: 1 }], stopReason: 'max-bytes', cells: 4 }, { maxBytes: 2048 });
  assert.equal(byBytes.stopReason, 'max-bytes');
  assert.equal(byBytes.cells, 4);
  assert.equal(byBytes.maxBytes, 2048);
});
