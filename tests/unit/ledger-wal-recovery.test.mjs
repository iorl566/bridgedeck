// tests/unit/ledger-wal-recovery.test.mjs —— 文件 WAL 的真实崩溃重启恢复（fsync/快照/旧格式兼容）。
//
// 模拟方式：第一个 IntentLedger 实例只写 WAL 不 flush，然后直接新建实例（= 进程被杀后的
// daemon 重启），断言恢复结论与持久化文件形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { IntentLedger, WAL_FRAME_VERSION, parseWalRecords } from '../../lib/intent-ledger.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ledger-recovery-'));
}

function writeLegacyWal(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.wal'), entries.map((entry) => JSON.stringify(entry) + '\n').join(''), 'utf8');
}

test('进程重启：WAL 中的 active 意图被 recover() 升级为 unknown，并写入崩溃证据', () => {
  const dir = tempDir();
  const first = new IntentLedger({ dir, staleMs: 60_000 });
  const entry = first.begin('click', { ref: '@e1' }, { tabId: 31, sessionId: 's31' });
  first.finish(first.begin('fill', { ref: '@e2' }, { tabId: 32, sessionId: 's32' }), 'done');
  assert.ok(fs.existsSync(path.join(dir, 'ledger.wal')));

  const restarted = new IntentLedger({ dir, staleMs: 60_000 });
  const summary = restarted.recover({ reason: 'daemon-restart' });
  assert.equal(summary.recovered, 1);
  assert.equal(summary.wal.parsed >= 2, true);
  const recovered = restarted.entries.find((item) => item.id === entry.id);
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.replayBlocked, true);
  // 已提交的 fill 不受影响。
  const done = restarted.entries.find((item) => item.method === 'fill');
  assert.equal(done.state, 'done');
  // 恢复后 WAL 被 snapshot 覆盖并截断，重启不会重复恢复同一批记录。
  assert.equal(fs.statSync(path.join(dir, 'ledger.wal')).size, 0);
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
  assert.equal(snapshot.version, WAL_FRAME_VERSION);
  const again = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(again.entries.length, restarted.entries.length);
  assert.equal(again.entries.filter((item) => item.state === 'unknown').length, 1);
});

test('0.3.0 旧 WAL（裸条目行）可被新版本读取，并在重启时变成 stale（load 兼容）', () => {
  const dir = tempDir();
  writeLegacyWal(dir, [
    { id: 'lt_legacy_1', at: new Date().toISOString(), method: 'click', tabId: 33, state: 'active' },
    { id: 'lt_legacy_2', at: new Date().toISOString(), method: 'fill', tabId: 34, state: 'done' },
  ]);
  const ledger = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.walStats.legacy, 2);
  ledger.load();
  assert.equal(ledger.entries.find((item) => item.id === 'lt_legacy_1').state, 'stale');
  assert.equal(ledger.entries.find((item) => item.id === 'lt_legacy_2').state, 'done');
});

test('snapshot 与 WAL 合并：同一 id 以 WAL 中更新的状态为准', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({
    version: WAL_FRAME_VERSION,
    entries: [
      { id: 'lt_a', at: new Date().toISOString(), method: 'click', tabId: 35, state: 'active' },
      { id: 'lt_b', at: new Date().toISOString(), method: 'fill', tabId: 36, state: 'done' },
    ],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'ledger.wal'), JSON.stringify({
    id: 'lt_a', at: new Date().toISOString(), method: 'click', tabId: 35, state: 'unknown', recovered: true,
  }) + '\n', 'utf8');
  const ledger = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries.find((item) => item.id === 'lt_a').state, 'unknown');
  assert.equal(ledger.entries.find((item) => item.id === 'lt_b').state, 'done');
});

test('WAL 损坏/半行不影响恢复，recover 后快照只保留合法记录', () => {
  const dir = tempDir();
  const first = new IntentLedger({ dir, staleMs: 60_000 });
  const keep = first.begin('navigate', { url: 'https://example.test/' }, { tabId: 37 });
  first.flush();
  // 人为往 WAL 写入一条合法 begin、一条坏 JSON、一条半行。
  const walPath = path.join(dir, 'ledger.wal');
  const goodFrame = {
    v: WAL_FRAME_VERSION,
    seq: 500,
    kind: 'begin',
    id: 'lt_good',
    at: new Date().toISOString(),
    entry: { id: 'lt_good', at: new Date().toISOString(), method: 'fill', tabId: 38, state: 'active' },
  };
  const cryptoLib = crypto;
  const sum = cryptoLib.createHash('sha256').update(JSON.stringify({
    v: goodFrame.v, seq: goodFrame.seq, kind: goodFrame.kind, id: goodFrame.id, at: goodFrame.at, entry: goodFrame.entry,
  })).digest('hex').slice(0, 16);
  fs.writeFileSync(walPath, JSON.stringify({ ...goodFrame, sum }) + '\n{bad\n' + '{"half":', 'utf8');
  const restarted = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(restarted.walStats.tornTail, true);
  assert.equal(restarted.walStats.corrupted >= 1, true);
  const summary = restarted.recover();
  assert.equal(summary.recovered >= 1, true);
  const raw = fs.readFileSync(walPath, 'utf8');
  assert.equal(raw.length, 0, '恢复后的 checkpoint 截断损坏 WAL');
  assert.equal(restarted.entries.some((item) => item.id === keep.id), true);
  assert.equal(restarted.entries.some((item) => item.id === 'lt_good'), true);
});

test('resolve 结论持久化：confirmed 在下次启动仍是 resolved/applied', () => {
  const dir = tempDir();
  const first = new IntentLedger({ dir, staleMs: 60_000 });
  const entry = first.begin('click', {}, { tabId: 39, sessionId: 's39' });
  first.finish(entry, 'unknown');
  first.resolve(entry.id, 'confirmed');
  first.checkpoint();
  const second = new IntentLedger({ dir, staleMs: 60_000 });
  const restored = second.entries.find((item) => item.id === entry.id);
  assert.equal(restored.state, 'resolved');
  assert.equal(restored.outcome, 'confirmed');
  assert.equal(restored.resolution.effect, 'applied');
  assert.doesNotThrow(() => second.begin('click', {}, { tabId: 39 }));
});

test('checkpoint 保留最近 maxEntries 条并截断 WAL', () => {
  const dir = tempDir();
  const ledger = new IntentLedger({ dir, maxEntries: 3, staleMs: 60_000 });
  for (let index = 0; index < 6; index += 1) {
    const entry = ledger.begin('fill', { selector: '#f' + index }, { tabId: 40 + index, sessionId: 's' + index });
    ledger.finish(entry, 'done');
  }
  ledger.checkpoint();
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.entries[2].method, 'fill');
  assert.equal(fs.statSync(path.join(dir, 'ledger.wal')).size, 0);
});

test('parseWalRecords：空输入、纯空白、未知 kind、缺 id 的容错', () => {
  assert.deepEqual(parseWalRecords('').records, []);
  assert.deepEqual(parseWalRecords('   \n\n').stats.lines, 0);
  const text = [
    JSON.stringify({ v: WAL_FRAME_VERSION, seq: 1, kind: 'unknown-kind', id: 'x', at: new Date().toISOString(), entry: { id: 'x' } }),
    JSON.stringify({ v: WAL_FRAME_VERSION, seq: 2, kind: 'begin', id: '', at: new Date().toISOString(), entry: {} }),
    JSON.stringify({ v: WAL_FRAME_VERSION, seq: 3, kind: 'begin', id: 'ok', at: new Date().toISOString(), entry: { id: 'ok', method: 'click', tabId: 1, state: 'active' } }),
  ].join('\n') + '\n';
  const { records, stats } = parseWalRecords(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'ok');
  assert.equal(stats.corrupted, 2);
  assert.equal(stats.corruptSamples.length, 2);
});
