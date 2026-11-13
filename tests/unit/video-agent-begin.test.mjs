import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function harness({ interactive = false } = {}) {
  const values = new Map();
  const calls = [];
  const store = {
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  let id = 0;
  const cdp = {
    trackSessionTab: (...args) => calls.push(['track', ...args]),
    acquireBackgroundExecution: async (...args) => calls.push(['background', ...args]),
    async send(tab, method, params) {
      calls.push(['send', tab, method, params]);
      if (method === 'Page.captureScreenshot') return { data: 'first-frame' };
      return {};
    },
  };
  const host = {
    async request(command) {
      calls.push(['host', command.action]);
      if (command.action === 'start') return { ...command.recording, state: 'recording', started_at: 1000 };
      return {};
    },
  };
  const manager = new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    cdp,
    host,
    overlay: async () => ({ interactive }),
  });
  return { manager, values, calls };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('begin enables page, captures first frame and starts host', async () => {
  const h = harness();
  const grant = await h.manager.start(options);
  assert.equal(grant.recording.state, 'recording');
  assert.ok(h.calls.some(([kind, , method]) => kind === 'send' && method === 'Page.enable'));
  assert.ok(h.calls.some(([kind, command]) => kind === 'host' && command === 'start'));
  assert.ok(h.calls.some(([kind]) => kind === 'background'));
  assert.equal((await h.manager.get(grant.recording.recording_id)).state, 'recording');
});

test('interactive overlay refuses start and marks the recording failed', async () => {
  const h = harness({ interactive: true });
  await assert.rejects(h.manager.start(options), /confirmation/);
  const stored = [...h.values.values()][0];
  assert.equal(stored.state, 'failed');
  assert.equal(stored.stop_reason, 'capture_failed');
});
