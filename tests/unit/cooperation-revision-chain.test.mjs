// 四项 revision/epoch 全链路：单调递增、stale 检测与对齐、跨 service worker 重启不倒退。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_FIELDS,
  REVISION_FIELDS,
  alignRevisionVectors,
  compareRevisionVectors,
  createRevisionChain,
  emptyRevisionVector,
  mergeRevisionVectors,
  normalizeBump,
  normalizeRevisionVector,
} from '../../extension/src/lib/revision-chain.js';

/** 内存持久化适配器：模拟 chrome.storage.session（可注入初始快照、记录写入）。 */
function memoryPersistence(initial = null) {
  let stored = initial;
  const writes = [];
  return {
    writes,
    async load() { return stored ? JSON.parse(JSON.stringify(stored)) : null; },
    async save(payload) { stored = JSON.parse(JSON.stringify(payload)); writes.push(stored); return { ok: true }; },
    raw() { return stored; },
  };
}

test('四项字段集合与空向量', () => {
  assert.deepEqual([...REVISION_FIELDS], ['controlRevision', 'authorityRevision', 'revision', 'frameEpoch']);
  const empty = emptyRevisionVector();
  for (const field of CHAIN_FIELDS) assert.equal(empty[field], 0);
  const normalized = normalizeRevisionVector({ controlRevision: 3, generation: '7', bogus: 9 });
  assert.equal(normalized.controlRevision, 3);
  assert.equal(normalized.generation, 7);
  assert.equal('bogus' in normalized, false);
});

test('compareRevisionVectors：远端落后/本地落后/混合/相等四种方向', () => {
  const remoteBehind = compareRevisionVectors({ controlRevision: 5, authorityRevision: 2, revision: 9, frameEpoch: 3 }, { controlRevision: 4, authorityRevision: 2, revision: 9, frameEpoch: 3 });
  assert.equal(remoteBehind.stale, true);
  assert.equal(remoteBehind.side, 'remote');
  assert.deepEqual(remoteBehind.ahead, ['controlRevision']);
  assert.equal(remoteBehind.maxDistance, 1);

  const localBehind = compareRevisionVectors({ controlRevision: 1 }, { controlRevision: 4, frameEpoch: 2 });
  assert.equal(localBehind.side, 'local');
  assert.deepEqual(localBehind.behind.sort(), ['controlRevision', 'frameEpoch']);

  const mixed = compareRevisionVectors({ controlRevision: 3, revision: 2 }, { controlRevision: 1, revision: 5 });
  assert.equal(mixed.side, 'mixed');
  assert.deepEqual(mixed.fields.map((entry) => entry.field).sort(), ['controlRevision', 'revision']);

  const equal = compareRevisionVectors({ controlRevision: 2, generation: 1 }, { controlRevision: 2, generation: 1 });
  assert.equal(equal.stale, false);
  assert.equal(equal.side, null);
});

test('mergeRevisionVectors / alignRevisionVectors：按字段取 max，永不写小值', () => {
  const merged = mergeRevisionVectors({ controlRevision: 2, revision: 5 }, { controlRevision: 4, frameEpoch: 3 });
  assert.equal(merged.controlRevision, 4);
  assert.equal(merged.revision, 5);
  assert.equal(merged.frameEpoch, 3);
  const { comparison, aligned } = alignRevisionVectors({ controlRevision: 2 }, { controlRevision: 5, epoch: 2 });
  assert.equal(comparison.side, 'local');
  assert.equal(aligned.controlRevision, 5);
  assert.equal(aligned.epoch, 2);
});

test('normalizeBump：数字/true/字符串/数组都规整成增量', () => {
  assert.deepEqual(normalizeBump({ controlRevision: 2, authorityRevision: true, bogus: 4 }), { controlRevision: 2, authorityRevision: 1 });
  assert.deepEqual(normalizeBump('frameEpoch'), { frameEpoch: 1 });
  assert.deepEqual(normalizeBump(['revision', 'epoch', 'nope']), { revision: 1, epoch: 1 });
  assert.deepEqual(normalizeBump({ revision: 0, epoch: -2, frameEpoch: 1.9 }), { frameEpoch: 1 });
  assert.deepEqual(normalizeBump(null), {});
});

test('bump 单调递增且 four 计数独立；retain 只抬高不降低', () => {
  const chain = createRevisionChain();
  chain.bump(1, { controlRevision: true });
  chain.bump(1, { controlRevision: true, authorityRevision: 2 });
  const record = chain.record(1);
  assert.equal(record.controlRevision, 2);
  assert.equal(record.authorityRevision, 2);
  assert.equal(record.revision, 0);
  chain.retain(1, { generation: 9, revision: 4 });
  assert.equal(chain.record(1).generation, 9);
  chain.retain(1, { generation: 3, revision: 1 });
  assert.equal(chain.record(1).generation, 9, 'retain 不应把计数改小');
  assert.equal(chain.record(1).revision, 4);
  assert.equal(chain.record(null).tabId, null, '非法 tabId 返回空记录（不抛异常）');
  assert.equal(chain.bump('nope'), null);
});

test('observe：同文档 revision 取 max，换文档重置并推进 documentEpoch/frameEpoch', () => {
  const chain = createRevisionChain();
  chain.observe(2, { revision: 5, document: 'https://a.example/' });
  assert.equal(chain.record(2).revision, 5);
  chain.observe(2, { revision: 3, document: 'https://a.example/' });
  assert.equal(chain.record(2).revision, 5, '同文档 revision 回退应被忽略');
  const reset = chain.observe(2, { revision: 1, document: 'https://b.example/' });
  assert.equal(reset.reset, true);
  assert.equal(chain.record(2).revision, 1, '换文档按文档重置');
  assert.equal(chain.record(2).documentEpoch, 1);
  assert.equal(chain.record(2).frameEpoch, 1);
  const counters = chain.counters();
  assert.equal(counters.documentResets, 1);
  assert.equal(counters.observes, 3);
});

test('align：远端落后返回 stale=remote 并抬高远端；对齐后再次 align 不 stale', () => {
  const chain = createRevisionChain();
  chain.bump(3, { controlRevision: 5, authorityRevision: 2 });
  const result = chain.align(3, { controlRevision: 2, authorityRevision: 2, revision: 7 });
  assert.equal(result.stale, true);
  assert.equal(result.side, 'mixed');
  const fields = result.fields.map((entry) => entry.field).sort();
  assert.deepEqual(fields, ['controlRevision', 'revision']);
  assert.equal(result.aligned.controlRevision, 5);
  assert.equal(result.aligned.revision, 7);
  assert.equal(result.evidence.behind.includes('revision'), true);
  const again = chain.align(3, { controlRevision: 5, authorityRevision: 2, revision: 7 });
  assert.equal(again.stale, false);
  assert.equal(chain.record(3).staleSide, 'mixed');
});

test('restore：持久化快照按字段 max 恢复，重启后 generation 不回退', async () => {
  const persistence = memoryPersistence({
    v: 1,
    tabs: {
      5: { generation: 9, controlRevision: 3, authorityRevision: 2, revision: 11, frameEpoch: 4, document: 'https://a/', documentEpoch: 2 },
    },
  });
  const restarted = createRevisionChain({ persist: persistence });
  assert.equal(restarted.record(5).generation, 0, '重启后内存先为空');
  const loaded = await restarted.load();
  assert.equal(loaded.restored, 1);
  assert.equal(restarted.record(5).generation, 9, '载入后 generation 应恢复');
  assert.equal(restarted.record(5).revision, 11);
  assert.equal(restarted.record(5).frameEpoch, 4);
  assert.equal(restarted.record(5).documentEpoch, 2);
  // 恢复后继续递增不会回退。
  const next = restarted.bump(5, { generation: true });
  assert.equal(next.generation, 10);
  // 再恢复一次更旧的快照：按 max 合并，仍是 10。
  restarted.restorePayload({ tabs: { 5: { generation: 4, controlRevision: 9 } } });
  assert.equal(restarted.record(5).generation, 10);
  assert.equal(restarted.record(5).controlRevision, 9);
  assert.equal(restarted.counters().restores >= 2, true);
});

test('flush：先读旧快照再 merge-max 写入，空白实例不会把持久化计数覆盖成 0', async () => {
  const persistence = memoryPersistence({ v: 1, tabs: { 6: { generation: 12, revision: 8 } } });
  const fresh = createRevisionChain({ persist: persistence });
  // 空白实例先 bump 自己的小计数（尚未 load）。
  fresh.bump(6, { controlRevision: 1 });
  await fresh.flush();
  const written = persistence.raw().tabs['6'];
  assert.equal(written.generation, 12, '写入前没有 merge 旧的更大 generation');
  assert.equal(written.revision, 8);
  assert.equal(written.controlRevision, 1);
  // 再次 flush 无脏数据时跳过。
  const second = await fresh.flush();
  assert.equal(second.skipped, true);
  // 无 persist 适配器时返回结构化失败。
  const bare = createRevisionChain();
  assert.equal((await bare.flush()).code, 'NO_PERSIST');
});

test('恢复载荷支持数组与直接 map；非法条目被忽略', () => {
  const chain = createRevisionChain();
  const restored = chain.restorePayload([{ tabId: 7, generation: 3 }, { tabId: 'x' }, null]);
  assert.equal(restored.restored, 1);
  assert.equal(chain.record(7).generation, 3);
  const mapRestored = chain.restorePayload({ 8: { generation: 2 }, nope: { generation: 9 } });
  assert.equal(mapRestored.restored, 1);
  assert.equal(chain.record(8).generation, 2);
  assert.equal(chain.list().length, 2);
});

test('maxTabs 上限与 clear/snapshot 元数据', () => {
  const chain = createRevisionChain({ maxTabs: 2 });
  chain.bump(1, { controlRevision: true });
  chain.bump(2, { controlRevision: true });
  chain.bump(3, { controlRevision: true });
  assert.equal(chain.list().length, 2);
  assert.equal(chain.record(1).controlRevision, 0, '最早插入的 tab 记录被淘汰');
  assert.equal(chain.clear(2), true);
  assert.equal(chain.list().length, 1);
  const snapshot = chain.snapshot(3);
  assert.equal(snapshot.tabId, 3);
  assert.equal(typeof snapshot.key, 'string');
  assert.equal(snapshot.counters.bumps >= 3, true);
});
