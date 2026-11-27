import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareRowAnchor,
  hasLegacyRowFacts,
  normalizeRowAnchor,
  parseRowAnchorProbe,
  rowAnchorAsPrevious,
  rowAnchorDigest,
} from '../../extension/src/lib/virtual-row-guard.js';

const listener = () => ({ addListener() {}, removeListener() {} });
if (!globalThis.chrome) {
  globalThis.chrome = {
    runtime: { onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null, getManifest: () => ({ version: '0.1.2' }) },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: listener(),
    },
    alarms: { create: async () => {}, onAlarm: listener() },
    tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async () => ({ id: 1 }), create: async () => ({ id: 1 }), remove: async () => {}, update: async () => ({}), captureVisibleTab: async () => '' },
    windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
    debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    scripting: { executeScript: async () => [] },
    webRequest: { onBeforeRequest: listener(), onSendHeaders: listener(), onCompleted: listener(), onErrorOccurred: listener() },
    downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
    action: { openPopup: async () => {} },
    permissions: { contains: async () => true },
  };
}
const { guardActionRowAnchor, readRowAnchorFacts } = await import('../../extension/src/tools/pointer-primitives.js');

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

/** W1 契约形状的 observe anchor（camelCase + role/tag）。 */
function observedAnchor(patch = {}) {
  return {
    ariaRowIndex: 12,
    dataIndex: 12,
    transform: 'matrix(1, 0, 0, 1, 0, -48)',
    rowKey: 'order-8891',
    rowText: '订单 8891 张三 待发货 128.00',
    containerScrollTop: 496,
    recycled: false,
    role: 'row',
    tag: 'div',
    ...patch,
  };
}

test('anchor 归一化：camelCase/旧 snake_case/transform 原始串都能读', () => {
  const camel = normalizeRowAnchor(observedAnchor());
  assert.equal(camel.rowIndex, 12);
  assert.equal(camel.rowKey, 'order-8891');
  assert.equal(camel.rowText, '订单 8891 张三 待发货 128.00');
  assert.equal(camel.transform.raw, 'matrix(1, 0, 0, 1, 0, -48)');
  assert.equal(camel.transform.y, -48);
  assert.equal(camel.containerScrollTop, 496);
  const snake = normalizeRowAnchor({ 'aria-rowindex': '7', 'data-index': 7, row_text: 'A', transform: 'translateY(0px)' });
  assert.equal(snake.ariaRowIndex, 7);
  assert.equal(snake.rowText, 'A');
  assert.equal(snake.rowIndex, 7);
  assert.equal(normalizeRowAnchor(null), null);
  assert.equal(normalizeRowAnchor('bad'), null);
  assert.equal(parseRowAnchorProbe({ ok: true, cause: 'not-virtualized', anchor: null }).cause, 'not-virtualized');
  assert.equal(parseRowAnchorProbe({ ok: false, cause: 'target-not-found', anchor: null }).ok, false);
  assert.equal(parseRowAnchorProbe(null).anchor, null);
});

test('稳定行：同 key/同文本/同 transform/同滚动 → stable 且证据完整', () => {
  const expected = observedAnchor();
  const current = observedAnchor();
  const result = compareRowAnchor(expected, current);
  assert.equal(result.ok, true);
  assert.equal(result.stable, true);
  assert.equal(result.guard, 'virtual-row');
  assert.equal(result.reason, 'stable');
  assert.equal(result.rowIndex, 12);
  assert.equal(result.kind, 'row');
  assert.equal(result.checks.every((item) => item.ok === true), true, JSON.stringify(result.checks));
  assert.equal(result.evidence.guard, 'virtual-row');
  assert.equal(result.evidence.check, 'all');
  // 亚像素抖动容差。
  assert.equal(compareRowAnchor(observedAnchor(), observedAnchor({ transform: 'matrix(1, 0, 0, 1, 0, -48.2)' })).ok, true);
});

test('漂移行：index/rowKey/rowText/transform/scroll 任一变化都拒绝并给出 E_TARGET_MISMATCH 证据', () => {
  const cases = [
    ['ariaRowIndex', { ariaRowIndex: 13, dataIndex: 13 }, 'index-mismatch'],
    ['dataIndex', { dataIndex: 11 }, 'index-mismatch'],
    ['rowKey', { rowKey: 'order-9999' }, 'row-recycled'],
    ['rowText', { rowText: '订单 9999 李四 已取消 0.00' }, 'row-text-changed'],
    ['transform', { transform: 'matrix(1, 0, 0, 1, 0, -144)' }, 'translated'],
    ['containerScrollTop', { containerScrollTop: 560 }, 'scroll-shifted'],
    ['recycled', { recycled: true }, 'row-recycled'],
  ];
  for (const [name, patch, reason] of cases) {
    const result = compareRowAnchor(observedAnchor(), observedAnchor(patch));
    assert.equal(result.ok, false, name + ' 漂移未被拒绝');
    assert.equal(result.code, 'E_TARGET_MISMATCH');
    assert.equal(result.guard, 'virtual-row');
    assert.equal(result.reason, reason, name + ' 拒绝原因=' + result.reason);
    assert.match(result.message, /重新 observe/);
    assert.equal(result.evidence.guard, 'virtual-row');
    assert.equal(typeof result.evidence.check, 'string');
    assert.equal(result.evidence.expected.rowKeyHash != null, true);
    assert.equal(JSON.stringify(result.evidence).includes('订单 8891'), false, '错误证据泄漏了页面正文');
  }
});

test('当前 anchor 缺失：按原因 fail-closed（不可证明稳定就不派发）', () => {
  const expected = observedAnchor();
  const cases = [
    ['anchor-missing', 'anchor-missing'],
    ['target-not-found', 'target-not-found'],
    ['target-detached', 'target-detached'],
    ['not-virtualized', 'not-virtualized'],
  ];
  for (const [cause, reason] of cases) {
    const result = compareRowAnchor(expected, null, { cause });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.code, 'E_TARGET_MISMATCH');
    assert.equal(result.checks.find((item) => item.name === 'current-anchor').cause, cause);
  }
  // 期望 anchor 没有任何行身份字段：跳过（不误伤非虚拟行调用）。
  const skipped = compareRowAnchor({ transform: 'none' }, null);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'no-anchor-identity');
});

test('rowAnchorDigest / legacy 行事实 / previous 映射：纯函数不泄漏正文且可复用分类器', () => {
  const digest = rowAnchorDigest(observedAnchor());
  assert.equal(digest.ariaRowIndex, 12);
  assert.equal(digest.rowText.length, [...'订单 8891 张三 待发货 128.00'].length);
  assert.equal(JSON.stringify(digest).includes('张三'), false);
  assert.equal(hasLegacyRowFacts(observedAnchor()), false);
  assert.equal(hasLegacyRowFacts({ previousRowIndex: 3 }), true);
  assert.equal(hasLegacyRowFacts({ detached: true }), true);
  const previous = rowAnchorAsPrevious(observedAnchor());
  assert.equal(previous.previousRowIndex, 12);
  assert.equal(previous.previousRowKey, 'order-8891');
  assert.equal(previous.previousTransform, 'matrix(1, 0, 0, 1, 0, -48)');
  assert.equal(previous.previousScrollTop, 496);
});

test('运行时守卫（page-lib row-anchor 命令）：稳定返回 row_guard，来源与 revision 可追溯', async () => {
  const calls = [];
  const deps = {
    execPage: async (tabId, name, args) => {
      calls.push({ tabId, name, args });
      assert.equal(name, 'row-anchor');
      assert.deepEqual(args, { ref: '@e42' });
      return { anchor: observedAnchor(), revision: 77 };
    },
  };
  const guard = await guardActionRowAnchor(4, { ref: '@e42', rowAnchor: observedAnchor() }, deps);
  assert.equal(guard.guard, 'virtual-row');
  assert.equal(guard.stable, true);
  assert.equal(guard.anchor_source, 'page-lib:row-anchor');
  assert.equal(guard.revision, 77);
  assert.equal(guard.dispatched, false);
  assert.equal(guard.row_index, 12);
  assert.equal(typeof guard.expected.rowKeyHash, 'string');
  assert.equal(calls.length, 1);
});

test('运行时守卫：行漂移抛 E_TARGET_MISMATCH + data.guard=virtual-row + replay=false', async () => {
  const deps = {
    execPage: async () => ({ anchor: observedAnchor({ ariaRowIndex: 13, dataIndex: 13, rowText: '另一行' }), revision: 78 }),
  };
  await assert.rejects(
    () => guardActionRowAnchor(4, { ref: '@e42', rowAnchor: observedAnchor() }, deps),
    (error) => {
      assert.equal(error.code, 'E_TARGET_MISMATCH');
      assert.equal(error.data.guard, 'virtual-row');
      assert.equal(error.data.stable, false);
      assert.equal(error.data.reason, 'index-mismatch');
      assert.equal(error.data.dispatched, false);
      assert.equal(error.data.replay, false);
      assert.equal(error.data.anchor_source, 'page-lib:row-anchor');
      assert.equal(typeof error.data.evidence.check, 'string');
      assert.equal(error.data.checks.some((item) => item.ok === false), true);
      assert.match(error.message, /重新 observe/);
      return true;
    },
  );
});

test('旧页面库回退：row-anchor 不存在时用 ref-selector + MAIN world 探针，结果等价', async () => {
  const calls = [];
  const deps = {
    execPage: async (tabId, name, args) => {
      calls.push(name);
      if (name === 'row-anchor') {
        const error = new Error('页面侧未知方法: row-anchor');
        error.code = 'E_UNKNOWN_METHOD';
        throw error;
      }
      if (name === 'ref-selector') return { selector: '#row-8891', frameUrl: 'https://example.com/' };
      throw new Error('unexpected page call: ' + name);
    },
    evalInMain: async (tabId, expression) => {
      calls.push('evalInMain');
      assert.match(expression, /row-8891/);
      assert.match(expression, /aria-rowindex/);
      return { value: { ok: true, cause: 'row', anchor: observedAnchor() } };
    },
  };
  const guard = await guardActionRowAnchor(4, { ref: '@e42', rowAnchor: observedAnchor() }, deps);
  assert.equal(guard.stable, true);
  assert.equal(guard.anchor_source, 'main-world-probe');
  assert.deepEqual(calls, ['row-anchor', 'ref-selector', 'evalInMain']);

  // 回退探针读到“已不是虚拟行”：fail-closed。
  const drifted = {
    execPage: async (tabId, name) => {
      if (name === 'row-anchor') {
        const error = new Error('页面侧未知方法');
        error.code = 'E_UNKNOWN_METHOD';
        throw error;
      }
      return { selector: '#row-8891' };
    },
    evalInMain: async () => ({ value: { ok: true, cause: 'not-virtualized', anchor: null } }),
  };
  await assert.rejects(
    () => guardActionRowAnchor(4, { ref: '@e42', rowAnchor: observedAnchor() }, drifted),
    (error) => error.code === 'E_TARGET_MISMATCH' && error.data.reason === 'not-virtualized' && error.data.anchor_source === 'main-world-probe',
  );
});

test('frame 内目标 / 没有目标：不可证明稳定时 fail-closed', async () => {
  const deps = { execPage: async () => ({ anchor: observedAnchor() }) };
  await assert.rejects(
    () => guardActionRowAnchor(4, { ref: '@e42', frameId: 3, rowAnchor: observedAnchor() }, deps),
    (error) => error.code === 'E_TARGET_MISMATCH' && error.data.probe_cause === 'frame-unsupported',
  );
  const noTarget = await guardActionRowAnchor(4, { rowAnchor: observedAnchor() }, deps);
  assert.equal(noTarget, null, '没有 ref/selector 的纯坐标动作不应启用行锚点守卫');
  const withoutAnchor = await guardActionRowAnchor(4, { ref: '@e1' }, deps);
  assert.equal(withoutAnchor, null);
});

test('接线守卫：fill/click 入口真的调用了行锚点守卫与 WAL 事务（源码级证据）', () => {
  const fill = read('extension/src/tools/fill-actions.js');
  assert.match(fill, /guardRowAnchor\(params\)/, 'fill 入口没有行锚点守卫');
  assert.match(fill, /guardActionRowAnchor\(tabId, params\)/, 'fill 守卫没有读当前行事实');
  assert.match(fill, /checkRowAnchor\(facts\)/, 'fill 没有保留 legacy 分类器');
  assert.match(fill, /throw bridgeError\('E_TARGET_MISMATCH'/, 'fill 拒绝没有协议错误码');
  assert.match(fill, /beginJournaledTransaction\(\{ method: 'fill'/, 'fill 派发前没有预写 journal');
  assert.match(fill, /tx\.markDispatched\(\{ phase: 'fill-insert'/, 'fill 没有标记已派发');
  assert.match(fill, /row_guard: rowGuard/, 'fill 成功没有返回 row_guard');

  const pointer = read('extension/src/tools/pointer-actions.js');
  assert.match(pointer, /guardRowAnchorForAction\(params\)/, 'click/hover 没有行锚点守卫');
  assert.match(pointer, /beginJournaledTransaction\(\{ method: 'click'/, 'click 没有预写 journal');
  assert.match(pointer, /beginJournaledTransaction\(\{ method: 'drag'/, 'drag 没有预写 journal');
  assert.match(pointer, /tx\.markDispatched\(\{ phase: 'click-backend-press'/, 'click-backend 没有标记已派发');
  assert.match(pointer, /coalescePointerMoves\(/, 'pointer-actions 没有接入移动合并');
  assert.match(pointer, /pointer_moves: pointerMoveSummary\(movePlan\)/, 'click 没有返回移动合并证据');

  const journalModule = read('extension/src/lib/action-journal.js');
  assert.match(journalModule, /kind: 'recovered'/, '恢复没有写 UNKNOWN 记录');
  assert.match(journalModule, /observe-then-resolve/, '恢复报告没有 reconcile 指引');
  assert.match(journalModule, /fsyncSync/, '文件 sink 没有 fsync 语义');
  assert.match(journalModule, /recovered: begun && Array\.isArray\(begun\.recovered\)/, '事务入口没有透传恢复结果');
  assert.match(fill, /journal_recovered: recovered/, 'fill 结果没有暴露重启恢复出的 UNKNOWN');
  assert.match(pointer, /journal_recovered: recovered/, 'click/drag 结果没有暴露重启恢复出的 UNKNOWN');
});
