import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function harness(overlayInteractive = false) {
  const values = new Map();
  const store = {
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  const requests = [];
  let id = 0;
  const manager = new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    overlay: async () => ({ interactive: overlayInteractive }),
    host: { async request(command) { requests.push(command); return {}; } },
  });
  return { manager, requests };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('navigation suspends then resumes cleanly', async () => {
  const h = harness(false);
  await h.manager.start(options);
  await h.manager.navigationStarted(7);
  assert.equal(h.requests[0].action, 'suspend');
  assert.equal(h.requests[0].mode, 'navigation');
  await h.manager.navigationSettled(7);
  assert.equal(h.requests.at(-1).mode, 'clean');
});

test('navigation settled uses interactive mode when overlay is interactive', async () => {
  const h = harness(true);
  await h.manager.start(options);
  await h.manager.navigationSettled(7);
  assert.equal(h.requests.at(-1).mode, 'interactive');
  assert.ok(h.requests.at(-1).label.length > 0);
});
