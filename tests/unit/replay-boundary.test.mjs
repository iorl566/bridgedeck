// tests/unit/replay-boundary.test.mjs —— 录制→回放边界判定（documentId/frame/revision）。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../extension/src/lib/replay-boundary.js';

function evidence(overrides = {}) {
  return {
    seq: 1,
    frameId: 0,
    documentId: 'doc-1',
    revision: 1,
    url: 'https://a.test/',
    actor: 'human',
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function step(overrides = {}) {
  return {
    ref: 'r1',
    kind: 'action',
    method: 'click',
    evidence: evidence(),
    ...overrides,
  };
}

test('normalizeBoundary：字段优先级 顶层 > evidence > boundary，revision 未知保持 null', () => {
  const boundary = B.normalizeBoundary({
    frameId: 3,
    revision: 9,
    evidence: { documentId: 'doc-evidence', frameId: 1, revision: 2, url: 'https://a.test/x' },
    boundary: { documentId: 'doc-boundary' },
  });
  assert.equal(boundary.documentId, 'doc-evidence');
  assert.equal(boundary.frameId, 3);
  assert.equal(boundary.revision, 9);
  assert.equal(boundary.urlKey, 'https://a.test/x');
  assert.equal(boundary.documentKind, 'opaque');

  const viaBoundary = B.normalizeBoundary({ boundary: { documentId: 'doc-b', frameId: 2, revision: 4 } });
  assert.equal(viaBoundary.documentId, 'doc-b');
  assert.equal(viaBoundary.frameId, 2);
  assert.equal(viaBoundary.revision, 4);

  const empty = B.normalizeBoundary(null);
  assert.equal(empty.documentId, '');
  assert.equal(empty.frameId, 0);
  assert.equal(empty.revision, null);
  assert.equal(empty.url, '');
});

test('normalizeBoundary：截断上限与非法值收敛（不抛）', () => {
  const longId = 'x'.repeat(500);
  const boundary = B.normalizeBoundary({ documentId: longId, frameId: -5, revision: '9', url: 'not a url' });
  assert.equal(boundary.documentId.length, B.BOUNDARY_LIMITS.maxDocumentId);
  assert.equal(boundary.frameId, 0);
  assert.equal(boundary.revision, 9);
  assert.equal(boundary.url, 'not a url');
  assert.equal(boundary.urlKey, 'not a url');

  const negativeRevision = B.normalizeBoundary({ revision: -1 });
  assert.equal(negativeRevision.revision, null);
  assert.equal(B.normalizeFrameId(undefined), 0);
  assert.equal(B.normalizeFrameId(2.5), 0);
  assert.equal(B.normalizeRevision(null), null);
});

test('documentIdKind：uuid/loader/synthetic/opaque/missing', () => {
  assert.equal(B.documentIdKind(''), 'missing');
  assert.equal(B.documentIdKind('9f1b4c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b'), 'uuid');
  assert.equal(B.documentIdKind('A1B2C3D4E5F60718'), 'loader-id');
  assert.equal(B.documentIdKind('synthetic:main'), 'synthetic');
  assert.equal(B.documentIdKind('whatever'), 'opaque');
});

test('pickDocumentId：按来源优先级挑选，同优先级取先出现', () => {
  const picked = B.pickDocumentId([
    { id: 'synthetic:1', source: 'synthetic' },
    { id: 'loader-1', source: 'cdp-loader-id' },
    { id: 'chrome-1', source: 'chrome-document-id' },
  ]);
  assert.equal(picked.id, 'loader-1');
  assert.equal(picked.source, 'cdp-loader-id');
  assert.equal(picked.rank, 0);

  const chromeOnly = B.pickDocumentId(['chrome-1', { id: 'chrome-2', source: 'chrome-document-id' }]);
  // 显式声明来源的候选优先于未标注来源的字符串候选。
  assert.equal(chromeOnly.id, 'chrome-2');
  assert.equal(B.pickDocumentId([]).id, '');
  assert.equal(B.pickDocumentId([{ id: '', source: 'recorded' }]).id, '');
});

test('normalizeUrlKey：去 hash、保留 origin+path+search；解析失败退回原文', () => {
  const key = B.normalizeUrlKey('https://a.test/p?q=1#frag');
  assert.equal(key.key, 'https://a.test/p?q=1');
  assert.equal(key.path, '/p?q=1');
  assert.equal(key.origin, 'https://a.test');
  assert.equal(key.valid, true);
  assert.equal(B.normalizeUrlKey('').key, '');
  assert.equal(B.normalizeUrlKey('mailto:x@y.z').valid, false);
});

test('compareBoundary：同窗口/文档/帧/revision/url/缺失 的关系与证据', () => {
  const base = B.normalizeBoundary({ documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' });
  assert.equal(B.compareBoundary(base, base).relation, 'same');
  assert.equal(B.compareBoundary(base, B.withRevision(base, 2)).relation, 'revision-changed');
  assert.equal(B.compareBoundary(base, B.withFrame(base, 2, 'https://a.test/frame')).relation, 'frame-changed');
  assert.equal(B.compareBoundary(base, { ...base, documentId: 'doc-2' }).relation, 'document-changed');
  assert.equal(B.compareBoundary(base, { ...base, url: 'https://a.test/next' }).relation, 'url-changed');
  assert.equal(B.compareBoundary({ ...base, tabId: 1 }, { ...base, tabId: 3 }).relation, 'tab-changed');

  const missing = B.compareBoundary({ frameId: 0 }, { frameId: 0 });
  assert.equal(missing.relation, 'missing-boundary');
  assert.equal(missing.severity, 'unknown');

  const comparison = B.compareBoundary(base, { ...base, documentId: 'doc-2' });
  assert.equal(comparison.ok, false);
  assert.equal(comparison.documentChanged, true);
  assert.equal(comparison.reasons[0].code, 'document-changed');
  assert.match(comparison.detail, /documentId/);
});

test('compareBoundary：严格度 exact/document/frame/loose 的通过条件', () => {
  const before = { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' };
  const urlChanged = { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/next' };
  const frameChanged = { documentId: 'doc-1', frameId: 5, revision: 1, url: 'https://a.test/' };
  const documentChanged = { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://a.test/' };
  const unknownDoc = { frameId: 0, revision: 1, url: 'https://a.test/' };

  assert.equal(B.compareBoundary(before, urlChanged, { mode: 'exact' }).ok, false);
  assert.equal(B.compareBoundary(before, urlChanged, { mode: 'document' }).ok, true);
  assert.equal(B.compareBoundary(before, frameChanged, { mode: 'document' }).ok, true);
  assert.equal(B.compareBoundary(before, frameChanged, { mode: 'frame' }).ok, false);
  assert.equal(B.compareBoundary(before, documentChanged, { mode: 'loose' }).ok, false);
  assert.equal(B.compareBoundary(before, unknownDoc, { mode: 'loose' }).ok, true);
  assert.equal(B.compareBoundary(before, unknownDoc, { mode: 'exact' }).ok, false);
  assert.equal(B.normalizeBoundaryMode('weird'), 'exact');
});

test('canReplayInWindow：与根 replay-timeline 的 reason 字符串兼容', () => {
  const recorded = { boundary: { documentId: 'doc-1', frameId: 2, revision: 7 } };
  const same = B.canReplayInWindow(recorded, { documentId: 'doc-1', frameId: 2, revision: 7 });
  assert.equal(same.ok, true);
  assert.equal(same.reason, 'same-window');
  assert.equal(B.canReplayInWindow(recorded, { documentId: 'doc-2', frameId: 2, revision: 7 }).reason, 'document-changed');
  assert.equal(B.canReplayInWindow(recorded, { documentId: 'doc-1', frameId: 3, revision: 7 }).reason, 'frame-changed');
  assert.equal(B.canReplayInWindow(recorded, { documentId: 'doc-1', frameId: 2, revision: 8 }).reason, 'revision-changed');
  assert.equal(B.canReplayInWindow(null, null).reason, 'missing-boundary');
});

test('requiresNewWindow：只把文档/帧变化视为“换窗口”', () => {
  const before = { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' };
  assert.equal(B.requiresNewWindow(before, { ...before, revision: 2 }).required, false);
  assert.equal(B.requiresNewWindow(before, { ...before, frameId: 1 }).required, true);
  assert.equal(B.requiresNewWindow(before, { ...before, documentId: 'doc-2' }).reason, 'document-changed');
});

test('sameDocument / sameFrame / sameRevision / sameUrl / sameTab：未知返回 null', () => {
  const left = { documentId: 'doc-1', frameId: 0, revision: 4, url: 'https://a.test/x#a', tabId: 1 };
  const right = { documentId: 'doc-1', frameId: 0, revision: 4, url: 'https://a.test/x#b', tabId: 1 };
  assert.equal(B.sameDocument(left, right), true);
  assert.equal(B.sameDocument({}, right), null);
  assert.equal(B.sameFrame(left, { ...right, frameId: 2 }), false);
  assert.equal(B.sameRevision(left, { ...right, revision: null }), null);
  assert.equal(B.sameUrl(left, right), true);
  assert.equal(B.sameTab(left, { ...right, tabId: null }), null);
  assert.equal(B.boundarySeverity('document-changed'), 'hard');
  assert.equal(B.isHardChange('revision-changed'), false);
  assert.equal(B.isHardChange('frame-changed'), true);
});

test('boundaryKey / boundaryHash / boundaryScopeKey：确定且与 revision 解耦', () => {
  const one = { documentId: 'doc-1', frameId: 0, revision: 1 };
  const two = { documentId: 'doc-1', frameId: 0, revision: 2 };
  assert.notEqual(B.boundaryKey(one), B.boundaryKey(two));
  assert.equal(B.boundaryHash(one), B.boundaryHash({ ...one }));
  assert.equal(B.boundaryScopeKey(one), B.boundaryScopeKey(two));
  assert.equal(B.boundaryScopeKey(one), 'doc-1|f0');
});

test('withRevision / withFrame：复制语义，不改原对象', () => {
  const base = { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' };
  const next = B.withRevision(base, 5);
  assert.equal(next.revision, 5);
  assert.equal(base.revision, 1);
  const moved = B.withFrame(base, 3, 'https://a.test/frame');
  assert.equal(moved.frameId, 3);
  assert.equal(moved.urlKey, 'https://a.test/frame');
  assert.equal(base.frameId, 0);
});

test('frame 树：normalizeFrameList / framePathOf / frameDepth / frameRelation', () => {
  const frames = [
    { frameId: 2, parentFrameId: 0, url: 'https://a.test/f2' },
    { frameId: 0, parentFrameId: -1, url: 'https://a.test/' },
    { frameId: 5, parentFrameId: 2, url: 'https://a.test/f5' },
  ];
  const normalized = B.normalizeFrameList(frames);
  assert.deepEqual(normalized.map((frame) => frame.frameId), [0, 2, 5]);
  assert.deepEqual(B.framePathOf(normalized, 5), [0, 2, 5]);
  assert.deepEqual(B.framePathOf(normalized, 0), [0]);
  assert.equal(B.frameDepth(normalized, 5), 2);
  assert.equal(B.frameDepth(normalized, 0), 0);
  assert.equal(B.findFrame(normalized, 2).url, 'https://a.test/f2');
  assert.equal(B.findFrame(normalized, 9), null);
  assert.equal(B.isMainFrame(0), true);
  assert.equal(B.isMainFrame(2), false);
  assert.equal(B.frameRelation(2, 2, normalized), 'same');
  assert.equal(B.frameRelation(2, 5, normalized), 'descendant');
  assert.equal(B.frameRelation(5, 2, normalized), 'ancestor');
  assert.equal(B.frameRelation(2, 9, normalized), 'unknown');
});

test('frameUrlMatches：精确/同源/缺失', () => {
  assert.equal(B.frameUrlMatches('https://a.test/x', 'https://a.test/x#h').ok, true);
  assert.equal(B.frameUrlMatches('https://a.test/x', 'https://a.test/y').ok, false);
  assert.equal(B.frameUrlMatches('https://a.test/x', 'https://a.test/y', { allowOriginOnly: true }).reason, 'same-origin');
  assert.equal(B.frameUrlMatches('', 'https://a.test/x').reason, 'missing-url');
});

test('boundaryFromStep / boundaryFromEvidence：读取 evidence 与 branch tabId', () => {
  assert.equal(B.boundaryFromStep(step()).documentId, 'doc-1');
  assert.equal(B.boundaryFromEvidence(evidence({ documentId: 'doc-9' })).documentId, 'doc-9');
  const tabStep = step({ branch: { boundary: 'tab-switch', tabId: 12 } });
  assert.equal(B.boundaryFromStep(tabStep).tabId, 12);
  assert.equal(B.boundaryFromStep(null).documentId, '');
});

test('replayWindowSegments：按当前身份切出可重放的连续区间', () => {
  const steps = [
    step({ evidence: evidence() }),
    step({ evidence: evidence({ revision: 2 }) }),
    step({ evidence: evidence({ documentId: 'doc-2', revision: 0 }) }),
    step({ evidence: evidence({ documentId: 'doc-2', revision: 1, url: 'https://a.test/next' }) }),
  ];
  const segments = B.replayWindowSegments(steps, { documentId: 'doc-1', frameId: 0, revision: 1 });
  assert.equal(segments.mode, 'exact');
  // exact 模式下：revision 变化、换文档都算“不在同一窗口”。
  assert.equal(segments.replayable, 1);
  assert.equal(segments.blocked, 3);
  assert.equal(segments.segments.length, 1);
  assert.deepEqual([segments.segments[0].startIndex, segments.segments[0].endIndex], [0, 0]);
  const loose = B.replayWindowSegments(steps, { documentId: 'doc-1', frameId: 0, revision: 1 }, { mode: 'loose' });
  assert.equal(loose.blocked, 2);
  assert.equal(B.replayWindowSegments([], null).segments.length, 0);
});
