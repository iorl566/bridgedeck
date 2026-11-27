// audit list 真实路径接线：recordAudit → chrome.storage.local → listAudit（bridge 'bb.audit.list'）
// 默认 { entries, total } 不变，新增 integrity/snapshot/diff/timeline/journal 都是可选字段。
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
        return { ...store };
      },
      set: async (value) => {
        Object.assign(store, value);
      },
      remove: async (key) => {
        delete store[key];
      },
    },
  },
};

const { clearAudit, listAudit, recordAudit } = await import('../../extension/src/audit.js');
const { beginDebugJournalSession, flushDebugEvents, recordDebugEvent } = await import('../../extension/src/debug-events.js');

const KEY = 'bb.audit.events';
const now = Date.now();

test('recordAudit：写入 storage、补单调 seq，最新在前', async () => {
  await clearAudit();
  await recordAudit({ ts: now - 2000, commandId: 'c1', method: 'observe', tabId: 5, sessionId: 's1', url: 'https://example.test/a' });
  await recordAudit({ ts: now - 1000, commandId: 'c2', method: 'click', tabId: 5, sessionId: 's1', url: 'https://example.test/b' });
  const stored = store[KEY];
  assert.equal(Array.isArray(stored), true);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].commandId, 'c2', '新条目 unshift 到最前');
  assert.equal(stored[0].seq, 2);
  assert.equal(stored[1].seq, 1);
  assert.equal(stored[0].ok, null, '没有 ok 就保持缺失，不伪造成功');
  assert.ok(stored[0].evidence.missing.includes('ok'));
});

test('listAudit：默认字段不变（entries/total），并新增 integrity（可选字段）', async () => {
  const result = await listAudit({ limit: 100 });
  assert.equal(result.total, 2);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].method, 'click');
  // 默认字段只能多不能少/改：entries 仍是原始条目形状
  assert.equal(typeof result.entries[0].ts, 'number');
  assert.ok(result.integrity, '缺少 integrity 可选字段');
  assert.equal(result.integrity.verified, true);
  assert.ok(Array.isArray(result.integrityChecks));
  assert.equal(result.integrityText, undefined, '默认不放大文本');
  const skipped = await listAudit({ limit: 10, integrity: false });
  assert.equal(skipped.integrity, undefined);
});

test('listAudit：offset 分页与 since 过滤（既有语义保持）', async () => {
  const page = await listAudit({ limit: 1, offset: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].commandId, 'c1');
  assert.equal(page.total, 2);
  const since = await listAudit({ since: now - 1500, limit: 100 });
  assert.equal(since.entries.length, 1);
  assert.equal(since.entries[0].commandId, 'c2');
});

test('listAudit：snapshot + baseline 差异（跨命令/跨会话）', async () => {
  const before = await listAudit({ snapshot: true, label: 'before' });
  assert.equal(before.snapshot.kind, 'audit-snapshot');
  assert.equal(before.snapshot.total, 2);
  assert.equal(before.snapshotSummary.total, 2);
  assert.ok(before.snapshot.digest);
  await recordAudit({ ts: now, commandId: 'c3', method: 'fill', tabId: 6, sessionId: 's2', url: 'https://example.test/c' });
  const after = await listAudit({ snapshot: true, baseline: before.snapshot });
  assert.equal(after.snapshot.total, 3);
  assert.equal(after.diff.kind, 'snapshot');
  assert.equal(after.diff.summary.added, 1);
  assert.ok(after.diff.sessions.added.includes('s2'));
  assert.match(after.diffText, /audit diff added=1/);
  // 只给 baseline（不回带快照）时也返回差异
  const diffOnly = await listAudit({ baseline: after.snapshot });
  assert.equal(diffOnly.snapshot, undefined);
  assert.equal(diffOnly.diff.kind, 'none');
});

test('listAudit：timeline + journal 关联消费 debug journal（debug.gaps 同一份持久日志）', async () => {
  beginDebugJournalSession(5, { url: 'https://example.test/a', name: 'audit-test' });
  recordDebugEvent(5, 'start', { name: 'audit-test' });
  await flushDebugEvents().catch(() => {});
  const result = await listAudit({ journal: true, timeline: true });
  assert.ok(result.journal, '缺少 journal 摘要');
  assert.equal(result.journal.available, true);
  assert.ok(result.journal.count >= 1);
  assert.ok(result.journalCorrelation);
  assert.equal(result.journalCorrelation.total, 3);
  assert.ok(result.journalCorrelation.linked >= 1, '同 tab 审计命令应与 journal 事件关联');
  assert.ok(result.journalCorrelation.windowMs > 0);
  assert.ok(result.timeline);
  assert.ok(result.timeline.counts.journal >= 1);
  assert.equal(result.timeline.counts.command, 3);
  assert.match(result.timelineText, /timeline events=/);
  // 不清空 journal 的情况下，关联结果 > 0 才算真实消费（不是空实现）
  assert.ok(result.timeline.events.some((event) => event.kind === 'journal'));
});

test('clearAudit：清空后 listAudit 返回空且字段仍稳定', async () => {
  const cleared = await clearAudit();
  assert.deepEqual(cleared, { ok: true });
  const result = await listAudit();
  assert.equal(result.total, 0);
  assert.equal(result.entries.length, 0);
  assert.equal(result.integrity.verified, true);
});
