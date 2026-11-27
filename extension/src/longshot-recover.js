// src/longshot-recover.js —— 从 IndexedDB tile 重建长截图（崩溃/关闭后恢复）。
//
// W2-A：恢复仍走“tile 画回画布”的旧语义（longshot.recover 的 wire 字段不变），
// 另外读 lib/longshot-store 的 manifest（index.json 等价物）做三件事：
//   1) 用 manifest 的 total/hash 判断完整性，hash 不一致的段进 refetch 证据；
//   2) 结果标记 recovered/sealed/manifest/recovery，回答“这是恢复的、原始采集是否封版”；
//   3) 未 sealed 的恢复在 lib/longshot-state 里登记 recovered 状态（失败登记 failed）。
//
// 第十批-D：在既有结果之上**只加字段**地接四块证据（原有 result.* 字段一个不改）：
//   * lib/longshot-shard   —— 分段索引（大 capture 的 shard 视图 + index.json 等价物摘要）；
//   * lib/longshot-resume  —— 断点：manifest → checkpoint → resume 决策（resume/restart/done）；
//   * lib/longshot-dpr     —— 分数 DPR 画布尺寸（面积超限时按上限裁剪，不直接 new 超大画布）；
//   * lib/longshot-degrade —— “若要重拍会降级到哪一档”的预算证据；
//   * lib/longshot-stitch  —— 恢复计划的覆盖分析（缺口/重叠，与 plan.gaps 互补）。
import { listLongshotTiles, getLongshotManifest } from './lib/longshot-store.js';
import { bridgeError } from './errors.js';
import { log } from './log.js';
import { longshotRuns, LONGSHOT_EVENTS } from './lib/longshot-state.js';
import { parseLongshotManifest, resumeLongshotManifest, describeManifest } from './lib/longshot-manifest.js';
import {
  planLongshotRecovery,
  applyRecoveryVerification,
  buildRecoveryResult,
  describeRecovery,
} from './lib/longshot-recovery.js';
import { describeShards, planShards, shardIndexWire, shardSignature } from './lib/longshot-shard.js';
import {
  applyResumeSegments,
  checkpointFromManifest,
  describeResume,
  planResume,
  resumeProgress,
  resumeWire,
} from './lib/longshot-resume.js';
import { describeDprPlan, planFractionalCanvas } from './lib/longshot-dpr.js';
import { describeLongshotDegrade, longshotDegradeWire, planLongshotDegrade } from './lib/longshot-degrade.js';
import { analyzePlacements, describeStitch, stitchWire } from './lib/longshot-stitch.js';

function base64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 恢复侧证据汇总：shard / checkpoint / resume / degrade / stitch / canvas。
 * 任何子分析失败只写 evidence.error，不影响恢复结果本身（既有恢复语义优先）。
 */
function recoveryEvidence(params) {
  const { manifest, tiles, plan, width, height, now } = params;
  const evidence = { shards: null, checkpoint: null, resume: null, degrade: null, stitch: null, canvas: null };
  try {
    if (manifest) {
      const shards = planShards(manifest, {});
      evidence.shards = {
        ok: shards.ok,
        count: shards.shards.length,
        signature: shardSignature(shards),
        index: shardIndexWire(shards),
        text: describeShards(shards),
      };
      const checkpoint = checkpointFromManifest(manifest, { now });
      const resumeDecision = planResume({
        checkpoint,
        manifest,
        available: tiles.map((tile) => ({ index: Number(tile.index) })),
        now,
      });
      const absorbed = applyResumeSegments(checkpoint, tiles.map((tile) => ({
        index: Number(tile.index),
        bytes: Number(tile.bytes) || 0,
        hash: tile.hash || '',
      })), { now });
      evidence.checkpoint = {
        checkpointDigest: resumeDecision.evidence.checkpointDigest,
        progress: resumeProgress(checkpoint),
      };
      evidence.resume = {
        ...resumeWire(resumeDecision),
        action: resumeDecision.action,
        applied: absorbed.accepted.slice(0, 16),
        duplicates: absorbed.duplicates.slice(0, 16),
        text: describeResume(resumeDecision),
      };
    }
    const dpr = manifest && Number(manifest.dpr) > 0 ? Number(manifest.dpr) : 1;
    const canvas = planFractionalCanvas({ deviceWidth: width, deviceHeight: height, dpr });
    evidence.canvas = {
      width: canvas.width,
      height: canvas.height,
      dpr,
      fractional: canvas.fractional,
      clamped: canvas.clamped,
      requestedPixels: canvas.requestedPixels,
      maxPixels: canvas.maxPixels,
    };
    if (canvas.clamped) log('长截图恢复画布超面积上限，裁剪到 ' + canvas.width + 'x' + canvas.height);
    const dprPlan = {
      dpr,
      fractional: canvas.fractional,
      deviceHeight: canvas.height,
      totalDeviceHeight: canvas.height,
      segments: [{
        index: 0,
        deviceY: 0,
        deviceHeight: canvas.height,
        cssY: 0,
        cssHeight: Math.round(canvas.height / dpr),
      }],
    };
    evidence.canvas.text = describeDprPlan(dprPlan);
    // “如果要重拍”：按 manifest 尺寸/DPR 走一遍预算降级阶梯，给调用方一个可解释的预估。
    const degrade = planLongshotDegrade({
      scrollWidth: manifest && manifest.width ? Math.round(Number(manifest.width) / dpr) : Math.round(width / dpr),
      scrollHeight: manifest && manifest.height ? Math.round(Number(manifest.height) / dpr) : Math.round(height / dpr),
      dpr,
      tileSize: 512,
    });
    evidence.degrade = { ...longshotDegradeWire(degrade), text: describeLongshotDegrade(degrade) };
    // 拼接覆盖：恢复计划里的段 → drawY/height → 缺口/重叠证据（与 plan.gaps 互补）。
    const placementFrames = (plan && Array.isArray(plan.segments) ? plan.segments : []).map((segment) => ({
      drawY: Number(segment.drawY != null ? segment.drawY : segment.offset) || 0,
      bitmapHeight: Number(segment.height) || 1,
    }));
    const coverage = analyzePlacements(placementFrames, { width, totalHeight: height });
    evidence.stitch = { ...stitchWire(coverage), text: describeStitch(coverage) };
  } catch (error) {
    evidence.error = String((error && error.message) || error);
  }
  return evidence;
}

export async function recoverLongshot(params = {}) {
  const captureId = String(params.longshotId || params.captureId || '');
  if (!captureId) throw bridgeError('E_BAD_ARG', '需要 longshotId');
  const [tiles, manifestRaw] = await Promise.all([
    listLongshotTiles(captureId),
    getLongshotManifest(captureId).catch(() => null),
  ]);
  const parsed = parseLongshotManifest(manifestRaw);
  const manifest = parsed.ok ? parsed.manifest : null;
  if (manifestRaw && !parsed.ok) {
    log('长截图 manifest 校验失败（按无索引恢复）：' + (parsed.errors[0] || {}).code);
  }
  if (manifest) log(describeManifest(manifest));
  const sealedManifest = Boolean(manifest && manifest.sealed === true);
  // 只有“未封版”的 capture 才走 recovered 状态；已封版的恢复只是重建输出，不算崩溃恢复。
  if (!sealedManifest) {
    const begin = longshotRuns.transition(captureId, LONGSHOT_EVENTS.RECOVER_BEGIN, {
      tiles: tiles.length,
      manifestSealed: false,
      url: manifest && manifest.url ? manifest.url : '',
      dpr: manifest && manifest.dpr,
    });
    if (!begin.ok) log('长截图恢复登记被拒绝（' + begin.code + '）：' + begin.error);
  }
  try {
    if (!tiles.length) throw bridgeError('E_NOT_FOUND', '没有可恢复的长截图分块：' + captureId);
    let plan = planLongshotRecovery({ manifest, tiles });
    if (!plan.ok) throw bridgeError('E_INTERNAL', plan.error || '分块规划失败');
    const verified = applyRecoveryVerification(plan, { manifest, tiles });
    plan = verified.plan;
    // manifest ↔ 磁盘分片的断点恢复计划（哪些段可复用、哪些必须重取/缺失、是否过期）。
    const resume = manifest
      ? resumeLongshotManifest(manifest, {
        available: tiles.map((tile) => ({ index: Number(tile.index), bytes: Number(tile.bytes) || 0, hash: tile.hash || '' })),
      })
      : null;
    log(describeRecovery(plan));
    let width = plan.width;
    let height = plan.height;
    if (!(width > 0 && height > 0)) throw bridgeError('E_INTERNAL', '分块尺寸无效');
    // 第十批-D：分数 DPR 画布规划（面积超上限时裁剪，默认尺寸与原路径一致）。
    const dpr = manifest && Number(manifest.dpr) > 0 ? Number(manifest.dpr) : 1;
    const canvasPlan = planFractionalCanvas({ deviceWidth: width, deviceHeight: height, dpr });
    if (canvasPlan.clamped) {
      log('长截图恢复画布 ' + width + 'x' + height + ' 超过面积上限，裁剪到 ' + canvasPlan.width + 'x' + canvasPlan.height);
      width = canvasPlan.width;
      height = canvasPlan.height;
    }
    const tileByIndex = new Map();
    for (const tile of tiles) tileByIndex.set(Number(tile.index), tile);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    const bitmaps = [];
    try {
      for (const segment of plan.segments) {
        const tile = tileByIndex.get(segment.index);
        if (!tile || !tile.blob) continue;
        const bitmap = await createImageBitmap(tile.blob);
        bitmaps.push(bitmap);
        context.drawImage(bitmap, Number(tile.x) || 0, Number(tile.drawY) || 0);
      }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dataUrl = 'data:image/png;base64,' + base64(bytes);
      const result = buildRecoveryResult({
        captureId,
        plan,
        width,
        height,
        bytes: bytes.byteLength,
        dataUrl,
        gaps: plan.gaps,
      });
      result.recovery = result.recovery || {};
      result.recovery.resume = resume
        ? { action: resume.action, resumable: resume.resumable, complete: resume.complete, missing: resume.missing, refetch: resume.refetch, expired: resume.expired }
        : null;
      // 第十批-D：新增证据（既有字段不动）。子分析失败只落到 evidence_error，不影响恢复结果。
      const evidence = recoveryEvidence({ manifest, tiles, plan, width, height, now: Date.now() });
      result.recovery.shards = evidence.shards
        ? {
          count: evidence.shards.count,
          ok: evidence.shards.ok,
          signature: evidence.shards.signature,
          index: evidence.shards.index,
          text: evidence.shards.text,
        }
        : null;
      result.recovery.checkpoint = evidence.checkpoint;
      result.recovery.resume_decision = evidence.resume;
      result.recovery.canvas = evidence.canvas;
      result.recovery.degrade = evidence.degrade;
      result.recovery.stitch = evidence.stitch;
      if (evidence.error) result.recovery.evidence_error = evidence.error;
      result.canvas = {
        width: canvasPlan.width,
        height: canvasPlan.height,
        clamped: canvasPlan.clamped,
        dpr: canvasPlan.dpr,
      };
      result.manifest_parse = { ok: parsed.ok, errors: parsed.errors };
      result.state = longshotRuns.evidence(captureId);
      return result;
    } finally {
      for (const bitmap of bitmaps) bitmap.close();
    }
  } catch (error) {
    if (!sealedManifest) {
      longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, { reason: (error && error.message) || String(error) });
    }
    throw error;
  }
}
