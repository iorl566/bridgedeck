// tests/unit/video-transcode-budget.test.mjs
// 第十一批-E：视频转码成本模型与预算（lib/video-transcode-budget.js）。
// 覆盖：成本估算（分辨率缩放/编码器系数/码率）、档位选择、转码决策（skip/transcode/downgrade/reject）、
//       编码器回退与预算内选型、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSCODE_ACTIONS,
  TRANSCODE_BUDGET_VERSION,
  TRANSCODE_CODECS,
  TRANSCODE_CODES,
  TRANSCODE_DEFAULTS,
  chooseQualityLadder,
  codecFallbackOrder,
  describeTranscode,
  estimateTranscodeCost,
  pickCodecWithinBudget,
  planVideoTranscode,
  resolveLadder,
  transcodeBudgetWire,
} from '../../extension/src/lib/video-transcode-budget.js';

test('常量：版本/动作/编码器/默认值形状稳定', () => {
  assert.equal(TRANSCODE_BUDGET_VERSION, 1);
  assert.deepEqual([...TRANSCODE_ACTIONS], ['skip', 'transcode', 'downgrade', 'reject']);
  assert.deepEqual([...TRANSCODE_CODECS], ['h264', 'vp9', 'av1']);
  assert.ok(TRANSCODE_DEFAULTS.ladder.length >= 4);
  assert.ok(TRANSCODE_DEFAULTS.codecFactors.av1 > TRANSCODE_DEFAULTS.codecFactors.h264);
  assert.match(TRANSCODE_CODES.SKIP, /^video\.transcode\./);
});

test('estimateTranscodeCost：像素=帧数×分辨率、编码器越新越慢、缩放生效', () => {
  const base = estimateTranscodeCost({ width: 1000, height: 500, fps: 10, durationMs: 1000, codec: 'h264' });
  assert.equal(base.frameCount, 10);
  assert.equal(base.pixels, 10 * 1000 * 500);
  assert.equal(base.seconds, 1);
  assert.ok(base.estimateMs > 0);
  assert.ok(base.estimateBytes > 0);
  const av1 = estimateTranscodeCost({ width: 1000, height: 500, fps: 10, durationMs: 1000, codec: 'av1' });
  assert.ok(av1.estimateMs > base.estimateMs);
  const half = estimateTranscodeCost({ width: 1000, height: 500, fps: 10, durationMs: 1000, scale: 0.5 });
  assert.equal(half.width, 500);
  assert.equal(half.height, 250);
  assert.equal(half.pixels, 10 * 500 * 250);
  const empty = estimateTranscodeCost({});
  assert.equal(empty.frameCount, 0);
  assert.equal(empty.estimateBytes, 0);
});

test('resolveLadder/chooseQualityLadder：预算够选原分辨率、不够逐档下探、全不够返回 null', () => {
  const ladder = resolveLadder({});
  assert.equal(ladder[0].name, 'source');
  assert.equal(ladder[0].scale, 1);
  const custom = resolveLadder({ ladder: [{ name: 'x', scale: 2, bitrateFactor: 1 }, { name: 'bad' }] });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].scale, 2);

  const loose = chooseQualityLadder({
    width: 640,
    height: 360,
    fps: 30,
    durationMs: 1000,
    bitrate: 2_000_000,
    maxTotalPixels: 10_000_000,
    maxDurationMs: 60_000,
  });
  assert.equal(loose.rung.name, 'source');
  assert.equal(loose.fitting.length >= 1, true);

  const tight = chooseQualityLadder({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10_000,
    bitrate: 8_000_000,
    maxTotalPixels: 40_000_000,
    maxDurationMs: 60_000,
    ladder: [
      { name: 'source', scale: 1, bitrateFactor: 1 },
      { name: 'tiny', scale: 0.25, bitrateFactor: 0.2 },
    ],
  });
  assert.notEqual(tight.rung, null);
  assert.ok(tight.rung.scale < 1);

  const impossible = chooseQualityLadder({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10_000,
    maxTotalPixels: 1000,
    maxDurationMs: 10,
  });
  assert.equal(impossible.rung, null);
  assert.deepEqual(impossible.fitting, []);
  assert.ok(impossible.attempts >= 4);
});

test('planVideoTranscode：不需转码 → skip', () => {
  const plan = planVideoTranscode({ width: 800, height: 600, durationMs: 5000, needTranscode: false });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.ok, true);
  assert.equal(plan.code, TRANSCODE_CODES.SKIP);
  assert.equal(plan.cost, null);
  assert.match(describeTranscode(plan), /skip/);
});

test('planVideoTranscode：预算内原分辨率 → transcode；紧预算 → downgrade', () => {
  const transcode = planVideoTranscode({
    width: 640,
    height: 360,
    fps: 30,
    durationMs: 1000,
    sourceBytes: 300_000,
    maxTotalPixels: 20_000_000,
    maxDurationMs: 60_000,
  });
  assert.equal(transcode.action, 'transcode');
  assert.equal(transcode.ok, true);
  assert.equal(transcode.chosen.scale, 1);
  assert.ok(transcode.cost.estimateMs > 0);
  assert.ok(typeof transcode.savings.ratio === 'number');

  const downgrade = planVideoTranscode({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10_000,
    sourceBytes: 5_000_000,
    maxTotalPixels: 100 * 1024 * 1024,
    maxDurationMs: 60_000,
  });
  assert.equal(downgrade.action, 'downgrade');
  assert.equal(downgrade.ok, true);
  assert.ok(downgrade.chosen.scale < 1);
  assert.ok(downgrade.savings.bytes > 0);
  assert.equal(downgrade.fitting.length >= 1, true);
});

test('planVideoTranscode：最低档也放不下 → reject（不伪造成功）', () => {
  const reject = planVideoTranscode({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 60_000,
    maxTotalPixels: 1000,
    maxDurationMs: 1,
  });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.ok, false);
  assert.equal(reject.code, TRANSCODE_CODES.REJECT);
  assert.equal(reject.chosen, null);
  assert.match(describeTranscode(reject), /reject/);
});

test('codecFallbackOrder/pickCodecWithinBudget：首选编码器优先、预算不足回退', () => {
  assert.deepEqual(codecFallbackOrder('vp9'), ['vp9', 'h264', 'av1']);
  assert.deepEqual(codecFallbackOrder('unknown'), ['h264', 'vp9', 'av1']);
  const picked = pickCodecWithinBudget({ width: 640, height: 360, fps: 30, durationMs: 1000, prefer: 'av1' });
  assert.equal(picked.codec, 'av1');
  assert.equal(picked.fits, true);
  const fallback = pickCodecWithinBudget({
    width: 640,
    height: 360,
    fps: 30,
    durationMs: 1000,
    prefer: 'av1',
    maxTotalPixels: 0,
    maxDurationMs: 400,
  });
  assert.notEqual(fallback.codec, 'av1');
  assert.equal(fallback.fits, true);
  const none = pickCodecWithinBudget({ width: 100, height: 100, durationMs: 1000, maxTotalPixels: 1, maxDurationMs: 1 });
  assert.equal(none.fits, false);
  assert.equal(none.codec, null);
});

test('transcodeBudgetWire/describeTranscode：截断列表、文本含尺寸与节省', () => {
  const plan = planVideoTranscode({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10_000,
    sourceBytes: 5_000_000,
    maxTotalPixels: 100 * 1024 * 1024,
    maxDurationMs: 60_000,
  });
  const wire = transcodeBudgetWire(plan, { maxListed: 1 });
  assert.equal(wire.version, TRANSCODE_BUDGET_VERSION);
  assert.equal(wire.action, 'downgrade');
  assert.equal(wire.fitting.length, 1);
  assert.equal(wire.chosen.scale < 1, true);
  assert.match(wire.text, /视频转码/);
  assert.match(describeTranscode(plan), /1920x1080/);
  assert.equal(transcodeBudgetWire(null).action, 'skip');
  assert.match(describeTranscode(null), /无/);
});
