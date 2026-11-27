import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKPOINT_DEFAULTS,
  CHECKPOINT_VERSION,
  RESUME_ACTIONS,
  applyResumeSegments,
  checkpointDiff,
  checkpointDigest,
  checkpointFromManifest,
  createCheckpoint,
  describeResume,
  planResume,
  planResumeBudget,
  resumeProgress,
  resumeWire,
  validateCheckpoint,
} from '../../extension/src/lib/longshot-resume.js';

const NOW = 1_700_000_000_000;

function checkpointOf(overrides = {}) {
  return createCheckpoint({
    captureId: 'cap-1',
    total: 10,
    done: [0, 1, 2],
    dpr: 1.5,
    width: 1862,
    height: 11250,
    segments: [
      { index: 0, offset: 0, bytes: 100, hash: 'aa' },
      { index: 1, offset: 750, bytes: 200, hash: 'bb' },
      { index: 2, offset: 1500, bytes: 300, hash: 'cc' },
    ],
    budget: { maxTiles: 32, maxBytes: 10_000_000 },
    used: { tiles: 3, bytes: 600, elapsedMs: 1200 },
    state: 'capturing',
    now: NOW,
    ...overrides,
  });
}

test('createCheckpoint：结构/进度/预算证据齐全', () => {
  const checkpoint = checkpointOf();
  assert.equal(checkpoint.version, CHECKPOINT_VERSION);
  assert.equal(checkpoint.captureId, 'cap-1');
  assert.equal(checkpoint.total, 10);
  assert.deepEqual(checkpoint.done, [0, 1, 2]);
  assert.equal(checkpoint.dpr, 1.5);
  assert.equal(checkpoint.used.tiles, 3);
  assert.equal(checkpoint.used.bytes, 600);
  assert.equal(checkpoint.budget.maxTiles, 32);
  assert.equal(checkpoint.createdAt, new Date(NOW).toISOString());
  assert.throws(() => createCheckpoint({}), /captureId/);
});

test('createCheckpoint：done 缺省由 segments 推出，重复序号去重', () => {
  const checkpoint = createCheckpoint({
    captureId: 'x',
    total: 3,
    segments: [{ index: 0 }, { index: 1 }, { index: 1 }],
    now: NOW,
  });
  assert.deepEqual(checkpoint.done, [0, 1]);
  const dedup = createCheckpoint({ captureId: 'x', total: 5, done: [1, 1, 3], now: NOW });
  assert.deepEqual(dedup.done, [1, 3]);
});

test('checkpointFromManifest：从 manifest 反推断点', () => {
  const manifest = {
    captureId: 'cap-2',
    url: 'https://x',
    tabId: 7,
    total: 4,
    dpr: 2,
    width: 100,
    height: 400,
    sealed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    segments: [{ index: 0, offset: 0, bytes: 10, hash: 'aa' }, { index: 2, offset: 200, bytes: 20, hash: 'cc' }],
  };
  const checkpoint = checkpointFromManifest(manifest, { now: NOW });
  assert.equal(checkpoint.captureId, 'cap-2');
  assert.equal(checkpoint.total, 4);
  assert.deepEqual(checkpoint.done, [0, 2]);
  assert.equal(checkpoint.state, 'capturing');
  assert.equal(checkpoint.signature, 'manifest:partial');
  assert.equal(checkpointFromManifest(null), null);
  const sealed = checkpointFromManifest({ ...manifest, sealed: true }, {});
  assert.equal(sealed.state, 'sealed');
});

test('validateCheckpoint：合法/版本/越界/重复/坏时间', () => {
  const checkpoint = checkpointOf();
  assert.equal(validateCheckpoint(checkpoint).ok, true);
  assert.equal(validateCheckpoint(null).errors[0].code, 'not-object');
  assert.equal(validateCheckpoint({ ...checkpoint, version: 99 }).errors[0].code, 'version');
  const dup = validateCheckpoint({ ...checkpoint, done: [0, 0] });
  assert.ok(dup.errors.some((error) => error.code === 'done-dup'));
  const range = validateCheckpoint({ ...checkpoint, done: [0, 99] });
  assert.ok(range.errors.some((error) => error.code === 'done-range'));
  const badTime = validateCheckpoint({ ...checkpoint, createdAt: 'x' });
  assert.ok(badTime.errors.some((error) => error.code === 'createdAt'));
  assert.ok(validateCheckpoint({ ...checkpoint, dpr: 9 }).errors.some((error) => error.code === 'dpr'));
});

test('checkpointDigest：忽略时间字段，随内容变化', () => {
  const a = checkpointOf();
  const b = checkpointOf({ now: NOW + 60_000 });
  assert.equal(checkpointDigest(a), checkpointDigest(b));
  const changed = checkpointOf({ done: [0, 1] });
  assert.notEqual(checkpointDigest(a), checkpointDigest(changed));
  assert.equal(checkpointDigest(null), '');
  assert.equal(checkpointDigest(a).length, 16);
});

test('planResume：新鲜断点 + 已有段 → resume，只补缺段', () => {
  const plan = planResume({ checkpoint: checkpointOf(), available: [0, 1, 2], now: NOW + 1000 });
  assert.equal(plan.action, 'resume');
  assert.deepEqual(plan.done, [0, 1, 2]);
  assert.deepEqual(plan.pending, [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(plan.expired, false);
  assert.equal(plan.tiles.length, 7);
  assert.ok(plan.reasons.some((reason) => reason.includes('复用')));
  assert.match(describeResume(plan), /断点恢复 resume：已拍 3\/10，补 7 段/);
});

test('planResume：没有任何可用段 → continue（从头拍）', () => {
  const plan = planResume({ checkpoint: checkpointOf({ done: [] }), available: [], now: NOW + 1000 });
  assert.equal(plan.action, 'continue');
  assert.deepEqual(plan.done, []);
  assert.equal(plan.pending.length, 10);
});

test('planResume：全部已拍 → done（区分 sealed）', () => {
  const all = Array.from({ length: 10 }, (_, index) => index);
  assert.equal(planResume({ checkpoint: checkpointOf({ done: all }), available: all, now: NOW }).action, 'done');
  const sealed = planResume({
    checkpoint: checkpointOf({ done: all, state: 'sealed' }),
    available: all,
    now: NOW,
  });
  assert.equal(sealed.action, 'done');
  assert.ok(sealed.reasons[0].includes('封版'));
});

test('planResume：断点过期 → restart；页面签名变化 → restart', () => {
  const expired = planResume({
    checkpoint: checkpointOf(),
    available: [0, 1, 2],
    now: NOW + CHECKPOINT_DEFAULTS.maxAgeMs + 1000,
  });
  assert.equal(expired.action, 'restart');
  assert.equal(expired.expired, true);
  assert.ok(expired.reasons.some((reason) => reason.includes('过期')));
  const signature = planResume({
    checkpoint: checkpointOf({ signature: 'page:v1' }),
    available: [0, 1, 2],
    now: NOW + 1000,
    pageSignature: 'page:v2',
  });
  assert.equal(signature.action, 'restart');
  assert.ok(signature.reasons.some((reason) => reason.includes('签名')));
});

test('planResume：checkpoint 说拍过但盘上全缺 → restart（分片被清理）', () => {
  const plan = planResume({ checkpoint: checkpointOf(), available: [], now: NOW + 1000 });
  assert.equal(plan.action, 'restart');
  assert.ok(plan.reasons.some((reason) => reason.includes('全部缺失')));
  assert.deepEqual(plan.pending, Array.from({ length: 10 }, (_, index) => index));
});

test('planResume：续拍次数达上限 → skip（不无限续）', () => {
  const plan = planResume({
    checkpoint: checkpointOf({ attempts: CHECKPOINT_DEFAULTS.maxAttempts }),
    available: [0, 1, 2],
    now: NOW + 1000,
  });
  assert.equal(plan.action, 'skip');
  assert.ok(plan.reasons[0].includes('上限'));
});

test('planResume：没有 checkpoint/manifest → skip；total=0 → skip', () => {
  assert.equal(planResume({}).action, 'skip');
  assert.equal(planResume({ total: 0, checkpoint: checkpointOf({ total: 0 }) }).action, 'skip');
  assert.equal(planResume({ manifest: { total: 3, segments: [] } }).action, 'continue');
});

test('planResume：预算不足 → rewrite（带字节证据）', () => {
  const plan = planResume({
    checkpoint: checkpointOf({ budget: { maxTiles: 4, maxBytes: 200 } }),
    available: [0, 1, 2],
    now: NOW + 1000,
  });
  assert.equal(plan.action, 'rewrite');
  assert.equal(plan.budget.exhausted, true);
  assert.ok(plan.reasons.some((reason) => reason.includes('预算不足')));
});

test('planResumeBudget：已知/未知预算与剩余量', () => {
  const unknown = planResumeBudget({ pending: [1, 2, 3] });
  assert.equal(unknown.known, false);
  assert.equal(unknown.estimatedTiles, 3);
  const known = planResumeBudget({
    pending: [1, 2, 3],
    used: { tiles: 2, bytes: 500 },
    budget: { maxTiles: 10, maxBytes: 2000 },
    estimatedTileBytes: 100,
  });
  assert.equal(known.known, true);
  assert.equal(known.remainingTiles, 8);
  assert.equal(known.remainingBytes, 1500);
  assert.equal(known.estimatedBytes, 300);
  assert.equal(known.exhausted, false);
  const tight = planResumeBudget({ pending: [1], used: { tiles: 10 }, budget: { maxTiles: 10 } });
  assert.equal(tight.exhausted, true);
});

test('applyResumeSegments：幂等吸收（重复/越界只记证据）', () => {
  const checkpoint = checkpointOf({ done: [0] });
  const applied = applyResumeSegments(checkpoint, [
    { index: 1, bytes: 10, hash: 'x' },
    { index: 1, bytes: 10, hash: 'x' },
    { index: 0, bytes: 10, hash: 'y' },
    { index: 99, bytes: 10, hash: 'z' },
  ], { now: NOW + 10 });
  assert.deepEqual(applied.accepted, [1]);
  assert.deepEqual(applied.duplicates, [1, 0]);
  assert.deepEqual(applied.outOfRange, [99]);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.checkpoint.done, [0, 1]);
  assert.equal(applied.checkpoint.used.tiles, 2);
  const noChange = applyResumeSegments(checkpoint, [], { now: NOW });
  assert.equal(noChange.changed, false);
  assert.equal(noChange.checkpoint, checkpoint);
  assert.equal(applyResumeSegments(null, []).changed, false);
});

test('resumeProgress/resumeWire：进度与协议字段', () => {
  assert.deepEqual(resumeProgress(checkpointOf()), { done: 3, total: 10, ratio: 0.3, complete: false });
  assert.deepEqual(resumeProgress(null), { done: 0, total: 0, ratio: 0, complete: false });
  const plan = planResume({ checkpoint: checkpointOf(), available: [0, 1, 2], now: NOW + 1000 });
  const wire = resumeWire(plan);
  assert.equal(wire.action, 'resume');
  assert.equal(wire.pendingCount, 7);
  assert.ok(wire.reasons.length > 0);
  assert.equal(wire.budget.exhausted, false);
  assert.ok(RESUME_ACTIONS.includes(wire.action));
  assert.equal(resumeWire(null).action, 'skip');
});

test('checkpointDiff：两次断点之间的新增/移除', () => {
  const before = checkpointOf();
  const after = checkpointOf({ done: [0, 1, 3, 4] });
  const diff = checkpointDiff(before, after);
  assert.deepEqual(diff.added, [3, 4]);
  assert.deepEqual(diff.removed, [2]);
  assert.equal(diff.unchanged, 2);
  assert.deepEqual(checkpointDiff(null, null), { added: [], removed: [], unchanged: 0 });
});

test('默认常量与动作集合稳定', () => {
  assert.equal(CHECKPOINT_DEFAULTS.maxAgeMs, 30 * 60 * 1000);
  assert.deepEqual(RESUME_ACTIONS.slice(), ['done', 'continue', 'resume', 'rewrite', 'restart', 'skip']);
});
