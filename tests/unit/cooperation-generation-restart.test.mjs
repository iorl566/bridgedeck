// 四项 revision/epoch 的持久化链路：control-generation 从 chrome.storage.session 恢复，
// service worker 重启后 generation 不回退，stale 对齐方向可证据化。
import test from 'node:test';
import assert from 'node:assert/strict';

// 注意：必须在 import control-generation 之前装好 storage stub（模块加载即触发一次恢复）。
const KEY = 'bb.control.generation';
const persistedTab = { tabId: 77, generation: 9, controlRevision: 4, authorityRevision: 2, revision: 11, frameEpoch: 3, epoch: 5, document: 'https://a.test/', documentEpoch: 1 };
const store = { [KEY]: { version: 1, key: KEY, at: 1000, tabs: { 77: persistedTab } } };
const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: {
      async get(key) {
        if (key === undefined || key === null) return { ...store };
        if (typeof key === 'string') return store[key] === undefined ? {} : { [key]: store[key] };
        return {};
      },
      async set(payload) { Object.assign(store, payload); },
      async remove() {},
    },
    onChanged: listener(),
  },
  tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async () => null },
  alarms: { create: async () => {}, onAlarm: listener() },
};

const cg = await import('../../extension/src/control-generation.js');

test('重启恢复：模块加载即从 storage.session 恢复 generation，bump 从恢复值继续递增', async () => {
  const restored = await cg.ensureControlGenerationsRestored();
  assert.equal(restored.restored, 1);
  assert.equal(cg.controlGeneration(77), 9, '恢复后 generation 必须等于持久化的 9，不能回退成 0');
  assert.equal(cg.bumpControlGeneration(77), 10);
  assert.equal(cg.bumpControlGeneration(77), 11);
  assert.equal(cg.controlGenerationRecord(77).generation, 11);
  assert.equal(cg.controlGenerationRecord(77).document, 'https://a.test/', '恢复后文档标识保留');
});

test('raise 只抬高不降低；align 给出 stale 方向证据且按字段取 max', () => {
  assert.equal(cg.raiseControlGeneration(78, 20), 20);
  assert.equal(cg.raiseControlGeneration(78, 3), 20, 'raise 到更小值不应降低 generation');
  const alignment = cg.alignControlGeneration(78, { generation: 4, controlRevision: 1, revision: 99 });
  assert.equal(alignment.stale, true);
  assert.equal(alignment.side, 'mixed', 'generation 远端落后、revision 本地落后 → mixed');
  assert.equal(alignment.fields.length, 3, 'generation/controlRevision/revision 三个字段都有差异');
  assert.deepEqual(alignment.fields.map((entry) => entry.field).sort(), ['controlRevision', 'generation', 'revision']);
  assert.equal(cg.controlGeneration(78), 20, 'align 后远端落后也不能把本地计数改小');
  assert.equal(cg.controlGenerationRecord(78).revision, 99, 'revision 按 max 采纳远端更大值');
});

test('四项计数写 revision-chain：同文档 revision 不倒退、换文档重置并推进 frameEpoch', () => {
  cg.raiseControlGeneration(79, 5);
  cg.bumpRevisions(79, { controlRevision: 1, authorityRevision: 1, frameEpoch: 1 });
  const record = cg.controlGenerationRecord(79);
  assert.equal(record.controlRevision, 1);
  assert.equal(record.authorityRevision, 1);
  assert.equal(record.frameEpoch, 1);
  const sameDoc = cg.observeControlRevisions(79, { revision: 12, document: 'https://a.test/' });
  assert.equal(sameDoc.revision, 12);
  assert.equal(sameDoc.reset, false);
  const older = cg.observeControlRevisions(79, { revision: 2, document: 'https://a.test/' });
  assert.equal(older.revision, 12, '同文档 revision 回退应被忽略');
  const newDoc = cg.observeControlRevisions(79, { revision: 1, document: 'https://b.test/' });
  assert.equal(newDoc.reset, true, '换文档应按文档重置 revision');
  assert.equal(newDoc.documentEpoch, 1);
  assert.equal(newDoc.frameEpoch, 2, '换文档推进 frameEpoch');
});

test('落盘后再恢复旧快照：按 max 合并不回退', async () => {
  const flushed = await cg.flushControlGenerations();
  assert.equal(flushed.ok, true);
  const written = store[KEY].tabs['79'];
  assert.equal(written.generation, 5);
  assert.equal(written.controlRevision, 1);
  assert.equal(written.frameEpoch, 2);
  // 模拟另一个（更旧的）实例写回较低计数：再次恢复时按 max 合并不回退。
  store[KEY] = { version: 1, key: KEY, at: 2000, tabs: { 79: { tabId: 79, generation: 2, controlRevision: 0, revision: 1 } } };
  const reRestored = await cg.restoreControlGenerations();
  assert.equal(reRestored.restored, 1);
  assert.equal(cg.controlGeneration(79), 5, '旧快照不能把 generation 写小');
  assert.equal(cg.controlGenerationRecord(79).revision, 1, '旧快照的 revision 只在更大时采纳');
  assert.equal(cg.controlGenerationRecord(79).controlRevision, 1);
  assert.equal(cg.controlGenerationCounters().chain.restores >= 2, true);
});

test('clear 之后 generation 归零；非法 tabId 不抛异常', async () => {
  cg.clearControlGeneration(79);
  assert.equal(cg.controlGeneration(79), 0);
  assert.equal(cg.bumpControlGeneration('nope'), 0);
  assert.equal(cg.raiseControlGeneration(null, 3), 0);
  assert.equal(cg.controlGenerationRecord(null), null);
  assert.equal(cg.alignControlGeneration('x', {}).ok, false);
  await cg.flushControlGenerations();
});
