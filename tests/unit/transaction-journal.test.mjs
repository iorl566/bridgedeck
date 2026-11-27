import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createActionJournal,
  createFileSink,
  createMemorySink,
  createStorageSink,
  fnv1a,
  journalKeys,
  journalTarget,
  rowAnchorDigest,
} from '../../extension/src/lib/action-journal.js';
import {
  classifyTransactionFailure,
  createActionTransaction,
  createFileTransaction,
  transactionFields,
} from '../../extension/src/lib/transaction-ledger.js';

let dirSeq = 0;
function tempDir(label = 'aj') {
  dirSeq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label + '-' + dirSeq + '-'));
  return {
    dir,
    file: path.join(dir, 'journal.jsonl'),
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows 上偶发占用：测试不因临时目录清理失败而挂。
      }
    },
  };
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

test('预写日志：begin 先落盘，commit 追加终态，JSONL 可逐行解析', async () => {
  const journal = createActionJournal({ sink: createMemorySink() });
  const begun = await journal.begin({ method: 'fill', tabId: 7, phase: 'pointer', params: { ref: '@e3', value: 'secret-value', rowAnchor: { ariaRowIndex: 4, rowText: '张三 100' } } });
  assert.equal(begun.ok, true);
  assert.match(begun.id, /^aj_/);
  assert.equal(begun.state, 'pending');
  assert.equal(typeof begun.latencyMs, 'number');
  // 预写记录在 commit 之前就已存在。
  const before = journal.entries();
  assert.equal(before.length, 1);
  assert.equal(before[0].kind, 'begin');
  assert.equal(before[0].method, 'fill');
  assert.equal(before[0].tabId, 7);
  assert.deepEqual(before[0].target, { ref: '@e3' });
  // 隐私：值不落盘，只留行锚点摘要。
  assert.equal(JSON.stringify(before[0]).includes('secret-value'), false, '预写日志泄漏了输入值');
  assert.equal(before[0].row_anchor.ariaRowIndex, 4);
  assert.equal(typeof before[0].row_anchor.rowTextHash, 'string');
  assert.equal(JSON.stringify(before[0]).includes('张三'), false, '预写日志泄漏了行文本');

  const committed = await journal.commit(begun.id, { details: { matches: true } });
  assert.equal(committed.ok, true);
  assert.equal(committed.state, 'committed');
  const lines = journal.exportJSONL().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.kind), ['begin', 'commit']);
  assert.equal(lines[1].details.matches, true);
  assert.equal(journal.stateOf(begun.id).state, 'committed');
  assert.equal(journal.status().begins, 1);
  assert.equal(journal.status().commits, 1);
});

test('隐私脱敏：参数键过滤 secret，目标只留定位字段，哈希稳定', () => {
  assert.deepEqual(journalKeys({ ref: '@e1', value: 'x', password: 'p', token: 't', noClear: true }), ['noClear', 'ref']);
  assert.deepEqual(journalTarget({ ref: '@e9', selector: 'input.x', value: 'v', tabId: 3, nested: { a: 1 }, visualIndex: 2 }), { ref: '@e9', selector: 'input.x', tabId: 3, visualIndex: 2 });
  assert.equal(fnv1a('same'), fnv1a('same'));
  assert.notEqual(fnv1a('same'), fnv1a('other'));
  const digest = rowAnchorDigest({ ariaRowIndex: 5, dataIndex: 5, rowKey: 'k1', rowText: 'row one', transform: 'translateY(12px)', containerScrollTop: 48, recycled: false });
  assert.equal(digest.ariaRowIndex, 5);
  assert.equal(digest.rowTextLength, 7);
  assert.equal(digest.transform, 'translateY(12px)');
  assert.equal(digest.containerScrollTop, 48);
  assert.equal(JSON.stringify(digest).includes('row one'), false);
});

test('文件 sink：JSONL 逐行 + fsync 被调用（可注入 fs 计数）', async () => {
  const tmp = tempDir('aj-file');
  try {
    let fsyncCalls = 0;
    const wrapped = {
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      writeSync: fs.writeSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      appendFileSync: fs.appendFileSync,
      readFileSync: fs.readFileSync,
      fsyncSync(target) {
        fsyncCalls += 1;
        return fs.fsyncSync(target);
      },
    };
    const sink = createFileSink({ file: tmp.file, fs: wrapped, fsync: true });
    const journal = createActionJournal({ sink });
    const first = await journal.begin({ method: 'click', tabId: 1, params: { ref: '@e1' } });
    const second = await journal.begin({ method: 'fill', tabId: 1, params: { ref: '@e2', value: 'hidden' } });
    await journal.commit(second.id, {});
    await journal.abort(first.id, 'page-changed', { revision: 9 });
    assert.equal(fsyncCalls >= 4, true, 'fsync 调用次数不足：' + fsyncCalls);
    const text = fs.readFileSync(tmp.file, 'utf8');
    const records = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.kind), ['begin', 'begin', 'commit', 'abort']);
    assert.equal(records[3].reason, 'page-changed');
    assert.equal(text.includes('hidden'), false, '文件日志泄漏输入值');
    assert.equal(sink.bytesWritten() > 0, true);
    sink.close();
  } finally {
    tmp.cleanup();
  }
});

test('预写延迟预算：内存/storage 形态 p95 < 3ms；JSONL+fsync 单独记录（磁盘 I/O 下界）', async () => {
  const memory = createActionJournal({ sink: createMemorySink() });
  const memorySamples = [];
  for (let index = 0; index < 120; index += 1) {
    const started = process.hrtime.bigint();
    const begun = await memory.begin({ method: 'click', tabId: 1, params: { ref: '@e' + index } });
    await memory.commit(begun.id, {});
    memorySamples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const memoryP95 = percentile(memorySamples, 0.95);
  assert.ok(memoryP95 < 3, '内存预写 p95=' + memoryP95.toFixed(3) + 'ms 超出 3ms 预算');
  assert.equal(memory.latency().budgetMs, 3);

  // 扩展 service worker 的真实形态是 storage（chrome.storage.session 在浏览器进程内存里，
  // 不落磁盘）；用一个即时 storage 夹具测“账本逻辑 + await 一次 set”的预写开销。
  const box = {};
  const storage = {
    async get(key) {
      return key in box ? { [key]: box[key] } : {};
    },
    async set(values) {
      Object.assign(box, values);
    },
  };
  const stored = createActionJournal({ sink: createStorageSink({ storage }) });
  const storageSamples = [];
  for (let index = 0; index < 80; index += 1) {
    const started = process.hrtime.bigint();
    const begun = await stored.begin({ method: 'fill', tabId: 2, params: { ref: '@e' + index } });
    storageSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
    await stored.commit(begun.id, {});
  }
  const storageP95 = percentile(storageSamples, 0.95);
  assert.ok(storageP95 < 3, 'storage 形态预写 p95=' + storageP95.toFixed(3) + 'ms 超出 3ms 预算');

  // JSONL+fsync 形态受本机磁盘支配（本机 temp 盘 fsync 中位数 1.5–3ms，负载下有长尾），
  // 这里只断言“常路径不劣化到不可用”，并把实测分布写进失败信息/报告。
  const tmp = tempDir('aj-bench');
  try {
    const sink = createFileSink({ file: tmp.file, fs: fs });
    const journal = createActionJournal({ sink });
    await journal.begin({ method: 'warmup', tabId: 9, params: { ref: '@e0' } });
    const samples = [];
    for (let index = 0; index < 60; index += 1) {
      const started = process.hrtime.bigint();
      const begun = await journal.begin({ method: 'fill', tabId: 9, params: { ref: '@e' + index } });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      await journal.commit(begun.id, {});
    }
    const p50 = percentile(samples, 0.5);
    const p90 = percentile(samples, 0.9);
    const stats = journal.latency();
    assert.ok(p50 < 8, 'JSONL+fsync 预写 p50=' + p50.toFixed(3) + 'ms 异常；统计=' + JSON.stringify(stats));
    assert.ok(p90 < 20, 'JSONL+fsync 预写 p90=' + p90.toFixed(3) + 'ms 抖动过大；统计=' + JSON.stringify(stats));
    assert.equal(stats.budgetMs, 3);
    assert.equal(stats.samples >= 60, true);
    // fsync 语义：每次预写都确实 fsync（次数 >= begin 数）。
    assert.equal(sink.fsyncCalls() >= 61, true, 'fsync 次数=' + sink.fsyncCalls());
    assert.equal(sink.durable, true);
    sink.close();
  } finally {
    tmp.cleanup();
  }
});

test('storage sink：预写 await 落 storage，崩溃后新实例恢复出 UNKNOWN', async () => {
  const box = {};
  const storage = {
    async get(key) {
      return key in box ? { [key]: box[key] } : {};
    },
    async set(values) {
      Object.assign(box, values);
    },
  };
  const first = createActionJournal({ sink: createStorageSink({ storage }) });
  const begun = await first.begin({ method: 'click', tabId: 3, params: { ref: '@e7', rowAnchor: { ariaRowIndex: 2 } } });
  assert.equal(typeof box.__bb_action_journal__, 'string', '预写没有写进 storage');
  assert.equal(box.__bb_action_journal__.includes(begun.id), true);

  // 模拟 service worker 被杀：不做 commit，直接新建 journal（同一 storage）。
  const second = createActionJournal({ sink: createStorageSink({ storage }) });
  const recovered = await second.begin({ method: 'observe-after-restart', tabId: 3 });
  const report = second.recoveredReport;
  assert.equal(report.unknown.length, 1, '重启后没有恢复出 UNKNOWN：' + JSON.stringify(report));
  assert.equal(report.unknown[0].id, begun.id);
  assert.equal(report.unknown[0].effectState, 'unknown');
  assert.equal(report.unknown[0].cleanupState, 'failed');
  assert.equal(report.unknown[0].replay, false);
  assert.equal(report.reconcile[0].action, 'observe-then-resolve');
  assert.deepEqual(report.reconcile[0].outcomes, ['confirmed', 'not-applied']);
  assert.equal(recovered.ok, true);
  // 未确认的 tab 被标记为需要显式 resolve，但不会自动重放。
  assert.equal(second.blocksTab(3).recurrence, 'requires-explicit-resolve');
});

test('文件日志崩溃恢复：pending 全部标 UNKNOWN，显式 resolve 后解除', async () => {
  const tmp = tempDir('aj-crash');
  try {
    const sinkA = createFileSink({ file: tmp.file, fs });
    const journalA = createActionJournal({ sink: sinkA });
    const first = await journalA.begin({ method: 'click', tabId: 11, params: { ref: '@e1' } });
    const second = await journalA.begin({ method: 'fill', tabId: 11, params: { ref: '@e2', value: 'x' } });
    await journalA.commit(first.id, {});
    // second 只有 begin：模拟扩展在动作中途被杀。
    const done = await journalA.begin({ method: 'hover', tabId: 12, params: { ref: '@e3' } });
    await journalA.commit(done.id, {});

    // 新实例（新进程）读同一文件：第一个动作触发恢复。
    const sinkB = createFileSink({ file: tmp.file, fs });
    const journalB = createActionJournal({ sink: sinkB });
    const next = await journalB.begin({ method: 'click', tabId: 11, params: { ref: '@e9' } });
    const report = journalB.recoveredReport;
    assert.equal(report.scanned >= 4, true);
    assert.equal(report.pending, 1);
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0].id, second.id);
    assert.equal(report.unknown[0].phase, 'pointer');
    assert.equal(report.cleanupState, 'needs-resolve');
    // 恢复结果也写回文件（可被下一进程读到）。
    const text = fs.readFileSync(tmp.file, 'utf8');
    assert.equal(text.includes('"kind":"recovered"'), true);
    assert.equal(text.includes('"state":"unknown"'), true);
    // 已有 UNKNOWN 时新动作仍可执行（journal 只提示，不越权拦截 daemon 层），但结果带 recovered 提示。
    assert.equal(next.recovered.length, 1);

    assert.equal(journalB.pending().length, 1);
    assert.equal(journalB.stateOf(second.id).state, 'unknown');
    assert.equal(journalB.stateOf(second.id).cleanupState, 'failed');
    const blocked = journalB.blocksTab(11);
    assert.equal(blocked.id, second.id);

    // UNKNOWN 不能自动变成 committed：commit 被拒。
    const lateCommit = await journalB.commit(second.id, {});
    assert.equal(lateCommit.ok, false);
    assert.equal(lateCommit.code, 'E_BAD_ARG');

    const resolved = await journalB.resolve(second.id, { outcome: 'not-applied', by: 'user', note: '页面未变化' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.state, 'resolved');
    assert.equal(journalB.pending().length, 0);
    assert.equal(journalB.blocksTab(11), null);
    assert.equal(journalB.status().resolved, 1);
    const resolvedRecord = journalB.entries().find((record) => record.kind === 'resolve' && record.id === second.id);
    assert.equal(resolvedRecord.outcome, 'not-applied');
    assert.equal(resolvedRecord.note, '页面未变化');
    // 重复 resolve 被拒（已终态）。
    assert.equal((await journalB.resolve(second.id, { outcome: 'confirmed' })).code, 'E_BAD_ARG');
    assert.equal((await journalB.resolve('aj_missing', { outcome: 'confirmed' })).code, 'E_NOT_FOUND');
    sinkA.close();
    sinkB.close();
  } finally {
    tmp.cleanup();
  }
});

test('事务四态：begin→dispatched→commit / unknown 后禁止重放，显式 resolve 才有结论', async () => {
  const tmp = tempDir('aj-tx');
  try {
    const sink = createFileSink({ file: tmp.file, fs });
    const journal = createActionJournal({ sink });
    const tx = createActionTransaction({ phase: 'pointer', journal, method: 'click', tabId: 5, params: { ref: '@e4' } });
    const begun = await tx.begin();
    assert.equal(begun.ok, true);
    assert.equal(tx.state, 'begun');
    assert.equal(tx.effectState, 'none');
    assert.equal(tx.cleanupState, 'pending');
    assert.equal(tx.canReplay(), true);
    assert.equal(typeof tx.journalId, 'string');
    tx.markDispatched({ phase: 'click-press' });
    assert.equal(tx.state, 'dispatched');
    assert.equal(tx.effectState, 'unknown');
    assert.equal(tx.canReplay(), false);
    const committed = await tx.commit({ details: { via: 'trusted' } });
    assert.equal(committed.ok, true);
    assert.equal(tx.effectState, 'committed');
    assert.equal(tx.cleanupState, 'ok');
    assert.deepEqual(tx.fields(), {
      effectState: 'committed',
      cleanupState: 'ok',
      phase: 'pointer',
      tx_id: tx.id,
      journal_id: tx.journalId,
      replayable: false,
    });
    assert.deepEqual(transactionFields(tx).tx_state, 'committed');

    const failing = createActionTransaction({ phase: 'pointer', journal, method: 'click', tabId: 5, params: { ref: '@e5' } });
    await failing.begin();
    failing.markDispatched();
    const networkError = new Error('socket disconnected');
    networkError.code = 'E_TIMEOUT';
    await failing.fail(networkError);
    assert.equal(failing.state, 'unknown');
    assert.equal(failing.cleanupState, 'failed');
    assert.equal(failing.canReplay(), false);
    assert.equal(networkError.data.effect_state, 'unknown');
    assert.equal(networkError.data.replay, false);
    assert.equal(networkError.data.tx_id, failing.id);
    assert.equal(networkError.data.next, 'observe-then-resolve');
    assert.throws(() => failing.assertReplayable(), (error) => error.data.cause === 'effect_unknown' && error.data.replay === false);
    const resolved = await failing.resolve({ outcome: 'confirmed', by: 'agent', note: '页面已出现新行' });
    assert.equal(resolved.ok, true);
    assert.equal(failing.state, 'resolved');
    assert.equal(failing.snapshot().resolveOutcome, 'confirmed');
    assert.equal((await failing.resolve({ outcome: 'confirmed' })).ok, false);
    assert.equal((await failing.resolve({ outcome: 'wrong' })).ok, false);

    // 事务日志链：begin → unknown → resolve
    const kinds = journal.entries().filter((record) => record.id === failing.journalId).map((record) => record.kind);
    assert.deepEqual(kinds, ['begin', 'unknown', 'resolve']);
    sink.close();
  } finally {
    tmp.cleanup();
  }
});

test('失败分类：派发前错误 abort（可重放），派发后/超时 unknown（不可重放）', async () => {
  assert.equal(classifyTransactionFailure({ code: 'E_NOT_FOUND', message: '找不到元素' }), 'none');
  assert.equal(classifyTransactionFailure({ code: 'E_TARGET_MISMATCH', message: '行不稳定' }), 'none');
  assert.equal(classifyTransactionFailure({ code: 'E_TIMEOUT', message: 'timeout' }), 'unknown');
  assert.equal(classifyTransactionFailure({ code: 'E_INTERNAL', message: '已按下但结果未知' }), 'unknown');
  assert.equal(classifyTransactionFailure({ code: 'E_INTERNAL', data: { effect_state: 'unknown' } }), 'unknown');
  assert.equal(classifyTransactionFailure({ code: 'E_INTERNAL', data: { dispatched: false } }), 'none');

  const journal = createActionJournal({ sink: createMemorySink() });
  const rejected = createActionTransaction({ phase: 'pointer', journal, method: 'fill', tabId: 2 });
  await rejected.begin();
  const notFound = new Error('找不到元素');
  notFound.code = 'E_NOT_FOUND';
  await rejected.fail(notFound);
  assert.equal(rejected.state, 'aborted');
  assert.equal(rejected.effectState, 'none');
  assert.equal(rejected.canReplay(), true, '派发前失败应允许安全重试');
  assert.equal(notFound.data.effect_state, 'none');
  assert.equal(notFound.data.dispatched, false);
  assert.equal(notFound.data.replay, true);

  const lost = createActionTransaction({ phase: 'pointer', journal, method: 'fill', tabId: 2 });
  await lost.begin();
  lost.markDispatched({ phase: 'fill-insert' });
  const generic = new Error('释放输入失败');
  await lost.fail(generic);
  assert.equal(lost.state, 'unknown');
  assert.equal(generic.data.effect_state, 'unknown');
  assert.equal(generic.data.replay, false);

  const cleanup = createActionTransaction({ phase: 'pointer', journal, method: 'drag', tabId: 2 });
  await cleanup.begin();
  cleanup.markDispatched();
  await cleanup.unknown({ reason: 'release-failed' });
  await cleanup.cleanupFailed({ release: 'failed' });
  assert.equal(cleanup.cleanupState, 'failed');
  const cleanupRecord = journal.entries().find((record) => record.kind === 'cleanup');
  assert.equal(cleanupRecord.state, 'failed');
});

test('file 事务：phase=file 的四态与 UNKNOWN 恢复 reconciliation', async () => {
  const tmp = tempDir('aj-filetx');
  try {
    const sink = createFileSink({ file: tmp.file, fs });
    const journal = createActionJournal({ sink });
    const tx = createFileTransaction({ journal, method: 'download', tabId: 8, params: { url: 'https://example.com/a.bin' } });
    await tx.begin();
    assert.equal(tx.phase, 'file');
    tx.markDispatched({ phase: 'download-start' });
    await tx.commit({ details: { bytes: 42 } });
    assert.deepEqual(tx.fields(), {
      effectState: 'committed',
      cleanupState: 'ok',
      phase: 'file',
      tx_id: tx.id,
      journal_id: tx.journalId,
      replayable: false,
    });

    const lost = createFileTransaction({ journal, method: 'upload', tabId: 8 });
    await lost.begin({ target: { selector: 'input[type=file]' } });
    lost.markDispatched({ phase: 'upload-start' });
    const timeout = new Error('upload timeout');
    timeout.code = 'E_TIMEOUT';
    await lost.fail(timeout);
    assert.equal(lost.state, 'unknown');
    // 未确认的 file 阶段 UNKNOWN 进入 pending；页面核对后显式 resolve。
    const pending = journal.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].phase, 'file');
    assert.equal(pending[0].cleanupState, 'failed');
    const resolved = await journal.resolve(pending[0].id, { outcome: 'confirmed', note: '下载目录已有文件' });
    assert.equal(resolved.ok, true);

    // 崩溃恢复：file 阶段只有 begin、没有终态 → 新实例把 pending 标 UNKNOWN 并给 reconcile 建议。
    const crashing = createFileTransaction({ journal, method: 'upload', tabId: 9 });
    await crashing.begin();
    const sink2 = createFileSink({ file: tmp.file, fs });
    const journal2 = createActionJournal({ sink: sink2 });
    await journal2.begin({ method: 'click', tabId: 1 });
    const report = journal2.recoveredReport;
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0].phase, 'file');
    assert.equal(report.reconcile[0].phase, 'file');
    assert.equal(report.reconcile[0].action, 'observe-then-resolve');
    assert.equal((await journal2.resolve(report.unknown[0].id, { outcome: 'not-applied' })).ok, true);
    sink2.close();
    sink.close();
  } finally {
    tmp.cleanup();
  }
});

test('compact 保留未确认 UNKNOWN，journal status/latency/export 结构完整', async () => {
  const journal = createActionJournal({ sink: createMemorySink(), maxEntries: 10 });
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    const begun = await journal.begin({ method: 'click', tabId: 1, params: { ref: '@e' + index } });
    ids.push(begun.id);
    if (index % 2 === 0) await journal.commit(begun.id, {});
  }
  const lastEntry = journal.entries()[journal.entries().length - 1];
  await journal.unknown(lastEntry.id, { phase: 'click-press' });
  const compacted = await journal.compact({ keepTerminal: 1 });
  assert.equal(compacted.ok, true);
  const kinds = journal.entries().map((record) => record.kind);
  assert.equal(kinds.includes('unknown'), true, 'compact 丢掉了未确认 UNKNOWN');
  assert.equal(journal.pending().length, 1);
  const status = journal.status();
  assert.equal(status.journal, 'memory');
  assert.equal(status.durable, false);
  assert.equal(status.pendingUnknown, 1);
  assert.equal(typeof status.latency.p50Ms, 'number');
  assert.equal(typeof journal.exportJSONL(), 'string');
  assert.equal(journal.stateOf('missing'), null);
});

test('自动压缩：不丢未确认 UNKNOWN，也不把孤立终态误判成 UNKNOWN', async () => {
  const tmp = tempDir('aj-trim');
  try {
    const sink = createFileSink({ file: tmp.file, fs });
    const journal = createActionJournal({ sink, maxEntries: 2 }); // 压缩阈值 = 2*4 = 8 条
    for (let index = 0; index < 12; index += 1) {
      const begun = await journal.begin({ method: 'click', tabId: 1, params: { ref: '@e' + index } });
      await journal.commit(begun.id, {});
    }
    assert.equal(journal.status().unknowns, 0, '孤立终态记录造出了 UNKNOWN');
    assert.equal(journal.pending().length, 0);
    assert.equal(journal.status().begins, 12);

    const lost = await journal.begin({ method: 'fill', tabId: 3, params: { ref: '@e99' } });
    for (let index = 0; index < 8; index += 1) {
      const begun = await journal.begin({ method: 'click', tabId: 1, params: { ref: '@x' + index } });
      await journal.commit(begun.id, {});
    }
    assert.equal(journal.status().unknowns, 0, '压缩后出现伪 UNKNOWN');
    // 未确认的 begin 必须还在，否则重启恢复会漏掉“页面可能已被改”的动作。
    assert.equal(journal.entries().some((record) => record.id === lost.id && record.kind === 'begin'), true, '压缩丢了未确认 UNKNOWN');
    assert.equal(journal.stateOf(lost.id).state, 'pending');

    // 模拟重启：同一文件的新实例把 pending 标 UNKNOWN，未确认记录没有被压缩丢掉。
    const sink2 = createFileSink({ file: tmp.file, fs });
    const journal2 = createActionJournal({ sink: sink2 });
    await journal2.begin({ method: 'click', tabId: 1 });
    const report = journal2.recoveredReport;
    assert.equal(report.unknown.some((item) => item.id === lost.id), true, '重启恢复漏掉了未确认动作：' + JSON.stringify(report.unknown));
    assert.equal(report.unknown[0].replay, false);
    assert.equal(journal2.status().pendingUnknown, report.unknown.length);
    sink2.close();
    sink.close();
  } finally {
    tmp.cleanup();
  }
});

test('真实扩展 runtime 事务入口：beginJournaledTransaction 预写+行锚点摘要+降级', async () => {
  const { beginJournaledTransaction, recoverActionJournal, setActionJournal, getActionJournal } = await import('../../extension/src/lib/action-journal.js');
  const journal = createActionJournal({ sink: createMemorySink() });
  setActionJournal(journal);
  try {
    const { tx, degraded } = await beginJournaledTransaction({
      method: 'fill',
      params: { tabId: 4, ref: '@e8', value: 'x', rowAnchor: { ariaRowIndex: 3, rowText: 'B' } },
    });
    assert.equal(degraded, false);
    assert.equal(tx.state, 'begun');
    const beginRecord = journal.entries().find((record) => record.kind === 'begin');
    assert.equal(beginRecord.method, 'fill');
    assert.equal(beginRecord.row_anchor.ariaRowIndex, 3);
    await tx.commit({ details: { matches: true } });
    const report = await recoverActionJournal(journal);
    assert.equal(report.ok, true);
    // 恢复入口也可直接跑（无 pending 时是 no-op 报告）。
    assert.equal(report.unknown.length, 0);
    assert.equal(getActionJournal(), journal);
  } finally {
    setActionJournal(null);
  }
});
