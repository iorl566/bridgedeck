import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_WINDOW_HOME, createAgentWindowApi } from '../../extension/src/session-manager/agent-window.js';

function harness(opts = {}) {
  const updates = [];
  const creates = [];
  const chrome = {
    windows: {
      async create(config) { creates.push(config); return { id: 10, incognito: config.incognito, tabs: [{ id: 1 }, { id: 2 }] }; },
      async remove(id) { updates.push(['remove', id]); },
    },
    tabs: {
      async query() { return opts.tabs ?? [{ id: 1, active: true }]; },
      async update(id, value) { updates.push(['update', id, value]); return { id }; },
      async create(config) { updates.push(['create', config]); return { id: 3 }; },
    },
  };
  return { api: createAgentWindowApi(chrome, opts.isAllowedIncognito), updates, creates };
}

test('create returns window and initial tab ids', async () => {
  const { api, creates } = harness();
  const created = await api.create(AGENT_WINDOW_HOME, { size: { width: 800, height: 600 }, focused: true, incognito: true });
  assert.deepEqual(created, { windowId: 10, incognito: true, initialTabIds: [1, 2] });
  assert.deepEqual(creates[0], { type: 'normal', focused: true, incognito: true, url: 'about:blank', width: 800, height: 600 });
});

test('incognito denied throws', async () => {
  const { api } = harness({ isAllowedIncognito: async () => false });
  await assert.rejects(() => api.create(AGENT_WINDOW_HOME, { incognito: true }), /Incognito/);
});

test('ensureActiveTab activates owned inactive tab', async () => {
  const { api, updates } = harness({ tabs: [{ id: 1, active: false }] });
  assert.equal(await api.ensureActiveTab(10, AGENT_WINDOW_HOME, new Set([1])), 1);
  assert.deepEqual(updates[0], ['update', 1, { active: true }]);
});

test('ensureActiveTab creates when no owned tab', async () => {
  const { api, updates } = harness({ tabs: [{ id: 9, active: true }] });
  assert.equal(await api.ensureActiveTab(10, AGENT_WINDOW_HOME, new Set([1])), 3);
  assert.deepEqual(updates[0], ['create', { windowId: 10, url: 'about:blank', active: true }]);
});
