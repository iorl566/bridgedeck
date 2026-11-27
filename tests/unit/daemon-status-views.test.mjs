// tests/unit/daemon-status-views.test.mjs —— daemon.status 增量视图（默认载荷零变化）。
//
// 关键回归点：不请求视图时 buildStatus 必须原样返回 0.3.0 的 status 载荷（同一引用、字段集合不变），
// 只有 views/doctor 显式出现时才追加 ledger/transfers/queue/doctor/views 字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_MAX_LIMIT, STATUS_VIEWS, createStatusViews, parseStatusViews } from '../../daemon/status-views.js';

function baseStatus() {
  // 模拟 0.3.0 status 的字段集合（与 daemon/health.js buildStatus 对齐）。
  return {
    service: 'browser-bridge',
    version: '0.3.0',
    protocol: '1.9',
    pid: 123,
    port: 52900,
    uptimeMs: 1000,
    browsers: [],
    sessions: [],
    inflight: [],
    queues: [],
    auth: { tracked: 0, blocked: [] },
    recovery: { at: 1, sessions: { live: 0 } },
    compatibility: { daemon: { protocol: '1.9', features: {} }, browsers: [] },
  };
}

function makeViews() {
  const calls = { base: 0, ledger: 0, transfers: 0, queue: 0, doctor: 0 };
  const views = createStatusViews({
    baseStatus: () => { calls.base += 1; return baseStatus(); },
    ledgerReport: { summary: () => { calls.ledger += 1; return { pending: 1, unknown: 0 }; } },
    transferOps: { transferSnapshot: (params) => { calls.transfers += 1; return { limit: params.limit, counts: { total: 0 } }; } },
    commandQueue: { diagnostics: (params) => { calls.queue += 1; return { limitSessions: params.limitSessions, tabLimit: params.tabLimit, totals: { pending: 0 } }; } },
    daemonDoctor: { run: () => { calls.doctor += 1; return { status: 'ok', checks: [] }; } },
  });
  return { views, calls };
}

test('parseStatusViews：未请求时 requested=false，且不改动任何视图', () => {
  assert.equal(parseStatusViews().requested, false);
  assert.equal(parseStatusViews({}).requested, false);
  assert.equal(parseStatusViews({ limit: 5 }).requested, false);
  const single = parseStatusViews({ views: 'ledger' });
  assert.deepEqual(single.views, ['ledger']);
  const many = parseStatusViews({ views: ['transfers', 'queues', 'transfers'] });
  assert.deepEqual(many.views, ['transfers', 'queues']);
  const all = parseStatusViews({ views: 'all' });
  assert.deepEqual(all.views, STATUS_VIEWS);
  assert.equal(all.requested, true);
});

test('parseStatusViews：doctor=true 隐含 doctor 视图；未知视图不报错只回显', () => {
  const doctor = parseStatusViews({ doctor: true });
  assert.deepEqual(doctor.views, ['doctor']);
  assert.equal(doctor.doctor, true);
  const unknown = parseStatusViews({ views: ['ledger', 'nope', 42] });
  assert.deepEqual(unknown.views, ['ledger']);
  assert.deepEqual(unknown.unknown, ['nope', '42']);
  const mixed = parseStatusViews({ views: ['queues', 'doctor'], doctor: true });
  assert.deepEqual(mixed.views, ['queues', 'doctor']);
});

test('parseStatusViews：limit/limitSessions 正整数化并封顶', () => {
  assert.equal(parseStatusViews({ views: 'ledger' }).limit, null);
  assert.equal(parseStatusViews({ views: 'ledger', limit: 5 }).limit, 5);
  assert.equal(parseStatusViews({ views: 'ledger', limit: 0 }).limit, null);
  assert.equal(parseStatusViews({ views: 'ledger', limit: 'x' }).limit, null);
  assert.equal(parseStatusViews({ views: 'ledger', limit: 10_000 }).limit, STATUS_MAX_LIMIT);
  assert.equal(parseStatusViews({ views: 'queues', limitSessions: 3 }).sessionsLimit, 3);
});

test('默认 status：返回 baseStatus 原对象（同一引用），不追加任何新字段', () => {
  const { views, calls } = makeViews();
  const result = views.buildStatus({});
  const expected = baseStatus();
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(expected).sort(), '默认字段集合不能变');
  assert.equal(calls.ledger + calls.transfers + calls.queue + calls.doctor, 0, '未请求视图时不能计算视图');
  // 显式空请求也不改变载荷。
  assert.deepEqual(views.buildStatus({ views: [] }), expected);
  assert.deepEqual(views.buildStatus({ detail: true }), expected);
});

test('views=ledger/transfers/queues：只追加请求的视图与 views 标记', () => {
  const { views, calls } = makeViews();
  const ledger = views.buildStatus({ views: ['ledger'] });
  assert.deepEqual(ledger.views, ['ledger']);
  assert.deepEqual(ledger.ledger, { pending: 1, unknown: 0 });
  assert.equal(ledger.transfers, undefined);
  assert.equal(ledger.queue, undefined);
  assert.equal(calls.ledger, 1);

  const transfers = views.buildStatus({ views: ['transfers'], limit: 7 });
  assert.deepEqual(transfers.transfers, { limit: 7, counts: { total: 0 } });
  assert.equal(transfers.ledger, undefined);

  const queue = views.buildStatus({ views: ['queues'], limit: 3, limitSessions: 2 });
  assert.equal(queue.queue.limitSessions, 2);
  assert.equal(queue.queue.tabLimit, 3);

  const all = views.buildStatus({ views: 'all' });
  assert.deepEqual(all.views, STATUS_VIEWS);
  assert.ok(all.ledger && all.transfers && all.queue && all.doctor);
  assert.equal(calls.doctor, 1);
});

test('doctor:true：在同一个 status 里追加结构化自检', () => {
  const { views, calls } = makeViews();
  const result = views.buildStatus({ doctor: true });
  assert.deepEqual(result.views, ['doctor']);
  assert.deepEqual(result.doctor, { status: 'ok', checks: [] });
  assert.equal(calls.doctor, 1);
  // 基础字段仍完整。
  assert.equal(result.service, 'browser-bridge');
  assert.deepEqual(result.browsers, []);
});

test('视图数据源异常：降级为 {ok:false,error} 字段，不抛错、不影响其他视图', () => {
  const views = createStatusViews({
    baseStatus,
    ledgerReport: { summary: () => { throw Object.assign(new Error('ledger fail'), { code: 'E_INTERNAL' }); } },
    transferOps: { transferSnapshot: () => { throw new Error('transfer fail'); } },
    commandQueue: { diagnostics: () => ({ totals: { pending: 0 } }) },
    daemonDoctor: { run: () => { throw new Error('doctor fail'); } },
  });
  const result = views.buildStatus({ views: 'all' });
  assert.equal(result.ledger.ok, false);
  assert.equal(result.ledger.error, 'E_INTERNAL');
  assert.equal(result.transfers.ok, false);
  assert.equal(result.transfers.error, 'E_INTERNAL');
  assert.deepEqual(result.queue.totals, { pending: 0 });
  assert.equal(result.doctor.ok, false);
  assert.equal(result.doctor.error, 'E_INTERNAL');
  assert.equal(result.service, 'browser-bridge');
});

test('缺失的数据源不产生字段（旧 daemon 配置/裁剪部署安全）', () => {
  const views = createStatusViews({ baseStatus });
  const result = views.buildStatus({ views: 'all' });
  assert.deepEqual(result.views, STATUS_VIEWS);
  assert.equal(result.ledger, undefined);
  assert.equal(result.transfers, undefined);
  assert.equal(result.queue, undefined);
  assert.equal(result.doctor, undefined);
});

test('未知视图名回显到 unknownViews，便于 CLI 诊断拼写', () => {
  const { views } = makeViews();
  const result = views.buildStatus({ views: ['ledger', 'tranfers'] });
  assert.deepEqual(result.views, ['ledger']);
  assert.deepEqual(result.unknownViews, ['tranfers']);
});

test('createStatusViews 缺 baseStatus 参数时快速失败', () => {
  assert.throws(() => createStatusViews({}), /baseStatus/);
});
