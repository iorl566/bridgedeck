import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';
import { MemoryDebugArchive } from '../../extension/src/debug/archive.js';

const TAB = { id: 7, windowId: 11, url: 'https://site.test/form?token=abc', title: 'Sign in' };

function sessionHarness() {
  const context = {
    sessionId: 's1',
    agentWindowId: 11,
    agentCreatedTabs: new Set([7]),
    borrowedTabs: new Set(),
    observedTabs: new Set(),
    createdAtMs: 50,
    refStore: {
      resolveEntry: (ref) => (ref === 'e1' ? { kind: 'dom', name: '#email' } : undefined),
    },
  };
  return {
    context,
    sessions: {
      get: (id) => (id === 's1' ? context : null),
      list: () => [context],
    },
  };
}

function cdpHarness() {
  const sends = [];
  let listener;
  return {
    sends,
    get subscribed() { return listener !== undefined; },
    emit(source, method, params) { listener?.(source, method, params); },
    onEvent(fn) {
      listener = fn;
      return { dispose() { listener = undefined; } };
    },
    trackSessionTab() {},
    async ensureNetworkCapture() {},
    async getFrameGraph() { return undefined; },
    async sendAttached(target, method, params) {
      sends.push([method, params]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 21 };
      if (method === 'Accessibility.getFullAXTree')
        return { nodes: [{ role: { value: 'StaticText' }, name: { value: 'Email address' } }] };
      if (method === 'Runtime.evaluate') return { result: { value: { fields: [], text: 'hello' } } };
      return {};
    },
  };
}

function harness() {
  const clock = { value: 1000 };
  let serial = 0;
  const cdp = cdpHarness();
  const { context, sessions } = sessionHarness();
  const archive = new MemoryDebugArchive([], () => clock.value);
  const tabs = {
    async get(id) { return { ...TAB, id }; },
    async query() { return [TAB]; },
  };
  const manager = new DebugManager(sessions, cdp, tabs, () => clock.value, archive);
  manager.newId = () => `d-test-${++serial}`;
  return { manager, archive, cdp, clock, context };
}

test('start requires an owned tab and records a redacted URL', async () => {
  const { manager, cdp } = harness();
  await assert.rejects(() => manager.start('s1', 9), /not owned by this task/);
  const run = await manager.start('s1', 7);
  assert.equal(run.state, 'capturing');
  assert.equal(run.name, '');
  assert.equal(run.url.includes('abc'), false);
  assert.ok(run.coverage.includes('initial_load_not_recorded'));
  assert.deepEqual(cdp.sends[0], ['Network.enable', {
    maxTotalBufferSize: 2 * 1024 * 1024,
    maxResourceBufferSize: 256 * 1024,
    maxPostDataSize: 64 * 1024,
  }]);
  assert.ok(cdp.sends.some(([method]) => method === 'Runtime.enable'));
  assert.ok(cdp.sends.some(([method]) => method === 'Log.enable'));
  const status = await manager.status(run.id);
  assert.equal(status.requests, 0);
  await manager.dispose();
});

test('read capabilities/status and release cleanup', async () => {
  const { manager, archive } = harness();
  const run = await manager.start('s1', 7);
  const capabilities = await manager.read({ session_id: 's1', action: 'capabilities' });
  assert.ok(capabilities.capabilities.actions.includes('requests'));
  const status = await manager.read({ session_id: 's1', action: 'status' });
  assert.deepEqual(status.runs.map((item) => item.id), [run.id]);
  await manager.releaseTab(7);
  assert.equal(manager.runs.size, 0);
  assert.equal((await manager.read({ session_id: 's1', action: 'status' })).runs.length, 0);
  const saved = await archive.get(run.id);
  assert.equal(saved.run.state, 'stopped');
  assert.equal(saved.run.stop_reason, 'tab_released');
  await assert.rejects(
    () => manager.read({ session_id: 'missing', action: 'status' }),
    /session not found/,
  );
  await manager.dispose();
});

test('console events coalesce and browser diagnostics are classified', async () => {
  const { manager, clock } = harness();
  const run = await manager.start('s1', 7);
  const state = manager.runs.get(run.id);
  const source = { tabId: 7 };
  const params = {
    type: 'error',
    args: [{ value: 'boom' }],
    stackTrace: {
      callFrames: [{ functionName: 'submit', url: 'https://site.test/app.js', lineNumber: 3, columnNumber: 4 }],
    },
  };
  manager.onEvent(source, 'Runtime.consoleAPICalled', params);
  clock.value += 10;
  manager.onEvent(source, 'Runtime.consoleAPICalled', params);
  assert.equal(state.console.length, 1);
  assert.equal(state.console[0].count, 2);
  assert.equal(state.console[0].level, 'error');
  assert.equal(state.console[0].source, 'website');
  assert.ok(state.console[0].stack.includes('https://site.test/app.js:4:5'));
  clock.value += 10;
  manager.onEvent(source, 'Log.entryAdded', {
    entry: { level: 'warning', text: 'Deprecated API', source: 'deprecation', url: 'https://site.test/app.js' },
  });
  assert.equal(state.console.length, 2);
  assert.equal(state.console[1].source, 'browser');
  assert.equal(state.console[1].level, 'warning');
  assert.equal((await manager.status(run.id)).errors, 2);
  await manager.dispose();
});

test('binding payloads produce human operations without duplicating a click', async () => {
  const { manager, clock } = harness();
  const run = await manager.start('s1', 7);
  const state = manager.runs.get(run.id);
  const binding = state.observer.binding;
  const call = (payload) => manager.onEvent({ tabId: 7 }, 'Runtime.bindingCalled', {
    name: binding,
    executionContextId: 21,
    payload: JSON.stringify(payload),
  });
  call({ kind: 'click', at: clock.value, target: '#submit', before: { fields: [], text: 'old' } });
  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].method, 'tool.click');
  assert.equal(state.operations[0].source, 'human');
  assert.equal(state.operations[0].before.text, 'old');
  const started = state.operations[0].started_at;
  call({ kind: 'submit', at: started, before: { fields: [], text: 'old' } });
  assert.equal(state.operations.length, 1);
  clock.value += 5;
  call({
    kind: 'input_start',
    at: clock.value,
    target: 'Email',
    before: { fields: [{ key: 'email', label: 'Email', value: 'a@b.test' }] },
  });
  assert.equal(state.operations.length, 2);
  assert.equal(state.operations[1].method, 'tool.fill');
  assert.equal(state.operations[1].state, 'running');
  call({ kind: 'input', at: clock.value, after: { fields: [{ key: 'email', label: 'Email', value: 'a@b.test' }] } });
  assert.equal(state.operations[1].state, 'completed');
  assert.equal(state.operations[1].after.fields[0].value, 'a@b.test');
  call({ kind: 'performance_error' });
  assert.ok(state.run.coverage.includes('performance_capture_unavailable'));
  await manager.dispose();
});

test('stop and history readers merge live evidence', async () => {
  const { manager, archive } = harness();
  const run = await manager.start('s1', 7);
  manager.onEvent({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId: '1',
    timestamp: 100,
    type: 'XHR',
    request: { url: 'https://site.test/api?token=abc', method: 'POST', headers: {} },
  });
  const stopped = await manager.stop(run.id, 'done');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.requests, 1);
  assert.equal((await archive.get(run.id)).run.stop_reason, 'done');
  const history = await manager.history();
  assert.deepEqual(history.runs.map((item) => item.id), [run.id]);
  const requests = await manager.readHistory({ run_id: run.id, action: 'requests' });
  assert.equal(requests.requests.length, 1);
  assert.equal(requests.requests[0].url.includes('abc'), false);
  const pages = await manager.readHistory({ run_id: run.id, action: 'pages' });
  assert.equal(pages.pages.length, 1);
  await manager.deleteHistory(run.id);
  await assert.rejects(() => manager.readHistory({ run_id: run.id, action: 'pages' }), /not found/);
});

test('tasks reports a live session slot', async () => {
  const { manager } = harness();
  const run = await manager.start('s1', 7);
  const tasks = await manager.tasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].session_id, 's1');
  assert.equal(tasks[0].created_at, 50);
  assert.equal(tasks[0].tab_id, 7);
  assert.equal(tasks[0].title, 'Sign in');
  assert.equal(tasks[0].url.includes('abc'), false);
  assert.equal(tasks[0].run.id, run.id);
  await manager.dispose();
});

test('dispose releases captures and the event listener', async () => {
  const { manager, cdp } = harness();
  await manager.start('s1', 7);
  assert.equal(cdp.subscribed, true);
  await manager.dispose();
  assert.equal(manager.runs.size, 0);
  assert.equal(cdp.subscribed, false);
});
