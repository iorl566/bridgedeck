// tests/unit/daemon-transfer-quota.test.mjs —— transfer 配额 / 断点续传 / 校验 / 失败清理。
//
// 纯策略（daemon/transfer-policy.js）与 staging 执行层（daemon/transfer.mjs）分开覆盖：
// 策略判定可注入任意条目/时钟，执行层用临时目录做真实文件读写。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransferStore, TRANSFER_CHUNK_BYTES } from '../../daemon/transfer.mjs';
import {
  MB,
  TRANSFER_DEFAULT_POLICY,
  buildTransferSnapshot,
  compareResumeOverlap,
  evaluateResumeChunk,
  evaluateTransferAdmission,
  normalizeTransferPolicy,
  planFailureCleanup,
  planTransferSweep,
  sha256Hex,
  transferPublicView,
  transferUsage,
  verifyChecksum,
} from '../../daemon/transfer-policy.js';

class TestBridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function makeStore({ policy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-transfer-quota-'));
  let clock = 1_000_000;
  const store = createTransferStore({
    dir,
    log: () => {},
    BridgeError: TestBridgeError,
    policy,
    now: () => clock,
  });
  return {
    dir,
    store,
    advance: (ms) => { clock += ms; },
    setClock: (value) => { clock = value; },
    clock: () => clock,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const b64 = (text) => Buffer.from(text).toString('base64');

// ---------------------------------------------------------------------------
// 纯策略：配额
// ---------------------------------------------------------------------------

test('normalizeTransferPolicy：非法/缺失值退回默认，不因坏配置误伤所有传输', () => {
  const defaults = normalizeTransferPolicy();
  assert.equal(defaults.maxConcurrent, TRANSFER_DEFAULT_POLICY.maxConcurrent);
  assert.equal(defaults.idleTtlMs, TRANSFER_DEFAULT_POLICY.idleTtlMs);
  const bad = normalizeTransferPolicy({ maxConcurrent: 0, maxTotalBytes: -1, idleTtlMs: 'x', maxSessionBytes: 3.5 });
  assert.equal(bad.maxConcurrent, TRANSFER_DEFAULT_POLICY.maxConcurrent);
  assert.equal(bad.maxTotalBytes, TRANSFER_DEFAULT_POLICY.maxTotalBytes);
  assert.equal(bad.idleTtlMs, TRANSFER_DEFAULT_POLICY.idleTtlMs);
  assert.equal(bad.maxSessionBytes, TRANSFER_DEFAULT_POLICY.maxSessionBytes);
  const custom = normalizeTransferPolicy({ maxConcurrent: 2, maxTotalBytes: 10 * MB, maxPerSession: 1 });
  assert.equal(custom.maxConcurrent, 2);
  assert.equal(custom.maxTotalBytes, 10 * MB);
  assert.equal(custom.maxPerSession, 1);
});

test('transferUsage：只把未完成条目算进并发/预留字节，并给出 planned 预估', () => {
  const entries = [
    { id: 'a', sessionId: 's1', byteSize: 100, received: 40, finished: false },
    { id: 'b', sessionId: 's1', byteSize: 50, received: 50, finished: true },
    { id: 'c', sessionId: 's2', byteSize: 200, received: 0, finished: false, direction: 'download' },
  ];
  const usage = transferUsage(entries, { sessionId: 's1', byteSize: 10 });
  assert.equal(usage.total, 3);
  assert.equal(usage.active, 2);
  assert.equal(usage.reservedBytes, 300);
  assert.equal(usage.receivedBytes, 90);
  assert.equal(usage.sessions, 2);
  assert.equal(usage.bySession.s1.active, 1);
  assert.deepEqual(usage.planned, { active: 3, reservedBytes: 310, sessionActive: 2, sessionBytes: 110 });
});

test('evaluateTransferAdmission：四类配额分别给出 reason/limit/usage', () => {
  const entries = [
    { id: 'a', sessionId: 's1', byteSize: 100, received: 0, finished: false },
    { id: 'b', sessionId: 's2', byteSize: 100, received: 0, finished: false },
  ];
  const allowed = evaluateTransferAdmission(entries, { sessionId: 's3', byteSize: 10, policy: { maxConcurrent: 4 } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, null);

  const concurrent = evaluateTransferAdmission(entries, { sessionId: 's3', byteSize: 10, policy: { maxConcurrent: 2, maxTotalBytes: 10 * MB } });
  assert.equal(concurrent.allowed, false);
  assert.equal(concurrent.code, 'E_TRANSFER_LIMIT');
  assert.equal(concurrent.reason, 'max-concurrent');
  assert.equal(concurrent.limit, 2);

  const perSession = evaluateTransferAdmission(entries, { sessionId: 's1', byteSize: 10, policy: { maxConcurrent: 8, maxPerSession: 1 } });
  assert.equal(perSession.reason, 'max-per-session');

  const totalBytes = evaluateTransferAdmission(entries, { sessionId: 's3', byteSize: 10, policy: { maxConcurrent: 8, maxTotalBytes: 150 } });
  assert.equal(totalBytes.reason, 'max-total-bytes');

  const sessionBytes = evaluateTransferAdmission(entries, { sessionId: 's1', byteSize: 10, policy: { maxConcurrent: 8, maxSessionBytes: 100 } });
  assert.equal(sessionBytes.reason, 'max-session-bytes');
  assert.ok(sessionBytes.usage && sessionBytes.limits);
});

// ---------------------------------------------------------------------------
// 纯策略：续传 / 校验 / 清理
// ---------------------------------------------------------------------------

test('evaluateResumeChunk：append / replay / gap / overflow / not-contiguous 判定', () => {
  const append = evaluateResumeChunk({ received: 0, offset: 0, chunkLength: 5, byteSize: 5 });
  assert.deepEqual({ allowed: append.allowed, mode: append.mode }, { allowed: true, mode: 'append' });

  // 未开 resume 时 offset 不连续 → not-contiguous（调用方映射回 E_TRANSFER_OFFSET）。
  const legacy = evaluateResumeChunk({ received: 3, offset: 0, chunkLength: 3, byteSize: 6, resume: false });
  assert.equal(legacy.allowed, false);
  assert.equal(legacy.reason, 'not-contiguous');

  // resume：重发已收区间 → replay，只写尾巴。
  const replay = evaluateResumeChunk({ received: 3, offset: 0, chunkLength: 6, byteSize: 6, resume: true });
  assert.equal(replay.allowed, true);
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.overlap, 3);
  assert.equal(replay.writeFrom, 3);
  assert.equal(replay.writeLength, 3);

  const partialReplay = evaluateResumeChunk({ received: 4, offset: 2, chunkLength: 4, byteSize: 10, resume: true });
  assert.equal(partialReplay.mode, 'replay');
  assert.equal(partialReplay.overlap, 2);
  assert.equal(partialReplay.writeLength, 2);

  const gap = evaluateResumeChunk({ received: 2, offset: 5, chunkLength: 1, byteSize: 10, resume: true });
  assert.equal(gap.reason, 'gap');

  const overflow = evaluateResumeChunk({ received: 0, offset: 0, chunkLength: 7, byteSize: 6 });
  assert.equal(overflow.reason, 'overflow');

  const empty = evaluateResumeChunk({ received: 0, offset: 0, chunkLength: 0, byteSize: 6 });
  assert.equal(empty.reason, 'empty');
});

test('compareResumeOverlap：逐字节比较并给出首个差异位置', () => {
  assert.equal(compareResumeOverlap(Buffer.from('abc'), Buffer.from('abc')).ok, true);
  const mismatch = compareResumeOverlap(Buffer.from('abc'), Buffer.from('abd'));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.at, 2);
  assert.equal(compareResumeOverlap(Buffer.from('abc'), Buffer.from('ab')).ok, false);
  assert.equal(compareResumeOverlap(Buffer.alloc(0), Buffer.alloc(0)).ok, true);
});

test('sha256Hex / verifyChecksum：缺省跳过、坏格式拒绝、不一致报 checksum-mismatch', () => {
  const digest = sha256Hex(Buffer.from('hello'));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyChecksum(undefined, digest), { ok: true, skipped: true, reason: null });
  assert.equal(verifyChecksum(digest.toUpperCase(), digest).ok, true);
  assert.equal(verifyChecksum('nope', digest).reason, 'bad-digest');
  const bad = verifyChecksum(sha256Hex(Buffer.from('other')), digest);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'checksum-mismatch');
});

test('planFailureCleanup / planTransferSweep：失败与空闲/过期回收计划', () => {
  const cleanup = planFailureCleanup({ id: 'tr_x', sessionId: 's1', received: 7, byteSize: 9 }, 'checksum-failed');
  assert.deepEqual(cleanup, { id: 'tr_x', sessionId: 's1', reason: 'checksum-failed', bytes: 7, needsUnlink: true });

  const now = 1_700_000_000_000;
  const entries = [
    { id: 'idle', sessionId: 's1', byteSize: 10, received: 1, finished: false, createdAt: now - 20 * 60_000, lastActivityAt: now - 20 * 60_000 },
    { id: 'busy', sessionId: 's1', byteSize: 10, received: 1, finished: false, createdAt: now - 20 * 60_000, lastActivityAt: now - 1_000 },
    { id: 'stale-finished', sessionId: 's2', byteSize: 10, received: 10, finished: true, createdAt: now - 60 * 60_000, lastActivityAt: now - 60 * 60_000 },
  ];
  const plan = planTransferSweep(entries, { now });
  assert.equal(plan.scanned, 3);
  assert.equal(plan.keep, 1);
  assert.deepEqual(plan.remove.map((item) => item.id).sort(), ['idle', 'stale-finished']);
  assert.equal(plan.reasons['idle-unfinished'], 1);
  assert.equal(plan.reasons['stale-finished'], 1);
  assert.equal(plan.bytes, 20);
  // 关闭 TTL：全部保留（运维在慢盘上可关掉自动清理）。
  const off = planTransferSweep(entries, { now, policy: { idleTtlMs: 0, finishedTtlMs: 0 } });
  assert.equal(off.remove.length, 0);
});

test('transferPublicView / buildTransferSnapshot：不暴露 staging 路径，汇总配额与截断', () => {
  const now = 1_000_000;
  const entry = {
    id: 'tr_aaaaaaaaaaaaaaaa', sessionId: 's1', name: 'a.txt', byteSize: 100, received: 50,
    filePath: 'C:/secret/staging/a.txt', createdAt: now - 1000, lastActivityAt: now - 200, finished: false,
    direction: 'upload', verified: false, checksum: null,
  };
  const view = transferPublicView(entry, { now });
  assert.equal(view.transferId, 'tr_aaaaaaaaaaaaaaaa');
  assert.equal(view.percent, 50);
  assert.equal(view.remaining, 50);
  assert.equal(view.idleMs, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'filePath'), false);
  assert.equal(JSON.stringify(view).includes('secret'), false);

  const snapshot = buildTransferSnapshot([entry], { now, limit: 1, policy: { maxConcurrent: 2, maxTotalBytes: 1000 } });
  assert.equal(snapshot.counts.total, 1);
  assert.equal(snapshot.counts.active, 1);
  assert.equal(snapshot.bytes.reserved, 100);
  assert.equal(snapshot.quota.maxConcurrent, 2);
  assert.equal(snapshot.quota.usagePercent, 10);
  assert.equal(snapshot.quota.slotsPercent, 50);
  assert.equal(snapshot.transfers.length, 1);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.sessions.length, 1);
});

// ---------------------------------------------------------------------------
// 执行层：配额
// ---------------------------------------------------------------------------

test('store.begin 配额拒绝：E_TRANSFER_LIMIT 带 reason/limit，且不创建 staging 目录', () => {
  const ctx = makeStore({ policy: { maxConcurrent: 1, maxPerSession: 1 } });
  try {
    const first = ctx.store.begin({ sessionId: 's1', name: 'a.txt', byteSize: 4 });
    assert.ok(first.transferId);
    const dirsBefore = fs.readdirSync(ctx.dir).length;
    assert.throws(
      () => ctx.store.begin({ sessionId: 's1', name: 'b.txt', byteSize: 4 }),
      (error) => error.code === 'E_TRANSFER_LIMIT' && error.data.reason === 'max-concurrent' && error.data.limit === 1,
    );
    assert.equal(fs.readdirSync(ctx.dir).length, dirsBefore, '拒绝时不能留下 staging 目录');
    ctx.store.release({ transferId: first.transferId });
    const second = ctx.store.begin({ sessionId: 's1', name: 'b.txt', byteSize: 4 });
    assert.ok(second.transferId, '释放后配额应恢复');
    const snapshot = ctx.store.snapshot();
    assert.equal(snapshot.counters.quotaRejected >= 1, true);
    assert.equal(snapshot.counters.rejectReasons['max-concurrent'] >= 1, true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 执行层：断点续传
// ---------------------------------------------------------------------------

test('store.chunk resume=true：重叠段校验 + 只追加尾巴（eof/nextOffset 正确）', () => {
  const ctx = makeStore();
  try {
    const begun = ctx.store.begin({ sessionId: 's1', name: 'resume.bin', byteSize: 6 });
    const first = ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('hel') });
    assert.deepEqual(first, { nextOffset: 3, eof: false });
    // 客户端断线后不知道进度，重发 offset=0 的完整块：重叠 'hel' 一致 → 追加 'lo!'。
    const resumed = ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('hello!'), resume: true });
    assert.equal(resumed.nextOffset, 6);
    assert.equal(resumed.eof, true);
    assert.equal(resumed.mode, 'replay');
    assert.equal(resumed.verifiedBytes, 3);
    assert.equal(resumed.received, 6);
    ctx.store.finish({ transferId: begun.transferId });
    const read = ctx.store.read({ transferId: begun.transferId, offset: 0 });
    assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'hello!');
    assert.equal(read.received, 6);
    assert.equal(read.byteSize, 6);
    assert.equal(read.remaining, 0);
    assert.equal(read.finished, true);
    assert.equal(ctx.store.snapshot().counters.resumeReplays, 1);
  } finally {
    ctx.cleanup();
  }
});

test('store.chunk resume=true：重叠字节不一致 → E_TRANSFER_STATE，不写入任何字节', () => {
  const ctx = makeStore();
  try {
    const begun = ctx.store.begin({ sessionId: 's1', name: 'resume-bad.bin', byteSize: 6 });
    ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('abc') });
    assert.throws(
      () => ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('abXdef'), resume: true }),
      (error) => error.code === 'E_TRANSFER_STATE' && error.data.at === 2,
    );
    const read = ctx.store.read({ transferId: begun.transferId, offset: 0, maxBytes: 3 });
    assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'abc');
    assert.equal(read.received, 3, '校验失败不能推进进度');
    // resume 仍允许 offset 比已收更小且完全重叠（只校验不写入）。
    const replay = ctx.store.chunk({ transferId: begun.transferId, offset: 1, dataBase64: b64('bc'), resume: true });
    assert.equal(replay.mode, 'replay');
    assert.equal(replay.nextOffset, 3);
  } finally {
    ctx.cleanup();
  }
});

test('store.chunk 单块 sha256：先校验再落盘（坏块不污染 staging）', () => {
  const ctx = makeStore();
  try {
    const begun = ctx.store.begin({ sessionId: 's1', name: 'chunk-digest.bin', byteSize: 4 });
    const bad = crypto.createHash('sha256').update('nope').digest('hex');
    assert.throws(
      () => ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('abcd'), sha256: bad }),
      (error) => error.code === 'E_BAD_ARG' && error.data.reason === 'checksum-mismatch',
    );
    assert.equal(ctx.store.read({ transferId: begun.transferId, offset: 0 }).received, 0);
    const good = sha256Hex(Buffer.from('abcd'));
    const chunk = ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('abcd'), sha256: good });
    assert.equal(chunk.nextOffset, 4);
    assert.equal(chunk.eof, true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 执行层：整文件校验与失败清理
// ---------------------------------------------------------------------------

test('store.finish sha256 校验：成功标记 verified；失败释放 staging（失败清理）', () => {
  const ctx = makeStore();
  try {
    const okTransfer = ctx.store.begin({ sessionId: 's1', name: 'ok.bin', byteSize: 5 });
    ctx.store.chunk({ transferId: okTransfer.transferId, offset: 0, dataBase64: b64('hello') });
    const digest = sha256Hex(Buffer.from('hello'));
    const finished = ctx.store.finish({ transferId: okTransfer.transferId, sha256: digest });
    assert.equal(finished.verified, true);
    assert.equal(finished.sha256, digest);
    assert.equal(ctx.store.read({ transferId: okTransfer.transferId, offset: 0, digest: true }).sha256, digest);

    const badTransfer = ctx.store.begin({ sessionId: 's1', name: 'bad.bin', byteSize: 5 });
    ctx.store.chunk({ transferId: badTransfer.transferId, offset: 0, dataBase64: b64('hello') });
    assert.throws(
      () => ctx.store.finish({ transferId: badTransfer.transferId, sha256: sha256Hex(Buffer.from('world')) }),
      (error) => error.code === 'E_TRANSFER_STATE' && error.data.released === true,
    );
    assert.equal(ctx.store.size, 1, '校验失败必须释放 staging（只留下已完成的那份）');
    assert.throws(
      () => ctx.store.read({ transferId: badTransfer.transferId, offset: 0 }),
      (error) => error.code === 'E_TRANSFER_NOT_FOUND',
    );
    assert.equal(ctx.store.snapshot().counters.checksumFailed >= 1, true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 执行层：空闲清理 / 快照
// ---------------------------------------------------------------------------

test('store.sweep：空闲未完成与过期已完成被回收，活跃传输保留', () => {
  const ctx = makeStore({ policy: { idleTtlMs: 10_000, finishedTtlMs: 10_000 } });
  try {
    const idle = ctx.store.begin({ sessionId: 's1', name: 'idle.bin', byteSize: 4 });
    ctx.advance(30_000);
    const active = ctx.store.begin({ sessionId: 's2', name: 'active.bin', byteSize: 4 });
    const done = ctx.store.begin({ sessionId: 's3', name: 'done.bin', byteSize: 4 });
    ctx.store.chunk({ transferId: done.transferId, offset: 0, dataBase64: b64('abcd') });
    ctx.store.finish({ transferId: done.transferId });
    ctx.advance(15_000);
    // 刷新 active 的最近活动时间（模拟客户端还在续传），它不应被清理。
    ctx.store.chunk({ transferId: active.transferId, offset: 0, dataBase64: b64('a') });
    const swept = ctx.store.sweep();
    const ids = swept.removed.map((item) => item.id).sort();
    assert.deepEqual(ids, [done.transferId, idle.transferId].sort());
    assert.equal(ctx.store.size, 1);
    assert.ok(ctx.store.read({ transferId: active.transferId, offset: 0 }));
    assert.equal(ctx.store.snapshot().counters.sweepRemoved, 2);
  } finally {
    ctx.cleanup();
  }
});

test('store.snapshot：配额用量/计数/截断，且不含 staging 路径', () => {
  const ctx = makeStore();
  try {
    for (let index = 0; index < 3; index += 1) {
      const begun = ctx.store.begin({ sessionId: 's1', name: 'f' + index + '.bin', byteSize: TRANSFER_CHUNK_BYTES });
      ctx.store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: b64('x') });
    }
    const snapshot = ctx.store.snapshot({ limit: 2 });
    assert.equal(snapshot.counts.total, 3);
    assert.equal(snapshot.counts.active, 3);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.transfers.length, 2);
    assert.equal(snapshot.bytes.reserved, 3 * TRANSFER_CHUNK_BYTES);
    assert.equal(snapshot.counters.begun, 3);
    assert.equal(JSON.stringify(snapshot).includes(ctx.dir), false, '快照不能泄露 staging 目录');
  } finally {
    ctx.cleanup();
  }
});
