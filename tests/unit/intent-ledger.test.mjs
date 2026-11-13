import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntentLedger, isMutating, isUnknownOutcome } from '../../lib/intent-ledger.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ledger-'));
}

test('isMutating 分类：读命令不落账，变异命令落账', () => {
  for (const method of ['observe', 'screenshot', 'status', 'get-html', 'ledger.status']) assert.equal(isMutating(method), false, method);
  for (const method of ['click', 'fill', 'navigate', 'tab.close', 'session.start', 'plan']) assert.equal(isMutating(method), true, method);
});

test('成功操作不阻塞同 tab 的下一步', () => {
  const ledger = new IntentLedger({ dir: tempDir(), staleMs: 1000 });
  const entry = ledger.begin('click', { session: 's1', ref: 'e1' }, { tabId: 7, sessionId: 's1' });
  ledger.finish(entry, 'done');
  assert.doesNotThrow(() => ledger.begin('fill', { session: 's1' }, { tabId: 7, sessionId: 's1' }));
});

test('unknown 结果会拦截同 tab 的变异操作，resolve 后解锁', () => {
  const ledger = new IntentLedger({ dir: tempDir(), staleMs: 1000 });
  const entry = ledger.begin('click', { session: 's1' }, { tabId: 7, sessionId: 's1' });
  ledger.finish(entry, 'unknown');
  assert.throws(() => ledger.begin('fill', { session: 's1' }, { tabId: 7, sessionId: 's1' }), (error) => error.code === 'E_LEDGER_PENDING' && error.id === entry.id);
  assert.doesNotThrow(() => ledger.begin('click', { session: 's2' }, { tabId: 9, sessionId: 's2' }));
  ledger.resolve(entry.id, 'abandoned');
  assert.doesNotThrow(() => ledger.begin('fill', { session: 's1' }, { tabId: 7, sessionId: 's1' }));
});

test('超时未完成的 active 记录会被判定为 stale 并拦截', () => {
  let now = 1_000_000;
  const ledger = new IntentLedger({ dir: tempDir(), staleMs: 500, now: () => now });
  const entry = ledger.begin('click', {}, { tabId: 3, sessionId: 's3' });
  now += 2_000;
  assert.throws(() => ledger.begin('fill', {}, { tabId: 3, sessionId: 's3' }), (error) => error.code === 'E_LEDGER_PENDING');
  const status = ledger.status({});
  assert.equal(status.pending.length, 1);
  assert.equal(status.pending[0].id, entry.id);
  assert.equal(status.pending[0].state, 'stale');
});

test('daemon 重启后遗留 active 记录转为 stale', () => {
  const dir = tempDir();
  const first = new IntentLedger({ dir, staleMs: 60_000 });
  first.begin('navigate', {}, { tabId: 5, sessionId: 's5' });
  const second = new IntentLedger({ dir, staleMs: 60_000 });
  second.load();
  assert.equal(second.entries[0].state, 'stale');
  assert.throws(() => second.begin('click', {}, { tabId: 5, sessionId: 's5' }), (error) => error.code === 'E_LEDGER_PENDING');
});

test('账本只保存参数键名，不保存参数值', () => {
  const ledger = new IntentLedger({ dir: tempDir(), staleMs: 1000 });
  const entry = ledger.begin('fill', { selector: '#pwd', value: 'super-secret', password: 'p@ss', text: 'hello' }, { tabId: 1, sessionId: 's1' });
  ledger.finish(entry, 'done');
  const raw = fs.readFileSync(ledger.file, 'utf8');
  assert.equal(raw.includes('super-secret'), false);
  assert.equal(raw.includes('p@ss'), false);
  assert.equal(raw.includes('hello'), false);
  assert.deepEqual(entry.keys, ['selector']);
});

test('isUnknownOutcome 识别超时与断连', () => {
  assert.equal(isUnknownOutcome({ code: 'E_TIMEOUT' }), true);
  assert.equal(isUnknownOutcome({ message: 'socket disconnected' }), true);
  assert.equal(isUnknownOutcome({ code: 'E_NOT_FOUND', message: 'no element' }), false);
});

test('派发前失败的错误不算 unknown，不冻结标签页', () => {
  for (const code of ['E_BAD_ARG', 'E_INVALID_PARAMS', 'E_NOT_FOUND', 'E_TARGET_NOT_FILLABLE', 'E_NOT_ACTIONABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS', 'E_NOT_SELECT']) {
    assert.equal(isUnknownOutcome({ code }), false, code);
  }
  assert.equal(isUnknownOutcome({ code: 'E_INTERNAL', effectState: 'none' }), false);
  assert.equal(isUnknownOutcome({ code: 'E_INTERNAL', dispatched: false }), false);
  assert.equal(isUnknownOutcome({ code: 'E_INTERNAL' }), false);
  assert.equal(isUnknownOutcome({ code: 'E_INTERNAL', message: 'timeout' }), true);
});