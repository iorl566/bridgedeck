import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager, VIDEO_NAVIGATION_TIMEOUT_MS } from '../../extension/src/video/manager.js';

function harness({ now = () => 1000, overlay, host, sessions, tabs } = {}) {
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
    now: typeof now === 'function' ? now : () => now,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    createOwner: () => 'owner',
    overlay,
    host: host ?? { async request(command) { requests.push(command); return {}; } },
    sessions,
    tabs,
  });
  return { manager, values, store, requests };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

function markRecording(values, id) {
  const value = values.get(id);
  value.state = 'recording';
  return value;
}

test('get and list derive live duration for the active recording', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  const value = markRecording(h.values, id);
  value.started_at = 500;
  value.max_duration_ms = 60_000;
  assert.equal((await h.manager.get(id)).duration_ms, 500);
  assert.equal((await h.manager.list('owner'))[0].duration_ms, 500);
  value.max_duration_ms = 100;
  assert.equal((await h.manager.get(id)).duration_ms, 100);
});

test('list hides an expired recording that is no longer active', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  await h.manager.stop(id);
  h.values.get(id).expires_at = 0;
  assert.equal((await h.manager.list()).length, 0);
});

test('start and rpc failures carry protocol error codes', async () => {
  const h = harness();
  await assert.rejects(
    h.manager.start({ session_id: '', request_id: 'req12345' }),
    (error) => error.code === 'invalid_params',
  );
  const started = await h.manager.start(options);
  await assert.rejects(
    h.manager.rpc({ action: 'nope', recording_id: started.recording.recording_id, capability: 'cap' }),
    (error) => error.code === 'invalid_params',
  );
});

test('get rejects a recording past its retention deadline', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  h.values.get(id).expires_at = 0;
  await assert.rejects(h.manager.get(id), /expired/);
});

test('list filters by owner and orders newest recordings first', async () => {
  let time = 1000;
  const h = harness({ now: () => time });
  const first = await h.manager.start(options);
  await h.manager.stop(first.recording.recording_id);
  time = 2000;
  const second = await h.manager.start({ ...options, request_id: 'req67890' });
  const listed = await h.manager.list('owner');
  assert.deepEqual(listed.map((value) => value.recording_id), [
    second.recording.recording_id,
    first.recording.recording_id,
  ]);
  assert.equal((await h.manager.list('other')).length, 0);
});

test('exported requires a ready recording', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  await assert.rejects(h.manager.exported(id), /not ready/);
  await h.manager.stop(id);
  await h.manager.exported(id);
  assert.equal(h.values.get(id).exported, true);
});

test('queryOverlay reports no recording while a stop is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const host = {
    async request(command) {
      requests.push(command);
      if (command.action === 'stop') return gate;
      return {};
    },
  };
  const h = harness({ host });
  const started = await h.manager.start(options);
  const stopping = h.manager.stop(started.recording.recording_id);
  assert.equal(await h.manager.queryOverlay(7), null);
  release(undefined);
  await stopping;
  assert.equal(requests.filter((command) => command.action === 'stop').length, 1);
});

test('queryOverlay treats a discovery retry for the same document as a read', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.suspend(7, 'navigation', 'doc-1');
  const requests = h.requests.length;
  assert.equal(await h.manager.queryOverlay(7, 'doc-1'), id);
  assert.equal(h.requests.length, requests);
});

test('suspend ignores a clean acknowledgement from a superseded document', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.queryOverlay(7, 'doc-1');
  await h.manager.navigationStarted(7);
  const requests = h.requests.length;
  assert.equal(await h.manager.suspend(7, 'clean', 'doc-1'), null);
  assert.equal(h.requests.length, requests);
});

test('navigation converts a normal stop into a partial capture failure', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.navigationStarted(7);
  const stopped = await h.manager.stop(id, 'user_stopped');
  assert.equal(stopped.stop_reason, 'capture_failed');
  assert.equal(stopped.completeness, 'partial');
  assert.equal(h.requests.at(-1).reason, 'capture_failed');
  assert.equal('navigation' in h.values.get(id), false);
});

test('an unsettled navigation stops the recording after the navigation timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.navigationStarted(7);
  t.mock.timers.tick(VIDEO_NAVIGATION_TIMEOUT_MS);
  const stopped = await h.manager.stop(id);
  assert.equal(stopped.stop_reason, 'capture_failed');
  assert.equal(stopped.completeness, 'partial');
});

test('navigationSettled ignores an event older than the navigation start', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  markRecording(h.values, started.recording.recording_id);
  await h.manager.navigationStarted(7, 2000);
  const requests = h.requests.length;
  await h.manager.navigationSettled(7, 1500);
  assert.equal(h.requests.length, requests);
  await h.manager.navigationSettled(7, 2500);
  assert.equal(h.requests.at(-1).mode, 'clean');
});

test('navigationSettled stops the recording when the overlay handshake fails', async () => {
  const h = harness({
    overlay: async () => { throw new Error('overlay gone'); },
  });
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.navigationStarted(7);
  await h.manager.navigationSettled(7);
  const value = await h.manager.get(id);
  assert.equal(value.state, 'ready');
  assert.equal(value.stop_reason, 'capture_failed');
  assert.equal(value.completeness, 'partial');
});

test('sync stops a recording whose session disappeared', async () => {
  let session = { sessionId: 's1', agentWindowId: 2, agentCreatedTabs: new Set([7]), borrowedTabs: new Map() };
  const h = harness({
    sessions: { get: () => session, list: () => (session ? [session] : []) },
    tabs: { async get() { return { id: 7, windowId: 2, title: 'Owned' }; } },
  });
  const started = await h.manager.start(options);
  session = null;
  await h.manager.sync();
  const value = await h.manager.get(started.recording.recording_id);
  assert.equal(value.stop_reason, 'session_ended');
  assert.equal(value.state, 'ready');
});

test('sync keeps a recording on a controlled tab', async () => {
  const session = {
    sessionId: 's1',
    agentWindowId: 2,
    agentCreatedTabs: new Set([7]),
    borrowedTabs: new Map(),
  };
  const h = harness({
    sessions: { get: () => session, list: () => [session] },
    tabs: { async get() { return { id: 7, windowId: 2, title: 'Owned' }; } },
  });
  const started = await h.manager.start(options);
  await h.manager.sync();
  assert.equal((await h.manager.get(started.recording.recording_id)).state, 'starting');
});

test('tasks hides tabs the session does not control', async () => {
  const session = {
    sessionId: 's1',
    agentWindowId: 2,
    agentCreatedTabs: new Set([7]),
    borrowedTabs: new Map(),
  };
  const h = harness({
    sessions: { list: () => [session] },
    tabs: { query: async () => [{ id: 7 }, { id: 8 }] },
    host: undefined,
  });
  assert.deepEqual(await h.manager.tasks(), [{ session_id: 's1', tabs: [{ id: 7, title: '', url: '', active: false }] }]);
});

test('concurrent stop calls share one host request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const host = {
    async request(command) {
      requests.push(command);
      if (command.action === 'stop') return gate;
      return {};
    },
  };
  const h = harness({ host });
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  const first = h.manager.stop(id);
  const second = h.manager.stop(id);
  release(undefined);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.recording_id, two.recording_id);
  assert.equal(requests.filter((command) => command.action === 'stop').length, 1);
});

test('finished preserves a navigation failure from the encoder reply', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  markRecording(h.values, id);
  await h.manager.navigationStarted(7);
  await h.store.put({ ...h.manager.recordingValue(h.values.get(id)), state: 'finalizing', completeness: 'complete' });
  await h.manager.finished(id);
  const value = h.values.get(id);
  assert.equal(value.completeness, 'partial');
  assert.equal(value.stop_reason, 'capture_failed');
  assert.equal(h.manager.active.size, 0);
});

test('start aborts when the caller cancels during reservation', async () => {
  const h = harness();
  const controller = new AbortController();
  h.store.list = async () => {
    controller.abort();
    return [];
  };
  await assert.rejects(h.manager.start(options, controller.signal), /cancelled/);
  assert.equal(h.values.size, 0);
});
