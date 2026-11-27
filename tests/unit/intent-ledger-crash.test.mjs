// tests/unit/intent-ledger-crash.test.mjs —— 预写 WAL 的崩溃注入/恢复/reconcile/UNKNOWN 保护。
//
// 全部使用可注入内存存储，直接构造“进程被杀”后的 WAL 形态：半行、损坏行、乱序帧、
// 重复帧、重复 resolve。断言的是账本对外语义与证据，不是内部实现细节。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IntentLedger,
  LEDGER_STATES,
  WAL_FRAME_VERSION,
  createFileLedgerStorage,
  createMemoryLedgerStorage,
  isNonIdempotentAction,
  normalizeResolveOutcome,
  parseWalRecords,
} from '../../lib/intent-ledger.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ledger-crash-'));
}

function memoryLedger(options = {}) {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage, staleMs: 60_000, ...options });
  return { ledger, storage };
}

function pendingClick(ledger, tabId = 7, sessionId = 's1') {
  return ledger.begin('click', { ref: '@e1', value: 'secret' }, { tabId, sessionId });
}

test('begin 先写 WAL 帧（预写）——执行前记录已持久化且带 checksum', () => {
  const { ledger, storage } = memoryLedger();
  const entry = pendingClick(ledger);
  assert.equal(entry.state, 'active');
  assert.equal(entry.nonIdempotent, true, 'click 属于非幂等动作');
  const raw = storage.readWalRaw();
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const frame = JSON.parse(lines[0]);
  assert.equal(frame.v, WAL_FRAME_VERSION);
  assert.equal(frame.kind, 'begin');
  assert.equal(frame.id, entry.id);
  assert.equal(typeof frame.seq, 'number');
  assert.equal(typeof frame.sum, 'string');
  assert.equal(frame.entry.method, 'click');
  // 预写不得保存参数值。
  assert.equal(raw.includes('secret'), false);
  const { records, stats } = parseWalRecords(raw);
  assert.equal(records.length, 1);
  assert.equal(stats.corrupted, 0);
});

test('commit 结算后再次打开账本：状态为 done 且不阻塞', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, staleMs: 60_000 });
  const entry = pendingClick(first);
  first.finish(entry, 'done');
  const second = new IntentLedger({ storage, staleMs: 60_000 });
  const restored = second.entries.find((item) => item.id === entry.id);
  assert.equal(restored.state, 'done');
  assert.equal(restored.finishedAt !== undefined, true);
  assert.doesNotThrow(() => second.begin('fill', {}, { tabId: 7, sessionId: 's1' }));
});

test('崩溃恢复：pending → unknown，非幂等动作禁止自动重放，必须显式 confirmed/not-applied', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, staleMs: 60_000 });
  const entry = pendingClick(first);
  // 进程被杀：first 不再写任何结算帧，直接用同一份存储“重启”。
  const second = new IntentLedger({ storage, staleMs: 60_000 });
  const summary = second.recover();
  assert.equal(summary.recovered, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.replayBlocked, 1);
  const recovered = second.entries.find((item) => item.id === entry.id);
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.previousState, 'active');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.replayBlocked, true);
  assert.equal(recovered.recoveryReason, 'daemon-restart');
  // 同 tab 的新变异被拦截，证据里带“谁/何时/为何/允许的 resolve 结论”。
  assert.throws(
    () => second.begin('click', { ref: '@e2' }, { tabId: 7, sessionId: 's1' }),
    (error) => {
      assert.equal(error.code, 'E_LEDGER_PENDING');
      assert.equal(error.data.id, entry.id);
      assert.equal(error.data.state, 'unknown');
      assert.equal(error.data.recovered, true);
      assert.equal(error.data.replayBlocked, true);
      assert.deepEqual(error.data.allowedOutcomes, ['confirmed', 'not-applied']);
      return true;
    },
  );
  // 旧结论（abandoned）不能解锁恢复后的非幂等动作。
  assert.throws(
    () => second.resolve(entry.id, 'abandoned'),
    (error) => error.code === 'E_LEDGER_RESOLVE_REQUIRED' && error.data.allowedOutcomes.length === 2,
  );
  // 显式 not-applied：页面未改动，重放放行（effect=none 证据）。
  const resolved = second.resolve(entry.id, 'not-applied');
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolution.effect, 'none');
  assert.equal(resolved.resolution.explicit, true);
  assert.equal(resolved.replayBlocked, false);
  assert.doesNotThrow(() => second.begin('click', { ref: '@e2' }, { tabId: 7, sessionId: 's1' }));
});

test('显式 confirmed 记录 effect=applied，并保留 resolved 帧', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage });
  const entry = first.begin('fill', { selector: '#pwd', value: 'hidden' }, { tabId: 9, sessionId: 's9' });
  const second = new IntentLedger({ storage });
  second.recover();
  second.resolve(entry.id, 'confirmed');
  const third = new IntentLedger({ storage });
  const restored = third.entries.find((item) => item.id === entry.id);
  assert.equal(restored.state, 'resolved');
  assert.equal(restored.outcome, 'confirmed');
  assert.equal(restored.resolution.effect, 'applied');
  assert.equal(restored.replayBlocked, false);
});

test('load() 保持 0.3.0 语义（active → stale），recover() 才升级为 unknown', () => {
  const storage = createMemoryLedgerStorage();
  new IntentLedger({ storage }).begin('navigate', {}, { tabId: 3 });
  const legacy = new IntentLedger({ storage });
  legacy.load();
  assert.equal(legacy.entries[0].state, 'stale');
  assert.equal(legacy.entries[0].replayBlocked, false);

  const storage2 = createMemoryLedgerStorage();
  new IntentLedger({ storage: storage2 }).begin('navigate', {}, { tabId: 4 });
  const modern = new IntentLedger({ storage: storage2 });
  modern.recover();
  assert.equal(modern.entries[0].state, 'unknown');
});

test('乱序 WAL：按 seq 重排，最终状态取最高 seq', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  const entry = ledger.begin('click', {}, { tabId: 5, sessionId: 's5' });
  const wal = storage.readWalRaw();
  const beginFrame = JSON.parse(wal.trim());
  // 构造乱序：resolve(seq+2) 排在 begin(seq) 前面，commit(seq+1) 在中间。
  const commitFrame = {
    v: WAL_FRAME_VERSION,
    seq: beginFrame.seq + 1,
    kind: 'commit',
    id: entry.id,
    at: new Date().toISOString(),
    entry: { ...entry, state: 'done' },
  };
  storage.injectRaw(JSON.stringify({ ...commitFrame, entry: { ...entry, state: 'unknown' } }) + '\n');
  // 重新造一份乱序 WAL：先写 resolve，再写 begin，再写 commit。
  const resolveFrame = {
    v: WAL_FRAME_VERSION,
    seq: beginFrame.seq + 2,
    kind: 'resolve',
    id: entry.id,
    at: new Date().toISOString(),
    entry: { ...entry, state: 'resolved', outcome: 'confirmed' },
  };
  const ordered = createMemoryLedgerStorage();
  ordered.injectRaw(JSON.stringify(resolveFrame) + '\n');
  ordered.injectRaw(JSON.stringify(beginFrame) + '\n');
  ordered.injectRaw(JSON.stringify(commitFrame) + '\n');
  const { records, stats } = parseWalRecords(ordered.readWalRaw());
  assert.equal(records.length, 3);
  assert.equal(stats.outOfOrder, 1, '第一条 resolve 的 seq 大于后两条，应记一次乱序');
  const restoredLedger = new IntentLedger({ storage: ordered });
  assert.equal(restoredLedger.entries.length, 1);
  assert.equal(restoredLedger.entries[0].state, 'resolved');
  assert.equal(restoredLedger.entries[0].outcome, 'confirmed');
});

test('损坏行：中间坏 JSON / checksum 冲突被跳过并计数，合法帧仍然恢复', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  const entry = ledger.begin('click', {}, { tabId: 6 });
  const valid = storage.readWalRaw().trim();
  storage.injectRaw('{not json at all\n');
  const tampered = JSON.parse(valid);
  tampered.entry = { ...tampered.entry, method: 'tampered' };
  // checksum 还是旧的 → 必须被判定损坏。
  storage.injectRaw(JSON.stringify(tampered) + '\n');
  const reopened = new IntentLedger({ storage });
  assert.equal(reopened.walStats.corrupted >= 2, true, JSON.stringify(reopened.walStats));
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.entries[0].id, entry.id);
  assert.equal(reopened.entries[0].method, 'click');
  const summary = reopened.recover();
  assert.equal(summary.recovered, 1);
});

test('半行（部分写入）：末尾无换行的半 JSON 记为 tornTail，不污染恢复', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  const entry = ledger.begin('fill', {}, { tabId: 8 });
  storage.injectRaw('{"v":2,"seq":999,"kind":"commit","id":"' + entry.id + '"');
  const reopened = new IntentLedger({ storage });
  assert.equal(reopened.walStats.tornTail, true);
  assert.equal(reopened.walStats.corrupted, 0);
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.entries[0].state, 'active');
});

test('重复帧去重：同一条 begin 写两次只恢复一次', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  ledger.begin('click', {}, { tabId: 11, sessionId: 's11' });
  const line = storage.readWalRaw();
  storage.injectRaw(line);
  const reopened = new IntentLedger({ storage });
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.walStats.duplicates, 1);
});

test('重复 resolve：同结论幂等（duplicate 证据、不重复写 WAL），异结论冲突', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  const entry = ledger.begin('click', {}, { tabId: 12, sessionId: 's12' });
  ledger.finish(entry, 'unknown');
  const first = ledger.resolve(entry.id, 'confirmed');
  assert.equal(first.state, 'resolved');
  const appendsAfterFirst = ledger.durability.appends;
  const second = ledger.resolve(entry.id, 'confirmed');
  assert.equal(second.duplicate, true);
  assert.equal(second.duplicateResolve, true);
  assert.equal(ledger.durability.appends, appendsAfterFirst, '重复 resolve 不应再写 WAL');
  // 'applied' 是 confirmed 的等价写法 → 仍视为同结论。
  const third = ledger.resolve(entry.id, 'applied');
  assert.equal(third.duplicate, true);
  // 结论冲突：confirmed vs not-applied 必须拒绝。
  assert.throws(
    () => ledger.resolve(entry.id, 'not-applied'),
    (error) => {
      assert.equal(error.code, 'E_LEDGER_CONFLICT');
      assert.equal(error.data.existing.outcome, 'confirmed');
      assert.equal(error.data.attempted, 'not-applied');
      return true;
    },
  );
});

test('文件存储：begin/checkpoint 产生真实 fsync 计数与 snapshot', () => {
  const dir = tempDir();
  const ledger = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(ledger.wal.endsWith('ledger.wal'), true);
  assert.equal(ledger.file.endsWith('ledger.json'), true);
  const entry = ledger.begin('click', { ref: '@e1' }, { tabId: 2, sessionId: 's2' });
  assert.equal(ledger.durability.fsync, true);
  assert.equal(ledger.durability.syncs >= 1, true);
  assert.equal(fs.existsSync(ledger.wal), true);
  ledger.finish(entry, 'unknown');
  const stats = ledger.checkpoint();
  assert.equal(stats.entries.unknown, 1);
  assert.equal(fs.statSync(ledger.wal).size, 0, 'checkpoint 后 WAL 截断');
  const snapshot = JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  assert.equal(snapshot.version, WAL_FRAME_VERSION);
  assert.equal(snapshot.entries[0].state, 'unknown');
  // 重启后 unknown 仍在，重放被拦截。
  const reopened = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(reopened.entries[0].state, 'unknown');
  assert.throws(() => reopened.begin('click', {}, { tabId: 2 }), (error) => error.code === 'E_LEDGER_PENDING');
});

test('WAL 写入失败降级：内存态仍生效，durability.degraded 留证据', () => {
  const storage = createMemoryLedgerStorage({ failAppendAfter: 0 });
  const ledger = new IntentLedger({ storage });
  const entry = ledger.begin('click', {}, { tabId: 13 });
  assert.ok(entry.id, '写入失败不阻断动作派发');
  assert.equal(ledger.durability.degraded, true);
  assert.equal(ledger.durability.lastError.code, 'E_LEDGER_WAL_IO');
  assert.equal(ledger.entries.length, 1);
  // 内存态仍然拦截重放。
  ledger.finish(entry, 'unknown');
  assert.throws(() => ledger.begin('click', {}, { tabId: 13 }), (error) => error.code === 'E_LEDGER_PENDING');
});

test('reconcile：恢复后的非幂等 unknown 不被自动和解，显式 confirmed 才清障', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage });
  const entry = first.begin('upload', {}, { tabId: 14, sessionId: 's14' });
  const second = new IntentLedger({ storage });
  second.recover();
  assert.equal(second.reconcile(14), 0, '自动和解不能解锁恢复后的非幂等动作');
  assert.equal(second.lastReconcileSkipped, 1);
  assert.equal(second.entries.find((item) => item.id === entry.id).state, 'unknown');
  assert.equal(second.reconcile(14, 'confirmed'), 1);
  assert.equal(second.entries.find((item) => item.id === entry.id).state, 'resolved');
});

test('checkReplay / stats：只读放行，阻塞证据完整，统计包含 WAL 与恢复信息', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage });
  const entry = first.begin('drag', {}, { tabId: 15, sessionId: 's15' });
  first.finish(entry, 'unknown');
  const ledger = new IntentLedger({ storage });
  assert.equal(ledger.checkReplay('observe', { tabId: 15 }).ok, true);
  const blocked = ledger.checkReplay('click', { tabId: 15, sessionId: 's15' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_LEDGER_PENDING');
  assert.equal(blocked.blocker.method, 'drag');
  assert.equal(blocked.blocker.sessionId, 's15');
  assert.equal(blocked.blocker.requestedMethod, 'click');
  assert.equal(blocked.blocker.requestedBy, 's15');
  const stats = ledger.stats();
  assert.equal(stats.entries.unknown, 1);
  assert.equal(stats.entries.replayBlocked >= 1, true);
  assert.equal(typeof stats.wal.parsed, 'number');
  assert.equal(typeof stats.durability.fsync, 'boolean');
  const status = ledger.status({});
  assert.equal(status.pending.length, 1);
  assert.equal(status.wal.parsed >= 1, true);
});

test('非幂等动作分类与 resolve 结论归一化', () => {
  for (const method of ['click', 'fill', 'upload', 'navigate', 'webmcp.call', 'dialog.accept']) {
    assert.equal(isNonIdempotentAction(method), true, method);
  }
  for (const method of ['observe', 'screenshot', 'read', 'ledger.status']) {
    assert.equal(isNonIdempotentAction(method), false, method);
  }
  assert.deepEqual(normalizeResolveOutcome('confirmed'), { outcome: 'confirmed', effect: 'applied', explicit: true });
  assert.deepEqual(normalizeResolveOutcome('not-applied'), { outcome: 'not-applied', effect: 'none', explicit: true });
  assert.equal(normalizeResolveOutcome('abandoned').explicit, false);
  assert.equal(normalizeResolveOutcome('what'), null);
  assert.equal(LEDGER_STATES.includes('unknown'), true);
});

test('可注入存储：不传 dir 也能工作，snapshot/truncate 调用可观测', () => {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage });
  ledger.begin('click', {}, { tabId: 20 });
  ledger.flush();
  assert.equal(storage.writes >= 1, true);
  assert.equal(storage.truncates >= 1, true);
  assert.equal(ledger.file, null);
  assert.equal(ledger.wal, null);
  // 自定义最小存储：只要实现 5 个方法即可注入。
  const calls = [];
  const custom = {
    kind: 'custom',
    paths: null,
    readSnapshot: () => { calls.push('readSnapshot'); return null; },
    readWal: () => { calls.push('readWal'); return ''; },
    writeSnapshot: () => calls.push('writeSnapshot'),
    appendWal: () => calls.push('appendWal'),
    truncateWal: () => calls.push('truncateWal'),
    sync: () => calls.push('sync'),
  };
  const customLedger = new IntentLedger({ storage: custom });
  customLedger.begin('fill', {}, { tabId: 21 });
  customLedger.flush();
  assert.equal(calls.includes('appendWal'), true);
  assert.equal(calls.includes('writeSnapshot'), true);
});

test('createFileLedgerStorage 可独立构造（daemon 与测试共用同一实现）', () => {
  const dir = tempDir();
  const storage = createFileLedgerStorage(dir, { fsync: false });
  assert.equal(storage.kind, 'file');
  storage.appendWal('{"legacy":true}\n');
  assert.equal(storage.readWal(), '{"legacy":true}\n');
  storage.writeSnapshot('{"version":2,"entries":[]}');
  storage.truncateWal();
  assert.equal(storage.readWal(), '');
  assert.equal(fs.existsSync(storage.paths.snapshot), true);
});
