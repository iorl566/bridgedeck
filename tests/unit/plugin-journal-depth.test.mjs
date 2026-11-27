// 启动所有权 journal 深度测试：损坏恢复、过期/上限裁剪、跨实例、孤儿回收的失败分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPluginStartJournal,
  recoverOrphanStarts,
} from '../../dsh-plugin/lib/start-journal.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function tempJournal(now = () => NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-journal-depth-'));
  return { dir, journal: createPluginStartJournal({ filePath: path.join(dir, 'dsh-starts.json'), now }) };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('journal：文件缺失/损坏/版本不符都从空开始，不抛错', () => {
  const { dir, journal } = tempJournal();
  try {
    assert.deepEqual(journal.list(), []);
    fs.writeFileSync(journal.filePath, '{not json', 'utf8');
    assert.deepEqual(journal.reload(), []);
    fs.writeFileSync(journal.filePath, JSON.stringify({ version: 2, entries: { a: {} } }), 'utf8');
    assert.deepEqual(journal.reload(), []);
    fs.writeFileSync(journal.filePath, JSON.stringify({ version: 1, entries: 'nope' }), 'utf8');
    assert.deepEqual(journal.reload(), []);
    // entries 里的非法条目只在 prune 时被丢弃，读取本身不崩。
    fs.writeFileSync(journal.filePath, JSON.stringify({ version: 1, entries: { a: null, b: { state: 'ready', at: NOW } } }), 'utf8');
    assert.equal(journal.reload().length, 2);
    journal.add('token-x', {});
    assert.deepEqual(journal.list().map((entry) => entry.token).sort(), ['b', 'token-x']);
  } finally {
    cleanup(dir);
  }
});

test('journal：超过 7 天的记录在写盘时被裁掉', () => {
  let clock = NOW;
  const { dir, journal } = tempJournal(() => clock);
  try {
    journal.add('old', {});
    clock = NOW + 8 * DAY_MS;
    journal.add('fresh', {});
    const tokens = journal.list().map((entry) => entry.token).sort();
    assert.deepEqual(tokens, ['fresh']);
    const disk = JSON.parse(fs.readFileSync(journal.filePath, 'utf8'));
    assert.deepEqual(Object.keys(disk.entries), ['fresh']);
  } finally {
    cleanup(dir);
  }
});

test('journal：最多保留 100 条，保留最新写入的', () => {
  let clock = NOW;
  const { dir, journal } = tempJournal(() => clock);
  try {
    for (let index = 0; index < 105; index += 1) {
      clock = NOW + index * 1000;
      journal.add('t' + String(index).padStart(3, '0'), {});
    }
    const entries = journal.list();
    assert.equal(entries.length, 100);
    const tokens = new Set(entries.map((entry) => entry.token));
    assert.ok(tokens.has('t104'), '最新一条必须保留');
    for (let index = 5; index < 105; index += 1) assert.ok(tokens.has('t' + String(index).padStart(3, '0')), '应保留较新的 t' + index);
    for (let index = 0; index < 5; index += 1) assert.ok(!tokens.has('t' + String(index).padStart(3, '0')), '应裁掉较旧的 t' + index);
    const disk = JSON.parse(fs.readFileSync(journal.filePath, 'utf8'));
    assert.equal(Object.keys(disk.entries).length, 100);
  } finally {
    cleanup(dir);
  }
});

test('journal：update 合并而不是覆盖，元数据保留；get 返回副本', () => {
  const { dir, journal } = tempJournal();
  try {
    journal.add('tok', { browser: 'edge', noFocus: true });
    journal.update('tok', { state: 'ready', sessionId: 's1' });
    const entry = journal.get('tok');
    assert.equal(entry.state, 'ready');
    assert.equal(entry.sessionId, 's1');
    assert.deepEqual(entry.meta, { browser: 'edge', noFocus: true });
    entry.state = 'mutated';
    assert.equal(journal.get('tok').state, 'ready', 'get 应返回副本');
    assert.equal(journal.get('missing'), null);
    journal.update('new-token', { state: 'custom' });
    assert.equal(journal.get('new-token').state, 'custom');
  } finally {
    cleanup(dir);
  }
});

test('journal：多实例共享文件，后写者能看到先写者的记录；目录自动创建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-journal-concurrent-'));
  try {
    const filePath = path.join(dir, 'nested', 'deeper', 'dsh-starts.json');
    const first = createPluginStartJournal({ filePath, now: () => NOW });
    first.add('a', {});
    const second = createPluginStartJournal({ filePath, now: () => NOW });
    assert.equal(second.get('a').state, 'starting');
    second.add('b', {});
    first.reload();
    assert.deepEqual(first.list().map((entry) => entry.token).sort(), ['a', 'b']);
  } finally {
    cleanup(dir);
  }
});

test('journal：stale 的阈值边界（>= staleMs 才算过期）', () => {
  const { dir, journal } = tempJournal();
  try {
    journal.add('exact', {});
    journal.add('just-new', {});
    journal.update('exact', { at: NOW - 120000 });
    journal.update('just-new', { at: NOW - 119999 });
    const stale = journal.stale(120000);
    assert.deepEqual(stale.map((entry) => entry.token), ['exact']);
  } finally {
    cleanup(dir);
  }
});

test('recoverOrphanStarts：ready 会 stop 并标 recovered；其它状态标 stale 并记录 lastState', async () => {
  const { dir, journal } = tempJournal();
  try {
    journal.add('ready', {});
    journal.add('cancelled', {});
    journal.add('failed', {});
    journal.add('empty', {});
    journal.add('no-session', {});
    for (const token of ['ready', 'cancelled', 'failed', 'empty', 'no-session']) journal.update(token, { at: NOW - 300000 });
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args[0] === 'session' && args[1] === 'stop') return { ok: true };
      const token = args[args.indexOf('--request-id') + 1];
      if (token === 'ready') return { entry: { state: 'ready', result: { sessionId: 's-ready' } } };
      if (token === 'cancelled') return { entry: { state: 'cancelled' } };
      if (token === 'failed') return { entry: { state: 'failed' } };
      if (token === 'empty') return { entry: null };
      return { entry: { state: 'ready', result: {} } }; // 没有 sessionId
    };
    const results = await recoverOrphanStarts({ run, journal, staleMs: 120000 });
    assert.equal(results.length, 5);
    assert.ok(calls.some((args) => args[0] === 'session' && args[1] === 'stop' && args[2] === 's-ready'));
    assert.equal(journal.get('ready').state, 'recovered');
    assert.equal(journal.get('ready').recoveredSessionId, 's-ready');
    assert.equal(journal.get('cancelled').state, 'stale');
    assert.equal(journal.get('cancelled').lastState, 'cancelled');
    assert.equal(journal.get('empty').state, 'stale');
    assert.equal(journal.get('empty').lastState, null);
    assert.equal(journal.get('no-session').state, 'stale');
    const recovered = results.filter((item) => item.recovered);
    assert.equal(recovered.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('recoverOrphanStarts：查询/停止失败只记录结果，不崩溃也不丢记录', async () => {
  const { dir, journal } = tempJournal();
  try {
    journal.add('query-fail', {});
    journal.add('stop-fail', {});
    journal.update('query-fail', { at: NOW - 300000 });
    journal.update('stop-fail', { at: NOW - 300000 });
    const run = async (args) => {
      const token = args[args.indexOf('--request-id') + 1];
      if (token === 'query-fail') throw Object.assign(new Error('查询失败'), { code: 'E_DAEMON' });
      if (args[0] === 'session' && args[1] === 'stop') throw new Error('停止失败');
      return { entry: { state: 'ready', result: { sessionId: 's-stop-fail' } } };
    };
    const results = await recoverOrphanStarts({ run, journal, staleMs: 120000 });
    assert.equal(results.length, 2);
    assert.ok(results.every((item) => item.recovered === false));
    assert.equal(results.find((item) => item.token === 'query-fail').error, 'E_DAEMON');
    assert.match(results.find((item) => item.token === 'stop-fail').error, /停止失败/);
    // 失败时保持 starting，下次启动还能再回收（不静默丢记录）。
    assert.equal(journal.get('query-fail').state, 'starting');
    assert.equal(journal.get('stop-fail').state, 'starting');
  } finally {
    cleanup(dir);
  }
});

test('recoverOrphanStarts：没有 stale 记录时不调用 CLI', async () => {
  const { dir, journal } = tempJournal();
  try {
    journal.add('fresh', {});
    let calls = 0;
    const results = await recoverOrphanStarts({ run: async () => { calls += 1; return {}; }, journal, staleMs: 120000 });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  } finally {
    cleanup(dir);
  }
});
