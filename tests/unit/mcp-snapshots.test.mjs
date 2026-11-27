// tests/unit/mcp-snapshots.test.mjs —— MCP resources 快照磁盘持久化（原子写/上限/TTL/重启恢复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SNAPSHOT_DIRNAME,
  SNAPSHOT_LIMITS,
  SNAPSHOT_LOCK_LIMITS,
  SNAPSHOT_VERSION,
  SnapshotPersistence,
  acquireFileLock,
  atomicWriteFileSync,
  buildSnapshotEntries,
  decodeSnapshotDocument,
  encodeSnapshotDocument,
  lockReport,
  releaseFileLock,
  resolveSnapshotDir,
  resolveSnapshotLimits,
  resolveSnapshotLock,
  snapshotFileName,
  snapshotsDisabled,
  snapshotsQuarantineCorrupt,
} from '../../mcp/snapshots.mjs';
import { createResourceRegistry } from '../../mcp/resources.mjs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-snapshots-'));
}

function fakeClock(start = 1_700_000_000_000) {
  const clock = { value: start };
  return {
    clock,
    now: () => clock.value,
    advance(ms) { clock.value += ms; },
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('环境变量解析：默认值 / 覆盖 / 非法值回退', () => {
  const defaults = resolveSnapshotLimits({});
  assert.equal(defaults.ttlMs, SNAPSHOT_LIMITS.ttlMs);
  assert.equal(defaults.maxTotalBytes, SNAPSHOT_LIMITS.maxTotalBytes);
  assert.equal(defaults.maxEntryBytes, SNAPSHOT_LIMITS.maxEntryBytes);

  const override = resolveSnapshotLimits({
    BB_MCP_SNAPSHOT_TTL_MS: '500',
    BB_MCP_SNAPSHOT_MAX_BYTES: '2048',
    BB_MCP_SNAPSHOT_ENTRY_BYTES: '1024',
    BB_MCP_SNAPSHOT_CLEANUP_MS: '100',
  });
  assert.equal(override.ttlMs, 500);
  assert.equal(override.maxTotalBytes, 2048);
  assert.equal(override.maxEntryBytes, 1024);
  assert.equal(override.cleanupIntervalMs, 100);

  const invalid = resolveSnapshotLimits({
    BB_MCP_SNAPSHOT_TTL_MS: '-5',
    BB_MCP_SNAPSHOT_MAX_BYTES: 'abc',
    BB_MCP_SNAPSHOT_ENTRY_BYTES: '0',
  });
  assert.equal(invalid.ttlMs, SNAPSHOT_LIMITS.ttlMs);
  assert.equal(invalid.maxTotalBytes, SNAPSHOT_LIMITS.maxTotalBytes);
  assert.equal(invalid.maxEntryBytes, SNAPSHOT_LIMITS.maxEntryBytes);
});

test('快照开关与目录解析', () => {
  assert.equal(snapshotsDisabled({ BB_MCP_SNAPSHOT: 'off' }), true);
  assert.equal(snapshotsDisabled({ BB_MCP_SNAPSHOT: '0' }), true);
  assert.equal(snapshotsDisabled({ BB_MCP_SNAPSHOT: 'on' }), false);
  assert.equal(snapshotsDisabled({}), false);

  const home = path.join('C:', 'tmp', 'bb-home');
  assert.equal(resolveSnapshotDir(home, {}), path.join(home, SNAPSHOT_DIRNAME));
  assert.equal(resolveSnapshotDir(home, { BB_MCP_SNAPSHOT_DIR: path.join('C:', 'tmp', 'snap') }), path.resolve('C:', 'tmp', 'snap'));
});

test('快照文件名只允许安全字符，禁止路径穿越', () => {
  assert.equal(snapshotFileName('observation'), 'observation.json');
  assert.equal(snapshotFileName('debug-evidence'), 'debug-evidence.json');
  assert.equal(snapshotFileName('a/../b'), 'a-..-b.json');
  assert.equal(snapshotFileName('中文 label'), '-label.json');
  assert.throws(() => snapshotFileName(''), /非法/);
  assert.throws(() => snapshotFileName('..'), /非法/);
});

test('原子写：同目录临时文件落盘后 rename，不残留 .tmp', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  const first = atomicWriteFileSync(file, '{"version":1}\n');
  assert.equal(first.file, path.resolve(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1}\n');
  const second = atomicWriteFileSync(file, '{"version":1,"entries":[]}\n');
  assert.equal(second.bytes, Buffer.byteLength('{"version":1,"entries":[]}\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"entries":[]}\n');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  // 目录不存在时自动创建
  const nested = path.join(dir, 'a', 'b', 'debug-journal.json');
  atomicWriteFileSync(nested, '{}\n');
  assert.equal(fs.existsSync(nested), true);
});

test('文档编码/解码：版本、label、过期过滤与损坏判定', () => {
  const now = 1_700_000_000_000;
  const limits = { ...SNAPSHOT_LIMITS, ttlMs: 1_000 };
  const entries = buildSnapshotEntries([
    { key: 'a', at: new Date(now - 100).toISOString(), label: 'observation', meta: { kind: 'observation' }, payload: { value: 1 } },
    { key: 'old', at: new Date(now - 5_000).toISOString(), payload: { value: 2 } },
  ], { limits, now });
  assert.equal(entries.entries.length, 1);
  assert.equal(entries.droppedExpired, 1);

  const text = encodeSnapshotDocument({
    label: 'observation',
    savedAt: new Date(now).toISOString(),
    limits,
    entries: entries.entries,
  });
  const decoded = decodeSnapshotDocument(text, { label: 'observation', limits, now });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.entries.length, 1);
  assert.equal(decoded.entries[0].key, 'a');
  assert.equal(decoded.entries[0].persisted, true);
  assert.equal(decoded.entries[0].payload.value, 1);

  const wrongLabel = decodeSnapshotDocument(text, { label: 'debug-evidence', limits, now });
  assert.equal(wrongLabel.ok, false);
  assert.equal(wrongLabel.corrupt, true);
  const wrongVersion = decodeSnapshotDocument(JSON.stringify({ version: SNAPSHOT_VERSION + 1, label: 'observation', entries: [] }), { label: 'observation', limits, now });
  assert.equal(wrongVersion.ok, false);
  assert.equal(decodeSnapshotDocument('not json', { limits, now }).ok, false);
  assert.equal(decodeSnapshotDocument('[]', { limits, now }).ok, false);

  const expired = decodeSnapshotDocument(text, { label: 'observation', limits, now: now + 2_000 });
  assert.equal(expired.ok, true);
  assert.equal(expired.entries.length, 0);
  assert.equal(expired.expired, 1);
});

test('单条目超过 maxEntryBytes：落盘为预览并标记 persistedTruncated', () => {
  const now = Date.now();
  const limits = { ...SNAPSHOT_LIMITS, maxEntryBytes: 512 };
  const entries = buildSnapshotEntries([
    { key: 'big', at: new Date(now).toISOString(), payload: { text: 'x'.repeat(4096) } },
  ], { limits, now });
  assert.equal(entries.entries.length, 1);
  assert.equal(entries.truncatedEntries, 1);
  assert.equal(entries.entries[0].truncated, true);
  assert.equal(entries.entries[0].payload.persistedTruncated, true);
  assert.ok(entries.entries[0].payload.originalBytes > 4096);
  assert.ok(entries.entries[0].payload.preview.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(entries.entries[0].payload)) <= limits.maxEntryBytes);
});

test('持久化 save/load 往返与总大小淘汰', () => {
  const dir = tempHome();
  const now = Date.now();
  const limits = { ...SNAPSHOT_LIMITS, ttlMs: 60_000, maxTotalBytes: 1_200, maxEntryBytes: 900 };
  const persistence = new SnapshotPersistence({ dir, limits, now: () => now });
  const saved = persistence.save('observation', [
    { key: 's1', at: new Date(now - 3_000).toISOString(), label: 'observation', meta: {}, payload: { text: 'a'.repeat(400) } },
    { key: 's2', at: new Date(now - 2_000).toISOString(), label: 'observation', meta: {}, payload: { text: 'b'.repeat(400) } },
    { key: 's3', at: new Date(now - 1_000).toISOString(), label: 'observation', meta: {}, payload: { text: 'c'.repeat(400) } },
  ]);
  assert.ok(saved.bytes <= limits.maxTotalBytes, String(saved.bytes));
  assert.ok(saved.droppedForSize >= 1, JSON.stringify(saved));
  const loaded = persistence.load('observation');
  assert.equal(loaded.ok, true);
  assert.ok(loaded.entries.length >= 1);
  assert.equal(loaded.entries.at(-1).key, 's3', '最新的条目必须保留');
  assert.ok(loaded.entries.every((entry) => entry.key !== 's1'), '最旧的条目应因总大小上限被淘汰');
  const stats = persistence.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.files, 1);
  assert.ok(stats.bytes > 0);
  assert.equal(stats.counters.saves, 1);
});

test('持久化禁用时所有写入是 no-op，stats 如实标记', () => {
  const dir = path.join(tempHome(), 'snap');
  const persistence = new SnapshotPersistence({ dir, env: { BB_MCP_SNAPSHOT: 'off' } });
  const result = persistence.save('observation', [{ key: 's1', at: new Date().toISOString(), payload: {} }]);
  assert.equal(result.skipped, true);
  assert.equal(persistence.enabled, false);
  assert.equal(fs.existsSync(dir), false);
  const loaded = persistence.load('observation');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.disabled, true);
});

test('resources 注册表：写入落盘 + 新进程恢复 latest（observation/evidence/journal）', () => {
  const home = tempHome();
  const first = createResourceRegistry({ home });
  first.recordObservation('s1', { url: 'https://a.test/', title: 'A', refs: 3, observation: '@e1 A' });
  first.recordEvidence('s1', { ok: true, requests: 7 });
  first.recordJournal('s1', { events: [{ seq: 1, stage: 'network' }, { seq: 2, stage: 'console' }] });
  const files = fs.readdirSync(path.join(home, SNAPSHOT_DIRNAME)).sort();
  assert.deepEqual(files, ['debug-evidence.json', 'debug-journal.json', 'observation.json']);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);

  // 模拟进程重启：全新注册表从磁盘 hydrate。
  const second = createResourceRegistry({ home });
  assert.equal(second.restored.observation, 1);
  assert.equal(second.restored.evidence, 1);
  assert.equal(second.restored.journal, 1);

  const observation = JSON.parse(second.read('bridge://observation/latest').contents[0].text);
  assert.equal(observation.key, 's1');
  assert.equal(observation.payload.url, 'https://a.test/');
  assert.equal(observation.payload.observation, '@e1 A');
  const observationMeta = second.read('bridge://observation/latest')._meta['browser-bridge/resource'];
  assert.equal(observationMeta.persisted, true);
  assert.equal(observationMeta.persistedTruncated, false);
  assert.equal(observationMeta.stale, false);
  assert.match(observationMeta.etag, /^W\/"[0-9a-f]{8}"$/);

  const evidence = JSON.parse(second.read('bridge://debug/evidence/latest').contents[0].text);
  assert.equal(evidence.payload.requests, 7);
  const journal = JSON.parse(second.read('bridge://debug/journal/latest').contents[0].text);
  assert.equal(journal.payload.kept, 2);
  assert.equal(journal.payload.lastSeq, 2);

  // resources/list 列出恢复后的会话资源
  const uris = second.list().map((row) => row.uri);
  assert.ok(uris.includes('bridge://observation/s1'));
  assert.ok(uris.includes('bridge://debug/evidence/s1'));
  assert.ok(uris.includes('bridge://debug/journal/s1'));
  // 快照 meta 能力位：支持订阅变更推送（W7-C 能力升级）
  assert.equal(observationMeta.capabilities.subscribe, true);
  assert.equal(observationMeta.capabilities.subscription.notification, 'notifications/resources/updated');
  assert.equal(observationMeta.capabilities.persistence, true);
  assert.equal(second.stats().persistence.enabled, true);
  assert.equal(second.stats().persistence.files, 3);
});

test('resources 注册表：TTL 过期后重启不再恢复（E_NOT_FOUND）', () => {
  const home = tempHome();
  const clock = fakeClock();
  const limits = resolveSnapshotLimits({ BB_MCP_SNAPSHOT_TTL_MS: '1000' });
  const first = createResourceRegistry({ home, limits, now: clock.now });
  first.recordObservation('s1', { url: 'https://a.test/', observation: '@e1' });
  clock.advance(5_000);
  const second = createResourceRegistry({ home, limits, now: clock.now });
  assert.equal(second.restored.observation, 0);
  assert.throws(() => second.read('bridge://observation/latest'), (error) => error.code === 'E_NOT_FOUND');
  assert.ok(second.stats().persistence.counters.prunedEntries >= 0);
});

test('文件损坏不阻塞启动：读不到就降级为空，sweep 清理过期损坏文件', () => {
  const home = tempHome();
  const dir = path.join(home, SNAPSHOT_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'observation.json'), '{"version":1,"label":"observation","entries":[', 'utf8');
  const registry = createResourceRegistry({ home });
  assert.equal(registry.restored.corrupt, 1);
  assert.throws(() => registry.read('bridge://observation/latest'), (error) => error.code === 'E_NOT_FOUND');

  // 损坏文件足够旧 → sweep 删除；同时清理遗留临时文件。
  const clock = fakeClock(Date.now());
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'observation.json'), old, old);
  const tmpFile = path.join(dir, '.observation.json.stale.tmp');
  fs.writeFileSync(tmpFile, 'partial', 'utf8');
  fs.utimesSync(tmpFile, old, old);
  const limits = resolveSnapshotLimits({});
  const persistence = new SnapshotPersistence({ dir, limits, now: clock.now });
  const report = persistence.sweep();
  assert.equal(report.removedFiles, 1);
  assert.equal(report.removedTmp, 1);
  assert.equal(fs.existsSync(path.join(dir, 'observation.json')), false);
  assert.equal(fs.existsSync(tmpFile), false);
});

test('sweep 重写“部分过期”的快照文件，只保留未过期条目', () => {
  const home = tempHome();
  const dir = path.join(home, SNAPSHOT_DIRNAME);
  const now = Date.now();
  const limits = { ...SNAPSHOT_LIMITS, ttlMs: 1_000 };
  const persistence = new SnapshotPersistence({ dir, limits, now: () => now });
  persistence.save('observation', [
    { key: 'old', at: new Date(now - 5_000).toISOString(), payload: { v: 1 } },
    { key: 'fresh', at: new Date(now).toISOString(), payload: { v: 2 } },
  ]);
  // save 本身已丢弃过期条目，这里手工构造一个带过期条目的文件来验证 sweep 的修复能力。
  const file = path.join(dir, 'observation.json');
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  document.entries.unshift({ key: 'old', at: new Date(now - 5_000).toISOString(), label: 'observation', meta: {}, payload: { v: 1 }, payloadBytes: 8, truncated: false });
  fs.writeFileSync(file, JSON.stringify(document), 'utf8');
  const report = persistence.sweep();
  assert.equal(report.prunedEntries, 1);
  assert.equal(report.rewrittenFiles, 1);
  const rewritten = readJson(file);
  assert.deepEqual(rewritten.entries.map((entry) => entry.key), ['fresh']);
});

test('pruneSnapshots：手动按 TTL 剪枝并落盘', () => {
  const home = tempHome();
  const clock = fakeClock();
  const limits = resolveSnapshotLimits({ BB_MCP_SNAPSHOT_TTL_MS: '1000' });
  const registry = createResourceRegistry({ home, limits, now: clock.now });
  registry.recordObservation('s1', { observation: '@e1' });
  registry.recordEvidence('s1', { ok: true });
  clock.advance(5_000);
  const pruned = registry.pruneSnapshots();
  assert.deepEqual(pruned.observation, ['s1']);
  assert.deepEqual(pruned.evidence, ['s1']);
  const second = createResourceRegistry({ home, limits, now: clock.now });
  assert.equal(second.restored.observation, 0);
  assert.equal(second.observations.size(), 0);
});

test('persist:false 与 persistence:null 都不落盘（离线/单测场景）', () => {
  const home = tempHome();
  const noPersist = createResourceRegistry({ home, persist: false });
  noPersist.recordObservation('s1', { observation: '@e1' });
  assert.equal(fs.existsSync(path.join(home, SNAPSHOT_DIRNAME)), false);
  assert.equal(noPersist.persistence, null);
  assert.equal(noPersist.stats().persistence.enabled, false);

  const explicitNull = createResourceRegistry({ home, persistence: null });
  explicitNull.recordObservation('s1', { observation: '@e1' });
  assert.equal(fs.existsSync(path.join(home, SNAPSHOT_DIRNAME)), false);
  assert.equal(explicitNull.read('bridge://observation/latest')._meta['browser-bridge/resource'].capabilities.persistence, false);
});

test('快照 etag 稳定：内容不变则标识不变，内容更新则变化', () => {
  const home = tempHome();
  const clock = fakeClock();
  const registry = createResourceRegistry({ home, now: clock.now });
  registry.recordObservation('s1', { observation: '@e1 same' });
  const first = registry.read('bridge://observation/s1')._meta['browser-bridge/resource'];
  const again = registry.read('bridge://observation/s1')._meta['browser-bridge/resource'];
  assert.equal(first.etag, again.etag);
  assert.equal(first.capturedAt, again.capturedAt);
  clock.advance(10);
  registry.recordObservation('s1', { observation: '@e1 changed' });
  const changed = registry.read('bridge://observation/s1')._meta['browser-bridge/resource'];
  assert.notEqual(changed.etag, first.etag);
});

test('陈旧快照带 stale 标记（不影响读取）', () => {
  const home = tempHome();
  const clock = fakeClock();
  const registry = createResourceRegistry({ home, now: clock.now });
  registry.recordObservation('s1', { observation: '@e1' });
  clock.advance(10 * 60 * 1000);
  const meta = registry.read('bridge://observation/s1')._meta['browser-bridge/resource'];
  assert.equal(meta.stale, true);
  assert.ok(meta.ageMs >= 10 * 60 * 1000);
});

test('BB_MCP_SNAPSHOT=off：注册表不落盘、也不算损坏恢复', () => {
  const home = tempHome();
  const previous = process.env.BB_MCP_SNAPSHOT;
  process.env.BB_MCP_SNAPSHOT = 'off';
  try {
    const registry = createResourceRegistry({ home });
    registry.recordObservation('s1', { observation: '@e1' });
    assert.equal(registry.restored.corrupt, 0);
    assert.equal(registry.stats().persistence.enabled, false);
    assert.equal(fs.existsSync(path.join(home, SNAPSHOT_DIRNAME)), false);
    const meta = registry.read('bridge://observation/latest')._meta['browser-bridge/resource'];
    assert.equal(meta.capabilities.persistence, false);
    assert.equal(meta.snapshotDir, undefined);
  } finally {
    if (previous === undefined) delete process.env.BB_MCP_SNAPSHOT;
    else process.env.BB_MCP_SNAPSHOT = previous;
  }
});

test('journal 快照落盘后重启仍保留事件上限与阶段集合', () => {
  const home = tempHome();
  const events = [];
  for (let index = 1; index <= 620; index += 1) {
    events.push({ seq: index, stage: index % 2 === 0 ? 'network' : 'console', text: 'e' + index });
  }
  const first = createResourceRegistry({ home });
  first.recordToolResult('browser_debug_journal', { session: 's9' }, { events, truncated: false });
  const second = createResourceRegistry({ home });
  const payload = JSON.parse(second.read('bridge://debug/journal/latest').contents[0].text).payload;
  assert.equal(payload.count, 620);
  assert.equal(payload.kept, 500);
  assert.equal(payload.dropped, 120);
  assert.deepEqual(payload.stages, ['console', 'network']);
  assert.equal(payload.events.at(-1).seq, 620);
});

// ---------------------------------------------------------------------------
// W7-C 第 3 项：快照写锁（O_EXCL 重试 / 过期接管 / 降级）+ 损坏恢复
// ---------------------------------------------------------------------------
test('写锁参数：默认值、只能收紧、可关闭、非法值回退', () => {
  const defaults = resolveSnapshotLock({});
  assert.deepEqual(defaults, {
    enabled: true,
    retries: SNAPSHOT_LOCK_LIMITS.retries,
    retryMs: SNAPSHOT_LOCK_LIMITS.retryMs,
    staleMs: SNAPSHOT_LOCK_LIMITS.staleMs,
  });
  const tightened = resolveSnapshotLock({
    BB_MCP_SNAPSHOT_LOCK_RETRIES: '3',
    BB_MCP_SNAPSHOT_LOCK_RETRY_MS: '2',
    BB_MCP_SNAPSHOT_LOCK_STALE_MS: '1000',
  });
  assert.equal(tightened.retries, 3);
  assert.equal(tightened.retryMs, 2);
  assert.equal(tightened.staleMs, 1000);
  const inflated = resolveSnapshotLock({
    BB_MCP_SNAPSHOT_LOCK_RETRIES: '99999',
    BB_MCP_SNAPSHOT_LOCK_RETRY_MS: '99999',
    BB_MCP_SNAPSHOT_LOCK_STALE_MS: '999999',
  });
  assert.ok(inflated.retries <= SNAPSHOT_LOCK_LIMITS.retries * 4);
  assert.ok(inflated.retryMs <= SNAPSHOT_LOCK_LIMITS.retryMs * 10);
  assert.ok(inflated.staleMs <= SNAPSHOT_LOCK_LIMITS.staleMs * 4);
  const invalid = resolveSnapshotLock({ BB_MCP_SNAPSHOT_LOCK_RETRIES: 'abc' });
  assert.equal(invalid.retries, SNAPSHOT_LOCK_LIMITS.retries);
  assert.equal(resolveSnapshotLock({ BB_MCP_SNAPSHOT_LOCK: 'off' }).enabled, false);
  assert.equal(snapshotsQuarantineCorrupt({ BB_MCP_SNAPSHOT_QUARANTINE: 'on' }), true);
  assert.equal(snapshotsQuarantineCorrupt({}), false);
});

test('文件锁：O_EXCL 抢占、释放后可再抢、锁文件命名与报告', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  const first = acquireFileLock(file, { retries: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.lockFile, path.join(dir, '.observation.json.lock'));
  assert.equal(fs.existsSync(first.lockFile), true);
  const payload = JSON.parse(fs.readFileSync(first.lockFile, 'utf8'));
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.file, path.resolve(file));

  const blocked = acquireFileLock(file, { retries: 1, retryMs: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.timedOut, true);
  assert.ok(blocked.attempts >= 2);
  assert.ok(blocked.error && blocked.error.code === 'EEXIST');

  assert.equal(releaseFileLock(first), true);
  assert.equal(fs.existsSync(first.lockFile), false);
  const third = acquireFileLock(file, { retries: 0 });
  assert.equal(third.ok, true);
  assert.equal(releaseFileLock(third), true);
  assert.equal(releaseFileLock({}), false);

  const summary = lockReport(first, { enabled: true });
  assert.equal(summary.acquired, true);
  assert.equal(summary.fallback, false);
  assert.equal(summary.skipped, false);
  assert.equal(lockReport(blocked).fallback, true);
  assert.equal(lockReport(first, { enabled: false }).skipped, true);
});

test('文件锁：过期锁（进程崩溃遗留）被接管并重试成功', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  const lockFile = path.join(dir, '.observation.json.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: 'old' }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  const held = acquireFileLock(file, { retries: 0, staleMs: 1_000 });
  assert.equal(held.ok, true);
  assert.equal(held.staleTaken, 1);
  // 新锁内容应指向当前进程，而不是上一次崩溃的进程。
  const payload = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(payload.pid, process.pid);
  assert.equal(releaseFileLock(held), true);
});

test('原子写默认带锁：成功后不残留 .lock/.tmp，锁报告可解释', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  const written = atomicWriteFileSync(file, '{"version":1,"entries":[]}\n');
  assert.equal(fs.existsSync(file), true);
  assert.equal(written.lock.enabled, true);
  assert.equal(written.lock.acquired, true);
  assert.equal(written.lock.fallback, false);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'));
  assert.deepEqual(leftovers, []);
  // 关闭锁时明确标记 skipped。
  const unlocked = atomicWriteFileSync(file, '{"version":1,"entries":[]}\n', { lock: false });
  assert.equal(unlocked.lock.skipped, true);
  assert.equal(unlocked.lock.acquired, false);
});

test('原子写降级：锁被别的进程占着时仍完成原子写并标记 fallback（不删除他人锁）', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  const lockFile = path.join(dir, '.observation.json.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 424242 }), 'utf8'); // mtime=now，视为新鲜锁
  const written = atomicWriteFileSync(file, '{"version":1,"entries":[]}\n', {
    lockOptions: { retries: 1, retryMs: 0, staleMs: 60_000 },
  });
  assert.equal(written.lock.acquired, false);
  assert.equal(written.lock.fallback, true);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(lockFile), true, '降级路径不能删掉别的进程的锁');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"entries":[]}\n');
});

test('SnapshotPersistence：save 使用写锁并计入 counters，无残留锁文件', () => {
  const dir = tempHome();
  const persistence = new SnapshotPersistence({ dir });
  const saved = persistence.save('observation', [
    { key: 's1', at: new Date().toISOString(), label: 'observation', meta: {}, payload: { v: 1 } },
  ]);
  assert.equal(saved.lock.acquired, true);
  assert.ok(persistence.stats().counters.lockAcquired >= 1);
  assert.equal(persistence.stats().counters.lockStaleTaken, 0);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(persistence.stats().lock.enabled, true);
});

test('并发写：4 个进程同时保存同一 label，最终文件始终是合法 JSON 且无锁/临时残留', async () => {
  const dir = tempHome();
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'mcp', 'snapshots.mjs')).href;
  const script = path.join(dir, 'writer.mjs');
  fs.writeFileSync(script, [
    'import { SnapshotPersistence } from ' + JSON.stringify(moduleUrl) + ';',
    'const [dir, label, key] = process.argv.slice(2);',
    'const persistence = new SnapshotPersistence({ dir });',
    'const result = persistence.save(label, [{ key, at: new Date().toISOString(), label, meta: {}, payload: { key } }]);',
    'process.stdout.write(JSON.stringify({ lock: result.lock, codes: persistence.stats().counters }));',
    '',
  ].join('\n'), 'utf8');
  const children = [];
  for (let index = 0; index < 4; index += 1) {
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [script, dir, 'observation', 'k' + index], {
        env: { ...process.env, BB_MCP_SNAPSHOT_LOCK_RETRIES: '400', BB_MCP_SNAPSHOT_LOCK_RETRY_MS: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (code) => resolve({ code, stdout }));
    }));
  }
  const results = await Promise.all(children);
  for (const result of results) assert.equal(result.code, 0, result.stdout);
  const parsed = results.map((result) => JSON.parse(result.stdout));
  assert.ok(parsed.filter((row) => row.lock && row.lock.acquired).length >= 1, '至少一个进程抢到写锁');
  const finalFile = path.join(dir, 'observation.json');
  const document = readJson(finalFile);
  assert.equal(document.version, SNAPSHOT_VERSION);
  assert.equal(document.label, 'observation');
  assert.equal(document.entries.length, 1);
  assert.ok(['k0', 'k1', 'k2', 'k3'].includes(document.entries[0].key));
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('损坏恢复：损坏文件被隔离（quarantine）后新写入自愈为合法文件', () => {
  const dir = tempHome();
  const file = path.join(dir, 'observation.json');
  fs.writeFileSync(file, '{"version":1,"label":"observation","entries":[', 'utf8');
  const persistence = new SnapshotPersistence({ dir, quarantineCorrupt: true });
  const loaded = persistence.load('observation');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.corrupt, true);
  assert.equal(typeof loaded.quarantined, 'string');
  assert.equal(fs.existsSync(file), false, '损坏文件已改名留证');
  assert.equal(fs.existsSync(loaded.quarantined), true);
  assert.equal(persistence.stats().counters.corruptFiles, 1);
  assert.equal(persistence.stats().counters.quarantinedFiles, 1);
  assert.match(String(persistence.stats().lastLoad.quarantined), /\.corrupt$/);

  const saved = persistence.save('observation', [
    { key: 'fresh', at: new Date().toISOString(), label: 'observation', meta: {}, payload: { v: 2 } },
  ]);
  assert.equal(saved.lock.acquired, true);
  const healed = readJson(file);
  assert.equal(healed.version, SNAPSHOT_VERSION);
  assert.deepEqual(healed.entries.map((entry) => entry.key), ['fresh']);
  const reloaded = persistence.load('observation');
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.entries.length, 1);
});

test('损坏恢复：默认保留现场；注册表降级为空，下一次快照写入自愈', () => {
  const home = tempHome();
  const dir = path.join(home, SNAPSHOT_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'observation.json'), 'not json at all', 'utf8');
  const registry = createResourceRegistry({ home });
  assert.equal(registry.restored.corrupt, 1);
  assert.equal(registry.stats().persistence.counters.corruptFiles, 1);
  assert.throws(() => registry.read('bridge://observation/latest'), (error) => error.code === 'E_NOT_FOUND');
  // 默认不隔离：现场文件仍在，便于人工排查。
  assert.equal(fs.existsSync(path.join(dir, 'observation.json')), true);
  // 新快照写入后文件自愈（合法 JSON），新进程可恢复。
  registry.recordObservation('s1', { observation: '@e1 healed' });
  const healed = readJson(path.join(dir, 'observation.json'));
  assert.equal(healed.version, SNAPSHOT_VERSION);
  assert.deepEqual(healed.entries.map((entry) => entry.key), ['s1']);
  const second = createResourceRegistry({ home });
  assert.equal(second.restored.observation, 1);
  assert.equal(JSON.parse(second.read('bridge://observation/latest').contents[0].text).key, 's1');
});

test('sweep：清理过期锁与隔离出来的损坏文件，新鲜锁不动', () => {
  const dir = tempHome();
  const now = Date.now();
  const limits = { ...SNAPSHOT_LIMITS, ttlMs: 1_000 };
  const persistence = new SnapshotPersistence({
    dir,
    limits,
    lock: { enabled: true, retries: 2, retryMs: 1, staleMs: 500 },
    now: () => now,
  });
  const staleLock = path.join(dir, '.observation.json.lock');
  const freshLock = path.join(dir, '.debug-evidence.json.lock');
  fs.writeFileSync(staleLock, '{}', 'utf8');
  fs.writeFileSync(freshLock, '{}', 'utf8');
  const old = new Date(now - 10_000);
  fs.utimesSync(staleLock, old, old);
  const corrupt = path.join(dir, 'debug-journal.json.' + (now - 10_000) + '.corrupt');
  fs.writeFileSync(corrupt, 'broken', 'utf8');
  fs.utimesSync(corrupt, old, old);
  const report = persistence.sweep();
  assert.equal(report.removedLocks, 1);
  assert.equal(fs.existsSync(staleLock), false);
  assert.equal(fs.existsSync(freshLock), true, '新鲜锁可能属于正在写的进程，不能删');
  assert.equal(report.removedFiles >= 1, true);
  assert.equal(fs.existsSync(corrupt), false);
  assert.ok(persistence.stats().counters.removedLocks >= 1);
});
