import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../extension/src/session-manager/manager.js';
import { DebugManager } from '../../extension/src/debug/manager.js';
import { MemoryDebugArchive } from '../../extension/src/debug/archive.js';
import { VideoManager } from '../../extension/src/video/manager.js';
import { VideoArtifactStore } from '../../extension/src/video/store.js';

test('session + debug + video source modules compose', async () => {
  const agentWindow = {
    async create() { return { windowId: 10, initialTabIds: [1] }; },
    async ensureActiveTab() { return 2; },
    async remove() {},
  };
  const sessions = new SessionManager({ agentWindow, now: () => 1000 });
  const session = await sessions.start('s1');
  assert(session.refStore.isEmpty());

  const archive = new MemoryDebugArchive([], () => 1000);
  const cdp = { onEvent() {}, async ensureNetworkCapture() {}, async sendAttached() { return {}; } };
  const debug = new DebugManager(sessions, cdp, undefined, () => 1000, archive);
  debug.newId = () => 'd1';
  debug.pageFor = async () => ({ state: 'available', fields: [] });
  await debug.start('s1', 2);
  await debug.onEvent({ tabId: 2, sessionId: 'root' }, 'Network.requestWillBeSent', {
    requestId: '1', timestamp: 1, type: 'XHR', request: { url: 'https://site.test/api', method: 'GET', headers: {} },
  });
  const ticket = await debug.before({ method: 'tool.click', params: { session_id: 's1', tab_id: 2, selector: '#go' } });
  debug.after(ticket);
  const stopped = await debug.stop('d1');
  assert.equal(stopped.requests, 1);

  const video = new VideoManager({ store: new VideoArtifactStore({ factory: undefined, storage: undefined, now: () => 1000 }), now: () => 1000, createId: () => 'vid_' + 'a'.repeat(32), createCapability: () => 'cap' });
  const grant = await video.start({ session_id: 's1', request_id: 'req_12345' });
  await video.stop(grant.recording.recording_id);
  assert.equal((await video.list()).length, 1);
});

test('debug archive persists and reads operation evidence', async () => {
  const archive = new MemoryDebugArchive([], () => 1000);
  const context = {
    sessionId: 's1',
    agentWindowId: 10,
    createdAtMs: 1000,
    agentCreatedTabs: new Set([2]),
    borrowedTabs: new Set(),
    observedTabs: new Set(),
  };
  const sessions = {
    get: (id) => (id === 's1' ? context : null),
    list: () => [context],
  };
  const cdp = { onEvent() {}, async ensureNetworkCapture() {}, async sendAttached() { return {}; } };
  const manager = new DebugManager(sessions, cdp, undefined, () => 1000, archive);
  manager.newId = () => 'd1';
  manager.pageFor = async () => ({ state: 'available', fields: [{ key: 'email', label: 'Email', value: 'a@b' }] });
  await manager.start('s1', 2);
  const ticket = await manager.before({ method: 'tool.fill', params: { session_id: 's1', tab_id: 2, selector: 'input' } });
  manager.after(ticket);
  await manager.stop('d1');
  const result = await archive.query('d1', { action: 'operation', id: ticket.operation.id });
  assert.equal(result.operation.method, 'tool.fill');
  assert(result.evidence);
});
