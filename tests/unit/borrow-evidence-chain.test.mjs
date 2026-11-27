// tests/unit/borrow-evidence-chain.test.mjs —— 借用证据链第二轮：
//   1) 多来源归一化（journey/gate/controller/leases/human/revision）与合并时间线；
//   2) 语义冲突（anomalies）只报告：journey 缺失、决策/闸门不一致、交还后 controller/租约不干净；
//   3) 证书 digest 校验、证书链（prevDigest+chainDigest）、两份证书 diff；
//   4) 真实接线：borrowGate/borrowJourneys 的真实旅程 → borrowGate.snapshot().evidenceLinks；
//      human-borrow-ledger.sealChain 第二轮字段（sourceDigest/kinds/sources）可校验。
const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: listener(),
  },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: {
    onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(),
    query: async () => [],
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/shop', title: 'shop', index: 0, active: true }),
    sendMessage: async () => ({ ok: true }),
    update: async () => ({}),
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }), update: async () => ({}) },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
};

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  BORROW_EVIDENCE_CODES,
  BORROW_EVIDENCE_SOURCES,
  BORROW_EVIDENCE_VERSION,
  borrowEvidenceDiff,
  borrowEvidenceLinks,
  borrowEvidenceTimeline,
  buildBorrowEvidence,
  chainBorrowEvidence,
  controllerEvidence,
  describeBorrowEvidence,
  formatBorrowEvidence,
  gateEvidence,
  journeyEvidence,
  revisionEvidence,
  sameBorrowCorrelation,
  summarizeBorrowEvidence,
  verifyBorrowEvidence,
  verifyBorrowEvidenceChain,
} = await import('../../extension/src/lib/borrow-evidence-chain.js');
const { sealChain, summarizeChainSources, verifyChain, chainEntry, CHAIN_SEAL_VERSION } = await import('../../extension/src/lib/human-borrow-ledger.js');
const { borrowGate } = await import('../../extension/src/lib/borrow-confirm.js');
const { borrowJourneys } = await import('../../extension/src/lib/borrow.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { humanGate } = await import('../../extension/src/lib/human-gate.js');
const { cooperationCoordinator } = await import('../../extension/src/lib/cooperate.js');
const { clearControlGeneration } = await import('../../extension/src/control-generation.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { humanSignalEntry, normalizeHumanChainSignal } = await import('../../extension/src/lib/human-gate-chain.js');

function cleanup(tabId) {
  try { borrowGate.clear(tabId); } catch { /* 清理不抛 */ }
  controllerState.clear(tabId);
  borrowJourneys.forget(tabId);
  cooperationCoordinator.forget(tabId);
  humanGate.clear(tabId);
  clearControlGeneration(tabId);
}

function sealedJourney(entries, extra = {}) {
  const state = extra.state || 'returned';
  const decision = extra.decision || 'allow';
  const requestId = extra.requestId || 'req-31';
  return {
    ...sealChain(entries),
    state,
    decision,
    requestId,
    extra: { tabId: 31, requestId, state, decision, ...extra },
  };
}

function sampleEntries(decision = 'allow') {
  const entries = [];
  entries.push(chainEntry(null, { seq: 1, kind: 'state', at: 1000, data: { event: 'request', requestId: 'req-31' } }));
  entries.push(chainEntry(entries[0], { seq: 2, kind: 'state', at: 1100, data: { event: 'presented', surface: 'modal' } }));
  entries.push(chainEntry(entries[1], { seq: 3, kind: 'state', at: 1200, data: { event: 'decision.allow', decision } }));
  entries.push(chainEntry(entries[2], { seq: 4, kind: 'return.complete', at: 1500, data: { decision } }));
  return entries;
}

test('journeyEvidence：快照与封存证书两种输入、chainVerified/sourceDigest、空输入', () => {
  const snapshot = { state: 'returned', decision: 'allow', requestId: 'req-1', entryCount: 4, sealed: { digest: 'abcd1234' } };
  const fromSnapshot = journeyEvidence(snapshot);
  assert.equal(fromSnapshot.present, true);
  assert.equal(fromSnapshot.state, 'returned');
  assert.equal(fromSnapshot.terminal, true);
  assert.equal(fromSnapshot.active, false);
  assert.equal(fromSnapshot.chainDigest, 'abcd1234');
  assert.equal(fromSnapshot.chainVerified, null, '快照没有完整链，无法校验');
  assert.match(fromSnapshot.digest, /^[0-9a-f]{8}$/);

  const fromSealed = journeyEvidence(sealedJourney(sampleEntries()));
  assert.equal(fromSealed.present, true);
  assert.equal(fromSealed.chainVerified, true);
  assert.match(fromSealed.sourceDigest, /^[0-9a-f]{8}$/);
  assert.equal(fromSealed.entryCount, 4);
  assert.equal(fromSealed.kinds.state, 3);

  const active = journeyEvidence({ state: 'confirmed', decision: 'allow' });
  assert.equal(active.active, true);
  assert.equal(active.terminal, false);

  const absent = journeyEvidence(null);
  assert.equal(absent.present, false);
  assert.equal(absent.digest, journeyEvidence(undefined).digest);
});

test('gateEvidence/controllerEvidence/revisionEvidence：三态与计数摘要', () => {
  const absentGate = gateEvidence(null);
  assert.equal(absentGate.present, false);
  const pendingGate = gateEvidence({ status: 'pending', requestId: 'req-1' });
  assert.equal(pendingGate.pending, true);
  assert.equal(pendingGate.confirmed, false);
  const confirmedGate = gateEvidence({ status: 'confirmed', requestId: 'req-1' });
  assert.equal(confirmedGate.confirmed, true);
  const expiredGate = gateEvidence({ status: 'pending', expired: true });
  assert.equal(expiredGate.expired, true);

  assert.equal(controllerEvidence(null).present, false);
  const borrowed = controllerEvidence('borrowed');
  assert.equal(borrowed.borrowed, true);
  assert.equal(controllerEvidence({ state: 'human' }).human, true);
  assert.equal(controllerEvidence({ controllerState: 'handoff' }).handoff, true);

  const revision = revisionEvidence({
    before: { controlRevision: 1, authorityRevision: 2, revision: 3, frameEpoch: 4 },
    after: { controlRevision: 2, authorityRevision: 2, revision: 5, frameEpoch: 4 },
    stale: true,
    side: 'remote',
  });
  assert.equal(revision.present, true);
  assert.equal(revision.before.revision, 3);
  assert.equal(revision.after.revision, 5);
  assert.equal(revision.stale, true);
  assert.equal(revision.side, 'remote');
  assert.equal(revisionEvidence(null).present, false);
});

test('borrowEvidenceTimeline：旅程/human/租约/闸门合并按时间排序、来源标注、上限', () => {
  const humanEntries = [
    humanSignalEntry(null, normalizeHumanChainSignal({ at: 1050, kind: 'click', frameId: 0, source: 'human-state', count: 1 }, { who: 'human', basis: 'human-state' })),
  ];
  const timeline = borrowEvidenceTimeline({
    journey: sealedJourney(sampleEntries()),
    human: { entries: humanEntries },
    leases: [{ leaseId: 'coop-1', kind: 'native-input', method: 'click', startedAt: 1200, active: true }],
    gate: { status: 'confirmed', requestId: 'req-31', resolvedAt: 1100 },
  });
  assert.equal(timeline.length >= 6, true);
  assert.equal(timeline[0].at, 1000);
  assert.equal(timeline[0].source, 'journey');
  const sources = new Set(timeline.map((entry) => entry.source));
  assert.equal(sources.has('journey'), true);
  assert.equal(sources.has('human'), true);
  assert.equal(sources.has('leases'), true);
  assert.equal(sources.has('gate'), true);
  const ats = timeline.map((entry) => entry.at);
  assert.deepEqual(ats, [...ats].sort((left, right) => left - right));

  const snapshotTimeline = borrowEvidenceTimeline({ journey: { requestedAt: 1000, presentedAt: 1100, returnedAt: 1500, decision: 'allow' } });
  assert.equal(snapshotTimeline.length, 3);
  assert.equal(varBounded(borrowEvidenceTimeline({ journey: sealedJourney(Array.from({ length: 100 }, (_, index) => chainEntry(index === 0 ? null : null, { seq: index + 1, kind: 'state', at: 1000 + index, data: {} }))) })).length, 64);
});

function varBounded(value) {
  return value;
}

test('buildBorrowEvidence：来源 digest 汇总 + correlationKey + 空输入证书可校验', () => {
  const certificate = buildBorrowEvidence({
    tabId: 31,
    at: 2000,
    journey: sealedJourney(sampleEntries()),
    gate: { status: 'confirmed', requestId: 'req-31' },
    controller: 'idle',
    leases: [],
    revision: { before: { revision: 1 }, after: { revision: 2 } },
  });
  assert.equal(certificate.version, BORROW_EVIDENCE_VERSION);
  assert.equal(certificate.kind, 'borrow.evidence');
  assert.equal(certificate.tabId, 31);
  assert.equal(typeof certificate.sources, 'object');
  assert.equal(Object.keys(certificate.sources).length, 6);
  assert.equal(Object.values(BORROW_EVIDENCE_SOURCES).every((name) => certificate.sources[name] != null), true);
  assert.equal(certificate.anomalies.length, 0, '一致证据不应报异常');
  assert.match(certificate.correlationKey, /^bk-[0-9a-f]{8}$/);
  assert.match(certificate.digest, /^[0-9a-f]{8}$/);
  assert.equal(verifyBorrowEvidence(certificate).ok, true);
  assert.equal(verifyBorrowEvidence(certificate).digestOk, true);

  const empty = buildBorrowEvidence({ tabId: null });
  assert.equal(empty.tabId, null);
  assert.equal(empty.journey.present, false);
  assert.equal(verifyBorrowEvidence(empty).ok, true);

  const tampered = { ...certificate, timeline: certificate.timeline.slice(0, 1) };
  assert.equal(verifyBorrowEvidence(tampered).ok, false);
  assert.equal(verifyBorrowEvidence(null).ok, false);
});

test('buildBorrowEvidence：语义冲突只报告（journey 缺失/决策不一致/交还后 controller/租约）', () => {
  const orphanGate = buildBorrowEvidence({ tabId: 32, gate: { status: 'pending', requestId: 'req-32' } });
  assert.equal(orphanGate.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.JOURNEY_MISSING), true);

  const noGate = buildBorrowEvidence({ tabId: 33, journey: { state: 'confirmed', decision: 'allow', requestId: 'req-33' } });
  assert.equal(noGate.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.GATE_MISSING), true);

  const mismatch = buildBorrowEvidence({
    tabId: 34,
    journey: { state: 'allowed', decision: 'allow', requestId: 'req-34' },
    gate: { status: 'pending', requestId: 'req-34' },
  });
  assert.equal(mismatch.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.DECISION_GATE_MISMATCH), true);

  const dirty = buildBorrowEvidence({
    tabId: 35,
    journey: { state: 'returned', decision: 'allow', requestId: 'req-35' },
    controller: 'borrowed',
    leases: [{ leaseId: 'coop-9', kind: 'native-input', startedAt: 1000, active: true }],
  });
  assert.equal(dirty.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.CONTROLLER_AFTER_RETURN), true);
  assert.equal(dirty.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.LEASE_AFTER_RETURN), true);

  const correlation = buildBorrowEvidence({
    tabId: 36,
    journey: { state: 'confirmed', decision: 'allow', requestId: 'req-a' },
    gate: { status: 'confirmed', requestId: 'req-b' },
  });
  assert.equal(correlation.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.CORRELATION_MISMATCH), true);
});

test('buildBorrowEvidence：人机链被篡改 → CHAIN_TAMPERED（journey/human 两个来源）', () => {
  const journeySealed = sealedJourney(sampleEntries());
  const tamperedJourney = { ...journeySealed, entries: journeySealed.entries.map((entry, index) => (index === 1 ? { ...entry, data: { event: '被改' } } : entry)) };
  const journeyEvidenceValue = buildBorrowEvidence({ tabId: 37, journey: tamperedJourney });
  assert.equal(journeyEvidenceValue.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.CHAIN_TAMPERED), true);
  assert.equal(journeyEvidenceValue.journey.chainVerified, false);

  const humanEntries = [humanSignalEntry(null, normalizeHumanChainSignal({ at: 1000, kind: 'input', source: 'human-state', count: 1 }, { who: 'human', basis: 'human-state' }))];
  const tamperedHuman = { version: 1, sealed: true, count: 1, firstAt: 1000, lastAt: 1000, digest: 'deadbeef', entries: humanEntries.map((entry) => ({ ...entry, kind: 'tampered' })) };
  const humanEvidenceValue = buildBorrowEvidence({ tabId: 38, human: tamperedHuman });
  assert.equal(humanEvidenceValue.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.CHAIN_TAMPERED), true);
});

test('borrowEvidenceDiff：逐来源差异、异常增删、correlation 对比', () => {
  const left = buildBorrowEvidence({ tabId: 39, journey: { state: 'confirmed', decision: 'allow', requestId: 'req-39' }, gate: { status: 'confirmed', requestId: 'req-39' } });
  const same = borrowEvidenceDiff(left, left);
  assert.equal(same.equal, true);
  assert.equal(same.sources.length, 0);
  assert.equal(same.correlation.same, true);

  const right = buildBorrowEvidence({
    tabId: 39,
    journey: { state: 'returned', decision: 'allow', requestId: 'req-39' },
    gate: { status: 'confirmed', requestId: 'req-39' },
    controller: 'idle',
    leases: [],
  });
  const diff = borrowEvidenceDiff(left, right);
  assert.equal(diff.equal, false);
  assert.equal(diff.sources.some((item) => item.source === 'journey'), true);
  assert.equal(diff.correlation.same, true);
  assert.equal(diff.stats.changedSources >= 1, true);
  assert.equal(Array.isArray(diff.anomaliesAdded), true);
});

test('chainBorrowEvidence/verifyBorrowEvidenceChain：链节链接、连续借用可对账、篡改定位', () => {
  const first = buildBorrowEvidence({ tabId: 40, journey: { state: 'confirmed', decision: 'allow', requestId: 'req-40' } });
  const second = buildBorrowEvidence({ tabId: 40, journey: { state: 'returned', decision: 'allow', requestId: 'req-40' } });
  const link1 = chainBorrowEvidence(null, first, { seq: 1, at: 1000 });
  assert.equal(link1.prevDigest, 'genesis');
  assert.match(link1.chainDigest, /^bc[0-9a-f]{8}$/);
  const link2 = chainBorrowEvidence(link1, second, { seq: 2, at: 2000 });
  assert.equal(link2.prevDigest, link1.chainDigest);
  const verified = verifyBorrowEvidenceChain([link1, link2]);
  assert.equal(verified.ok, true);
  assert.equal(verified.count, 2);
  assert.equal(verified.digest, link2.chainDigest);
  const tampered = verifyBorrowEvidenceChain([link1, { ...link2, tabId: 41 }]);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.index, 1);
  assert.equal(verifyBorrowEvidenceChain([]).ok, true);
  assert.equal(chainBorrowEvidence(null, null), null);
});

test('summarize/describe/format/links/sameCorrelation：紧凑、文本、轻量接线', () => {
  const certificate = buildBorrowEvidence({
    tabId: 42,
    journey: sealedJourney(sampleEntries()),
    gate: { status: 'confirmed', requestId: 'req-42' },
    controller: 'idle',
    leases: [],
  });
  const summary = summarizeBorrowEvidence(certificate);
  assert.equal(summary.version, BORROW_EVIDENCE_VERSION);
  assert.equal(summary.digest, certificate.digest);
  assert.equal(summary.tabId, 42);
  assert.equal(summary.journey.state, 'returned');
  assert.equal(summary.timeline >= 4, true);
  assert.ok(JSON.stringify(summary).length < 700);
  assert.equal(summarizeBorrowEvidence(null), null);

  const described = describeBorrowEvidence(certificate);
  assert.match(described, /^borrow-evidence=bk-/);
  assert.match(described, /journey=returned/);
  assert.equal(describeBorrowEvidence(null), 'borrow-evidence: 无证书');
  const lines = formatBorrowEvidence(certificate, { maxLines: 5 });
  assert.equal(lines.length <= 5, true);
  assert.match(lines[0], /borrow-evidence/);
  assert.deepEqual(formatBorrowEvidence(null), ['borrow-evidence: 无证书']);

  const links = borrowEvidenceLinks({
    tabId: 43,
    status: { status: 'pending', requestId: 'req-43' },
    journey: { state: 'requested', decision: null, requestId: 'req-43' },
    controller: 'handoff',
    leases: [],
    at: 1000,
  });
  assert.equal(links.ok, true, 'gate pending 与 journey requested 一致，无异常');
  assert.match(links.correlationKey, /^bk-/);
  assert.equal(links.controller.state, 'handoff');
  assert.equal(borrowEvidenceLinks({ tabId: null }), null);

  const left = { correlationKey: 'bk-aaaaaaaa' };
  assert.equal(sameBorrowCorrelation(left, { correlationKey: 'bk-aaaaaaaa' }).same, true);
  assert.equal(sameBorrowCorrelation(left, { correlationKey: 'bk-bbbbbbbb' }).reason, 'key-mismatch');
  assert.equal(sameBorrowCorrelation(left, null).reason, 'missing-key');
});

test('human-borrow-ledger 第二轮封存字段：sourceDigest/kinds/sources 随 sealChain 产出且可校验', () => {
  const entries = sampleEntries();
  const sealed = sealChain(entries, { tabId: 44 });
  assert.equal(sealed.version, 1);
  assert.equal(sealed.chainVersion, CHAIN_SEAL_VERSION);
  assert.match(sealed.sourceDigest, /^[0-9a-f]{8}$/);
  assert.equal(sealed.kinds.state, 3);
  assert.equal(sealed.kinds['return.complete'], 1);
  assert.deepEqual(sealed.sources.decisions, ['allow']);
  assert.deepEqual(sealed.sources.surfaces, ['modal']);
  assert.equal(sealed.count, 4);
  assert.equal(verifyChain(sealed).ok, true);
  assert.equal(verifyChain(sealed).sourcesOk, true);

  const summary = summarizeChainSources(entries);
  assert.equal(summary.sourceDigest, sealed.sourceDigest);
  assert.equal(summary.entries, 4);

  const replacedSource = { ...sealed, sourceDigest: 'deadbeef' };
  const replacedCheck = verifyChain(replacedSource);
  assert.equal(replacedCheck.ok, false);
  assert.equal(replacedCheck.code, 'JOURNEY_EVIDENCE_TAMPERED');
  assert.equal(replacedCheck.sourcesOk, false);

  // 旧证书（没有 sourceDigest 字段）行为完全不变。
  const legacy = { ...sealed };
  delete legacy.sourceDigest;
  delete legacy.kinds;
  delete legacy.sources;
  delete legacy.chainVersion;
  assert.equal(verifyChain(legacy).ok, true);
});

test('真实接线：borrowGate.snapshot() 附带 evidenceLinks（旅程/闸门/controller 对账）', () => {
  const tabId = 601;
  try {
    assert.equal(borrowGate.request(tabId, { requestId: 'bk-601', timeoutMs: 60_000, title: '结算页' }).ok, true);
    const snapshot = borrowGate.snapshot(tabId);
    assert.equal(snapshot.status.status, 'pending');
    assert.ok(snapshot.evidenceLinks, 'snapshot 应附带多来源证据摘要');
    assert.match(snapshot.evidenceLinks.correlationKey, /^bk-/);
    assert.match(snapshot.evidenceLinks.digest, /^[0-9a-f]{8}$/);
    assert.equal(snapshot.evidenceLinks.journeyState, 'requested');
    assert.equal(snapshot.evidenceLinks.controller.state, 'handoff');
    assert.equal(snapshot.evidenceLinks.leases.count, 0);
    assert.equal(typeof snapshot.evidenceLinks.sources, 'object');

    // 真实旅程封存链 → 证书可校验（controller 在允许后是 borrowed）。
    assert.equal(borrowGate.resolve('bk-601', { decision: 'allow', allow: true }).allowed, true);
    const afterAllow = borrowGate.snapshot(tabId);
    assert.equal(afterAllow.status.status, 'confirmed');
    assert.equal(afterAllow.evidenceLinks.controller.state, 'borrowed');
    assert.equal(afterAllow.evidenceLinks.journeyState, 'confirmed');

    const journeyEvidenceValue = borrowJourneys.evidence(tabId);
    assert.equal(verifyChain(journeyEvidenceValue).ok, true);
    assert.match(journeyEvidenceValue.sourceDigest, /^[0-9a-f]{8}$/);
    const certificate = buildBorrowEvidence({
      tabId,
      journey: journeyEvidenceValue,
      gate: afterAllow.status,
      controller: controllerState.get(tabId),
      leases: cooperationCoordinator.snapshot(tabId).leases,
    });
    assert.equal(certificate.journey.chainVerified, true);
    assert.equal(verifyBorrowEvidence(certificate).digestOk, true);
  } finally {
    cleanup(tabId);
  }
  assert.equal(borrowGate.snapshot(601).evidenceLinks === undefined, true, '清理后不再有证据字段');
});

test('真实接线（端到端）：request → deny/timeout/cancel 的旅程证据仍可相关（异常分类）', () => {
  const tabId = 602;
  try {
    borrowGate.request(tabId, { requestId: 'bk-602', timeoutMs: 60_000 });
    borrowGate.resolve('bk-602', { decision: 'deny', allow: false });
    const snapshot = borrowGate.snapshot(tabId);
    assert.equal(snapshot.status.status, 'denied');
    assert.equal(snapshot.evidenceLinks.journeyState, 'denied');
    assert.equal(snapshot.evidenceLinks.ok, true, 'deny 终态与闸门一致，无异常');

    const certificate = buildBorrowEvidence({
      tabId,
      journey: borrowJourneys.evidence(tabId),
      gate: snapshot.status,
      controller: controllerState.get(tabId),
      leases: [],
    });
    assert.equal(certificate.timeline.length >= 2, true);
    assert.equal(verifyBorrowEvidence(certificate).ok, true);
  } finally {
    cleanup(tabId);
  }
});

test('独立 human-gate 证据链可直接被借用证据证书引用（人机冲突与借用决策同链）', () => {
  let clock = 700_000;
  const gate = createHumanGate({ now: () => clock, activeMs: 500, coolingMs: 100 });
  gate.noteHuman(45, { at: clock, kind: 'input', frameId: 0 });
  const chainEvidence = gate.chainEvidence(45);
  const certificate = buildBorrowEvidence({
    tabId: 45,
    journey: { state: 'confirmed', decision: 'allow', requestId: 'req-45' },
    human: chainEvidence.chain,
    at: clock,
  });
  assert.equal(certificate.human.present, true);
  assert.equal(certificate.human.chainVerified, true);
  assert.equal(certificate.human.count, chainEvidence.chain.count);
  assert.equal(certificate.human.chainDigest, chainEvidence.chain.digest);
  const summary = summarizeBorrowEvidence(certificate);
  assert.equal(summary.human.count, chainEvidence.chain.count);
  gate.reset();
});

test('borrowEvidenceDiff：revision 来源变化可见；formatted 文本有上限', () => {
  const base = buildBorrowEvidence({ tabId: 46, journey: { state: 'returned', decision: 'allow', requestId: 'req-46' }, revision: { before: { revision: 1 }, after: { revision: 2 } } });
  const changed = buildBorrowEvidence({ tabId: 46, journey: { state: 'returned', decision: 'allow', requestId: 'req-46' }, revision: { before: { revision: 1 }, after: { revision: 5 } } });
  const diff = borrowEvidenceDiff(base, changed);
  assert.equal(diff.sources.some((item) => item.source === BORROW_EVIDENCE_SOURCES.REVISION), true);
  assert.equal(diff.stats.changedSources >= 1, true);
  assert.equal(diff.correlation.same, true);

  const many = buildBorrowEvidence({
    tabId: 47,
    journey: { state: 'returned', decision: 'deny', requestId: 'req-47' },
    gate: { status: 'confirmed', requestId: 'req-47' },
    controller: 'borrowed',
    leases: [{ leaseId: 'l1', kind: 'native-input', startedAt: 1000, active: true }],
    human: { state: 'human-active', active: true, lastAt: 1000, chain: { digest: 'deadbeef' } },
  });
  assert.equal(many.anomalies.length >= 2, true);
  const lines = formatBorrowEvidence(many, { maxLines: 3 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /anomalies=/);
});

test('chainBorrowEvidence：链长度上限与空链校验；human 单独被篡改也会报 CHAIN_TAMPERED', () => {
  const links = [];
  let previous = null;
  for (let index = 0; index < BORROW_EVIDENCE_LIMITS_CHAIN + 6; index += 1) {
    const certificate = buildBorrowEvidence({ tabId: 48 + index, journey: { state: 'confirmed', decision: 'allow', requestId: 'req-' + index } });
    const link = chainBorrowEvidence(previous, certificate, { seq: index + 1, at: 1000 + index });
    links.push(link);
    previous = link;
  }
  assert.equal(links.length, BORROW_EVIDENCE_LIMITS_CHAIN + 6);
  assert.equal(verifyBorrowEvidenceChain(links).ok, true);

  const humanOnly = buildBorrowEvidence({
    tabId: 49,
    human: {
      version: 1,
      sealed: true,
      count: 1,
      firstAt: 1000,
      lastAt: 1000,
      digest: 'deadbeef',
      entries: [humanSignalEntry(null, normalizeHumanChainSignal({ at: 1000, kind: 'input', source: 'human-state', count: 1 }, { who: 'human', basis: 'human-state' }))],
    },
  });
  assert.equal(humanOnly.journey.present, false);
  assert.equal(humanOnly.human.present, true);
  assert.equal(humanOnly.anomalies.some((item) => item.code === BORROW_EVIDENCE_CODES.CHAIN_TAMPERED), true);
});

const BORROW_EVIDENCE_LIMITS_CHAIN = 16;
