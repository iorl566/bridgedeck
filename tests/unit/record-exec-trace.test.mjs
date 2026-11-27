// tests/unit/record-exec-trace.test.mjs —— 执行轨迹证据：
//   1) 参数脱敏：password/value/token 不进轨迹，长值截断，array/object 只留尺寸；
//   2) 归一化与哈希链：同输入 digest 确定，任一字段改动都能被 verifyTrace 定位；
//   3) 有界记录器：超过上限丢弃最旧，counters/summary 准确；
//   4) 封存/校验/空链；两条轨迹 diff；文本格式化上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACE_CODES,
  TRACE_LIMITS,
  TRACE_PHASES,
  TRACE_STATUSES,
  TRACE_VERSION,
  chainTraceEntry,
  createTraceRecorder,
  describeTrace,
  diffTraces,
  formatTrace,
  normalizeTraceEntry,
  redactTraceParams,
  sealTrace,
  summarizeTrace,
  verifyTrace,
} from '../../extension/src/lib/record-exec-trace.js';

function entry(overrides = {}) {
  return {
    seq: 1,
    index: 0,
    ref: 'r1',
    kind: 'action',
    method: 'click',
    phase: TRACE_PHASES.SERIAL,
    status: TRACE_STATUSES.OK,
    attempts: 1,
    at: 1000,
    note: '',
    ...overrides,
  };
}

test('redactTraceParams：敏感键打码、普通值截断、数组/对象只留尺寸、键数有上限', () => {
  const redacted = redactTraceParams({
    selector: '#q',
    value: 'super-secret',
    password: 'p@ss',
    token: 'abc',
    cookie: '',
    count: 3,
    flag: true,
    nil: null,
    list: [1, 2, 3],
    nested: { a: 1, b: 2 },
    longText: 'x'.repeat(400),
  });
  assert.equal(redacted.selector, '#q');
  assert.match(redacted.value, /^\*\*\*:/, '敏感键整值替换成 ***:len');
  assert.equal(redacted.value.includes('super-secret'), false);
  assert.match(redacted.password, /^\*\*\*:/);
  assert.match(redacted.token, /^\*\*\*:/);
  assert.equal(redacted.cookie, '***', '空值也只表达“有值但不展示”');
  assert.equal(redacted.count, 3);
  assert.equal(redacted.flag, true);
  assert.equal(redacted.nil, null);
  assert.equal(redacted.list, '[array:3]');
  assert.equal(redacted.nested, '[object:2]');
  assert.equal(redacted.longText.length, 120);
  assert.equal(redactTraceParams(null), null);
  assert.equal(redactTraceParams('nope'), null);

  const bounded = redactTraceParams({ a: 1, b: 2, c: 3 }, { maxParams: 2 });
  assert.equal(Object.keys(bounded).length, 3);
  assert.equal(bounded.__truncated, 1);
});

test('normalizeTraceEntry：默认状态/阶段、字段截断、条件扩展字段、非法输入', () => {
  assert.equal(normalizeTraceEntry(null), null);
  assert.equal(normalizeTraceEntry(42), null);
  const basic = normalizeTraceEntry({ index: 5, ref: 'x'.repeat(100), method: 'click', at: 2000 });
  assert.equal(basic.seq, 1);
  assert.equal(basic.index, 5);
  assert.equal(basic.phase, TRACE_PHASES.SERIAL);
  assert.equal(basic.status, TRACE_STATUSES.OK);
  assert.equal(basic.attempts, 1);
  assert.equal(basic.ref.length, 64);
  assert.equal(basic.params, null);

  const extended = normalizeTraceEntry(entry({
    status: 'weird',
    phase: 'weird',
    branch: { label: 'a' },
    parallel: 'grp',
    cancel: 'pay',
    humanGate: true,
    params: { selector: '#q', value: 'v' },
    attempts: 0,
  }));
  assert.equal(extended.status, TRACE_STATUSES.OK, '未知状态回退 ok');
  assert.equal(extended.phase, TRACE_PHASES.SERIAL);
  assert.deepEqual(extended.branch, { label: 'a' });
  assert.equal(extended.parallel, 'grp');
  assert.equal(extended.cancel, 'pay');
  assert.equal(extended.humanGate, true);
  assert.equal(extended.attempts, 1);
  assert.match(extended.params.value, /^\*\*\*:/);

  const raw = normalizeTraceEntry(entry({ params: { selector: '#q', value: 'v' } }), { redact: false });
  assert.equal(raw.params.value, 'v');
});

test('chainTraceEntry：链式 digest 确定、prevDigest 链接、字段改动改变 digest', () => {
  const first = chainTraceEntry(null, normalizeTraceEntry(entry({ index: 0 })));
  assert.equal(first.prevDigest, 'genesis');
  assert.match(first.digest, /^t[0-9a-f]{8}$/);
  const second = chainTraceEntry(first, normalizeTraceEntry(entry({ index: 1, ref: 'r2', at: 1100 })));
  assert.equal(second.prevDigest, first.digest);
  assert.notEqual(second.digest, first.digest);

  const again = chainTraceEntry(null, normalizeTraceEntry(entry({ index: 0 })));
  assert.equal(again.digest, first.digest, '同输入 digest 必须稳定');
  const changed = chainTraceEntry(null, normalizeTraceEntry(entry({ index: 0, status: TRACE_STATUSES.SKIPPED })));
  assert.notEqual(changed.digest, first.digest);
  assert.equal(chainTraceEntry(null, null), null);
});

test('createTraceRecorder：有界、计数、摘要与封存校验（默认上限 2000，测试内注入小上限）', () => {
  let clock = 1000;
  const recorder = createTraceRecorder({ now: () => clock, limit: 3 });
  for (let index = 0; index < 5; index += 1) {
    clock += 10;
    const written = recorder.push(entry({ index, ref: 'r' + index, at: clock }));
    assert.ok(written && written.digest);
  }
  assert.equal(recorder.size(), 3);
  assert.equal(recorder.limit, 3);
  const counters = recorder.counters();
  assert.equal(counters.pushed, 5);
  assert.equal(counters.dropped, 2);
  assert.equal(counters.byStatus.ok, 5);
  assert.equal(counters.byPhase.serial, 5);

  const entries = recorder.entries();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].index, 2, '最旧两条被丢弃');
  entries[0].status = TRACE_STATUSES.FAILED;
  assert.notEqual(recorder.entries()[0].status, TRACE_STATUSES.FAILED, 'entries() 返回副本');

  const summary = recorder.summary();
  assert.equal(summary.version, TRACE_VERSION);
  assert.equal(summary.count, 3);
  assert.equal(summary.digest, entries[entries.length - 1].digest);
  assert.equal(recorder.digest(), summary.digest);

  const sealed = recorder.seal({ tag: 't' });
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.extra.tag, 't');
  assert.equal(recorder.verify(sealed).ok, true);
  assert.equal(verifyTrace(sealed).ok, true);

  recorder.push(entry({ index: 9, status: TRACE_STATUSES.FAILED, method: 'click' }));
  const failedSummary = recorder.summary();
  assert.equal(failedSummary.failed, 1);
  assert.equal(failedSummary.ok, false);
  assert.equal(recorder.clear().cleared, 3);
  assert.equal(recorder.size(), 0);
  assert.equal(recorder.push(null), null);
});

test('sealTrace/verifyTrace：原始条目重新链接、空链可校验、逐条定位被改动条目', () => {
  const raw = [
    entry({ index: 0, ref: 'a', at: 1000 }),
    entry({ seq: 2, index: 1, ref: 'b', at: 1010, attempts: 2 }),
    entry({ seq: 3, index: 2, ref: 'c', at: 1020, status: TRACE_STATUSES.SKIPPED }),
  ];
  const sealed = sealTrace(raw, { runId: 'run-1' });
  assert.equal(sealed.count, 3);
  assert.equal(sealed.firstAt, 1000);
  assert.equal(sealed.lastAt, 1020);
  assert.equal(sealed.extra.runId, 'run-1');
  assert.equal(verifyTrace(sealed).ok, true);
  assert.equal(verifyTrace(sealed).count, 3);
  assert.equal(verifyTrace(sealTrace([])).ok, true, '空链也能校验');

  const tampered = {
    ...sealed,
    entries: sealed.entries.map((item, index) => (index === 1 ? { ...item, note: '被改' } : item)),
  };
  const tamperedCheck = verifyTrace(tampered);
  assert.equal(tamperedCheck.ok, false);
  assert.equal(tamperedCheck.index, 1);
  assert.equal(tamperedCheck.code, TRACE_CODES.TRACE_MISMATCH);

  const digestTampered = { ...sealed, digest: 'tdeadbeef' };
  assert.equal(verifyTrace(digestTampered).ok, false);
  assert.equal(verifyTrace(null).ok, false);
  assert.equal(verifyTrace({}).code, TRACE_CODES.TRACE_BAD_ARG);
});

test('summarizeTrace：按状态/阶段/种类统计，重试数取 attempts-1，首末时间与体积', () => {
  const summary = summarizeTrace([
    entry({ index: 0, at: 1000, status: TRACE_STATUSES.OK }),
    entry({ index: 1, at: 1100, status: TRACE_STATUSES.RETRY, attempts: 3, phase: TRACE_PHASES.PARALLEL, parallel: 'g1', humanGate: true }),
    entry({ index: 2, at: 1200, status: TRACE_STATUSES.SKIPPED, cancel: 'pay' }),
    entry({ index: 3, at: 1300, status: TRACE_STATUSES.FAILED, branch: 'x' }),
    entry({ index: 4, at: 1400, status: TRACE_STATUSES.BLOCKED }),
  ]);
  assert.equal(summary.count, 5);
  assert.equal(summary.byStatus.ok, 1);
  assert.equal(summary.byStatus.retry, 1);
  assert.equal(summary.byStatus.skipped, 1);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(summary.byStatus.blocked, 1);
  assert.equal(summary.byPhase.parallel, 1);
  assert.equal(summary.retries, 2, 'attempts=3 的重试增量 = 2（status=retry 但 attempts=1 不重复计）');
  assert.equal(summary.humanGates, 1);
  assert.equal(summary.cancels, 1);
  assert.equal(summary.branches, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.firstAt, 1000);
  assert.equal(summary.lastAt, 1400);
  assert.equal(summary.durationMs, 400);
  assert.equal(summary.ok, false);
  assert.ok(JSON.stringify(summary).length < 700);
  assert.equal(summarizeTrace(null).count, 0);
  assert.equal(summarizeTrace([]).ok, true);
});

test('diffTraces：相同/新增/删除/字段变化，hunk 按 index 排序', () => {
  const left = [
    entry({ index: 0, ref: 'a', status: TRACE_STATUSES.OK }),
    entry({ index: 1, ref: 'b', status: TRACE_STATUSES.OK }),
    entry({ index: 2, ref: 'c', status: TRACE_STATUSES.OK }),
  ];
  const same = diffTraces(left, left);
  assert.equal(same.equal, true);
  assert.equal(same.stats.hunks, 0);

  const right = [
    entry({ index: 0, ref: 'a', status: TRACE_STATUSES.OK }),
    entry({ index: 1, ref: 'b', status: TRACE_STATUSES.FAILED }),
    entry({ index: 3, ref: 'd', status: TRACE_STATUSES.OK }),
  ];
  const diff = diffTraces(left, right);
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.added.map((item) => item.ref), ['d']);
  assert.deepEqual(diff.removed.map((item) => item.ref), ['c']);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0].fields, ['status']);
  assert.equal(diff.changed[0].before.status, 'ok');
  assert.equal(diff.changed[0].after.status, 'failed');
  assert.equal(diff.hunks[0].index, 1);
  assert.equal(diff.stats.left, 3);
  assert.equal(diff.stats.right, 3);
  assert.equal(diff.ok, true);
});

test('formatTrace/describeTrace：默认空轨迹、行数上限、摘要文本', () => {
  assert.match(formatTrace([]), /空/);
  const lines = formatTrace(sealTrace(Array.from({ length: 20 }, (_, index) => entry({ index, ref: 'r' + index, at: 1000 + index }))), { maxLines: 5 }).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^#0 serial ok action click/);
  assert.equal(formatTrace(null).includes('空'), true);

  const described = describeTrace(summarizeTrace([entry({ status: TRACE_STATUSES.RETRY, attempts: 2, humanGate: true })]));
  assert.match(described, /^trace=1/);
  assert.match(described, /retries=1/);
  assert.match(described, /human=1/);
  assert.equal(describeTrace(null), 'record-trace: 无轨迹');
  assert.ok(TRACE_LIMITS.maxEntries >= 100);
});
