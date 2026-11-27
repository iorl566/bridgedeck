// tests/unit/har-merge-deep.test.mjs —— W9-C：多 HAR 合并（去重/时间归一/冲突裁决）、
// 结构化校验（pages/pageTimings/entries/timings）、失败可解释、往返一致性。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFLICT_POLICIES,
  HAR_MERGE_VERSION,
  MERGE_ALIGNMENTS,
  arbitrateHarEntries,
  canonicalHarUrl,
  compareHarRoundTrip,
  deepEqualJson,
  explainHarIssues,
  harEntryFingerprint,
  harRequestKey,
  mergeHarSources,
  parseHarSource,
  summarizeHarMergeReport,
  validateHarDeep,
} from '../../lib/har-merge.mjs';
import { buildHar } from '../../lib/har.mjs';
import { importHar } from '../../lib/har-import.mjs';
import { normalizeHar } from '../../lib/har-normalize.mjs';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function entryOf(overrides = {}) {
  const base = {
    startedDateTime: new Date(START).toISOString(),
    time: 40,
    request: { method: 'GET', url: 'https://api.test/users?page=2', headers: [{ name: 'accept', value: 'application/json' }] },
    response: {
      status: 200,
      bodySize: 11,
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { size: 11, mimeType: 'application/json', text: '{"ok":true}' },
    },
    timings: { blocked: 2, dns: -1, connect: -1, send: 0, wait: 30, receive: 8 },
    _requestId: 'r-1',
    _transferSize: 341,
    _frameId: 'F1',
    _framePath: 'F1',
    _resourceType: 'XHR',
  };
  return { ...base, ...overrides };
}

function harOf(entries, { pageTitle = 'X', pageId = 'page_1', pageTimings = { onLoad: 100 } } = {}) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'test', version: '1.0' },
      pages: [{ id: pageId, title: pageTitle, startedDateTime: new Date(START).toISOString(), pageTimings }],
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// 来源解析：任何非法输入都必须结构化报告，不抛异常
// ---------------------------------------------------------------------------

test('parseHarSource：HAR 文档 / entries 包装 / 裸数组 / JSON 字符串都接受', () => {
  const doc = harOf([entryOf()]);
  assert.equal(parseHarSource(doc).ok, true);
  assert.equal(parseHarSource({ entries: [entryOf()] }).ok, true);
  assert.equal(parseHarSource([entryOf()]).ok, true);
  const viaString = parseHarSource(JSON.stringify(doc));
  assert.equal(viaString.ok, true);
  assert.equal(viaString.label, 'source[0]');
  assert.equal(parseHarSource(doc, { index: 3, label: 'mine' }).label, 'mine');
});

test('parseHarSource：空/坏 JSON/非 HAR 对象都返回结构化 failure', () => {
  const empty = parseHarSource(null);
  assert.equal(empty.ok, false);
  assert.equal(empty.failure.code, 'missing-source');
  const badJson = parseHarSource('{not json');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.failure.code, 'unparsable-json');
  const notHar = parseHarSource({ nope: true });
  assert.equal(notHar.ok, false);
  assert.equal(notHar.failure.code, 'not-har');
  const emptyArray = parseHarSource([]);
  assert.equal(emptyArray.ok, false);
  assert.equal(emptyArray.failure.code, 'empty-entries');
  const num = parseHarSource(42);
  assert.equal(num.ok, false);
  assert.equal(num.failure.code, 'not-har');
  // failure 一定带 index/label/message，供上层解释
  assert.equal(typeof num.failure.index, 'number');
  assert.equal(typeof num.failure.label, 'string');
  assert.equal(typeof num.failure.message, 'string');
});

test('canonicalHarUrl / harRequestKey / harEntryFingerprint / deepEqualJson', () => {
  assert.equal(canonicalHarUrl('https://a.test:443/x#frag'), 'https://a.test/x');
  assert.equal(canonicalHarUrl('http://a.test:80/x'), 'http://a.test/x');
  assert.equal(canonicalHarUrl('not a url'), 'not a url');
  const one = harRequestKey(entryOf());
  const two = harRequestKey(entryOf({ _requestId: 'other' }));
  assert.equal(one, two); // requestId 不参与身份键
  const post = entryOf({ request: { method: 'POST', url: 'https://api.test/users', headers: [] } });
  const postWithBody = entryOf({
    request: { method: 'POST', url: 'https://api.test/users', headers: [], postData: { mimeType: 'text/plain', text: 'x' } },
  });
  assert.notEqual(harRequestKey(post), harRequestKey(postWithBody));
  assert.equal(typeof harEntryFingerprint(entryOf()), 'string');
  assert.equal(deepEqualJson({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(deepEqualJson({ a: [1, 2] }, { a: [1, 3] }), false);
  assert.equal(deepEqualJson(null, null), true);
  assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: 2 }), false);
});

// ---------------------------------------------------------------------------
// 合并：去重 / 时间归一 / 冲突裁决
// ---------------------------------------------------------------------------

test('mergeHarSources：同 requestId 去重、正文取更长、缺失头/分项互补、冲突可解释', () => {
  const first = harOf([entryOf()]);
  const second = harOf([entryOf({
    startedDateTime: new Date(START + 200).toISOString(),
    time: 42,
    _transferSize: 360,
    request: { method: 'GET', url: 'https://api.test/users?page=2', headers: [] },
    response: {
      status: 200,
      bodySize: 13,
      headers: [{ name: 'x-extra', value: '1' }],
      content: { size: 13, mimeType: 'application/json', text: '{"ok":true,"x":1}' },
    },
    timings: { blocked: 3, dns: 1, connect: 2, send: 1, wait: 30, receive: 8, _queueingMs: 3, _ttfbMs: 33, _contentDownloadMs: 8, totalMs: 44 },
  })], { pageTitle: 'X2' });

  const { har, report } = mergeHarSources([first, second], { now: START });
  assert.equal(report.ok, true);
  assert.equal(report.entries.total, 2);
  assert.equal(report.entries.kept, 1);
  assert.equal(report.entries.duplicates, 1);
  assert.equal(report.entries.mergedGroups, 1);
  assert.equal(har.log.entries.length, 1);
  const merged = har.log.entries[0];
  assert.equal(merged._requestId, 'r-1');
  assert.equal(merged.response.content.text, '{"ok":true,"x":1}');
  assert.equal(merged._transferSize, 360);
  // 获胜来源缺分项计时时，由其它来源补齐
  assert.equal(merged.timings.dns, 1);
  assert.equal(merged.timings.connect, 2);
  // 请求头从另一来源补齐（获胜来源没有请求头）
  assert.deepEqual(merged.request.headers, [{ name: 'accept', value: 'application/json' }]);
  // 合并证据
  assert.equal(merged._merge.duplicates, 2);
  assert.equal(merged._merge.sources.length, 2);
  assert.equal(merged._merge.policy, 'prefer-complete');
  assert.equal(merged._merge.version, HAR_MERGE_VERSION);
  // 冲突类型可解释
  const kinds = new Set(report.conflicts.map((item) => item.kind));
  for (const kind of ['size-mismatch', 'content-mismatch', 'timings-mismatch']) {
    assert.equal(kinds.has(kind), true, '缺少冲突类型 ' + kind);
  }
  for (const conflict of report.conflicts) {
    assert.equal(typeof conflict.field, 'string');
    assert.equal(typeof conflict.reason, 'string');
    assert.equal(typeof conflict.winner, 'string');
    assert.equal(Array.isArray(conflict.sources), true);
  }
  // 页面去重：同 id 合并成 1 个 page
  assert.equal(report.pages.total, 2);
  assert.equal(report.pages.kept, 1);
  assert.equal(har.log.pages.length, 1);
  // 合并后结构校验随附
  assert.equal(report.validation.ok, true);
  assert.equal(report.validation.errors, 0);
  assert.equal(typeof har.log._validation.counts.errors, 'number');
  assert.equal(typeof report.bytes, 'number');
});

test('mergeHarSources：时间归一 rebase 把各来源对齐到最早来源，absolute 保持原时间', () => {
  const early = harOf([entryOf({ startedDateTime: new Date(START).toISOString(), _requestId: 'a' })]);
  const late = harOf([entryOf({
    startedDateTime: new Date(START + 5000).toISOString(),
    _requestId: 'b',
    request: { method: 'GET', url: 'https://api.test/late', headers: [] },
  })]);

  const absolute = mergeHarSources([early, late], { now: START });
  assert.equal(absolute.report.align, 'absolute');
  assert.equal(absolute.report.sources[1].offsetMs, 0);
  assert.equal(absolute.har.log.entries.length, 2);
  assert.equal(absolute.har.log.entries[1]._startedAt - absolute.har.log.entries[0]._startedAt, 5000);

  const rebased = mergeHarSources([early, late], { now: START, align: 'rebase' });
  assert.equal(rebased.report.align, 'rebase');
  assert.equal(rebased.report.sources[1].offsetMs, -5000);
  const rebasedEntries = rebased.har.log.entries;
  assert.equal(rebasedEntries[1]._startedAt, rebasedEntries[0]._startedAt);
  assert.equal(rebasedEntries[1]._timeShiftMs, -5000);
  assert.equal(rebasedEntries[1].startedDateTime, rebasedEntries[0].startedDateTime);
  // time.spanMs 用合并后时间轴
  assert.equal(rebased.report.time.spanMs, 40);
  assert.equal(typeof rebased.report.time.base, 'string');
  // 枚举常量与报告一致
  assert.equal(MERGE_ALIGNMENTS.includes('rebase'), true);
  assert.equal(CONFLICT_POLICIES.includes('prefer-last'), true);
});

test('mergeHarSources：不同 requestId 但同 method+url+body 在时间窗内视为重复', () => {
  const one = harOf([entryOf({ _requestId: 'x-1' })]);
  const two = harOf([entryOf({
    _requestId: 'x-2',
    startedDateTime: new Date(START + 300).toISOString(),
  })]);
  const merged = mergeHarSources([one, two], { now: START, timeWindowMs: 1000 });
  assert.equal(merged.report.entries.kept, 1);
  assert.equal(merged.report.entries.duplicates, 1);
  // 超出时间窗 → 保留两条（真实的重复请求）
  const far = mergeHarSources([one, harOf([entryOf({
    _requestId: 'x-3',
    startedDateTime: new Date(START + 9000).toISOString(),
  })])], { now: START, timeWindowMs: 1000 });
  assert.equal(far.report.entries.kept, 2);
  assert.equal(far.report.entries.duplicates, 0);
  assert.equal(far.report.timeWindowMs, 1000);
});

test('mergeHarSources：坏来源进 failures，合法来源仍可合并（ok=false 但不抛）', () => {
  const merged = mergeHarSources([
    harOf([entryOf({ _requestId: 'ok-1' })]),
    null,
    '{broken',
    { nope: 1 },
  ], { now: START });
  assert.equal(merged.report.ok, false);
  assert.equal(merged.report.failures.length, 3);
  const codes = merged.report.failures.map((item) => item.code);
  assert.deepEqual(codes, ['missing-source', 'unparsable-json', 'not-har']);
  assert.equal(merged.report.sources.length, 4);
  assert.equal(merged.report.sources.filter((item) => item.ok === false).length, 3);
  assert.equal(merged.report.entries.kept, 1);
  assert.equal(merged.har.log.entries.length, 1);
  const summary = summarizeHarMergeReport(merged.report);
  assert.equal(summary.ok, false);
  assert.equal(summary.failedSources, 3);
  assert.equal(summary.keptEntries, 1);
});

test('mergeHarSources：绝不修改入参（来源 entry 保持原值）', () => {
  const source = harOf([entryOf()]);
  const snapshot = JSON.stringify(source);
  mergeHarSources([source], { now: START });
  assert.equal(JSON.stringify(source), snapshot);
});

test('arbitrateHarEntries：prefer-last/first 决定获胜来源，error-vs-success 可解释', () => {
  const records = [
    { entry: normalizeHar(harOf([entryOf({ _requestId: 'r' })])).log.entries[0], sourceIndex: 0, indexInSource: 0, label: 'a' },
    {
      entry: normalizeHar(harOf([entryOf({
        _requestId: 'r',
        response: { status: 0, bodySize: 0, headers: [], content: { size: 0, mimeType: '' } },
        _error: 'net::ERR_FAILED',
      })])).log.entries[0],
      sourceIndex: 1,
      indexInSource: 0,
      label: 'b',
    },
  ];
  const last = arbitrateHarEntries(records, { policy: 'prefer-last' });
  assert.equal(last.winner.label, 'b');
  assert.equal(last.entry._merge.winner, 'b');
  const first = arbitrateHarEntries(records, { policy: 'prefer-first' });
  assert.equal(first.winner.label, 'a');
  // 默认 prefer-complete 会选成功的那份（有状态码、无错误）
  const complete = arbitrateHarEntries(records, {});
  assert.equal(complete.winner.label, 'a');
  const kinds = complete.conflicts.map((item) => item.kind);
  assert.equal(kinds.includes('error-vs-success'), true);
  assert.equal(kinds.includes('status-mismatch'), true);
  // 空输入安全
  assert.deepEqual(arbitrateHarEntries([]), { entry: null, conflicts: [], winner: null });
});

test('mergeHarSources：WS 帧按连接合并去重并按时间排序', () => {
  function wsEntry(frames, seed) {
    return entryOf({
      startedDateTime: new Date(START + seed).toISOString(),
      request: { method: 'GET', url: 'wss://echo.test/socket', headers: [] },
      response: { status: 101, bodySize: 0, headers: [], content: { size: 0, mimeType: '' } },
      _requestId: 'ws-1',
      _frameId: null,
      _resourceType: 'WebSocket',
      _webSocketMessages: frames,
      _webSocketConnection: { id: 7, url: 'wss://echo.test/socket', closed: false, frameCount: frames.length },
    });
  }
  const one = mergeHarSources([harOf([wsEntry([
    { type: 'send', time: new Date(START + 300).toISOString(), opcode: 1, data: 'a', _bytes: 1 },
    { type: 'receive', time: new Date(START + 200).toISOString(), opcode: 1, data: 'b', _bytes: 1 },
  ], 100)], { pageTitle: 'w' })], { now: START });
  const two = mergeHarSources([
    harOf([wsEntry([
      { type: 'send', time: new Date(START + 300).toISOString(), opcode: 1, data: 'a', _bytes: 1 },
      { type: 'receive', time: new Date(START + 200).toISOString(), opcode: 1, data: 'b', _bytes: 1 },
    ], 100)]),
    harOf([wsEntry([
      { type: 'send', time: new Date(START + 300).toISOString(), opcode: 1, data: 'a', _bytes: 1 },
      { type: 'receive', time: new Date(START + 400).toISOString(), opcode: 1, data: 'c', _bytes: 1 },
    ], 100)]),
  ], { now: START });
  // 单来源不合并时保留全部帧
  assert.equal(one.har.log.entries[0]._webSocketMessages.length, 2);
  // 多来源合并：同 type+time+data 去重，剩余按时间升序
  const messages = two.har.log.entries[0]._webSocketMessages;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((message) => message.data), ['b', 'a', 'c']);
});

// ---------------------------------------------------------------------------
// 深度校验
// ---------------------------------------------------------------------------

test('validateHarDeep：合法 HAR ok=true，扩展字段齐全', () => {
  const har = normalizeHar(harOf([entryOf()]));
  const validation = validateHarDeep(har);
  assert.equal(validation.ok, true);
  assert.equal(validation.counts.errors, 0);
  assert.equal(validation.entries, 1);
  assert.equal(validation.pages, 1);
  assert.equal(validation.truncated, false);
  // 缺 log 也结构化
  const missing = validateHarDeep({});
  assert.equal(missing.ok, false);
  assert.equal(missing.entries, 0);
  assert.equal(missing.issues.some((item) => item.code === 'missing-log'), true);
});

test('validateHarDeep：pages/pageTimings/pageref 问题分级报告', () => {
  const har = {
    log: {
      version: '1.2',
      pages: [
        { id: 'p1', startedDateTime: 'not-a-time', pageTimings: { onLoad: -5, bogus: 1 } },
        { id: 'p1', title: 'dup', startedDateTime: new Date(START).toISOString(), pageTimings: 'nope' },
        null,
      ],
      entries: [entryOf({ pageref: 'missing-page' })],
    },
  };
  const validation = validateHarDeep(har);
  assert.equal(validation.ok, false);
  const codes = validation.issues.map((item) => item.code);
  for (const code of ['bad-page-time', 'bad-page-timing', 'unknown-page-timing', 'duplicate-page-id', 'bad-page-timings', 'bad-page', 'bad-pageref']) {
    assert.equal(codes.includes(code), true, '缺少问题码 ' + code);
  }
  const severities = new Set(validation.issues.map((item) => item.severity));
  assert.equal(severities.has('error'), true);
  assert.equal(severities.has('info'), true);
});

test('validateHarDeep：entries 内部一致性（timings/时长/重复 requestId/WS/base64/cache）', () => {
  const har = {
    log: {
      version: '1.2',
      pages: [],
      entries: [
        {
          startedDateTime: new Date(START).toISOString(),
          time: 10,
          request: {
            method: 'GET',
            url: 'relative/path',
            headers: 'not-an-array',
            bodySize: -2,
          },
          response: {
            status: 200,
            headers: [{ name: '', value: 5 }],
            bodySize: 1,
            content: { size: -1, mimeType: 'text/plain', encoding: 'gzip' },
          },
          cache: { beforeRequest: 'nope' },
          timings: { blocked: 1, send: 1, wait: 10, receive: 5 },
          _requestId: 'dup',
          _startedAt: START,
          _finishedAt: START - 1,
          _webSocketMessages: [{ type: 'bogus', time: 'never', opcode: 'x', data: 5 }],
        },
        {
          startedDateTime: new Date(START).toISOString(),
          time: 4,
          request: { method: 'GET', url: 'https://ok.test/', headers: [] },
          response: { status: 200, bodySize: 0, headers: [], content: { size: 0, mimeType: '' } },
          timings: { wait: 4 },
          _requestId: 'dup',
        },
      ],
    },
  };
  const validation = validateHarDeep(har);
  assert.equal(validation.ok, false);
  const codes = new Set(validation.issues.map((item) => item.code));
  for (const code of [
    'relative-url', 'bad-headers', 'bad-size', 'bad-header-value', 'bad-content-size',
    'bad-encoding', 'bad-cache-entry', 'timings-sum-mismatch', 'finished-before-start',
    'duplicate-request-id', 'bad-ws-type', 'bad-ws-time', 'bad-ws-opcode', 'bad-ws-data',
  ]) {
    assert.equal(codes.has(code), true, '缺少问题码 ' + code);
  }
  // 问题数值都有可达路径与说明
  for (const issue of validation.issues) {
    assert.equal(typeof issue.path, 'string');
    assert.equal(typeof issue.message, 'string');
    assert.equal(['error', 'warning', 'info'].includes(issue.severity), true);
  }
});

test('validateHarDeep：maxIssues 截断并标记 truncated/omitted', () => {
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    entries.push(entryOf({
      _requestId: null,
      request: { method: 'GET', url: 'not-a-url-' + index, headers: [] },
      response: { status: 200, bodySize: 0, headers: [], content: { size: 0, mimeType: '' } },
    }));
  }
  const validation = validateHarDeep(harOf(entries), { maxIssues: 5 });
  assert.equal(validation.issues.length, 5);
  assert.equal(validation.truncated, true);
  assert.equal(validation.omitted > 0, true);
});

test('explainHarIssues：可读行带级别/路径/问题码，超限提示剩余数', () => {
  const validation = validateHarDeep({
    log: { version: '1.1', entries: [{ request: {}, response: {}, startedDateTime: 'x' }] },
  });
  const lines = explainHarIssues(validation, { limit: 2 });
  assert.equal(lines.length, 3); // 2 条 + 剩余提示
  assert.match(lines[0], /^\[(error|warn|info)\] /);
  assert.match(lines[0], /（.+）$/);
  assert.match(lines[lines.length - 1], /其余 \d+ 条/);
  assert.deepEqual(explainHarIssues(null), []);
});

// ---------------------------------------------------------------------------
// 往返一致性
// ---------------------------------------------------------------------------

test('compareHarRoundTrip：同份 HAR 一致；状态/正文变化被逐字段报告', () => {
  const before = normalizeHar(harOf([entryOf()]), { now: START });
  const same = compareHarRoundTrip(before, before, { now: START });
  assert.equal(same.identical, true);
  assert.equal(same.differences.length, 0);
  assert.equal(same.compared.entries, 1);
  assert.equal(same.compared.fields > 10, true);

  const changed = normalizeHar(harOf([entryOf({
    response: {
      status: 503,
      bodySize: 4,
      headers: [],
      content: { size: 4, mimeType: 'text/plain', text: 'down' },
    },
  })]), { now: START });
  const diff = compareHarRoundTrip(before, changed, { now: START });
  assert.equal(diff.identical, false);
  const fields = new Set(diff.differences.map((item) => item.path.replace(/^log\.entries\[\d+\]\./, '')));
  assert.equal(fields.has('response.status'), true);
  assert.equal(fields.has('response.content.textHash'), true);
  for (const item of diff.differences) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'before'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'after'), true);
  }
});

test('compareHarRoundTrip：生成型 requestId 不误报，entry 数量变化被报告', () => {
  const before = normalizeHar(harOf([entryOf({ _requestId: null })]), { now: START });
  const after = normalizeHar(harOf([entryOf({ _requestId: 'har-2' })]), { now: START });
  const ignored = compareHarRoundTrip(before, after, { now: START });
  assert.equal(ignored.identical, true);
  const strict = compareHarRoundTrip(before, after, { now: START, ignoreGeneratedRequestIds: false });
  assert.equal(strict.identical, false);
  const shorter = compareHarRoundTrip(before, normalizeHar({ log: { version: '1.2', pages: [], entries: [] } }, { now: START }), { now: START });
  assert.equal(shorter.identical, false);
  assert.equal(shorter.differences.some((item) => item.path === 'log.entries.length'), true);
  assert.equal(shorter.differences.some((item) => item.path === 'log.pages.length'), true);
});

// ---------------------------------------------------------------------------
// 运行时接线：buildHar / importHar 的加法字段
// ---------------------------------------------------------------------------

test('buildHar：追加 log._validation，标准字段与旧行为不变', () => {
  const detail = {
    entry: {
      id: 1,
      method: 'GET',
      url: 'https://x.test/a?q=1',
      status: 200,
      mime: 'application/json',
      startedAt: START,
      durationMs: 12,
      responseBytes: 8,
    },
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":1}',
  };
  const har = buildHar([detail], { pageUrl: 'https://x.test', pageTitle: 'X' });
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.creator.name, 'BridgeDeck');
  assert.equal(typeof har.log._validation, 'object');
  assert.equal(har.log._validation.ok, true);
  assert.equal(har.log._validation.counts.errors, 0);
  assert.equal(Array.isArray(har.log._validation.explain), true);
  // 关掉自检时不出现该字段（旧形状）
  const plain = buildHar([detail], { validate: false });
  assert.equal('_validation' in plain.log, false);
});

test('importHar：多份 HAR 自动合并，archive._merge 记录去重与来源偏移', () => {
  const one = harOf([entryOf({ _requestId: 'r-1' })]);
  const two = harOf([entryOf({
    _requestId: 'r-1',
    startedDateTime: new Date(START + 400).toISOString(),
    response: {
      status: 200,
      bodySize: 16,
      headers: [],
      content: { size: 16, mimeType: 'application/json', text: '{"ok":true,"more":1}' },
    },
  })]);
  const archive = importHar([one, two], { id: 'merged', now: START });
  assert.equal(archive.requests.length, 1);
  assert.equal(archive._merge.version, HAR_MERGE_VERSION);
  assert.equal(archive._merge.duplicates, 1);
  assert.equal(archive._merge.sources.length, 2);
  assert.equal(archive._merge.ok, true);
  assert.equal(archive._merge.conflicts.length > 0, true);
  assert.equal(archive.summary.requests, 1);
  assert.equal(archive._har.normalized, true);
  // 标准字段仍是 1 条请求 + 完整 request 形状
  assert.equal(archive.requests[0].method, 'GET');
  assert.equal(archive.requests[0].source, 'har');
  // 合并结论随归档保留
  assert.equal(archive._har.roundTrip.identical, true);
});

test('importHar：单份 HAR 行为不变（requests 字段与 summary 旧键），只新增扩展键', () => {
  const archive = importHar(harOf([entryOf()]), { id: 'single', now: START });
  assert.equal(archive.id, 'single');
  assert.equal(archive.source, 'har');
  assert.equal(archive.requests.length, 1);
  assert.equal(archive.summary.requests, 1);
  assert.equal(archive.summary.webSocketFrames, 0);
  assert.equal(archive.summary.generatedRequestIds, 0);
  assert.equal(archive.requests[0].requestId, 'r-1');
  assert.equal(archive.requests[0].durationMs, 40);
  assert.equal(archive.requests[0].timings._ttfbMs, 30); // normalizeTimings 派生
  // 新增：校验 / 往返 / 瀑布归因（全部 `_` 前缀或 summary 新键）
  assert.equal(typeof archive._har.validation, 'object');
  assert.equal(archive._har.validation.ok, true);
  assert.equal(typeof archive._har.roundTrip.identical, 'boolean');
  assert.equal(typeof archive._waterfall, 'object');
  assert.equal(typeof archive.summary.slowRequests, 'number');
  assert.equal(typeof archive.summary.streamingRequests, 'number');
});

test('importHar：数组 entry 仍按"一批 entry"处理（向后兼容，不走合并）', () => {
  const entries = normalizeHar(harOf([entryOf()])).log.entries;
  const archive = importHar(entries, { now: START });
  assert.equal(archive.requests.length, 1);
  assert.equal('_merge' in archive, false);
  assert.equal(archive._waterfall.version >= 1, true);
});

test('importHar：往返自检在超限/关闭时给出 skipped 原因，而不是假装通过', () => {
  const archive = importHar(harOf([entryOf()]), { now: START, verifyRoundTrip: false });
  assert.equal(archive._har.roundTrip.skipped, true);
  assert.equal(archive._har.roundTrip.reason, 'disabled');
  const limited = importHar(harOf([entryOf(), entryOf({
    _requestId: 'r-2',
    request: { method: 'GET', url: 'https://api.test/other', headers: [] },
  })]), { now: START, roundTripLimit: 1 });
  assert.equal(limited._har.roundTrip.skipped, true);
  assert.equal(limited._har.roundTrip.reason, 'entries-over-limit');
  assert.equal(limited._har.roundTrip.entries, 2);
});

test('importHar：坏 HAR（缺 request/response）不崩，校验问题进 explain', () => {
  const archive = importHar({
    log: {
      version: '1.2',
      entries: [
        { startedDateTime: 'bad', request: { url: '', method: '' }, response: { status: 1200 } },
      ],
    },
  }, { id: 'bad' });
  assert.equal(archive.requests.length, 1);
  assert.equal(archive._har.validation.ok, false);
  assert.equal(archive._har.validation.counts.errors > 0, true);
  assert.equal(archive.summary.validationErrors > 0, true);
  assert.equal(archive._har.validation.explain.length > 0, true);
});
