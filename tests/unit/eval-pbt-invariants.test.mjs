import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_MODES,
  applyVisibilityGate,
  comparePaintOrder,
  evaluateVisibility,
  rectArea,
  resolveOcclusion,
  visibilityFlags,
} from '../../extension/src/lib/vom-visibility.js';
import { buildZOrderModel, compareZorder, resolveHitTest, summarizeZOrder } from '../../extension/src/lib/vom-zorder.js';
import { DEFAULT_VOM_WEIGHTS, estimateVomTokens, rankVomNodes, scoreVomNode } from '../../extension/src/lib/vom-weights.js';
import { buildFrameDepthReport, frameChainOf } from '../../extension/src/lib/vom-frames-depth.js';
import { applyObservationPatch, diffObservation } from '../../lib/observation-delta.mjs';
import { createSessionQueue } from '../../lib/session-queue.mjs';
import {
  NON_IDEMPOTENT_METHODS,
  IntentLedger,
  createMemoryLedgerStorage,
  hasNoEffect,
  isNonIdempotentAction,
  parseWalRecords,
} from '../../lib/intent-ledger.mjs';
import {
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  validateMethodProofs,
} from '../../lib/method-catalog.mjs';
import { negotiateHandshake, parseProtocol, protocolBand, protocolSkew } from '../../lib/protocol.mjs';
import { featuresForCall, negotiate, protocolGate } from '../../lib/protocol-features.mjs';
import {
  auditMethodStateMachine,
  checkPreconditions,
  isIdempotent,
  isReplayable,
  recoveryPlan,
  replayDecision,
} from '../../lib/method-state-machine.mjs';
import { createDeferred, createManualClock, createQueueHarness, flushMicrotasks } from '../../tools/eval/lib/harness.mjs';
import { stableStringify } from '../../tools/eval/lib/shrink.mjs';

test('VOM：可见性 gate 嵌套与完整划分（固定节点集）', () => {
  const nodes = [
    { id: 'visible', bounds: { x: 0, y: 0, width: 100, height: 40 }, visible: true, clickable: true, hitTest: 'hit' },
    { id: 'hidden', bounds: { x: 0, y: 50, width: 100, height: 40 }, visible: false },
    { id: 'detached', bounds: { x: 200, y: 0, width: 100, height: 40 }, detached: true },
    { id: 'pointer-none', bounds: { x: 300, y: 0, width: 100, height: 40 }, pointerEvents: 'none' },
    { id: 'offscreen', bounds: { x: -2000, y: 0, width: 10, height: 10 } },
  ];
  assert.equal(rectArea({ width: 3, height: 4 }), 12);
  assert.equal(rectArea(null), 0);
  assert.equal(visibilityFlags(nodes[0]).offscreen, false);
  assert.equal(visibilityFlags(nodes[4]).offscreen, true);
  const keptIds = (mode) => new Set(applyVisibilityGate(nodes, { mode }).nodes.map((node) => node.id));
  const paintable = keptIds('paintable');
  const visible = keptIds('visible');
  const interactable = keptIds('interactable');
  assert.deepEqual([...paintable].sort(), ['offscreen', 'pointer-none', 'visible']);
  assert.deepEqual([...visible].sort(), ['pointer-none', 'visible']);
  assert.deepEqual([...interactable].sort(), ['visible']);
  for (const id of interactable) assert.ok(visible.has(id), 'interactable ⊄ visible');
  for (const id of visible) assert.ok(paintable.has(id), 'visible ⊄ paintable');
  const gate = applyVisibilityGate(nodes, { mode: 'visible' });
  assert.equal(gate.counts.input, nodes.length);
  assert.equal(gate.counts.kept + gate.counts.dropped, nodes.length);
  for (const mode of Object.keys(GATE_MODES)) {
    const decision = evaluateVisibility(nodes[0], {});
    assert.equal(typeof decision[mode === 'interactable' ? 'interactive' : mode], 'boolean');
  }
  assert.equal(comparePaintOrder({ layerKind: 'base' }, { layerKind: 'top-layer' }) < 0, true);
  assert.equal(comparePaintOrder({ zIndex: 2 }, { zIndex: 2 }), 0);
});

test('VOM：遮挡完全覆盖与祖先排除（固定几何）', () => {
  const target = { id: 'target', bounds: { x: 10, y: 10, width: 100, height: 50 } };
  const blocker = { id: 'blocker', blocking: true, bounds: { x: 10, y: 10, width: 100, height: 50 } };
  const result = resolveOcclusion([target, blocker]);
  assert.equal(result.byId.get('target').occluderId, 'blocker');
  assert.equal(result.byId.get('target').coverage, 1);
  const descendant = { ...target, ancestorIds: ['blocker'] };
  assert.equal(resolveOcclusion([descendant, blocker]).byId.has('target'), false);
  const half = { id: 'half', blocking: true, bounds: { x: 10, y: 10, width: 50, height: 25 } };
  assert.equal(resolveOcclusion([target, half]).byId.has('target'), false, '半覆盖不应达到默认阈值');
});

test('VOM：绘制栈排序 / 遮挡链 / 命中测试', () => {
  const layers = [
    { id: 'base', rect: { x: 0, y: 0, width: 400, height: 300 }, layerKind: 'base' },
    { id: 'dialog', rect: { x: 50, y: 50, width: 300, height: 200 }, layerKind: 'blocking', blocking: true, pointerEvents: 'auto', paintOrder: 1 },
    { id: 'ghost', rect: { x: 60, y: 60, width: 250, height: 150 }, layerKind: 'top-layer', pointerEvents: 'none', paintOrder: 2 },
  ];
  const model = buildZOrderModel({ layers, viewport: { x: 0, y: 0, width: 400, height: 300 } });
  assert.equal(model.available, true);
  assert.equal(model.counts.stack, 3);
  for (let index = 1; index < model.stack.length; index += 1) {
    assert.ok(compareZorder(model.stack[index - 1], model.stack[index]) <= 0, '栈没有排序');
    assert.equal(model.stack[index].paintIndex, index);
  }
  const chain = model.chains.find((item) => item.id === 'base');
  assert(chain, 'base 没有被遮挡链记录');
  assert.equal(chain.occluders[0].id, 'ghost');
  const hit = resolveHitTest(model, { x: 100, y: 100 });
  assert.equal(hit.hitId, 'dialog', '命中测试没有穿透 pointer-events:none 的顶层元素');
  assert.equal(hit.candidates[0].id, 'ghost');
  assert.equal(hit.candidates[0].passThrough, true);
  const summary = summarizeZOrder(model, { stack: 2, chains: 1, points: 1 });
  assert.equal(summary.stack.length, 2);
  assert.equal(summary.occluded.length, 1);
  assert.equal(summary.hit.length, 1);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test('VOM：权重差值 / 排序稳定性 / token 估算 / 跨帧链', () => {
  const base = { name: 'submit', role: 'button', rect: { x: 0, y: 0, w: 200, h: 60 }, visible: true };
  assert.equal(scoreVomNode(base).score - scoreVomNode({ ...base, visible: false }).score, -DEFAULT_VOM_WEIGHTS.hidden);
  assert.equal(estimateVomTokens({ name: 'abc' }), 8 + Math.ceil((3 / 4) * 1.1));
  const ranked = rankVomNodes([
    { id: 'low', vomScore: 1 },
    { id: 'high', vomScore: 9 },
    { id: 'tie', vomScore: 9 },
  ]);
  assert.deepEqual(ranked.map((node) => node.id), ['high', 'tie', 'low']);
  const parentById = new Map([[3, 1], [1, 0], [0, null]]);
  const chain = frameChainOf(3, parentById, { maxChain: 8 });
  assert.deepEqual(chain.path, [3, 1, 0]);
  assert.equal(chain.depth, 2);
  assert.equal(chain.cycle, false);
  assert.equal(chain.missingParent, false);
  const cyclic = frameChainOf(3, new Map([[3, 1], [1, 3]]), { maxChain: 8 });
  assert.equal(cyclic.cycle, true);
  assert.equal(cyclic.path.length <= 9, true);
  const missing = frameChainOf(2, new Map([[2, 5], [5, null]]), { maxChain: 8 });
  assert.equal(missing.missingParent, true);
  const report = buildFrameDepthReport({
    frames: [
      { frameId: 0, parentFrameId: null, vom: { available: true, nodes: [], edges: [{ type: 'frame', from: '@e1', to: 'frame:1' }], counts: { nodes: 2, edges: 1 } } },
      { frameId: 1, parentFrameId: 0 },
    ],
  });
  assert.equal(report.stats.frames, 2);
  assert.equal(report.stats.links, 1);
  assert.equal(report.links[0].toFrameId, 1);
  assert.equal(report.gaps.length, 1);
});

test('观察 diff：同文/文本/patch 回放/ref 变化/追加删除（固定样例）', () => {
  const same = '- button "OK" [ref=@e1]';
  assert.deepEqual(diffObservation(same, same), { kind: 'same', patch: [], changes: 0 });
  const next = '- button "Cancel" [ref=@e1]';
  const textDiff = diffObservation(same, next);
  assert.equal(textDiff.kind, 'text');
  assert.equal(textDiff.changes, 1);
  assert.equal(applyObservationPatch(same, textDiff.patch), next);
  const refChanged = diffObservation(same, '- button "OK" [ref=@e2]');
  assert.equal(refChanged.kind, 'structural');
  assert.equal(refChanged.reason, 'refs');
  const appended = diffObservation('a', 'a\nb');
  assert.equal(appended.kind, 'structural-text');
  assert.deepEqual(appended.ops, [{ op: 'insert', line: 1, lines: ['b'] }]);
  assert.equal(applyObservationPatch('a', appended.patch), 'a\nb');
  const deleted = diffObservation('a\nb\nc', 'a\nc');
  assert.equal(deleted.kind, 'structural-text');
  assert.deepEqual(deleted.ops, [{ op: 'remove', line: 1, count: 1 }]);
  assert.equal(applyObservationPatch('a\nb\nc', deleted.patch), 'a\nc');
  assert.equal(applyObservationPatch('a', []), 'a');
});

test('队列：FIFO / 容量 / drop / 错误隔离（真实 createSessionQueue）', async () => {
  const queue = createSessionQueue({ capacity: 2 });
  const order = [];
  const first = createDeferred('first');
  const second = createDeferred('second');
  const firstTask = queue.enqueue('s', async () => {
    order.push('first');
    await first.promise;
    return 'first-result';
  });
  const secondTask = queue.enqueue('s', async () => {
    order.push('second');
    await second.promise;
    return 'second-result';
  });
  const overflow = await queue.enqueue('s', () => 'nope').catch((error) => error.code);
  assert.equal(overflow, 'E_QUEUE_FULL');
  await flushMicrotasks(4);
  assert.equal(order.length, 1);
  first.resolve();
  await flushMicrotasks(6);
  assert.deepEqual(order, ['first', 'second']);
  second.resolve();
  assert.equal(await firstTask, 'first-result');
  assert.equal(await secondTask, 'second-result');
  queue.drop('s');
  const stopped = await queue.enqueue('s', () => 'x').catch((error) => error.code);
  assert.equal(stopped, 'E_SESSION_STOPPED');
  const harness = createQueueHarness(createSessionQueue, { capacity: 3 });
  assert.equal(typeof harness.snapshot, 'function');
});

test('账本：UNKNOWN 阻塞 / 显式 resolve / 恢复 / 脱敏 / WAL（真实 IntentLedger）', () => {
  const clock = createManualClock(1710000000000);
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage, now: clock.now, fsync: false });
  const entry = ledger.begin('click', { ref: '@e1', value: 'TOP-SECRET', token: 'tok' }, { tabId: 1 });
  assert.equal(entry.state, 'active');
  assert.equal(entry.nonIdempotent, isNonIdempotentAction('click'));
  assert(!JSON.stringify(entry).includes('TOP-SECRET'), '账本条目不支持脱敏');
  assert(!storage.readWalRaw().includes('TOP-SECRET'), 'WAL 不支持脱敏');
  assert.equal(ledger.checkReplay('click', { tabId: 1 }).ok, true);
  ledger.finish(entry, 'unknown');
  assert.equal(ledger.checkReplay('click', { tabId: 1 }).ok, false);
  assert.throws(() => ledger.begin('fill', {}, { tabId: 1 }), (error) => error.code === 'E_LEDGER_PENDING');
  assert.equal(ledger.checkReplay('observe', { tabId: 1 }).ok, true);
  const resolved = ledger.resolve(entry.id, 'confirmed');
  assert.equal(resolved.state, 'resolved');
  assert.equal(ledger.checkReplay('click', { tabId: 1 }).ok, true);
  const duplicate = ledger.resolve(entry.id, 'confirmed');
  assert.equal(duplicate.duplicate, true);
  assert.throws(() => ledger.resolve(entry.id, 'not-applied'), (error) => error.code === 'E_LEDGER_CONFLICT');
  const rawWal = storage.readWalRaw();
  ledger.flush();
  const parsed = parseWalRecords(rawWal, { now: clock.now });
  assert.equal(parsed.stats.corrupted, 0);
  assert.equal(parsed.records.length, 3);
  assert.equal(storage.readWalRaw(), '', 'flush 后 WAL 应被截断');

  const crashStorage = createMemoryLedgerStorage();
  const crashed = new IntentLedger({ storage: crashStorage, now: clock.now, fsync: false });
  const pending = crashed.begin('navigate', {}, { tabId: 2 });
  const recovery = crashed.recover();
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.unknown, 1);
  assert.equal(recovery.replayBlocked, 1);
  assert.throws(() => crashed.resolve(pending.id, 'abandoned'), (error) => error.code === 'E_LEDGER_RESOLVE_REQUIRED');
  assert.equal(crashed.resolve(pending.id, 'confirmed').state, 'resolved');
  assert.equal(hasNoEffect({ code: 'E_BAD_ARG' }), true);
  assert.equal(hasNoEffect({ code: 'E_TIMEOUT' }), false);
  for (const method of ['click', 'observe']) {
    assert.equal(isNonIdempotentAction(method), NON_IDEMPOTENT_METHODS.has(method));
  }
});

test('协议：握手表 / 全方法闸门 / 物理协商 / 特性推导（真实目录）', () => {
  assert.equal(parseProtocol('1.9') !== null, true);
  assert.equal(parseProtocol('x'), null);
  assert.equal(protocolBand(PROTOCOL_BASELINE), 'baseline');
  assert.equal(protocolSkew('1.8', '1.9').relation, 'actual-older');
  const current = negotiateHandshake(PROTOCOL_CURRENT);
  assert.equal(current.decision, 'accept');
  const baseline = negotiateHandshake(PROTOCOL_BASELINE);
  assert.equal(baseline.decision, 'accept');
  const legacy = negotiateHandshake('1.7');
  assert.equal(legacy.decision, 'reject-with-upgrade');
  const unknown = negotiateHandshake('not-a-version');
  assert.equal(unknown.decision, 'reject');
  const major = negotiateHandshake('2.0');
  assert.equal(major.decision, 'reject');
  for (const method of METHOD_NAMES) {
    const gate = protocolGate({ protocol: PROTOCOL_CURRENT }, method, {});
    assert.equal(gate.ok, true, '当前协议下方法被拒绝：' + method);
  }
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'video.start', {}).ok, false);
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'video.start', {}).code, 'E_PROTOCOL_UNSUPPORTED');
  assert.deepEqual(featuresForCall('screenshot', { stream: true }), ['capture.stream']);
  const negotiation = negotiate({ protocol: PROTOCOL_BASELINE }, { calls: [{ method: 'video.start' }] });
  assert.equal(negotiation.ok, false);
  assert.equal(negotiation.verdict === 'degraded' || negotiation.verdict === 'incompatible', true);
  assert(negotiation.missing.includes('video'));
});

test('方法状态机：目录审计 / 三态前置 / 重放决策 / 恢复计划（真实目录）', () => {
  assert.deepEqual(validateMethodProofs(), []);
  assert.deepEqual(auditMethodStateMachine(), []);
  const truthy = {
    daemon: true, instanceConnected: true, browserReady: true, sessionActive: true, sessionUnpaused: true,
    tabBound: true, controlHeld: true, observationFresh: true, recording: true, debuggerIdle: true,
    dialogPending: true, transferOpen: true, networkCapturing: true, traceActive: true, planApproved: true,
    pairAvailable: true, artifactPresent: true, cooperationAligned: true, uiAttached: true, transportLocal: true,
    params: { ref: '@e1' },
  };
  const proven = checkPreconditions('click', truthy);
  assert.equal(proven.ok, true);
  assert.equal(proven.proven, true);
  assert.deepEqual(proven.violations, []);
  assert.equal(checkPreconditions('click', {}).proven, false);
  assert.equal(replayDecision('observe', { effectState: 'unknown' }).allowed, true);
  assert.equal(replayDecision('click', { effectState: 'applied', dispatched: true }).allowed, false);
  assert.equal(replayDecision('click', { effectState: 'none' }).allowed, true);
  assert.equal(replayDecision('no-such-method', {}).known, false);
  assert.equal(replayDecision('observe', {}).idempotent, isIdempotent('observe'));
  assert.equal(replayDecision('observe', {}).requiresResolve, false);
  assert.equal(isReplayable('observe'), true);
  assert.equal(recoveryPlan('click', 'E_LEDGER_PENDING').requiresResolve, true);
  assert.equal(recoveryPlan('click', 'E_LEDGER_PENDING').retryAllowed, false);
  assert.equal(recoveryPlan('click', 'E_TIMEOUT').known, true);
  assert.equal(recoveryPlan('click', 'E_NOT_A_REAL_CODE').known, false);
  assert.equal(stableStringify(recoveryPlan('click', 'E_TIMEOUT')), stableStringify(recoveryPlan('click', 'E_TIMEOUT')));
});
