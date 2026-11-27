// tests/unit/replay-boundary-plan.test.mjs —— 边界分段（epoch）与还原规划。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../extension/src/lib/replay-boundary-plan.js';

function step(index, overrides = {}) {
  const { doc = 'doc-1', frame = 0, revision = 1, url = 'https://a.test/', ...rest } = overrides;
  return {
    index,
    ref: 'r' + index,
    kind: 'action',
    method: 'click',
    params: { selector: '#x' + index },
    evidence: { seq: index + 1, index, frameId: frame, documentId: doc, revision, url, actor: 'human', at: 1_700_000_000_000 + index * 100 },
    ...rest,
  };
}

function navigate(index, doc, url, overrides = {}) {
  return step(index, {
    doc,
    url,
    revision: 0,
    kind: 'branch',
    method: 'navigate',
    branch: { boundary: 'document', source: 'navigation', url },
    ...overrides,
  });
}

const current = { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' };

test('boundaryKindOfStep / isNavigationStep', () => {
  assert.equal(P.boundaryKindOfStep({ kind: 'action', method: 'click' }), 'step');
  assert.equal(P.boundaryKindOfStep({ kind: 'branch', method: 'navigate' }), 'document');
  assert.equal(P.boundaryKindOfStep({ kind: 'branch', branch: { boundary: 'tab-switch' } }), 'tab-switch');
  assert.equal(P.isNavigationStep({ kind: 'branch', method: 'navigate' }), true);
  assert.equal(P.isNavigationStep({ kind: 'action', method: 'navigate' }), false);
  assert.equal(P.boundaryKindOfStep(null), 'step');
});

test('boundaryEpochs：按文档/帧/tab 切换切 epoch，revision/URL 软变化不切', () => {
  const steps = [
    step(0),
    step(1, { revision: 2 }),
    navigate(2, 'doc-2', 'https://a.test/next'),
    step(3, { doc: 'doc-2', revision: 1, url: 'https://a.test/next' }),
    step(4, { doc: 'doc-2', frame: 3, revision: 0, url: 'https://a.test/next' }),
    step(5, { doc: 'doc-2', frame: 3, revision: 1, url: 'https://a.test/other' }),
  ];
  const result = P.boundaryEpochs(steps);
  assert.equal(result.epochs.length, 3);
  assert.deepEqual(result.epochs.map((epoch) => [epoch.startIndex, epoch.endIndex, epoch.boundaryKind]), [
    [0, 1, 'initial'],
    [2, 3, 'document'],
    [4, 5, 'frame'],
  ]);
  // revision/URL 变化记为软变化。
  assert.equal(result.epochs[0].revisions.length, 2);
  assert.equal(result.epochs[2].urlChanges.length, 1);
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['document', 'frame']);
  assert.equal(result.transitions[0].canNavigate, true);
  assert.equal(result.summary.epochs, 3);
  assert.equal(result.summary.documents, 2);
  assert.equal(result.summary.navigations, 1);
  assert.equal(typeof result.fingerprint, 'string');
  assert.equal(P.boundaryFingerprint(result.epochs), result.fingerprint);
});

test('boundaryEpochs：tab 切换切 epoch，缺 URL 的换文档记 issue', () => {
  const steps = [
    step(0),
    step(1, { branch: { boundary: 'tab-switch', tabId: 9 }, kind: 'branch', method: '' }),
    navigate(2, 'doc-2', ''),
  ];
  const result = P.boundaryEpochs(steps);
  assert.equal(result.epochs.length, 3);
  assert.equal(result.epochs[1].boundaryKind, 'tab-switch');
  assert.equal(result.epochs[1].tabId, 9);
  assert.equal(result.transitions[0].kind, 'tab');
  assert.equal(result.issues.some((issue) => issue.code === 'BOUNDARY_URL_MISSING'), true);
});

test('boundaryEpochs：截断与 revision 回退自检', () => {
  const steps = [step(0), step(1, { revision: 5 }), step(2, { revision: 2 })];
  const result = P.boundaryEpochs(steps);
  assert.equal(result.issues.some((issue) => issue.code === 'BOUNDARY_REVISION_REGRESSION'), true);
  const truncated = P.boundaryEpochs(steps, { maxSteps: 2 });
  assert.equal(truncated.epochs.reduce((sum, epoch) => sum + epoch.count, 0) <= 2, true);
  assert.equal(truncated.issues.some((issue) => issue.code === 'BOUNDARY_STEPS_TRUNCATED'), true);
});

test('epochOfIndex / epochKey / boundaryFingerprint', () => {
  const result = P.boundaryEpochs([step(0), step(1), navigate(2, 'doc-2', 'https://a.test/next')]);
  assert.equal(P.epochOfIndex(result, 0).epoch, 0);
  assert.equal(P.epochOfIndex(result, 2).epoch, 1);
  assert.equal(P.epochOfIndex(result, 9), null);
  assert.equal(P.epochOfIndex(null, 0), null);
  assert.equal(P.epochKey(result.epochs[0]), 'doc-1|f0');
  assert.equal(P.epochKey(null), '-');
  const reordered = P.boundaryEpochs([step(0), step(1), navigate(2, 'doc-2', 'https://a.test/next')]);
  assert.equal(reordered.fingerprint, result.fingerprint);
});

test('planBoundaryRestoration：当前身份一致 → continue，revision 变化 → re-resolve', () => {
  const steps = [step(0), step(1, { revision: 2 })];
  const plan = P.planBoundaryRestoration(steps, { current });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 2);
  assert.equal(plan.plans[0].action, 'continue');
  assert.equal(plan.plans[0].firstOfEpoch, true);
  assert.equal(plan.plans[1].action, 'continue');
  assert.equal(plan.plans[1].rebind, true);
  assert.equal(plan.summary.reregisters >= 1, true);
  assert.equal(plan.resumeFromIndex, 0);
});

test('planBoundaryRestoration：换文档 → navigate；缺 URL → abort + blocker', () => {
  const steps = [step(0), navigate(1, 'doc-2', 'https://a.test/next')];
  const plan = P.planBoundaryRestoration(steps, { current });
  assert.equal(plan.plans[1].action, 'navigate');
  assert.equal(plan.plans[1].url, 'https://a.test/next');
  assert.equal(plan.summary.navigations, 1);
  assert.equal(plan.ok, true);

  const noUrl = P.planBoundaryRestoration([step(0), navigate(1, 'doc-2', '')], { current });
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.plans[1].action, 'abort');
  assert.equal(noUrl.blockers[0].code, 'BOUNDARY_URL_MISSING');
  assert.match(noUrl.blockers[0].message, /URL/);
});

test('planBoundaryRestoration：帧切换与帧缺失', () => {
  const steps = [step(0), step(1, { frame: 3, revision: 0 })];
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://a.test/' },
    { frameId: 3, parentFrameId: 0, url: 'https://a.test/frame' },
  ];
  const okPlan = P.planBoundaryRestoration(steps, { current, frames });
  assert.equal(okPlan.plans[1].action, 'frame-switch');
  assert.equal(okPlan.plans[1].frameId, 3);
  assert.equal(okPlan.ok, true);

  const missing = P.planBoundaryRestoration(steps, { current, frames: [{ frameId: 0, parentFrameId: -1, url: 'https://a.test/' }] });
  assert.equal(missing.plans[1].action, 'abort');
  assert.equal(missing.blockers[0].code, 'BOUNDARY_FRAME_UNAVAILABLE');
});

test('planBoundaryRestoration：tab 切换、禁用 tab 切换、缺 tabId', () => {
  const steps = [step(0), step(1, { kind: 'branch', method: '', branch: { boundary: 'tab-switch', tabId: 7 } })];
  const plan = P.planBoundaryRestoration(steps, { current });
  assert.equal(plan.plans[1].action, 'tab-switch');
  assert.equal(plan.plans[1].tabId, 7);

  const disabled = P.planBoundaryRestoration(steps, { current, allowTabSwitch: false });
  assert.equal(disabled.plans[1].action, 'abort');
  assert.equal(disabled.ok, false);

  const noTab = P.planBoundaryRestoration([step(0), step(1, { kind: 'branch', method: '', branch: { boundary: 'tab-switch' } })], { current });
  assert.equal(noTab.blockers[0].code, 'BOUNDARY_TAB_MISSING');
});

test('planBoundaryRestoration：当前身份未知 → check-document（strict 时阻断）', () => {
  const steps = [step(0)];
  const loose = P.planBoundaryRestoration(steps, {});
  assert.equal(loose.plans[0].action, 'check-document');
  assert.equal(loose.ok, true);
  assert.equal(loose.warnings.some((warning) => warning.code === 'BOUNDARY_CURRENT_UNKNOWN'), true);
  const strict = P.planBoundaryRestoration(steps, { strictCurrent: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.blockers[0].code, 'BOUNDARY_CURRENT_UNKNOWN');
});

test('matchBoundaryEpoch / resumeFromBoundary：从当前身份定位起点', () => {
  const steps = [step(0), navigate(1, 'doc-2', 'https://a.test/next'), step(2, { doc: 'doc-2', revision: 1, url: 'https://a.test/next' })];
  const regions = P.boundaryEpochs(steps);
  const matched = P.matchBoundaryEpoch(regions, { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://a.test/next' });
  assert.equal(matched.found, true);
  assert.equal(matched.epoch.startIndex, 1);

  const unknown = P.matchBoundaryEpoch(regions, { documentId: 'doc-9', frameId: 0, revision: 1 });
  assert.equal(unknown.found, false);
  assert.equal(unknown.index >= 0, true);

  const repairPlan = P.planBoundaryRestoration(steps, { current: { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://a.test/next' } });
  const resume = P.resumeFromBoundary(repairPlan, { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://a.test/next' });
  assert.equal(resume.ok, true);
  assert.equal(resume.fromIndex, 1);
  assert.equal(P.resumeFromBoundary(null, current).ok, false);
  assert.equal(P.matchBoundaryEpoch({ epochs: [] }, current).reason, 'no-epochs');
});

test('summarizeBoundaries / boundaryBlockerCodes', () => {
  const plan = P.planBoundaryRestoration([step(0), navigate(1, 'doc-2', '')], { current });
  const summary = P.summarizeBoundaries(plan);
  assert.equal(summary.version, 1);
  assert.equal(summary.epochs, 2);
  assert.equal(summary.blockers, 1);
  assert.deepEqual(P.boundaryBlockerCodes(plan), ['BOUNDARY_URL_MISSING']);
  const empty = P.summarizeBoundaries(null);
  assert.equal(empty.epochs, 0);
  assert.equal(empty.blockers, 0);
});

test('verifyBoundarySequence：连续覆盖/缺口/末尾', () => {
  const result = P.boundaryEpochs([step(0), step(1), navigate(2, 'doc-2', 'https://a.test/next')]);
  assert.equal(P.verifyBoundarySequence(result, 3).ok, true);
  const broken = { epochs: [{ epoch: 0, startIndex: 1, endIndex: 1, documentId: 'a' }], transitions: [] };
  assert.equal(P.verifyBoundarySequence(broken, 2).ok, false);
  assert.equal(P.verifyBoundarySequence({ epochs: [] }, 3).ok, false);
});
