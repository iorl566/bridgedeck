// tests/record-ops.test.ts —— ops 页自测（真实链路计数：start → 真实点击 → stop → list）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOpsSelftestTab, runOpsSelftest, type OpsSelftestDeps, type OpsSelftestTab } from '../src/record/ops-selftest.ts';

function depsOf(overrides: Partial<OpsSelftestDeps> = {}): { deps: OpsSelftestDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: OpsSelftestDeps = {
    tabs: async () => [
      { tabId: 7, url: 'chrome-extension://ext/ops.html', title: '操作录制' },
      { tabId: 12, url: 'https://example.test/', title: '夹具页', active: false },
    ],
    start: async (params) => {
      calls.push('start:' + String(params.tabId) + ':includeAgent=' + String(params.includeAgent));
      return { tabId: Number(params.tabId), startedAt: 1 };
    },
    stop: async (params) => {
      calls.push('stop:' + String(params.tabId));
      return { recording: { id: 'rec-1', events: 3 } };
    },
    list: async (params) => {
      calls.push('list:includeEvents=' + String(params?.includeEvents));
      return { recordings: [{ id: 'rec-1', events: 3 }] };
    },
    clickPage: async (tabId) => {
      calls.push('click:' + tabId);
      return true;
    },
    sleep: async (ms) => {
      calls.push('sleep:' + ms);
    },
    ...overrides,
  };
  return { deps, calls };
}

test('pickOpsSelftestTab：优先 http(s)，跳过扩展页；无可用 tab 返回 null', () => {
  const tabs: OpsSelftestTab[] = [
    { tabId: 1, url: 'chrome-extension://ext/ops.html' },
    { tabId: 2, url: 'about:blank' },
    { tabId: 3, url: 'https://example.test/' },
  ];
  assert.equal(pickOpsSelftestTab(tabs)?.tabId, 3);
  assert.equal(pickOpsSelftestTab([{ tabId: 1, url: 'chrome-extension://ext/a.html' }, { tabId: 2, url: 'about:blank' }])?.tabId, 1);
  assert.equal(pickOpsSelftestTab([]), null);
  assert.equal(pickOpsSelftestTab([{ tabId: 0, url: 'https://x/' }]), null);
  assert.equal(pickOpsSelftestTab([{ tabId: Number.NaN, url: 'https://x/' }]), null);
});

test('runOpsSelftest：真实 start → 点击 → stop → list，计数全部来自 list', async () => {
  const { deps, calls } = depsOf();
  const result = await runOpsSelftest(deps);
  assert.equal(result.tabId, 12);
  assert.equal(result.recordings, 1);
  assert.equal(result.events, 3);
  assert.deepEqual(calls, [
    'start:12:includeAgent=true',
    'click:12',
    'sleep:350',
    'click:12',
    'sleep:800',
    'stop:12',
    'list:includeEvents=false',
  ]);
});

test('runOpsSelftest：事件计数支持数组形状与 eventCount 兜底', async () => {
  const arrayShape = depsOf({
    list: async () => ({ recordings: [{ id: 'rec', events: [{ kind: 'click' }, { kind: 'click' }] }] }),
  });
  assert.equal((await runOpsSelftest(arrayShape.deps)).events, 2);

  const fallbackShape = depsOf({
    list: async () => ({ recordings: [{ id: 'rec', eventCount: 4 }] }),
  });
  assert.equal((await runOpsSelftest(fallbackShape.deps)).events, 4);

  const emptyShape = depsOf({ list: async () => ({ recordings: [] }) });
  const empty = await runOpsSelftest(emptyShape.deps);
  assert.equal(empty.recordings, 0);
  assert.equal(empty.events, 0);
});

test('runOpsSelftest：没有目标标签页时抛错（页面据此报 fail）', async () => {
  const { deps } = depsOf({ tabs: async () => [] });
  await assert.rejects(() => runOpsSelftest(deps), /没有可录制的目标标签页/);
});

test('runOpsSelftest：点击失败不阻断自测（由事件计数如实反映）；start 失败向上抛', async () => {
  const clickFail = depsOf({ clickPage: async () => false });
  const result = await runOpsSelftest(clickFail.deps);
  assert.equal(result.recordings, 1);

  const startFail = depsOf({
    start: async () => {
      throw new Error('record 服务未注册');
    },
  });
  await assert.rejects(() => runOpsSelftest(startFail.deps), /record 服务未注册/);
});
