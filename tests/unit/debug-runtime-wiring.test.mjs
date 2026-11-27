// tests/unit/debug-runtime-wiring.test.mjs —— debug-events 运行时桥接 + 新模块调用点守卫。
//
// debug-events.js 是扩展 service worker 的真实调用面（network.js / rules.js / debug.js
// 都同步调用 recordDebugEvent）。这里在 Node 里用内存 storage 跑同一套代码，验证：
//   - 事件序号单调、脱敏后落内存、按 tab 读取；
//   - begin/end/clear/forget 生命周期；
//   - snapshot → coverage / correlation / export 的完整链路；
//   - 源码调用点守卫：每个新模块都被 debug.js/debug-events.js 真正 import 并在函数体里调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginDebugJournalSession,
  clearDebugEvents,
  debugJournalSnapshot,
  debugJournalStats,
  debugJournalStore,
  debugJournalVersion,
  endDebugJournalSession,
  flushDebugEvents,
  forgetDebugEvents,
  hydrateDebugEvents,
  readDebugEvents,
  recordDebugEvent,
} from '../../extension/src/debug-events.js';
import { buildDebugCoverage, summarizeCoverage } from '../../extension/src/lib/debug-coverage.js';
import { buildDebugCorrelation, summarizeCorrelation } from '../../extension/src/lib/debug-correlation.js';
import { buildJournalExport, verifyJournalExport } from '../../extension/src/lib/debug-export.js';
import { scanForPlaintextSecrets } from '../../extension/src/lib/debug-redact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAB_ID = 9_701;

function resetTab() {
  forgetDebugEvents(TAB_ID);
  debugJournalStore()._state.hydrated = true; // 避免每个用例重复读空 storage
}

test('debug-events 运行时桥接：seq 单调、事件脱敏、按 tab 读取', async () => {
  resetTab();
  assert.equal(debugJournalVersion(), 2);
  beginDebugJournalSession(TAB_ID, { tabId: TAB_ID, url: 'https://x.test/?token=SESSION_SECRET', name: 'demo' });
  const first = recordDebugEvent(TAB_ID, 'start', { name: 'demo' });
  const second = recordDebugEvent(TAB_ID, 'replay', {
    id: 1,
    method: 'POST',
    url: 'https://x.test/api?access_token=REPLAY_SECRET',
    headers: { Authorization: 'Bearer HEADER_SECRET', Cookie: 'sid=COOKIE_SECRET' },
    ok: false,
    error: 'failed with token=ERROR_SECRET',
  });
  const third = recordDebugEvent(TAB_ID, 'pin', { id: 'req-1' });
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.equal(second.sessionId, 'tab-' + TAB_ID);
  assert.equal(second.type, 'replay');

  const events = readDebugEvents(TAB_ID);
  assert.deepEqual(events.map((event) => event.type), ['start', 'replay', 'pin']);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].method, 'POST');
  const scan = scanForPlaintextSecrets(JSON.stringify(events), ['SESSION_SECRET', 'REPLAY_SECRET', 'HEADER_SECRET', 'COOKIE_SECRET', 'ERROR_SECRET']);
  assert.deepEqual(scan.leaked, []);
  assert.match(events[1].url, /access_token=/);

  // 会话 meta 也脱敏
  const snapshot = debugJournalSnapshot(TAB_ID);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].meta.name, 'demo');
  assert.equal(JSON.stringify(snapshot.sessions[0].meta).includes('SESSION_SECRET'), false);

  const stats = debugJournalStats();
  assert.ok(stats.events >= 3);
  assert.equal(stats.hydrated, true);
  assert.equal(debugJournalStats().limits.maxSessionEvents, 200);

  // 非法 tabId 不写 journal
  assert.equal(recordDebugEvent('bad', 'start', {}), null);
  assert.equal(recordDebugEvent(1.5, 'start', {}), null);
});

test('debug-events 生命周期：end/clear/forget 与 flush', async () => {
  resetTab();
  beginDebugJournalSession(TAB_ID, { tabId: TAB_ID });
  recordDebugEvent(TAB_ID, 'start', {});
  recordDebugEvent(TAB_ID, 'rule', { action: 'add', id: 3 });
  const ended = endDebugJournalSession(TAB_ID, { requests: 2 });
  assert.ok(ended.endedAt > 0);
  assert.equal(ended.meta.requests, 2);

  const flushed = await flushDebugEvents();
  assert.equal(flushed.written, true);
  assert.ok(flushed.seq >= 2);

  assert.equal(clearDebugEvents(TAB_ID), 2);
  assert.deepEqual(readDebugEvents(TAB_ID), []);
  assert.equal(debugJournalSnapshot(TAB_ID).sessions[0].count, 0);

  assert.equal(forgetDebugEvents(TAB_ID), true);
  assert.equal(debugJournalSnapshot(TAB_ID).sessions.length, 0);
  assert.equal(clearDebugEvents('nope'), 0);
  assert.equal(forgetDebugEvents('nope'), false);
});

test('hydrate 在 Node（无 chrome）下 fail-safe 返回 empty', async () => {
  const result = await hydrateDebugEvents(TAB_ID);
  // 单例 store 第一次 hydrate 读内存 storage（空）→ empty；之后返回 already-hydrated。
  assert.equal(result.restored, false);
  assert.ok(['empty', 'already-hydrated'].includes(result.reason));
});

test('snapshot → coverage/correlation/export 全链路（真实调用点输入）', async () => {
  resetTab();
  beginDebugJournalSession(TAB_ID, { tabId: TAB_ID, url: 'https://x.test/', name: 'chain' });
  recordDebugEvent(TAB_ID, 'start', { name: 'chain' });
  recordDebugEvent(TAB_ID, 'pin', { id: 'req-1' });
  recordDebugEvent(TAB_ID, 'stop', { requests: 1 });
  const snapshot = debugJournalSnapshot(TAB_ID);
  assert.equal(snapshot.events.length, 3);
  assert.deepEqual(snapshot.byType, { start: 1, pin: 1, stop: 1 });
  assert.ok(snapshot.timeRange.from > 0 && snapshot.timeRange.to >= snapshot.timeRange.from);

  const requests = [{
    id: 1,
    method: 'GET',
    url: 'https://x.test/api/a',
    status: 200,
    startedAt: snapshot.events[1].at,
    durationMs: 12,
  }];
  const coverage = buildDebugCoverage({
    session: { id: 'tab-' + TAB_ID, tabId: TAB_ID, active: true, bodies: true, startedAt: snapshot.events[0].at },
    requests,
    requestsTotal: 1,
    console: [],
    consoleTotal: 0,
    frames: [{ frameId: 0 }],
    websockets: { sockets: [], total: 0 },
    trace: { traceEvents: [{ name: 'Task', ts: 1000 }] },
    screenshots: [],
    journal: snapshot,
    now: Date.now(),
  });
  assert.equal(coverage.coverage.phases.journal.observed, true);
  assert.equal(coverage.complete, false); // screenshots 未订阅
  assert.equal(summarizeCoverage(coverage).gaps, coverage.gaps.length);

  const correlation = buildDebugCorrelation({
    session: { id: 'tab-' + TAB_ID, tabId: TAB_ID },
    requests,
    journal: snapshot.events,
    screenshots: [],
    now: Date.now(),
  });
  assert.equal(correlation.summary.requests, 1);
  assert.equal(correlation.links[0].journal.length > 0, true);
  assert.equal(summarizeCorrelation(correlation).requests, 1);

  const envelope = buildJournalExport({
    session: { id: 'tab-' + TAB_ID, tabId: TAB_ID, name: 'chain' },
    journal: snapshot,
    requests,
    coverage,
    correlation,
    generatedAt: Date.now(),
  });
  const verified = verifyJournalExport(envelope);
  assert.equal(verified.ok, true);
  assert.equal(verified.events, 3);
  assert.equal(verified.requests, 1);
  assert.match(envelope.integrity.digest, /^[0-9a-f]{16}$/);

  const flushed = await flushDebugEvents({ force: true });
  assert.equal(flushed.written, true);
  resetTab();
});

test('调用点守卫：新模块都被 extension/src 运行时真正 import 并调用', () => {
  const debugSource = fs.readFileSync(path.join(ROOT, 'extension/src/debug.js'), 'utf8');
  const eventsSource = fs.readFileSync(path.join(ROOT, 'extension/src/debug-events.js'), 'utf8');
  const sources = { debug: debugSource, events: eventsSource };

  const imports = [
    { file: 'events', token: "from './lib/debug-journal-persist.js'" },
    { file: 'events', token: "from './lib/debug-redact.js'" },
    { file: 'debug', token: "from './lib/debug-coverage.js'" },
    { file: 'debug', token: "from './lib/debug-correlation.js'" },
    { file: 'debug', token: "from './lib/debug-export.js'" },
    { file: 'debug', token: "from './lib/debug-redact.js'" },
    { file: 'debug', token: "from './debug-events.js'" },
  ];
  for (const entry of imports) {
    assert.equal(sources[entry.file].includes(entry.token), true, entry.file + ' 缺少 import: ' + entry.token);
  }

  const callSites = [
    { file: 'events', token: 'createDebugJournalStore(' },
    { file: 'events', token: 'debugJournalStore().append(' },
    { file: 'events', token: 'redact: redactJournalEvent' },
    { file: 'events', token: 'debugJournalStore().flush(' },
    { file: 'events', token: 'debugJournalStore().hydrate(' },
    { file: 'debug', token: 'buildDebugCoverage({' },
    { file: 'debug', token: 'buildDebugCorrelation({' },
    { file: 'debug', token: 'queryRequests(' },
    { file: 'debug', token: 'buildJournalExport({' },
    { file: 'debug', token: 'verifyJournalExport(' },
    { file: 'debug', token: 'redactForPersistence(' },
    { file: 'debug', token: 'debugJournalSnapshot(' },
  ];
  for (const entry of callSites) {
    assert.equal(sources[entry.file].includes(entry.token), true, entry.file + ' 缺少调用点: ' + entry.token);
  }

  // 持久化前必须脱敏：debugStop 写 history 前调用 redactForPersistence
  const stopBody = debugSource.slice(debugSource.indexOf('export async function debugStop'), debugSource.indexOf('export async function debugHistory'));
  assert.match(stopBody, /redactForPersistence\(record\)/);
  // coverage 报告必须真的进入 debugCoverage 返回值
  const coverageBody = debugSource.slice(debugSource.indexOf('export async function debugCoverage'), debugSource.indexOf('export function debugTasks'));
  assert.match(coverageBody, /gaps: report\.gaps/);
  assert.match(coverageBody, /coverage: report\.coverage/);
});
