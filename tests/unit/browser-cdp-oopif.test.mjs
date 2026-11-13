import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness() {
  const listeners = new Set();
  const api = {
    async attach() {},
    async detach() {},
    async sendCommand(target, method) {
      if (method === 'Page.getFrameTree') {
        return target.sessionId
          ? { frameTree: { frame: { id: 'f2', parentId: 'f1', url: 'https://child' } } }
          : { frameTree: { frame: { id: 'f1', url: 'https://root' }, childFrames: [{ frame: { id: 'f2', parentId: 'f1', url: 'https://child' } }] } };
      }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 42 };
      return {};
    },
    onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    onDetach: { addListener() {}, removeListener() {} },
  };
  return { cdp: new ChromiumCdp(api), emit: (source, method, params) => { for (const fn of listeners) fn(source, method, params); } };
}

test('OOPIF child tree contributes owner backend node', async () => {
  const h = harness();
  await h.cdp.ensureAttached(7);
  h.emit({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe', targetId: 'f2' } });
  const graph = await h.cdp.getFrameGraph(7);
  assert.equal(graph.frames.length, 2);
  assert.equal(graph.frames.find((frame) => frame.frameId === 'f2').ownerBackendNodeId, 42);
});
