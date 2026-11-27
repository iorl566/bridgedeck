// tests/unit/replay-boundary-exec.test.mjs —— 边界还原执行器（真实 documentId/URL 轨迹判定 + 阻断证据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../../extension/src/lib/replay-boundary-exec.js';
import { planBoundaryRestoration } from '../../extension/src/lib/replay-boundary-plan.js';
import { buildReplayPlan } from '../../extension/src/lib/replay-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function stepOf(options = {}) {
  const ref = options.ref || 'r';
  const evidence = {
    documentId: options.documentId || 'doc-1',
    frameId: options.frameId === undefined ? 0 : options.frameId,
    revision: options.revision === undefined ? 1 : options.revision,
    url: options.url !== undefined ? options.url : 'https://a.test/',
  };
  return {
    ref,
    kind: options.kind || 'action',
    method: options.method || 'click',
    params: options.params || { selector: '#' + ref },
    target: options.target || { selector: '#' + ref },
    idempotent: options.idempotent !== false,
    evidence,
    boundary: evidence,
    ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
  };
}

function navigatePlan() {
  const steps = [
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/', revision: 1 }),
    stepOf({
      ref: 'r2',
      documentId: 'doc-2',
      url: 'https://b.test/',
      revision: 1,
      kind: 'branch',
      method: 'navigate',
      branch: { boundary: 'document', url: 'https://b.test/' },
    }),
  ];
  return planBoundaryRestoration(steps, {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
    frames: [{ frameId: 0, parentFrameId: -1, url: 'https://a.test/' }],
  });
}

function framePlan(includeFrame = true) {
  const steps = [
    stepOf({ ref: 'r1', documentId: 'doc-1', frameId: 0, url: 'https://a.test/', revision: 1 }),
    stepOf({ ref: 'r2', documentId: 'doc-1', frameId: 7, url: 'https://a.test/frame', revision: 2 }),
  ];
  const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://a.test/' }];
  if (includeFrame) frames.push({ frameId: 7, parentFrameId: 0, url: 'https://a.test/frame' });
  return planBoundaryRestoration(steps, {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
    frames,
  });
}

function tabPlan() {
  const steps = [
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/', tabId: 1 }),
    stepOf({
      ref: 'r2',
      documentId: 'doc-2',
      url: 'https://c.test/',
      tabId: 2,
      kind: 'branch',
      method: 'navigate',
      branch: { boundary: 'tab-switch' },
    }),
  ];
  return planBoundaryRestoration(steps, {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/', tabId: 1 },
  });
}

function traceEntry(fields) {
  return { kind: 'identity', ...fields };
}

// ---------------------------------------------------------------------------
// 常量 / 条目归一
// ---------------------------------------------------------------------------

test('边界执行器版本/结果码/码表与既有 BOUNDARY_CODES 同源', () => {
  assert.equal(B.REPLAY_BOUNDARY_EXEC_VERSION, 2);
  assert.equal(B.BOUNDARY_EXEC_CODES.OK, 'BOUNDARY_EXEC_OK');
  assert.equal(B.BOUNDARY_EXEC_CODES.FRAME_MISSING, 'BOUNDARY_EXEC_FRAME_MISSING');
  assert.equal(B.BOUNDARY_EXEC_LIMITS.maxEntries, 2000);
  assert.deepEqual([...B.BOUNDARY_TRACE_KINDS], ['identity', 'navigation', 'frame-switch', 'tab-switch', 'resume', 'observation']);
  assert.equal(B.BOUNDARY_EXEC_CATALOG_CODES[B.BOUNDARY_EXEC_CODES.FRAME_MISSING], 'BOUNDARY_FRAME_UNAVAILABLE');
  assert.equal(B.BOUNDARY_EXEC_BOUNDARY_CODES.URL_MISSING, 'BOUNDARY_URL_MISSING');
});

test('normalizeTraceEntry：读取 CDP loaderId / chrome documentId / 帧 / tab / 时间戳', () => {
  const entry = B.normalizeTraceEntry({
    kind: 'page',
    atMs: 123,
    documentId: '6F1A2B3C4D5E6F708192A3B4C5D6E7F8',
    frameId: 3,
    url: 'https://a.test/page?q=1#h',
    revision: 5,
    loaderId: 'loader-xyz',
    tabId: 9,
    status: 200,
  }, 4);
  assert.equal(entry.kind, 'navigation');
  assert.equal(entry.atMs, 123);
  assert.equal(entry.sourceIndex, 4);
  assert.equal(entry.frameId, 3);
  assert.equal(entry.urlKey, 'https://a.test/page?q=1');
  assert.equal(entry.revision, 5);
  assert.equal(entry.loaderId, 'loader-xyz');
  assert.equal(entry.tabId, 9);
  assert.equal(entry.status, 200);
  assert.equal(entry.index, 0);
});

test('normalizeTraceEntry：接受 step/evidence 形状；全空条目返回 null', () => {
  const entry = B.normalizeTraceEntry({ evidence: { documentId: 'doc-1', frameId: 0, revision: 2, url: 'https://a.test/' } }, 0);
  assert.equal(entry.documentId, 'doc-1');
  assert.equal(entry.revision, 2);
  assert.equal(B.normalizeTraceEntry({}, 0), null);
  assert.equal(B.normalizeTraceEntry(null, 0), null);
  assert.equal(B.normalizeTraceEntry('x', 0), null);
  const unknownKind = B.normalizeTraceEntry({ kind: 'weird', url: 'https://a.test/' }, 0);
  assert.equal(unknownKind.kind, 'identity');
});

test('normalizeBoundaryTrace：空轨迹确定；非法条目记 issue；摘要稳定', () => {
  const empty = B.normalizeBoundaryTrace([]);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.summary.entries, 0);
  assert.equal(typeof empty.digest, 'string');
  assert.deepEqual(B.normalizeBoundaryTrace(null).entries, []);

  const trace = B.normalizeBoundaryTrace([null, { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }, { foo: 1 }]);
  assert.equal(trace.entries.length, 1);
  assert.equal(trace.issues.some((issue) => issue.code === B.BOUNDARY_EXEC_CODES.TRACE_INVALID), true);
  assert.equal(trace.summary.documents, 1);
  assert.equal(trace.summary.frames, 1);
  assert.equal(trace.summary.urls, 1);
  assert.equal(trace.summary.kinds.identity, 1);
});

test('normalizeBoundaryTrace：有时间戳时按时间稳定重排；无时间戳保持输入序', () => {
  const reordered = B.normalizeBoundaryTrace([
    traceEntry({ atMs: 30, documentId: 'doc-3', url: 'https://c.test/' }),
    traceEntry({ atMs: 10, documentId: 'doc-1', url: 'https://a.test/' }),
    traceEntry({ atMs: 20, documentId: 'doc-2', url: 'https://b.test/' }),
  ]);
  assert.deepEqual(reordered.entries.map((entry) => entry.documentId), ['doc-1', 'doc-2', 'doc-3']);
  assert.equal(reordered.reordered, true);
  assert.equal(reordered.issues.some((issue) => issue.code === B.BOUNDARY_EXEC_CODES.TRACE_INVALID), true);

  const ordered = B.normalizeBoundaryTrace([
    traceEntry({ documentId: 'doc-2', url: 'https://b.test/' }),
    traceEntry({ documentId: 'doc-1', url: 'https://a.test/' }),
  ]);
  assert.deepEqual(ordered.entries.map((entry) => entry.documentId), ['doc-2', 'doc-1']);
  assert.equal(ordered.reordered, false);
});

test('normalizeBoundaryTrace：上限截断、revision 回退、导航条目缺 URL 都有 issue', () => {
  const many = [];
  for (let index = 0; index < 10; index += 1) many.push(traceEntry({ documentId: 'doc-' + index, url: 'https://a.test/' + index }));
  const truncated = B.normalizeBoundaryTrace(many, { maxEntries: 3 });
  assert.equal(truncated.entries.length, 3);
  assert.equal(truncated.issues.some((issue) => issue.code === B.BOUNDARY_EXEC_CODES.TRACE_TRUNCATED), true);

  const regressed = B.normalizeBoundaryTrace([
    traceEntry({ documentId: 'doc-1', revision: 5, url: 'https://a.test/' }),
    traceEntry({ documentId: 'doc-1', revision: 3, url: 'https://a.test/' }),
  ]);
  assert.equal(regressed.issues.some((issue) => issue.code === B.BOUNDARY_EXEC_CODES.STALE_DOCUMENT), true);

  const navNoUrl = B.normalizeBoundaryTrace([traceEntry({ kind: 'navigation', documentId: 'doc-1' })]);
  assert.equal(navNoUrl.issues.some((issue) => issue.code === B.BOUNDARY_EXEC_CODES.URL_MISSING), true);
});

test('traceDigestOf：同轨迹不同标签/时间 → 同指纹；身份不同 → 不同指纹', () => {
  const left = B.normalizeBoundaryTrace([
    traceEntry({ atMs: 1, label: 'a', documentId: 'doc-1', frameId: 0, url: 'https://a.test/', revision: 1 }),
    traceEntry({ atMs: 2, label: 'b', documentId: 'doc-2', frameId: 0, url: 'https://b.test/', revision: 1 }),
  ]);
  const right = B.normalizeBoundaryTrace([
    traceEntry({ atMs: 9, label: 'x', documentId: 'doc-1', frameId: 0, url: 'https://a.test/#frag', revision: 1 }),
    traceEntry({ atMs: 10, label: 'y', documentId: 'doc-2', frameId: 0, url: 'https://b.test/', revision: 1 }),
  ]);
  assert.equal(left.digest, right.digest);
  const different = B.normalizeBoundaryTrace([traceEntry({ documentId: 'doc-9', url: 'https://z.test/' })]);
  assert.notEqual(different.digest, left.digest);
});

test('traceIdentitySeries：document/frame/url/revision 变化都被确定性记录', () => {
  const trace = B.normalizeBoundaryTrace([
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/', revision: 1 }),
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/next', revision: 1 }),
    traceEntry({ documentId: 'doc-1', frameId: 5, url: 'https://a.test/frame', revision: 1 }),
    traceEntry({ documentId: 'doc-2', frameId: 5, url: 'https://b.test/frame', revision: 1 }),
    traceEntry({ documentId: 'doc-2', frameId: 5, url: 'https://b.test/frame', revision: 2 }),
  ]);
  const series = B.traceIdentitySeries(trace);
  assert.equal(series.points.length, 5);
  assert.deepEqual(series.transitions.map((transition) => transition.kind), ['url', 'frame', 'document', 'revision']);
  assert.equal(series.changed, 4);
  assert.equal(series.lastIdentity.documentId, 'doc-2');
  assert.equal(B.traceIdentitySeries(trace).digest, series.digest);
});

test('matchTraceIdentity：命中 / requireUrl 拒绝 / 无命中给最近证据', () => {
  const trace = B.normalizeBoundaryTrace([
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/one' }),
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/two' }),
  ]);
  const hit = B.matchTraceIdentity(trace, { documentId: 'doc-1', frameId: 0, url: 'https://a.test/one' }, { requireUrl: true });
  assert.equal(hit.found, true);
  assert.equal(hit.index, 0);
  assert.equal(hit.entry.urlKey, 'https://a.test/one');

  const missUrl = B.matchTraceIdentity(trace, { documentId: 'doc-1', frameId: 0, url: 'https://a.test/three' }, { requireUrl: true });
  assert.equal(missUrl.found, false);

  const miss = B.matchTraceIdentity(trace, { documentId: 'doc-9', frameId: 0 }, {});
  assert.equal(miss.found, false);
  assert.equal(miss.nearest !== null, true);
  assert.equal(miss.relation.length > 0, true);
});

test('summarizeIdentity：只输出有界身份证据', () => {
  const summary = B.summarizeIdentity({ documentId: 'doc-' + 'x'.repeat(200), frameId: 2, revision: 4, url: 'https://a.test/p?q=1#h', tabId: 3 });
  assert.equal(summary.frameId, 2);
  assert.equal(summary.revision, 4);
  assert.equal(summary.urlKey, 'https://a.test/p?q=1');
  assert.equal(summary.tabId, 3);
  assert.equal(summary.documentId.length <= 48, true);
});

// ---------------------------------------------------------------------------
// 计划适配 / 判定
// ---------------------------------------------------------------------------

test('boundaryPlanOf：接受 plan / boundaries / steps 三种输入', () => {
  const plan = navigatePlan();
  assert.equal(B.boundaryPlanOf(plan), plan);
  assert.equal(B.boundaryPlanOf({ boundaries: plan }), plan);
  const fromSteps = B.boundaryPlanOf({ steps: [
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/' }),
  ] });
  assert.equal(Array.isArray(fromSteps.epochs), true);
  assert.equal(fromSteps.epochs.length, 1);
  assert.equal(B.boundaryPlanOf(null), null);
  assert.equal(B.boundaryPlanOf({ foo: 1 }), null);
});

test('evaluateBoundaryExecution：没有边界计划 → PLAN_MISSING', () => {
  const result = B.evaluateBoundaryExecution(null, []);
  assert.equal(result.ok, false);
  assert.equal(result.code, B.BOUNDARY_EXEC_CODES.PLAN_MISSING);
  assert.equal(result.blockers.length, 1);
});

test('evaluateBoundaryExecution：空轨迹 + 有计划 → TRACE_EMPTY 阻断（拒绝用当前页面猜）', () => {
  const result = B.evaluateBoundaryExecution(navigatePlan(), []);
  assert.equal(result.ok, false);
  assert.equal(result.code, B.BOUNDARY_EXEC_CODES.BLOCKED);
  assert.equal(result.blockers[0].code, B.BOUNDARY_EXEC_CODES.TRACE_EMPTY);
  assert.equal(result.epochs.every((row) => row.status !== 'matched'), true);
});

test('evaluateBoundaryExecution：轨迹覆盖两个 epoch → 全部 matched，指纹两次一致', () => {
  const trace = [
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }),
    traceEntry({ documentId: 'doc-2', frameId: 0, url: 'https://b.test/' }),
  ];
  const first = B.evaluateBoundaryExecution(navigatePlan(), trace);
  const second = B.evaluateBoundaryExecution(navigatePlan(), trace);
  assert.equal(first.ok, true);
  assert.equal(first.code, B.BOUNDARY_EXEC_CODES.OK);
  assert.equal(first.matched, 2);
  assert.equal(first.needsAction, 0);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.epochs.map((row) => row.status), ['matched', 'matched']);
  assert.equal(first.epochs[1].match.source, 'trace');
});

test('evaluateBoundaryExecution：轨迹缺第二文档但录了 URL → needs-action（可执行还原）', () => {
  const trace = [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })];
  const result = B.evaluateBoundaryExecution(navigatePlan(), trace);
  assert.equal(result.ok, true);
  assert.equal(result.code, B.BOUNDARY_EXEC_CODES.NEEDS_ACTION);
  assert.equal(result.needsAction, 1);
  const row = result.epochs[1];
  assert.equal(row.status, 'needs-action');
  assert.equal(row.target.action, 'navigate');
  assert.equal(row.target.urlKey, 'https://b.test/');
  assert.equal(row.evidence.expectedUrlKey, 'https://b.test/');
});

test('evaluateBoundaryExecution：换文档但录制里没有 URL → URL_MISSING（拒绝猜）', () => {
  const steps = [
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/' }),
    stepOf({ ref: 'r2', documentId: 'doc-2', url: '' }),
  ];
  const plan = planBoundaryRestoration(steps, { current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' } });
  const result = B.evaluateBoundaryExecution(plan, [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })]);
  assert.equal(result.ok, false);
  assert.equal(result.epochs[1].code, B.BOUNDARY_EXEC_CODES.URL_MISSING);
  assert.equal(result.blockers.some((blocker) => blocker.code === B.BOUNDARY_EXEC_CODES.URL_MISSING), true);
});

test('evaluateBoundaryExecution：帧树里缺录制帧 → FRAME_MISSING 带可用帧证据', () => {
  const result = B.evaluateBoundaryExecution(framePlan(false), [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })]);
  assert.equal(result.ok, false);
  assert.equal(result.epochs[1].code, B.BOUNDARY_EXEC_CODES.FRAME_MISSING);
  const blocker = result.blockers.find((item) => item.code === B.BOUNDARY_EXEC_CODES.FRAME_MISSING);
  assert.equal(blocker.evidence.frameId, 7);
  assert.equal(Array.isArray(blocker.evidence.availableFrames), true);
});

test('evaluateBoundaryExecution：帧可切换 → needs-action 带 frameId/frameUrl', () => {
  const result = B.evaluateBoundaryExecution(framePlan(true), [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })]);
  assert.equal(result.ok, true);
  assert.equal(result.epochs[1].status, 'needs-action');
  assert.equal(result.epochs[1].target.action, 'frame-switch');
  assert.equal(result.epochs[1].target.frameId, 7);
  assert.equal(result.epochs[1].target.frameUrl, 'https://a.test/frame');
});

test('evaluateBoundaryExecution：tab 切换缺 tabId → TAB_MISSING；有 tabId → needs-action', () => {
  const stepsMissingTab = [
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/', tabId: 1 }),
    {
      ref: 'r2',
      kind: 'branch',
      method: 'navigate',
      params: {},
      target: null,
      idempotent: true,
      evidence: { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' },
      boundary: { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' },
      branch: { boundary: 'tab-switch' },
    },
  ];
  const missingPlan = planBoundaryRestoration(stepsMissingTab, { current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/', tabId: 1 } });
  const missingTrace = [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/', tabId: 1 })];
  const missing = B.evaluateBoundaryExecution(missingPlan, missingTrace);
  assert.equal(missing.ok, false);
  assert.equal(missing.epochs[1].code, B.BOUNDARY_EXEC_CODES.TAB_MISSING);

  const result = B.evaluateBoundaryExecution(tabPlan(), [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/', tabId: 1 })]);
  assert.equal(result.ok, true);
  assert.equal(result.epochs[1].status, 'needs-action');
  assert.equal(result.epochs[1].target.action, 'tab-switch');
  assert.equal(result.epochs[1].target.tabId, 2);
});

test('evaluateBoundaryExecution：显式 current 可证明身份（source=current）', () => {
  const plan = planBoundaryRestoration([stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/' })], {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
  });
  const otherTrace = [traceEntry({ documentId: 'doc-other', frameId: 0, url: 'https://other.test/' })];
  const result = B.evaluateBoundaryExecution(plan, otherTrace, { current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' } });
  assert.equal(result.ok, true);
  assert.equal(result.epochs[0].match.source, 'current');
});

test('evaluateBoundaryExecution：轨迹顺序与录制矛盾 → ORDER 阻断', () => {
  const trace = [
    traceEntry({ documentId: 'doc-2', frameId: 0, url: 'https://b.test/' }),
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }),
  ];
  const result = B.evaluateBoundaryExecution(navigatePlan(), trace);
  assert.equal(result.ok, false);
  assert.equal(result.blockers.some((blocker) => blocker.code === B.BOUNDARY_EXEC_CODES.ORDER), true);
});

// ---------------------------------------------------------------------------
// 执行（navigate / frame-switch / tab-switch / resume）
// ---------------------------------------------------------------------------

function currentTraceOnly() {
  return [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })];
}

test('executeBoundaryRestoration：判定被阻断时一个 provider 都不调用', async () => {
  let called = 0;
  const result = await B.executeBoundaryRestoration(navigatePlan(), [], {
    navigate: async () => { called += 1; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(called, 0);
  assert.equal(result.blocked.length > 0, true);
});

test('executeBoundaryRestoration：navigate 成功 → 用真实身份证明 URL 与文档切换', async () => {
  const calls = [];
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async (action) => {
      calls.push(action.url);
      return { ok: true };
    },
    sampleIdentity: async () => ({ documentId: 'doc-new-2', frameId: 0, url: 'https://b.test/' }),
  });
  assert.deepEqual(calls, ['https://b.test/']);
  assert.equal(result.ok, true);
  assert.equal(result.code, B.BOUNDARY_EXEC_CODES.RESUME_OK);
  const action = result.actions[0];
  assert.equal(action.action, 'navigate');
  assert.equal(action.code, B.BOUNDARY_EXEC_CODES.NAVIGATE_OK);
  assert.equal(action.before.documentId, 'doc-1');
  assert.equal(action.after.documentId, 'doc-new-2');
  assert.equal(action.evidence.expectedUrlKey, 'https://b.test/');

  const again = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-new-2', frameId: 0, url: 'https://b.test/' }),
  });
  assert.equal(again.digest, result.digest);
});

test('executeBoundaryRestoration：导航后 URL 不对 → NAVIGATE_URL_MISMATCH 带 before/after 证据', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-new-2', frameId: 0, url: 'https://wrong.test/' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].code, B.BOUNDARY_EXEC_CODES.NAVIGATE_URL_MISMATCH);
  assert.equal(result.blocked[0].evidence.expectedUrlKey, 'https://b.test/');
  assert.equal(result.blocked[0].evidence.actualUrlKey, 'https://wrong.test/');
  assert.equal(result.actions[0].after.urlKey, 'https://wrong.test/');
});

test('executeBoundaryRestoration：导航 provider 返成功但身份没变 → NAVIGATE_NOT_CONFIRMED', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-1', frameId: 0, url: 'https://b.test/' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].code, B.BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED);
});

test('executeBoundaryRestoration：缺 navigate provider → PROVIDER_MISSING（不假装还原）', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {});
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].code, B.BOUNDARY_EXEC_CODES.PROVIDER_MISSING);
  assert.equal(result.actions[0].code, B.BOUNDARY_EXEC_CODES.PROVIDER_MISSING);
  assert.equal(B.explainBoundaryExecution(result).code, 'BOUNDARY_NAVIGATION_REQUIRED');
});

test('executeBoundaryRestoration：provider 抛错 / 返回 ok:false → 阻断并保留证据', async () => {
  const thrown = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => { throw new Error('target closed'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.blocked[0].code, B.BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED);
  assert.equal(thrown.blocked[0].message.includes('target closed'), true);

  const refused = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: false, reason: 'navigation cancelled', code: 'BOUNDARY_NAVIGATION_REQUIRED' }),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked[0].code, 'BOUNDARY_NAVIGATION_REQUIRED');
  assert.equal(refused.actions[0].evidence.reason, 'navigation cancelled');
});

test('executeBoundaryRestoration：frame-switch 成功/URL 不一致/帧不一致', async () => {
  const good = await B.executeBoundaryRestoration(framePlan(true), currentTraceOnly(), {
    switchFrame: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-1', frameId: 7, url: 'https://a.test/frame' }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.actions[0].code, B.BOUNDARY_EXEC_CODES.FRAME_OK);
  assert.equal(good.actions[0].evidence.frameId, 7);

  const wrongUrl = await B.executeBoundaryRestoration(framePlan(true), currentTraceOnly(), {
    switchFrame: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-1', frameId: 7, url: 'https://a.test/wrong' }),
  });
  assert.equal(wrongUrl.ok, false);
  assert.equal(wrongUrl.blocked[0].code, B.BOUNDARY_EXEC_CODES.FRAME_URL_MISMATCH);

  const wrongFrame = await B.executeBoundaryRestoration(framePlan(true), currentTraceOnly(), {
    switchFrame: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }),
  });
  assert.equal(wrongFrame.ok, false);
  assert.equal(wrongFrame.blocked[0].code, B.BOUNDARY_EXEC_CODES.FRAME_NOT_CONFIRMED);
});

test('executeBoundaryRestoration：tab-switch 成功 / tabId 不一致', async () => {
  const good = await B.executeBoundaryRestoration(tabPlan(), currentTraceOnly(), {
    switchTab: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-2', frameId: 0, url: 'https://c.test/', tabId: 2 }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.actions[0].code, B.BOUNDARY_EXEC_CODES.TAB_OK);

  const wrong = await B.executeBoundaryRestoration(tabPlan(), currentTraceOnly(), {
    switchTab: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-2', frameId: 0, url: 'https://c.test/', tabId: 3 }),
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.blocked[0].code, B.BOUNDARY_EXEC_CODES.TAB_NOT_CONFIRMED);
});

test('executeBoundaryRestoration：无采样身份 → 无法证明（NOT_CONFIRMED）', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].code, B.BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED);
  assert.equal(result.actions[0].after, null);
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test('resumeFromRealTrace：轨迹当前身份命中 epoch → 给出 fromIndex 与证据', () => {
  const trace = B.normalizeBoundaryTrace([
    traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }),
    traceEntry({ documentId: 'doc-2', frameId: 0, url: 'https://b.test/' }),
  ]);
  const plan = navigatePlan();
  const resume = B.resumeFromRealTrace(plan, trace);
  assert.equal(resume.ok, true);
  assert.equal(resume.code, B.BOUNDARY_EXEC_CODES.RESUME_OK);
  assert.equal(resume.fromIndex, plan.epochs[1].startIndex);
  assert.equal(resume.epoch, 1);
  assert.equal(resume.relation, 'same');
  assert.equal(typeof resume.evidence.traceDigest, 'string');
});

test('resumeFromRealTrace：身份不匹配 → RESUME_NO_MATCH + 最近 epoch 证据（不猜起点）', () => {
  const trace = B.normalizeBoundaryTrace([traceEntry({ documentId: 'doc-x', frameId: 9, url: 'https://x.test/' })]);
  const resume = B.resumeFromRealTrace(navigatePlan(), trace);
  assert.equal(resume.ok, false);
  assert.equal(resume.code, B.BOUNDARY_EXEC_CODES.RESUME_NO_MATCH);
  assert.equal(resume.fromIndex, 0);
  assert.equal(resume.nearest !== null, true);
  assert.equal(typeof resume.traceDigest, 'string');
});

test('resumeFromRealTrace：没有当前身份 / 没有计划 → 显式失败', () => {
  const unknown = B.resumeFromRealTrace(navigatePlan(), []);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, B.BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN);
  const noPlan = B.resumeFromRealTrace(null, []);
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.code, B.BOUNDARY_EXEC_CODES.PLAN_MISSING);
});

// ---------------------------------------------------------------------------
// 解释 / 摘要 / 自检 / 确定性
// ---------------------------------------------------------------------------

test('explainBoundaryExecution：成功的执行返回 null；阻断映射到失败目录码', async () => {
  const good = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-new', frameId: 0, url: 'https://b.test/' }),
  });
  assert.equal(B.explainBoundaryExecution(good), null);

  const frameBlocked = B.evaluateBoundaryExecution(framePlan(false), currentTraceOnly());
  const explanation = B.explainBoundaryExecution(frameBlocked);
  assert.equal(explanation.code, 'BOUNDARY_FRAME_UNAVAILABLE');
  assert.equal(explanation.category, 'boundary');
  assert.equal(explanation.boundaryExecution.code, B.BOUNDARY_EXEC_CODES.FRAME_MISSING);
  assert.equal(typeof explanation.boundaryExecution.traceDigest, 'string');
});

test('summarizeBoundaryExecution / formatBoundaryExecution：有界稳定', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-new', frameId: 0, url: 'https://b.test/' }),
  });
  const summary = B.summarizeBoundaryExecution(result);
  assert.equal(summary.ok, true);
  assert.equal(summary.version, 2);
  assert.equal(summary.trace.entries, 1);
  assert.equal(summary.actions.length, 1);
  assert.equal(summary.resume.ok, true);
  const text = B.formatBoundaryExecution(result);
  assert.equal(text.includes('边界还原 成功'), true);
  assert.equal(text.split('\n').length <= 20, true);
  assert.equal(B.formatBoundaryExecution(null), '边界还原：无结果');

  const blocked = B.evaluateBoundaryExecution(framePlan(false), currentTraceOnly());
  const blockedText = B.formatBoundaryExecution(blocked);
  assert.equal(blockedText.includes('阻断'), true);
});

test('verifyBoundaryExecutionEvidence：成功证据齐全；人为缺字段能检出', async () => {
  const result = await B.executeBoundaryRestoration(navigatePlan(), currentTraceOnly(), {
    navigate: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-new', frameId: 0, url: 'https://b.test/' }),
  });
  assert.equal(B.verifyBoundaryExecutionEvidence(result).ok, true);
  const broken = B.verifyBoundaryExecutionEvidence({ actions: [{ epoch: 0 }], blocked: [{}], trace: {} });
  assert.equal(broken.ok, false);
  assert.equal(broken.issues.length > 0, true);
});

test('boundaryExecutionDigest：同轨迹/同 providers 两次执行 → 同摘要', async () => {
  const run = () => B.executeBoundaryRestoration(framePlan(true), currentTraceOnly(), {
    switchFrame: async () => ({ ok: true }),
    sampleIdentity: async () => ({ documentId: 'doc-1', frameId: 7, url: 'https://a.test/frame' }),
  });
  const first = await run();
  const second = await run();
  assert.equal(B.boundaryExecutionDigest(first), B.boundaryExecutionDigest(second));
  assert.equal(B.boundaryExecutionDigest(null), '');
});

test('边界执行器源码确定性门禁：不含 Date.now / Math.random', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension/src/lib/replay-boundary-exec.js'), 'utf8');
  assert.equal(/Date\.now\s*\(/.test(source), false);
  assert.equal(/Math\.random\s*\(/.test(source), false);
});

test('buildReplayPlan 产出的 boundaries 可直接喂给执行器（真实计划形状）', () => {
  const plan = buildReplayPlan([
    stepOf({ ref: 'r1', documentId: 'doc-1', url: 'https://a.test/' }),
  ], { current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }, allowNonIdempotent: true });
  const result = B.evaluateBoundaryExecution(plan, [traceEntry({ documentId: 'doc-1', frameId: 0, url: 'https://a.test/' })]);
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(result.digest.length > 0, true);
});
