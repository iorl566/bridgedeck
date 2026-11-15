// DSH 插件启动所有权日志：token 记录、幂等重试、孤儿回收。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPluginStartJournal,
  defaultJournalPath,
  recoverOrphanStarts,
} from '../../dsh-plugin/lib/start-journal.mjs';

const NOW = 1_800_000_000_000;

function tempJournal(now = () => NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-journal-'));
  return createPluginStartJournal({ filePath: path.join(dir, 'dsh-starts.json'), now });
}

test('journal：starting → ready/failed，重启后仍可读', () => {
  const journal = tempJournal();
  const token = `${NOW + 60_000}:plugin1`;
  journal.add(token, { browser: 'edge' });
  assert.equal(journal.get(token).state, 'starting');
  journal.ready(token, { sessionId: 's1', tabId: 3, windowId: 4 });
  assert.equal(journal.get(token).state, 'ready');
  assert.equal(journal.get(token).result.sessionId, 's1');
  const reloaded = createPluginStartJournal({ filePath: journal.filePath, now: () => NOW });
  assert.equal(reloaded.get(token).result.sessionId, 's1');
  const other = `${NOW + 60_000}:plugin2`;
  journal.add(other);
  journal.fail(other, 'E_TIMEOUT');
  assert.equal(journal.get(other).state, 'failed');
});

test('stale 只返回超过阈值的 starting', () => {
  const journal = tempJournal();
  journal.add(`${NOW + 60_000}:old`, {});
  journal.add(`${NOW + 60_000}:new`, {});
  journal.ready(`${NOW + 60_000}:done`, { sessionId: 's9' });
  // 把 old 的时间改到过去
  journal.update(`${NOW + 60_000}:old`, { at: NOW - 300000 });
  const stale = journal.stale(120000);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].token, `${NOW + 60_000}:old`);
});

test('recoverOrphanStarts：ready 的孤儿会话被 stop 并标记 recovered；未知标记 stale', async () => {
  const journal = tempJournal();
  const readyToken = `${NOW + 60_000}:orphanReady`;
  const goneToken = `${NOW + 60_000}:orphanGone`;
  journal.add(readyToken, {});
  journal.add(goneToken, {});
  journal.update(readyToken, { at: NOW - 300000 });
  journal.update(goneToken, { at: NOW - 300000 });
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const token = args[args.indexOf('--request-id') + 1];
    if (token === readyToken) return { entry: { state: 'ready', result: { sessionId: 's-ready' } } };
    return { entry: null };
  };
  const results = await recoverOrphanStarts({ run, journal, staleMs: 120000 });
  assert.equal(results.length, 2);
  assert.ok(calls.some((args) => args[0] === 'session' && args[1] === 'stop' && args[2] === 's-ready'));
  assert.equal(journal.get(readyToken).state, 'recovered');
  assert.equal(journal.get(goneToken).state, 'stale');
});

test('defaultJournalPath 优先 home，其次 BB_HOME', () => {
  const saved = process.env.BB_HOME;
  try {
    process.env.BB_HOME = 'D:/bb-home';
    assert.equal(defaultJournalPath('D:/custom'), path.join('D:/custom', 'dsh-starts.json'));
    assert.equal(defaultJournalPath(''), path.join('D:/bb-home', 'dsh-starts.json'));
  } finally {
    if (saved === undefined) delete process.env.BB_HOME;
    else process.env.BB_HOME = saved;
  }
});
