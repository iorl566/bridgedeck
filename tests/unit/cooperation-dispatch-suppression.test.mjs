// 【关键接线】capture suppression 真正包住 dispatch 的截图/原生输入路径：
// 开始时 acquire、finally release，失败/超时也释放，并有证据可查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const sent = [];
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: listener() },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: {
    onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(),
    query: async () => [],
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/form', title: 'form', index: 0, active: true }),
    create: async () => ({ id: 1 }),
    remove: async () => {},
    update: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,',
    async sendMessage(tabId, message) { sent.push({ tabId, message }); return { ok: true, generation: message && message.generation }; },
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1, type: 'normal' }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
  debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

const { HANDLERS, runSerialized } = await import('../../extension/src/dispatch.js');
const { captureSuppression } = await import('../../extension/src/lib/capture-suppression.js');
const { suppressionScope, SUPPRESSION_KINDS, SUPPRESSION_OUTCOMES } = await import('../../extension/src/lib/suppression-scope.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');

function observe(tabId) {
  const snapshot = captureSuppression.snapshot(tabId);
  return { count: snapshot.count, active: snapshot.active, holders: snapshot.holders.map((holder) => holder.owner) };
}

function cleanup(tabIds) {
  for (const tabId of tabIds) {
    captureSuppression.releaseAll(tabId);
    controllerState.clear(tabId);
  }
}

test('截图路径：截图中抑制生效（持有者 dispatch），结束后立即释放', async () => {
  const original = HANDLERS.screenshot;
  let during = null;
  try {
    HANDLERS.screenshot = async () => {
      during = observe(81);
      return { ok: true, dataUrl: 'data:image/png;base64,AA==' };
    };
    const result = await runSerialized('screenshot', { tabId: 81 });
    assert.equal(result.ok, true);
    assert.equal(during.active, true, '截图 handler 执行时 capture 抑制必须 active');
    assert.deepEqual(during.holders, ['dispatch']);
    assert.equal(during.count, 1);
    const after = observe(81);
    assert.equal(after.active, false, '截图结束后引用必须归零');
    const entries = suppressionScope.recent(81);
    assert.equal(entries.length >= 1, true);
    assert.equal(entries.at(-1).outcome, SUPPRESSION_OUTCOMES.OK);
    assert.equal(entries.at(-1).kind, SUPPRESSION_KINDS.CAPTURE);
    assert.equal(entries.at(-1).released, true);
  } finally {
    HANDLERS.screenshot = original;
    cleanup([81]);
  }
});

test('原生输入路径：click 整段持有 native-input 抑制，结束后释放', async () => {
  const original = HANDLERS.click;
  let during = null;
  try {
    HANDLERS.click = async () => { during = observe(82); return { ok: true }; };
    await runSerialized('click', { tabId: 82 });
    assert.equal(during.active, true, '原生输入期间 capture 抑制必须 active');
    assert.deepEqual(during.holders, ['dispatch']);
    assert.equal(observe(82).active, false);
    const entry = suppressionScope.recent(82).at(-1);
    assert.equal(entry.kind, SUPPRESSION_KINDS.NATIVE_INPUT);
    assert.equal(entry.outcome, SUPPRESSION_OUTCOMES.OK);
  } finally {
    HANDLERS.click = original;
    cleanup([82]);
  }
});

test('失败路径：handler 抛错时 finally 仍释放，释放结局记为 error', async () => {
  const original = HANDLERS.click;
  let during = null;
  try {
    HANDLERS.click = async () => { during = observe(83); throw new Error('handler-boom'); };
    await assert.rejects(() => runSerialized('click', { tabId: 83 }), /handler-boom/);
    assert.equal(during.active, true);
    assert.equal(observe(83).active, false, '失败路径必须释放抑制');
    const entry = suppressionScope.recent(83).at(-1);
    assert.equal(entry.outcome, SUPPRESSION_OUTCOMES.ERROR);
  } finally {
    HANDLERS.click = original;
    cleanup([83]);
  }
});

test('超时路径：看门狗强制释放（expired 证据），动作返回后引用也不残留', async () => {
  const original = HANDLERS.click;
  try {
    const previousMax = suppressionScope.setMaxHoldMs(60);
    HANDLERS.click = async () => {
      // 故意远超看门狗上限：模拟动作卡死，释放只能由看门狗完成。
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true };
    };
    await runSerialized('click', { tabId: 84 });
    assert.equal(captureSuppression.snapshot(84).active, false, '看门狗超时后必须释放');
    const history = suppressionScope.recent(84);
    const expired = history.find((entry) => entry.expired === true || entry.kind === 'expired');
    assert.ok(expired, '缺少看门狗超时释放证据');
    assert.equal(expired.outcome, SUPPRESSION_OUTCOMES.EXPIRED);
    assert.equal(suppressionScope.counters().expired >= 1, true);
    suppressionScope.setMaxHoldMs(previousMax);
  } finally {
    HANDLERS.click = original;
    cleanup([84]);
    suppressionScope.setMaxHoldMs(180000);
  }
});

test('嵌套：dispatch 外层引用 + overlay-suppress 内层引用，只有归零才真正解除', async () => {
  const { withOverlaysHidden } = await import('../../extension/src/overlay-suppress.js');
  const { openOverlay, closeOverlay } = await import('../../extension/src/overlay-state.js');
  const hiddenCalls = [];
  const originalExecute = chrome.scripting.executeScript;
  const original = HANDLERS.click;
  try {
    chrome.scripting.executeScript = async (options) => {
      const args = options && Array.isArray(options.args) ? options.args : null;
      // overlay-suppress 的 apply 调用形如 args=[HOST_IDS, hidden(boolean)]。
      if (args && args.length === 2 && typeof args[1] === 'boolean') hiddenCalls.push(args[1]);
      return [];
    };
    openOverlay(85, 'takeover', { priority: 10 });
    let inner = null;
    let afterInner = null;
    HANDLERS.click = async () => {
      await withOverlaysHidden(85, async () => { inner = observe(85); });
      afterInner = observe(85);
      return { ok: true };
    };
    await runSerialized('click', { tabId: 85 });
    assert.equal(inner.count, 2, 'dispatch 外层 + overlay-suppress 内层应有两个引用');
    assert.deepEqual(inner.holders, ['dispatch', 'overlay-suppress']);
    assert.equal(afterInner.count, 1, '内层释放后外层仍持有');
    assert.deepEqual(hiddenCalls, [true, false], '浮层隐藏/恢复各一次');
    assert.equal(observe(85).active, false);
    closeOverlay(85, 'takeover');
  } finally {
    chrome.scripting.executeScript = originalExecute;
    HANDLERS.click = original;
    cleanup([85]);
  }
});

test('ops 录制步骤截图也接 suppression（源码调用点 + run 语义一致）', async () => {
  const source = readFileSync(new URL('../../extension/src/ops.js', import.meta.url), 'utf8');
  assert.match(source, /suppressionScope\.run\(session\.tabId, \{ kind: SUPPRESSION_KINDS\.RECORD_SHOT/);
  assert.match(source, /withOverlaysHidden\(session\.tabId, \(\) => captureStepShotInner/);
  // run() 的通用语义：record-shot 作用域异常也释放。
  let activeDuring = false;
  await assert.rejects(
    () => suppressionScope.run(86, { kind: SUPPRESSION_KINDS.RECORD_SHOT, method: 'record.step-shot', owner: 'ops' }, async () => {
      activeDuring = captureSuppression.snapshot(86).active;
      throw new Error('shot-failed');
    }),
    /shot-failed/,
  );
  assert.equal(activeDuring, true);
  assert.equal(captureSuppression.snapshot(86).active, false);
  cleanup([86]);
});
