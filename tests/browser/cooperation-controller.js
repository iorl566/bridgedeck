// 真实 Chromium DOM 证据：controller 状态机 + 浮层抑制（真实 visibility 变化）+ 快照聚合。
// 说明：overlay-suppress 的 apply 通过 window.chrome.scripting.executeScript stub 在**真实页面**
// 执行，断言读的是真实 DOM 的 style/attribute，而不是 stub 调用记录。
import { createCaptureSuppression } from '../../extension/src/lib/capture-suppression.js';
import { openOverlay, closeOverlay, getOverlayState } from '../../extension/src/overlay-state.js';
import { withOverlaysHidden, overlaySuppressionSnapshot, isOverlaySuppressed } from '../../extension/src/overlay-suppress.js';
import { createControllerStateMachine } from '../../extension/src/lib/controller-state.js';
import { createRevisionChain, compareRevisionVectors } from '../../extension/src/lib/revision-chain.js';
import { buildControllerToolbarSnapshot, describeControllerToolbar } from '../../extension/src/lib/controller-toolbar.js';
import { createSuppressionScope, SUPPRESSION_KINDS } from '../../extension/src/lib/suppression-scope.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const raf2 = async () => { await nextFrame(); await nextFrame(); };
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const host = () => document.getElementById('__bb_takeover_host');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeHost() {
  const old = host();
  if (old) old.remove();
  const node = document.createElement('div');
  node.id = '__bb_takeover_host';
  node.setAttribute('data-bb-ui', 'takeover');
  node.style.cssText = 'position:fixed;right:8px;top:8px;width:48px;height:18px;background:#2563eb';
  node.textContent = 'Agent';
  document.body.appendChild(node);
  return node;
}

test('真实 DOM：抑制期间浮层 visibility=hidden，释放后恢复原值', async () => {
  const node = makeHost();
  node.style.visibility = 'visible';
  openOverlay(1, 'takeover', { priority: 10 });
  assert(host().style.visibility === 'visible', '初始 visibility 应为 visible');
  let suppressed = false;
  await withOverlaysHidden(1, async () => {
    suppressed = host().getAttribute('data-bb-suppressed') !== null;
    assert(host().style.visibility === 'hidden', '抑制期间浮层必须隐藏，实际：' + host().style.visibility);
    assert(isOverlaySuppressed(1) === true, 'overlaySuppressionSnapshot 应标记 domHidden');
  });
  assert(suppressed === true, '应记录被抑制前的 visibility');
  assert(host().style.visibility === 'visible', '释放后应恢复原 visibility，实际：' + host().style.visibility);
  assert(host().getAttribute('data-bb-suppressed') === null, '恢复后应移除标记');
  assert(isOverlaySuppressed(1) === false, '释放后不应标记 domHidden');
  assert(overlaySuppressionSnapshot(1).domHolders === 0, 'domHolders 应归零');
  assert(getOverlayState(1).capturing === false, 'capture 锁应归零');
  closeOverlay(1, 'takeover');
  host().remove();
});

test('真实 DOM：dispatch 外层抑制 + overlay-suppress 内层，只有内层结束才恢复', async () => {
  const node = makeHost();
  node.style.visibility = 'visible';
  openOverlay(2, 'takeover', { priority: 10 });
  const scope = createSuppressionScope();
  const begun = scope.begin(2, { kind: SUPPRESSION_KINDS.CAPTURE, method: 'screenshot', owner: 'dispatch' });
  assert(begun.ok === true, 'scope.begin 失败');
  let innerSnapshot = null;
  await withOverlaysHidden(2, async () => {
    assert(host().style.visibility === 'hidden', '外层抑制存在时仍必须隐藏浮层');
    innerSnapshot = overlaySuppressionSnapshot(2);
  });
  assert(innerSnapshot.capture.count === 2, '嵌套时应有 dispatch + overlay-suppress 两个引用');
  assert(host().style.visibility === 'visible', '内层结束后浮层应恢复（截图已结束）');
  assert(scope.snapshot(2).count === 1, 'dispatch 引用仍在');
  const ended = scope.end(2, { scopeId: begun.scopeId, outcome: 'ok' });
  assert(ended.released === true, 'dispatch 引用应释放');
  assert(scope.snapshot(2).count === 0, '全部释放后 count 应为 0');
  closeOverlay(2, 'takeover');
  host().remove();
});

test('真实 DOM：重复 withOverlaysHidden 嵌套只隐藏一次，最外层释放才恢复', async () => {
  const node = makeHost();
  node.style.visibility = 'visible';
  openOverlay(3, 'takeover', { priority: 10 });
  let applied = 0;
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (options) => {
    const args = Array.isArray(options.args) ? options.args : [];
    if (args.length === 2 && typeof args[1] === 'boolean' && args[1] === true) applied += 1;
    return original(options);
  };
  try {
    await withOverlaysHidden(3, async () => {
      await withOverlaysHidden(3, async () => {
        assert(host().style.visibility === 'hidden', '嵌套内层应保持隐藏');
      });
      assert(host().style.visibility === 'hidden', '内层释放不应提前恢复');
    });
    assert(applied === 1, '只应 apply 一次 hide，实际 ' + applied);
    assert(host().style.visibility === 'visible', '最外层释放后恢复');
  } finally {
    chrome.scripting.executeScript = original;
    closeOverlay(3, 'takeover');
    host().remove();
  }
});

test('真实 DOM：2 帧 ack 后才算 effective（rAF 真实时钟）', async () => {
  const store = createCaptureSuppression();
  const lease = store.acquire(4, { owner: 'dom-real-ack' });
  assert(lease.effective === false, 'acquire 后不应立即 effective');
  await raf2();
  const snapshot = store.snapshot(4);
  assert(snapshot.effective === true, '两帧后应 effective');
  assert(snapshot.frame === 2, 'ack 帧数应为 2，实际 ' + snapshot.frame);
  const released = store.release(4, lease.token);
  assert(released.count === 0 && released.disabled === true, '释放应归零');
});

test('真实 DOM：controller 状态机迁移与非法拒绝证据', () => {
  const machine = createControllerStateMachine();
  assert(machine.transition(5, 'agent.claim', { holder: 'coop:5' }).ok === true, 'idle→agent 应合法');
  assert(machine.transition(5, 'human.take', { source: 'pointer' }).ok === true, 'agent→human 应合法');
  const illegal = machine.transition(5, 'hold.release', {});
  assert(illegal.ok === false && illegal.code === 'CONTROLLER_TRANSITION', 'human→hold.release 应被拒绝');
  assert(Array.isArray(illegal.evidence.allowed) && illegal.evidence.allowed.length > 0, '拒绝应给 allowed 列表');
  assert(machine.get(5) === 'human', '拒绝后状态不变');
});

test('真实 DOM：快照聚合浮层/controller/弃用计数，并渲染可读摘要', () => {
  const node = makeHost();
  openOverlay(6, 'takeover', { priority: 10 });
  const chain = createRevisionChain();
  chain.bump(6, { controlRevision: 2, authorityRevision: 1, frameEpoch: 1 });
  chain.observe(6, { revision: 4, document: location.href });
  const machine = createControllerStateMachine();
  machine.transition(6, 'agent.claim', { holder: 'coop:6' });
  const snapshot = buildControllerToolbarSnapshot({
    tabId: 6,
    controller: machine.snapshot(6),
    takeover: { paused: false, borrowed: false },
    overlays: getOverlayState(6),
    revisions: chain.record(6),
  });
  assert(snapshot.controller.state === 'agent', 'controller 状态应为 agent');
  assert(snapshot.toolbar.kind === 'takeover', 'toolbar kind 应为 takeover');
  assert(snapshot.toolbar.visible === true, '有浮层时应可见');
  assert(snapshot.toolbar.labels.title === 'Agent 已接管该标签页', '标签文案不对：' + snapshot.toolbar.labels.title);
  assert(snapshot.revisions.controlRevision === 2 && snapshot.revisions.revision === 4, '四项计数应透出');
  assert(snapshot.blocking.blocked === false, 'agent 态不应 blocked');
  const text = describeControllerToolbar(snapshot);
  assert(text.includes('controller=agent') && text.includes('toolbar=takeover'), '摘要不对：' + text);
  const stale = compareRevisionVectors(chain.record(6), { controlRevision: 1, revision: 9 });
  assert(stale.stale === true && stale.side === 'mixed', 'stale 方向应为 mixed');
  closeOverlay(6, 'takeover');
  host().remove();
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      const node = host();
      if (node) node.remove();
      document.title = 'COOP_CTRL_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'COOP_CTRL_OK:' + passed;
})();
