// tests/refs.test.ts —— TS ref 签名/生命周期：与 0.3.0 JS ref-registry 的差分 + 纯函数判定。
//
// 差分测试直接 import 根 extension 的 JS 模块（只读兼容目标），断言同输入同输出：
// 签名、fence key、refKeyId、sameRef 逐字段相等。TS 特有的“无 CDP identity 签名”
// 单独断言可区分节点，不拿它冒充与 JS 相等。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessObservationFreshness,
  assessRefMatch,
  makeFenceKey,
  makeRefKey,
  makeStabilitySignature,
  refKeyId,
  sameRef,
  sameStabilitySignature,
  signatureHash,
  RefRegistry,
  STALE_REF_MESSAGES,
} from '../src/refs/index.ts';

/**
 * 根 extension 是 JS（无 .d.ts），差分测试用动态 import + 本地类型声明：
 * 既避免给兼容目标补声明文件（只读），又保留 tsc 对我们调用面的类型检查。
 */
interface JsRefRegistryModule {
  makeStabilitySignature(parts?: Record<string, unknown>): string;
  makeFenceKey(parts?: Record<string, unknown>): Record<string, unknown>;
  sameRef(a: unknown, b: unknown): boolean;
  refKeyId(key: Record<string, unknown>): string;
  RefRegistry: new (options?: { now?: () => number }) => {
    register(tabId: number, ref: string, parts: Record<string, unknown>): Record<string, unknown>;
    upgradeBackend(tabId: number, ref: string, backendNodeId: number): Record<string, unknown>;
  };
}

const jsRef = (await import('../../../extension/src/refs/ref-registry.js' as string)) as unknown as JsRefRegistryModule;
const jsMakeStabilitySignature = jsRef.makeStabilitySignature;
const jsMakeFenceKey = jsRef.makeFenceKey;
const jsSameRef = jsRef.sameRef;
const jsRefKeyId = jsRef.refKeyId;
const JsRefRegistry = jsRef.RefRegistry;

const SIGNATURE_CASES = [
  { documentId: 'doc-a', backendNodeId: 42, frameId: 0, cdpSessionId: 'tab:0' },
  { documentId: 'doc-a', backendNodeId: 42, frameId: 0 },
  { documentId: 'doc-b', backendNodeId: 7, frameId: 3, cdpSessionId: 'tab:0' },
  { documentId: 'doc-c', frameId: 0, cdpSessionId: null },
  { documentId: 'doc-d', backendNodeId: '12' as unknown as number, frameId: '2' as unknown as number },
  { documentId: 'doc-e', backendNodeId: -1, frameId: 0 },
];

test('FNV-1a 签名哈希：与 JS 扩展同一算法（可比较、非安全哈希）', () => {
  // 只断言性质：确定性、32 位无符号、base36、空串稳定。
  assert.equal(signatureHash(''), signatureHash(''));
  assert.equal(signatureHash('abc'), signatureHash('abc'));
  assert.notEqual(signatureHash('abc'), signatureHash('abd'));
  assert.match(signatureHash('abc'), /^[0-9a-z]+$/);
});

test('makeStabilitySignature：有 backendNodeId 时与 JS 逐字符一致', () => {
  for (const parts of SIGNATURE_CASES) {
    assert.equal(
      makeStabilitySignature(parts),
      jsMakeStabilitySignature(parts),
      '签名不一致：' + JSON.stringify(parts),
    );
  }
});

test('makeStabilitySignature：documentId 缺失时两边都抛错', () => {
  assert.throws(() => makeStabilitySignature({}), /documentId/);
  assert.throws(() => jsMakeStabilitySignature({}), /documentId/);
});

test('makeStabilitySignature：TS 无 CDP 时用 identity 区分同文档节点', () => {
  const a = makeStabilitySignature({ documentId: 'doc-a', identity: 'button|#go|button|Go' });
  const b = makeStabilitySignature({ documentId: 'doc-a', identity: 'button|#stop|button|Stop' });
  assert.notEqual(a, b, '不同节点的签名不应相同');
  // 同一节点多次观察签名稳定（不含 revision 时）。
  assert.equal(a, makeStabilitySignature({ documentId: 'doc-a', identity: 'button|#go|button|Go' }));
  // identity 不影响带 backendNodeId 的 JS 兼容路径。
  assert.equal(
    makeStabilitySignature({ documentId: 'doc-a', backendNodeId: 5, identity: 'x' }),
    jsMakeStabilitySignature({ documentId: 'doc-a', backendNodeId: 5 }),
  );
});

test('sameStabilitySignature：空值一律不一致', () => {
  assert.equal(sameStabilitySignature('sig:abc', 'sig:abc'), true);
  assert.equal(sameStabilitySignature('', ''), false);
  assert.equal(sameStabilitySignature(null, 'sig:abc'), false);
  assert.equal(sameStabilitySignature('sig:abc', 'sig:abd'), false);
});

test('makeFenceKey / refKeyId / sameRef 与 JS 逐字段相等', () => {
  const parts = { documentId: 'doc-a', backendNodeId: 9, frameId: 0, revision: 3, generation: 2, cdpSessionId: 't:0' };
  assert.deepEqual({ ...makeFenceKey(parts) }, { ...jsMakeFenceKey(parts) });
  assert.equal(refKeyId(makeFenceKey(parts)), jsRefKeyId(jsMakeFenceKey(parts)));

  const a = makeFenceKey({ documentId: 'doc-a', backendNodeId: 9, frameId: 0, revision: 3 });
  const b = makeFenceKey({ documentId: 'doc-a', backendNodeId: 9, frameId: 0 });
  assert.equal(sameRef(a, b), true, 'revision 缺省应视为通配');
  assert.equal(sameRef(a, b), jsSameRef(jsMakeFenceKey({ ...a }), jsMakeFenceKey({ ...b })));
  assert.equal(sameRef(a, null), false);
  assert.equal(jsSameRef(a, null), false);
});

test('makeRefKey：缺 backendNodeId 抛错（与 JS 相同），makeFenceKey 不要求', () => {
  assert.throws(() => makeRefKey({ documentId: 'doc-a' }), /backendNodeId/);
  assert.throws(() => jsMakeFenceKey({}), /documentId/);
  assert.equal(makeFenceKey({ documentId: 'doc-a' }).backendNodeId, null);
});

// ---------------------------------------------------------------------------
// 纯函数失效判定
// ---------------------------------------------------------------------------

const ENTRY = {
  key: makeFenceKey({ documentId: 'doc-a', backendNodeId: 5, frameId: 0, revision: 4, generation: 2 }),
  signature: makeStabilitySignature({ documentId: 'doc-a', backendNodeId: 5 }),
  generation: 2,
};

test('assessRefMatch：六项比较与 JS resolve 的六条提示逐字符一致', () => {
  assert.deepEqual(assessRefMatch(ENTRY), { ok: true });
  assert.deepEqual(assessRefMatch(null), { ok: false, reason: 'missing', message: STALE_REF_MESSAGES.missing });
  assert.equal(STALE_REF_MESSAGES.missing, 'ref 不在当前注册表里，请重新 observe');
  assert.equal(STALE_REF_MESSAGES.stale_document, 'ref 属于旧 document，请重新 observe');

  const documentMismatch = assessRefMatch(ENTRY, { documentId: 'doc-b' });
  assert.equal(documentMismatch.ok, false);
  if (!documentMismatch.ok) assert.equal(documentMismatch.reason, 'stale_document');

  const generationMismatch = assessRefMatch(ENTRY, { generation: 3 });
  assert.equal(generationMismatch.ok, false);
  if (!generationMismatch.ok) assert.equal(generationMismatch.reason, 'stale_generation');

  const signatureMismatch = assessRefMatch(ENTRY, { signature: 'sig:other' });
  assert.equal(signatureMismatch.ok, false);
  if (!signatureMismatch.ok) assert.equal(signatureMismatch.reason, 'stale_signature');

  const revisionMismatch = assessRefMatch(ENTRY, { revision: 5 });
  assert.equal(revisionMismatch.ok, false);
  if (!revisionMismatch.ok) assert.equal(revisionMismatch.reason, 'stale_revision');

  const frameMismatch = assessRefMatch(ENTRY, { frameId: 2 });
  assert.equal(frameMismatch.ok, false);
  if (!frameMismatch.ok) assert.equal(frameMismatch.reason, 'stale_frame');

  const backendMismatch = assessRefMatch(ENTRY, { backendNodeId: 6 });
  assert.equal(backendMismatch.ok, false);
  if (!backendMismatch.ok) assert.equal(backendMismatch.reason, 'stale_backend');

  // 相同期望值通过（不误杀）。
  assert.deepEqual(
    assessRefMatch(ENTRY, { documentId: 'doc-a', generation: 2, signature: ENTRY.signature, revision: 4, frameId: 0, backendNodeId: 5 }),
    { ok: true },
  );
});

test('assessObservationFreshness：document/generation/revision 三类过期，缺省不推断', () => {
  assert.deepEqual(assessObservationFreshness({ documentId: 'doc-a', revision: 3 }, { documentId: 'doc-a', revision: 3 }), { ok: true });
  assert.deepEqual(assessObservationFreshness(null, { documentId: 'doc-a' }), { ok: true });

  const documentStale = assessObservationFreshness({ documentId: 'doc-a', revision: 3 }, { documentId: 'doc-b', revision: 3 });
  assert.equal(documentStale.ok, false);
  if (!documentStale.ok) {
    assert.equal(documentStale.code, 'E_OBSERVATION_STALE');
    assert.equal(documentStale.reason, 'stale_document');
  }

  const generationStale = assessObservationFreshness({ documentId: 'doc-a', generation: 1 }, { documentId: 'doc-a', generation: 2 });
  assert.equal(generationStale.ok, false);
  if (!generationStale.ok) assert.equal(generationStale.reason, 'stale_generation');

  const revisionStale = assessObservationFreshness({ documentId: 'doc-a', revision: 3 }, { documentId: 'doc-a', revision: 4 });
  assert.equal(revisionStale.ok, false);
  if (!revisionStale.ok) {
    assert.equal(revisionStale.reason, 'stale_revision');
    assert.match(revisionStale.message, /3 → 4/);
  }
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

function makeRegistry(now = () => 1_000): RefRegistry {
  return new RefRegistry({ now });
}

test('RefRegistry.register/resolve：登记后可解析，期望不匹配按原因拒绝', () => {
  const refs = makeRegistry();
  const key = refs.register(7, '@e1', { documentId: 'doc-a', revision: 3 }, { role: 'button', name: 'Go', identity: 'button|#go' });
  assert.equal(key.documentId, 'doc-a');
  assert.equal(key.revision, 3);
  assert.equal(refs.size(7), 1);
  assert.equal(refs.total(), 1);

  const ok = refs.resolve(7, '@e1');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.meta.role, 'button');
    assert.equal(ok.meta.name, 'Go');
    assert.equal(ok.meta.signature, makeStabilitySignature({ documentId: 'doc-a', identity: 'button|#go' }));
  }

  const missing = refs.resolve(7, '@e999');
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, 'E_STALE_REF');
    assert.equal(missing.reason, 'missing');
  }

  const staleRevision = refs.resolve(7, '@e1', { revision: 4 });
  assert.equal(staleRevision.ok, false);
  if (!staleRevision.ok) assert.equal(staleRevision.reason, 'stale_revision');

  const staleBackend = refs.resolve(7, '@e1', { backendNodeId: 99 });
  assert.equal(staleBackend.ok, false);
  if (!staleBackend.ok) assert.equal(staleBackend.reason, 'stale_backend');
});

test('RefRegistry：登记新文档推进 generation，旧引用判 stale_document', () => {
  const refs = makeRegistry();
  refs.register(7, '@e1', { documentId: 'doc-a', revision: 1 }, { identity: 'a' });
  assert.equal(refs.noteDocument(7, 'doc-a').changed, false);
  const before = refs.generationOf(7);

  const noted = refs.noteDocument(7, 'doc-b');
  assert.equal(noted.changed, true);
  assert.equal(noted.generation, before + 1);
  assert.equal(refs.generationOf(7), before + 1);

  // resolve 本身只比较“调用方给的期望”；注册表侧的文档失效靠 invalidateDocument/register。
  const stale = refs.resolve(7, '@e1', { documentId: 'doc-b' });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, 'stale_document');
});

test('RefRegistry.registerObservation：整体重建 ref 表，旧 ref 立即失效', () => {
  const refs = makeRegistry();
  refs.register(7, '@e1', { documentId: 'doc-a', revision: 1 }, { identity: 'a' });

  const registered = refs.registerObservation(7, {
    documentId: 'doc-a',
    revision: 2,
    refs: [
      { ref: '@e1', role: 'button', name: 'Go', identity: 'button|#go', stableRef: 's-abc' },
      { ref: '@e2', role: 'textbox', name: 'Kw', identity: 'input|#kw', stableRef: 's-def' },
      { ref: 'not-a-ref', role: 'button' },
    ],
  });
  assert.deepEqual(registered, { registered: 2, skipped: 1, generation: refs.generationOf(7), documentId: 'doc-a' });
  assert.equal(refs.size(7), 2);
  assert.equal(refs.get(7, '@e1')?.key.revision, 2);
  assert.equal(refs.getByStableRef(7, 's-abc')?.ref, '@e1');
  assert.equal(refs.getByStableRef(7, 's-def')?.ref, '@e2');
  assert.equal(refs.getByStableRef(7, 's-nope'), null);

  // signature 查找：同文档同 identity 命中。
  const signature = refs.get(7, '@e2')?.signature;
  assert.ok(signature);
  assert.equal(refs.getBySignature(7, signature)?.ref, '@e2');

  // 没有 documentId 的观察不登记（也不清空旧表）。
  const skipped = refs.registerObservation(7, { refs: [{ ref: '@e9' }] });
  assert.equal(skipped.registered, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(refs.size(7), 2);
});

test('RefRegistry：stableRef 协商给出 stale_document/not_found 与 renegotiate 标记', () => {
  const refs = makeRegistry();
  refs.registerObservation(7, {
    documentId: 'doc-a',
    revision: 3,
    refs: [{ ref: '@e1', role: 'button', name: 'Go', identity: 'button|#go', stableRef: 's-abc' }],
  });

  const current = refs.negotiate(7, ['s-abc', 's-missing'], { documentId: 'doc-a', revision: 3 });
  assert.equal(current.ok, true);
  assert.equal(current.documentId, 'doc-a');
  const first = current.refs[0];
  assert.ok(first);
  assert.equal(first.ok, true);
  assert.equal(first.ref, '@e1');
  assert.equal(first.renegotiate, false);
  const second = current.refs[1];
  assert.ok(second);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'not_found');
  assert.equal(second.renegotiate, true);

  const staleDocument = refs.negotiate(7, ['s-abc'], { documentId: 'doc-b' });
  const stale = staleDocument.refs[0];
  assert.ok(stale);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_document');

  const staleRevision = refs.negotiate(7, ['s-abc'], { documentId: 'doc-a', revision: 9 });
  assert.equal(staleRevision.refs[0]?.reason, 'stale_revision');
});

test('RefRegistry.invalidateDocument/invalidateTab/sweep：清理并推进代际', () => {
  let now = 1_000;
  const refs = new RefRegistry({ now: () => now });
  refs.registerObservation(7, {
    documentId: 'doc-a',
    revision: 1,
    refs: [
      { ref: '@e1', identity: 'a', stableRef: 's-a' },
      { ref: '@e2', identity: 'b', stableRef: 's-b' },
    ],
  });
  const generation = refs.generationOf(7);
  const removed = refs.invalidateDocument(7, 'doc-a');
  assert.equal(removed, 2);
  assert.equal(refs.size(7), 0);
  assert.equal(refs.generationOf(7), generation + 1);

  refs.registerObservation(8, { documentId: 'doc-x', revision: 1, refs: [{ ref: '@e1', identity: 'a', stableRef: 's-a' }] });
  assert.equal(refs.invalidateTab(8), true);
  assert.equal(refs.size(8), 0);

  now = 1_000;
  refs.registerObservation(9, { documentId: 'doc-y', revision: 1, refs: [{ ref: '@e1', identity: 'a' }] });
  now += 6 * 60 * 1000;
  assert.equal(refs.sweep(), 1);
  assert.equal(refs.size(9), 0);
});

test('RefRegistry：tab 隔离，upgradeBackend 把签名切回 JS 兼容路径', () => {
  const refs = makeRegistry();
  refs.register(1, '@e1', { documentId: 'doc-a', revision: 1 }, { identity: 'button|#go' });
  assert.equal(refs.get(2, '@e1'), null);
  assert.equal(refs.resolve(2, '@e1').ok, false);

  const beforeSignature = refs.get(1, '@e1')?.signature;
  const key = refs.upgradeBackend(1, '@e1', 321);
  assert.ok(key);
  assert.equal(key.backendNodeId, 321);
  const entry = refs.get(1, '@e1');
  assert.ok(entry);
  assert.equal(entry.signature, jsMakeStabilitySignature({ documentId: 'doc-a', backendNodeId: 321, frameId: 0 }));
  assert.notEqual(entry.signature, beforeSignature);
  assert.equal(refs.upgradeBackend(1, '@e1', 0), null);

  // 与 JS 注册表对同一操作序列的 key 结果一致。
  const jsRefs = new JsRefRegistry();
  jsRefs.register(1, '@e1', { documentId: 'doc-a', revision: 1 });
  const jsKey = jsRefs.upgradeBackend(1, '@e1', 321);
  assert.deepEqual({ ...key }, { ...jsKey });});
