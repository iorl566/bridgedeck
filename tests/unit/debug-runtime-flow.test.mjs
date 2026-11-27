// tests/unit/debug-runtime-flow.test.mjs —— debug.js 运行时全链路（最小 chrome stub）。
//
// 这是 module-load 之外的「行为」门禁：用最小 chrome stub 真正跑一遍
// debug.start → pin → current → coverage → stop → history → detail → delete，
// 验证 journal 持久化、coverage/gaps、关联、导出 checksum、脱敏在真实函数体里生效。
import test from 'node:test';
import assert from 'node:assert/strict';

function createStorageArea() {
  const map = new Map();
  return {
    map,
    async get(key) {
      if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
      if (Array.isArray(key)) {
        const out = {};
        for (const item of key) if (map.has(item)) out[item] = map.get(item);
        return out;
      }
      if (key && typeof key === 'object') {
        const out = {};
        for (const [name, fallback] of Object.entries(key)) out[name] = map.has(name) ? map.get(name) : fallback;
        return out;
      }
      return {};
    },
    async set(patch) {
      for (const [name, value] of Object.entries(patch)) map.set(name, value);
    },
    async remove(key) {
      if (Array.isArray(key)) key.forEach((item) => map.delete(item));
      else map.delete(key);
    },
  };
}

const listener = () => ({ addListener() {}, removeListener() {} });
const local = createStorageArea();
const session = createStorageArea();
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.3.0' }),
    onMessage: listener(),
    onConnect: listener(),
    onInstalled: listener(),
    onStartup: listener(),
    sendMessage: async () => ({}),
    getURL: (part) => 'chrome-extension://stub/' + part,
    lastError: null,
  },
  storage: { local, session, onChanged: listener() },
  tabs: {
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://x.test/app', title: 'X' }),
    query: async () => [],
    update: async () => ({}),
    onRemoved: listener(),
    onUpdated: listener(),
    onCreated: listener(),
    onActivated: listener(),
    captureVisibleTab: async () => 'data:image/png;base64,',
  },
  webNavigation: {
    getAllFrames: async () => [
      { frameId: 0, parentFrameId: -1, url: 'https://x.test/app' },
      { frameId: 7, parentFrameId: 0, url: 'https://frame.test/embed' },
    ],
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
    onEvent: listener(),
    onDetach: listener(),
  },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
  alarms: { create: async () => {}, onAlarm: listener() },
};
globalThis.WebSocket = class {
  send() {}
  close() {}
};

const debug = await import('../../extension/src/debug.js');
const events = await import('../../extension/src/debug-events.js');
const { scanForPlaintextSecrets } = await import('../../extension/src/lib/debug-redact.js');

const TAB_ID = 9_601;

test('debug.start → pin → current：journal/coverage/timeline 在真实函数体里可用', async () => {
  const started = await debug.debugStart({ tabId: TAB_ID, bodies: true, name: 'runtime-flow' });
  assert.equal(started.ok, true);
  assert.equal(started.tabId, TAB_ID);
  assert.ok(started.startedAt > 0);

  let journal = events.readDebugEvents(TAB_ID);
  assert.deepEqual(journal.map((event) => event.type), ['start']);
  assert.equal(journal[0].name, 'runtime-flow');
  const startSeq = journal[0].seq;

  const pin = await debug.debugPin({ tabId: TAB_ID, id: 'req-1' });
  assert.deepEqual(pin.pinned, ['req-1']);
  const pinned = await debug.debugPinned();
  assert.deepEqual(pinned.pinned, ['req-1']);

  // 记录一条带 secret 的 replay 事件，验证持久化面脱敏（debug-events 单例）
  events.recordDebugEvent(TAB_ID, 'replay', {
    id: 1,
    method: 'POST',
    url: 'https://x.test/api?token=URL_SECRET',
    headers: { Authorization: 'Bearer AUTH_SECRET' },
  });

  const current = await debug.debugCurrent({ tabId: TAB_ID });
  assert.equal(current.ok, true);
  assert.equal(current.bodies, true);
  assert.deepEqual(current.journal.map((event) => event.type), ['start', 'pin', 'replay']);
  assert.ok(current.journal[2].seq > startSeq);
  assert.equal(current.coverage.phases.network.subscribed, true);
  assert.equal(current.journalSummary.count, 3);
  assert.equal(Array.isArray(current.timeline), true);
  assert.equal(typeof current.correlation.requests, 'number');
  assert.equal(JSON.stringify(current.journal).includes('URL_SECRET'), false);
  assert.equal(JSON.stringify(current.journal).includes('AUTH_SECRET'), false);

  const tasks = debug.debugTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'runtime-flow');
  const caps = debug.debugCapabilities();
  assert.equal(caps.features.journalPersistence, true);
  assert.equal(caps.features.journalChecksum, true);
  assert.equal(caps.features.correlation, true);
  assert.equal(caps.features.redaction, true);
});

test('debug.coverage：frames 来自 webNavigation，gaps 指出未订阅的 trace/screenshots', async () => {
  const report = await debug.debugCoverage({ tabId: TAB_ID });
  assert.equal(report.ok, true);
  assert.equal(report.active, true);
  assert.equal(report.requests.total, 0);
  assert.equal(report.coverage.phases.frames.observed, true);
  assert.equal(report.coverage.phases.frames.count, 2);
  assert.equal(report.gaps.some((gap) => gap.kind === 'network-empty'), true);
  assert.equal(report.gaps.some((gap) => gap.kind === 'trace-subscription'), true);
  // 截图/ WebSocket 管线已接线但窗口内为空：记为 observed=false，不谎报 not-subscribed
  assert.equal(report.coverage.phases.screenshots.subscribed, true);
  assert.equal(report.coverage.phases.screenshots.observed, false);
  assert.equal(report.coverage.phases.websockets.subscribed, true);
  assert.equal(report.complete, false);
  assert.equal(report.journal.events.length >= 3, true);
  assert.equal(report.journalStats.events >= 3, true);
  assert.match(report.gaps.find((gap) => gap.kind === 'trace-subscription').category, /^not-subscribed$/);
});

test('debug.stop：coverage/correlation/journalExport(checksum) 落入返回值与 history', async () => {
  const stopped = await debug.debugStop({ tabId: TAB_ID });
  assert.equal(stopped.ok, true);
  assert.match(stopped.id, /^[0-9a-f-]{8,}/);
  assert.equal(stopped.requests, 0);
  assert.equal(stopped.complete, false);
  assert.ok(Array.isArray(stopped.gaps));
  assert.equal(stopped.journalExport.verified, true);
  assert.match(stopped.journalExport.digest, /^[0-9a-f]{16}$/);
  assert.equal(stopped.journalExport.schema.name, 'bridgedeck.debug.journal');
  assert.equal(stopped.record.coverage.version, 1);
  assert.equal(stopped.record.correlation.requests, 0);
  assert.equal(stopped.record.journalSummary.count, 4);
  assert.equal(JSON.stringify(stopped.record.journalExport).includes('verified'), true);

  // 历史记录已落 chrome.storage.local，且是脱敏后的文本
  const stored = local.map.get('bb.debug.history');
  assert.equal(Array.isArray(stored), true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'runtime-flow');
  const storedText = JSON.stringify(stored[0]);
  assert.deepEqual(scanForPlaintextSecrets(storedText, ['URL_SECRET', 'AUTH_SECRET']).leaked, []);
  assert.equal(stored[0].journal.length, 4);
  assert.deepEqual(stored[0].journal.map((event) => event.type), ['start', 'pin', 'replay', 'stop']);

  const history = await debug.debugHistory();
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].name, 'runtime-flow');
  assert.equal(history.history[0].journal, 4);
  assert.equal(history.history[0].checksum, stopped.journalExport.digest);
  assert.equal(history.history[0].complete, false);
});

test('debug.history.detail：导出 envelope 可校验，query 分页结构稳定', async () => {
  const history = await debug.debugHistory();
  const id = history.history[0].id;
  const detail = await debug.debugHistoryDetail({ id });
  assert.equal(detail.ok, true);
  assert.equal(detail.record.id, id);
  assert.equal(detail.journalExport.schema.version, 1);
  assert.deepEqual(detail.verification, {
    ok: true,
    reason: 'verified',
    schema: { name: 'bridgedeck.debug.journal', version: 1 },
    digest: detail.journalExport.integrity.digest,
    bytes: detail.journalExport.integrity.bytes,
    events: 4,
    requests: 0,
    generatedAt: detail.verification.generatedAt,
  });
  assert.equal(detail.journalExportSummary.verified, true);
  assert.equal(detail.correlation.requests, 0);

  const queried = await debug.debugHistoryDetail({
    id,
    query: { url: '/api/', status: 200, limit: 10, offset: 0 },
  });
  assert.equal(queried.query.total, 0);
  assert.deepEqual(queried.query.items, []);
  assert.equal(queried.query.hasMore, false);
  assert.equal(queried.query.limit, 10);

  const missing = await debug.debugHistoryDetail({ id: 'nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /找不到/);
});

test('跨会话 seq 单调递增（clear 不重置全局 seq），delete 清历史', async () => {
  // debug.start 会 clearDebugEvents，但 seq 必须继续增长（否则恢复/排序会乱）
  const before = events.debugJournalStats().seq;
  await debug.debugStart({ tabId: TAB_ID, name: 'second-run' });
  const journal = events.readDebugEvents(TAB_ID);
  assert.deepEqual(journal.map((event) => event.type), ['start']);
  assert.equal(journal[0].seq > before, true);
  await debug.debugStop({ tabId: TAB_ID });
  assert.equal(events.debugJournalStats().seq > journal[0].seq, true);

  const history = await debug.debugHistory();
  assert.equal(history.history.length, 2);
  const target = history.history[0].id;
  const deleted = await debug.debugDelete({ id: target });
  assert.equal(deleted.removed, 1);
  assert.equal((await debug.debugHistory()).history.length, 1);
});
