// 可恢复会话启动：token 校验 + 预写日志幂等语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStartToken, createStartJournal, normalizeStartToken, START_TOKEN_TTL_MS } from '../../lib/start-journal.mjs';

const NOW = 1_800_000_000_000;

test('token 形态：<expiry>:<id>', () => {
  assert.equal(normalizeStartToken(`${NOW + 60_000}:abcdefgh`, NOW), `${NOW + 60_000}:abcdefgh`);
  assert.equal(createStartToken(NOW, 60_000, 'fixedid123').startsWith(`${NOW + 60_000}:`), true);
  assert.throws(() => normalizeStartToken('nope', NOW), /expiry-unix-ms/);
  assert.throws(() => normalizeStartToken(`${NOW + 60_000}:short`, NOW), /8-80/);
});

test('过期 / 超过 10 分钟的 token 被拒绝', () => {
  assert.throws(() => normalizeStartToken(`${NOW - 1}:abcdefgh`, NOW), /已过期/);
  assert.throws(() => normalizeStartToken(`${NOW + START_TOKEN_TTL_MS + 1}:abcdefgh`, NOW), /10 分钟/);
});

test('journal：begin → ready 幂等；失败记录可重试', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-start-journal-'));
  const file = path.join(dir, 'session-starts.json');
  const journal = createStartJournal(file, { now: () => NOW });
  const token = `${NOW + 60_000}:tokenabc`;
  assert.equal(journal.get(token), null);
  journal.begin(token, { browser: 'edge' });
  assert.equal(journal.get(token).state, 'starting');
  journal.ready(token, { sessionId: 's1', tabId: 7, windowId: 8, instanceId: 'i1' });
  const ready = journal.get(token);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.result.sessionId, 's1');
  // 重新加载文件仍能读到（daemon 重启后的幂等基础）
  const reloaded = createStartJournal(file, { now: () => NOW });
  assert.equal(reloaded.get(token).result.sessionId, 's1');
  // 失败
  journal.fail(token, 'boom');
  assert.equal(journal.get(token).state, 'failed');
  assert.match(journal.get(token).error, /boom/);
});

test('journal 写入是原子替换，损坏文件从空开始', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-start-journal-'));
  const file = path.join(dir, 'session-starts.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const journal = createStartJournal(file, { now: () => NOW });
  assert.deepEqual(journal.snapshot(), {});
  journal.begin(`${NOW + 60_000}:tokenxyz`, {});
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries[`${NOW + 60_000}:tokenxyz`].state, 'starting');
});

test('journal：prepare / setState 生命周期（prepared → ready → claimed → cancelled）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-start-journal-'));
  const file = path.join(dir, 'session-starts.json');
  const journal = createStartJournal(file, { now: () => NOW });
  const token = `${NOW + 60_000}:lifecycle1`;
  journal.prepare(token, { browser: 'edge' });
  assert.equal(journal.get(token).state, 'prepared');
  journal.setState(token, 'ready', { result: { sessionId: 's1' } });
  assert.equal(journal.get(token).state, 'ready');
  journal.setState(token, 'claimed');
  assert.equal(journal.get(token).state, 'claimed');
  journal.setState(token, 'cancelled');
  assert.equal(journal.get(token).state, 'cancelled');
  // 墓碑持久化
  const reloaded = createStartJournal(file, { now: () => NOW });
  assert.equal(reloaded.get(token).state, 'cancelled');
  assert.equal(reloaded.get(token).result.sessionId, 's1');
});
