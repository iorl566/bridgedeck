// read/extract 的文档身份护栏：前后主文档一致才返回采样。
import test from 'node:test';
import assert from 'node:assert/strict';

const state = { backendNodeId: 10, frameId: 'f1' };

globalThis.chrome = {
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (target, method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: state.frameId } } };
      if (method === 'Runtime.evaluate') {
        return { result: { deepSerializedValue: { type: 'node', value: { backendNodeId: state.backendNodeId } } } };
      }
      return {};
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: {},
};

const { acquire } = await import('../../extension/src/debugger.js');
const { readDocumentIdentity, sameDocumentIdentity } = await import('../../extension/src/document-identity.js');

test('未挂 CDP 的标签页跳过身份校验', async () => {
  assert.equal(await readDocumentIdentity(99), null);
});

test('同一文档前后身份一致', async () => {
  await acquire(1, 'test');
  state.backendNodeId = 10;
  const before = await readDocumentIdentity(1);
  const after = await readDocumentIdentity(1);
  assert.equal(before.frameId, 'f1');
  assert.equal(before.backendNodeId, 10);
  assert.equal(sameDocumentIdentity(before, after), true);
});

test('导航/重渲染后 backendNodeId 变化即判为不同文档', async () => {
  await acquire(2, 'test');
  state.backendNodeId = 20;
  const before = await readDocumentIdentity(2);
  state.backendNodeId = 21;
  const after = await readDocumentIdentity(2);
  assert.equal(sameDocumentIdentity(before, after), false);
});
