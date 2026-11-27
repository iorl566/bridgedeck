// 长截图分块采集：设备像素分块、固定顶/底带重绘、stale 后的补拍与按 tile 重写。
//
// W2-A 深度补强（状态机/多段固定带/分片 manifest/断点恢复/预算）：
//   * 每次采集在 lib/longshot-state.js 里登记一条显式运行（idle→capturing→stitching→sealed /
//     stale / recovered / failed），返回值带 state 证据；
//   * 分段规划交给 lib/longshot-segments.js（段边界 + 重叠区 + 分数 DPR + 固定带只画首/末段）；
//   * 每段落盘后写 lib/longshot-manifest.js 的索引（{version,total,dpr,segments[],sealed,createdAt}），
//     并对已落盘分片做 hash 读回校验，校验失败的分片重取（refetch）；
//   * 像素/内存/并发预算交给 lib/longshot-budget.js，超限时降级 DPR 或显式截断，
//     结果带 {budget, used, degraded, reason}；
//   * 崩溃恢复沿用 longshot-recover.js 的语义（IndexedDB tile 重拼），manifest 只是新增证据。
import { send as cdpSend } from './debugger.js';
import { execPage } from './inject.js';
import { withTimeout } from './timeout.js';
import { bridgeError } from './errors.js';
import { log } from './log.js';
import { staleMetrics, planStaleRecovery } from './lib/capture-freshness.js';
import { persistLongshotCapture } from './capture-persist.js';
import {
  saveLongshotTile,
  saveLongshotManifest,
  listLongshotTiles,
  cleanupLongshotManifests,
} from './lib/longshot-store.js';
import { longshotRuns, LONGSHOT_EVENTS } from './lib/longshot-state.js';
import {
  estimateLongshotBudget,
  budgetReport,
  describeBudget,
  chooseTileConcurrency,
  estimateTileCount,
  mapWithConcurrency,
} from './lib/longshot-budget.js';
import {
  planFixedBands,
  planLongshotSegments,
  tileRectsForSegment,
  bandRedrawRect,
  validateSegmentPlan,
  segmentPlanWire,
  describeSegmentPlan,
} from './lib/longshot-segments.js';
import {
  buildLongshotManifest,
  appendSegment,
  sealManifest,
  hashLongshotBytes,
  manifestSummary,
} from './lib/longshot-manifest.js';

const CAPTURE_TILE_HEIGHT = 512;
const CAPTURE_TILE_WIDTH = 512;
const MAX_TILED_HEIGHT = 40000;
const MAX_TILED_WIDTH = 40000;
const MAX_TOTAL_TILED_HEIGHT = MAX_TILED_HEIGHT * 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取截图 Blob 失败'));
    reader.readAsDataURL(blob);
  });
}

function newLongshotId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* 忽略 */ }
  return 'longshot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 把固定顶/底带画进某个段画布：临时滚到页首/页尾截一张视口图，再裁出带高贴到段的顶/底，
 * 最后恢复原滚动位置。分段采集原来完全不重绘固定带，超大页会丢页眉/页脚。
 * @returns {Promise<number>} 实际画进去的设备像素带高（失败返回 0，不阻断截图）
 */
async function redrawSegmentBand(options) {
  const { tabId, metrics, edge, segment, context, width } = options;
  const rect = bandRedrawRect(segment, edge);
  if (!rect) return 0;
  const originalY = Number(metrics && metrics.scrollY) || 0;
  const scrollHeight = Number(metrics && metrics.scrollHeight) || 0;
  const innerHeight = Number(metrics && metrics.innerHeight) || 0;
  const bottomY = Math.max(0, Math.round(scrollHeight - innerHeight));
  try {
    await execPage(tabId, 'scroll-to-y', { y: edge === 'top' ? 0 : bottomY });
    await sleep(120);
    const view = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', { format: 'png' }), 15000, 'Page.captureScreenshot ' + edge + ' band');
    if (!view || typeof view.data !== 'string' || !view.data) return 0;
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + view.data)).blob());
    try {
      const band = Math.min(rect.height, bitmap.height, segment.drawHeight);
      if (band <= 0) return 0;
      if (edge === 'top') {
        context.drawImage(bitmap, 0, 0, bitmap.width, band, 0, 0, width, band);
      } else {
        context.drawImage(bitmap, 0, bitmap.height - band, bitmap.width, band, 0, segment.drawHeight - band, width, band);
      }
      return band;
    } finally {
      bitmap.close();
    }
  } catch (error) {
    log('固定带重绘失败（忽略）：' + ((error && error.message) || error));
    return 0;
  } finally {
    await execPage(tabId, 'scroll-to-y', { y: originalY }).catch(() => {});
  }
}

/**
 * 分段采集（超过单画布上限的超大页）：
 *   - 段规划来自 lib/longshot-segments（分数 DPR 下 CDP clip 用 CSS 坐标、按设备像素推进）；
 *   - 每段落盘成 PNG，写入 manifest（含 offset/bytes/hash/dpr），崩溃后可断点恢复；
 *   - 首段重绘固定顶带、末段重绘固定底带；
 *   - 结束前读回分片 hash 校验，不一致的分片重取一次（refetch），仍不一致则标记失败证据。
 */
async function captureSegments(tabId, tabUrl, budgetPlan, tileSize, options, captureId) {
  const scale = budgetPlan.dpr;
  const deviceWidth = budgetPlan.deviceWidth;
  const deviceHeight = budgetPlan.deviceHeight;
  const metrics = await execPage(tabId, 'page-metrics', {}).catch(() => null);
  const bands = planFixedBands({ metrics, dpr: scale, deviceHeight });
  const plan = planLongshotSegments({
    deviceWidth,
    deviceHeight,
    dpr: scale,
    fixedTop: bands.fixedTop,
    fixedBottom: bands.fixedBottom,
    overlap: Math.max(0, Math.round(Number(options.segmentOverlap) || 0)),
    maxSegmentHeight: budgetPlan.segmentHeight,
    minSegmentHeight: Math.min(budgetPlan.segmentHeight, CAPTURE_TILE_HEIGHT),
  });
  const validation = validateSegmentPlan(plan);
  if (!validation.ok) log('分段规划自检失败（按规划继续）：' + validation.errors.map((item) => item.code).join(','));
  log('长截图分段规划：' + describeSegmentPlan(plan));

  const tileConcurrency = chooseTileConcurrency({
    requested: options.tileConcurrency,
    budget: budgetPlan.budget,
    tiles: estimateTileCount({ deviceWidth, deviceHeight, tileSize }).tiles,
  }).concurrency;
  let manifest = buildLongshotManifest({
    captureId,
    tabId,
    url: tabUrl,
    dpr: scale,
    width: deviceWidth,
    height: deviceHeight,
    total: plan.totalSegments,
  });
  await saveLongshotManifest(manifest).catch((error) => log('长截图索引写入失败（忽略）：' + ((error && error.message) || error)));

  let tilesTotal = 0;
  let persistedSegments = 0;
  const segments = [];

  const renderSegment = async (segment) => {
    const canvas = new OffscreenCanvas(deviceWidth, segment.drawHeight);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, deviceWidth, segment.drawHeight);
    const rects = tileRectsForSegment(segment, tileSize);
    const hashes = await mapWithConcurrency(rects, tileConcurrency, async (rect) => {
      const result = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: rect.cssX, y: rect.cssY, width: rect.cssWidth, height: rect.cssHeight, scale },
      }), 15000, 'Page.captureScreenshot segment');
      if (!result || typeof result.data !== 'string' || !result.data) {
        throw bridgeError('E_INTERNAL', '分段截图没有返回数据（y=' + rect.deviceY + '）');
      }
      const blob = await (await fetch('data:image/png;base64,' + result.data)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const bitmap = await createImageBitmap(blob);
      try {
        // 分数 DPR 下 CDP 返回的像素可能 ±1：统一拉伸到目标 tile 尺寸，避免接缝/缺口。
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, rect.x, rect.y, rect.width, rect.height);
      } finally {
        bitmap.close();
      }
      return hashLongshotBytes(bytes);
    });
    let fixedTop = 0;
    let fixedBottom = 0;
    if (segment.fixedTop > 0) {
      fixedTop = await redrawSegmentBand({ tabId, metrics, edge: 'top', segment, context, width: deviceWidth });
    }
    if (segment.fixedBottom > 0) {
      fixedBottom = await redrawSegmentBand({ tabId, metrics, edge: 'bottom', segment, context, width: deviceWidth });
    }
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    return {
      tiles: hashes.length,
      fixedTop,
      fixedBottom,
      pngBlob,
      bytes: pngBytes.byteLength,
      hash: hashLongshotBytes(pngBytes),
    };
  };

  const persistSegment = async (segment, rendered) => {
    try {
      await saveLongshotTile(captureId, {
        index: segment.index,
        x: 0,
        y: segment.drawY,
        width: deviceWidth,
        height: segment.drawHeight,
        drawY: segment.drawY,
        hash: rendered.hash,
        blob: rendered.pngBlob,
      });
      persistedSegments += 1;
    } catch (error) {
      log('分段落盘失败（忽略，仍返回内存图）：' + ((error && error.message) || error));
    }
    manifest = appendSegment(manifest, {
      index: segment.index,
      offset: segment.drawY,
      bytes: rendered.bytes,
      hash: rendered.hash,
      width: deviceWidth,
      height: segment.drawHeight,
    });
    await saveLongshotManifest(manifest).catch(() => 0);
  };

  for (const segment of plan.segments) {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.CAPTURE_PROGRESS, {
      tiles: tilesTotal,
      segments: segments.length,
      totalSegments: plan.totalSegments,
    });
    const rendered = await renderSegment(segment);
    tilesTotal += rendered.tiles;
    const dataUrl = await blobToDataUrl(rendered.pngBlob);
    const wire = segmentPlanWire(segment);
    segments.push({
      ...wire,
      fixedTop: rendered.fixedTop,
      fixedBottom: rendered.fixedBottom,
      width: deviceWidth,
      dataUrl,
    });
    await persistSegment(segment, rendered);
    log('分段截图 ' + segments.length + '/' + plan.totalSegments + '：' + deviceWidth + 'x' + segment.drawHeight +
      '（offset ' + segment.drawY + '，dpr ' + scale + '，hash ' + rendered.hash.slice(0, 8) + '）');
  }

  // 读回校验：manifest hash ↔ IndexedDB 分片字节；不一致就重取该段（hash 校验失败重取）。
  // 落盘完全不可用（配额/隐私模式）时跳过读回，不把"没有分片可校验"当成损坏。
  let verification = { checked: 0, mismatched: 0, refetched: 0, hashVerified: true, skipped: persistedSegments === 0 };
  try {
    const stored = persistedSegments > 0 ? await listLongshotTiles(captureId) : [];
    if (stored.length) {
      const storedByIndex = new Map(stored.map((tile) => [Number(tile.index), tile]));
      let mismatched = 0;
      let refetched = 0;
      for (const segment of plan.segments) {
        const tile = storedByIndex.get(segment.index);
        const expected = manifest.segments.find((item) => item.index === segment.index);
        let actual = '';
        if (tile && tile.blob) {
          try {
            const bytes = new Uint8Array(await tile.blob.arrayBuffer());
            actual = hashLongshotBytes(bytes);
          } catch {
            actual = '';
          }
        }
        if (tile && tile.blob && expected && expected.hash && actual === expected.hash) continue;
        mismatched += 1;
        log('分片 hash 校验未通过（index=' + segment.index + '），重取该段');
        const rendered = await renderSegment(segment);
        await persistSegment(segment, rendered);
        const record = segments.find((item) => item.index === segment.index);
        if (record) {
          record.dataUrl = await blobToDataUrl(rendered.pngBlob);
          record.fixedTop = rendered.fixedTop;
          record.fixedBottom = rendered.fixedBottom;
        }
        refetched += 1;
      }
      verification = {
        checked: plan.segments.length,
        mismatched,
        refetched,
        hashVerified: mismatched === 0 || refetched === mismatched,
      };
    }
  } catch (error) {
    verification = { checked: 0, mismatched: 0, refetched: 0, hashVerified: false, error: (error && error.message) || String(error) };
    log('分片读回校验失败（标记未校验）：' + verification.error);
  }

  // 封版：分片数必须等于计划段数，且 hash 已校验通过（状态机 seal 闸门同口径）。
  longshotRuns.transition(captureId, LONGSHOT_EVENTS.STITCH_BEGIN, {
    tiles: tilesTotal,
    segments: segments.length,
    totalSegments: plan.totalSegments,
  });
  const sealedSegments = manifest.segments.length;
  let manifestSealed = false;
  if (sealedSegments === plan.totalSegments && verification.hashVerified !== false) {
    try {
      manifest = sealManifest(manifest, { hashVerified: true });
      await saveLongshotManifest(manifest).catch(() => 0);
      manifestSealed = manifest.sealed === true;
    } catch (error) {
      log('长截图 manifest 封版失败（忽略）：' + ((error && error.message) || error));
    }
  }
  if (manifestSealed) {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.SEAL, {
      totalSegments: plan.totalSegments,
      sealedSegments,
      hashVerified: true,
    });
  } else if (sealedSegments === plan.totalSegments && verification.hashVerified !== false) {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, {
      reason: 'manifest-seal-failed',
      totalSegments: plan.totalSegments,
      sealedSegments,
      hashVerified: verification.hashVerified,
    });
  } else if (sealedSegments === plan.totalSegments) {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, {
      reason: 'hash-mismatch',
      totalSegments: plan.totalSegments,
      sealedSegments,
      hashVerified: false,
    });
  } else {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, {
      reason: 'incomplete-segments',
      totalSegments: plan.totalSegments,
      sealedSegments,
      hashVerified: verification.hashVerified,
    });
  }

  await persistLongshotCapture({
    id: captureId,
    url: tabUrl || '',
    width: deviceWidth,
    height: deviceHeight,
    frames: segments.map((segment) => ({ dataUrl: segment.dataUrl, width: segment.width, height: segment.height, drawY: segment.y })),
  }).catch(() => 0);

  return {
    dataUrl: segments[0] ? segments[0].dataUrl : '',
    width: deviceWidth,
    height: deviceHeight,
    via: 'cdp',
    tiled: tilesTotal,
    tile_size: tileSize,
    full_page: true,
    dpr: scale,
    segmented: true,
    segment_count: segments.length,
    segments,
    longshot_id: captureId,
    fixedTop: bands.fixedTop,
    fixedFooter: bands.fixedBottom,
    fixedBands: bands.bands.length,
    manifest: manifestSummary(manifest),
    manifest_verified: { ...verification },
    plan: {
      totalSegments: plan.totalSegments,
      segmentHeight: plan.maxSegmentHeight,
      overlap: plan.overlap,
      fixedTop: bands.fixedTop,
      fixedBottom: bands.fixedBottom,
      dpr: plan.dpr,
      fractionalDpr: plan.fractional,
    },
  };
}

/**
 * 单画布分块采集（页面高度 ≤ MAX_TILED_HEIGHT）：原有 2D 分块 + 固定带重绘 + stale 补拍/重写。
 * 与 0.3.0 行为一致，只是把固定带计算换成 planFixedBands（同一公式），并写入 manifest/状态机。
 */
async function captureSingleTiled(tabId, tabUrl, width, height, scale, tileSize, options, attempt, maxStaleAttempts, longshotId) {
  let deviceWidth = Math.max(1, Math.min(Math.ceil(Number(width) * scale), MAX_TILED_WIDTH));
  let deviceHeight = Math.max(1, Math.min(Math.ceil(Number(height) * scale), MAX_TILED_HEIGHT));
  let canvas = new OffscreenCanvas(deviceWidth, deviceHeight);
  let context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, deviceWidth, deviceHeight);

  const tileHashes = new Map();
  const tileRecords = [];
  let tileSeq = 0;
  let tilesPersisted = 0;
  const persistTile = async (bitmap, tile) => {
    try {
      const off = new OffscreenCanvas(bitmap.width, bitmap.height);
      off.getContext('2d').drawImage(bitmap, 0, 0);
      const png = await off.convertToBlob({ type: 'image/png' });
      const pngBytes = new Uint8Array(await png.arrayBuffer());
      const hash = hashLongshotBytes(pngBytes);
      if (await saveLongshotTile(longshotId, { ...tile, index: tileSeq, hash, blob: png })) {
        tileRecords.push({
          index: tileSeq,
          offset: Math.max(0, Math.round(Number(tile.drawY) || 0)),
          bytes: pngBytes.byteLength,
          hash,
          width: Math.max(0, Math.round(Number(tile.width) || 0)),
          height: Math.max(0, Math.round(Number(tile.height) || 0)),
        });
        tilesPersisted += 1;
        tileSeq += 1;
      }
    } catch {
      // 磁盘分块是恢复增强，失败不阻断截图
    }
  };
  const hashBitmap = (bitmap) => {
    try {
      const sample = new OffscreenCanvas(24, 24);
      const sampleCtx = sample.getContext('2d');
      sampleCtx.drawImage(bitmap, 0, 0, 24, 24);
      const data = sampleCtx.getImageData(0, 0, 24, 24).data;
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash >>> 0;
    } catch {
      return 0;
    }
  };
  const drawTiles = async (ctx, targetWidth, targetHeight, fromY, tileOptions = {}) => {
    let count = 0;
    let rewritten = 0;
    for (let y = fromY; y < targetHeight; y += tileSize) {
      const tileHeight = Math.min(tileSize, targetHeight - y);
      for (let x = 0; x < targetWidth; x += tileSize) {
        const tileWidth = Math.min(tileSize, targetWidth - x);
        const result = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: x / scale, y: y / scale, width: tileWidth / scale, height: tileHeight / scale, scale },
        }), 15000, 'Page.captureScreenshot tile');
        if (!result || typeof result.data !== 'string' || !result.data) {
          throw bridgeError('E_INTERNAL', '分块截图没有返回数据（tile x=' + x + ' y=' + y + '）');
        }
        const blob = await (await fetch('data:image/png;base64,' + result.data)).blob();
        const bitmap = await createImageBitmap(blob);
        const key = x + ',' + y;
        const hash = hashBitmap(bitmap);
        const changed = tileHashes.get(key) !== hash;
        tileHashes.set(key, hash);
        if (tileOptions.onlyChanged === true && !changed) {
          bitmap.close();
          continue;
        }
        // 分数 DPR 下 CDP 返回的像素可能 ±1：统一拉伸到目标 tile 尺寸，避免接缝/缺口。
        ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, x, y, tileWidth, tileHeight);
        if (tileOptions.persist !== false) await persistTile(bitmap, { x, y, width: tileWidth, height: tileHeight, drawY: y });
        bitmap.close();
        count += 1;
        if (changed) rewritten += 1;
      }
    }
    return { count, rewritten };
  };

  const drawBands = async (ctx, targetWidth, targetHeight) => {
    let fixedTop = 0;
    let fixedFooter = 0;
    let measured = null;
    try {
      const metrics = await execPage(tabId, 'page-metrics', {});
      measured = metrics;
      const bandsPlan = planFixedBands({ metrics, dpr: scale, deviceHeight: targetHeight });
      const topDev = bandsPlan.fixedTop;
      const footerDev = bandsPlan.fixedBottom;
      if (topDev || footerDev) {
        const originalY = Number(metrics.scrollY) || 0;
        const bottomY = Math.max(0, Math.round(Number(metrics.scrollHeight || targetHeight) - Number(metrics.innerHeight || 0)));
        const drawBand = (bitmap, bandDev, atTop) => {
          const band = Math.min(bandDev, bitmap.height, targetHeight);
          if (band <= 0) return 0;
          if (atTop) ctx.drawImage(bitmap, 0, 0, bitmap.width, band, 0, 0, targetWidth, band);
          else ctx.drawImage(bitmap, 0, bitmap.height - band, bitmap.width, band, 0, targetHeight - band, targetWidth, band);
          return band;
        };
        try {
          if (topDev) {
            await execPage(tabId, 'scroll-to-y', { y: 0 });
            await sleep(120);
            const view = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', { format: 'png' }), 15000, 'Page.captureScreenshot header');
            if (view && typeof view.data === 'string' && view.data) {
              const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + view.data)).blob());
              fixedTop = drawBand(bitmap, topDev, true);
              bitmap.close();
            }
          }
          if (footerDev) {
            await execPage(tabId, 'scroll-to-y', { y: bottomY });
            await sleep(120);
            const view = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', { format: 'png' }), 15000, 'Page.captureScreenshot footer');
            if (view && typeof view.data === 'string' && view.data) {
              const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + view.data)).blob());
              fixedFooter = drawBand(bitmap, footerDev, false);
              bitmap.close();
            }
          }
        } catch (error) {
          log('固定顶栏/页脚重绘失败（忽略）：' + ((error && error.message) || error));
        } finally {
          await execPage(tabId, 'scroll-to-y', { y: originalY }).catch(() => {});
        }
      }
    } catch (error) {
      log('固定带测量失败（忽略）：' + ((error && error.message) || error));
    }
    return { fixedTop, fixedFooter, measured };
  };

  let tileStats = await drawTiles(context, deviceWidth, deviceHeight, 0);
  let tiles = tileStats.count;
  let rewrittenTiles = 0;
  let bands = await drawBands(context, deviceWidth, deviceHeight);
  let extended = false;
  let staleRepairs = 0;
  const afterMetrics = await execPage(tabId, 'page-metrics', {}).catch(() => null);
  const freshness = staleMetrics(bands.measured, afterMetrics, { tolerance: 1 });
  const recovery = freshness.stale
    ? planStaleRecovery(bands.measured, afterMetrics, { scale, device: { width: deviceWidth, height: deviceHeight } })
    : { action: 'accept' };
  if (freshness.stale) {
    longshotRuns.transition(longshotId, LONGSHOT_EVENTS.STALE_DETECTED, {
      changed: freshness.changed.map((item) => item.field),
      action: recovery.action,
      tiles,
    });
  }
  if (freshness.stale && attempt < maxStaleAttempts - 1 && recovery.action === 'extend') {
    // 页面只在底部继续增长：保留已拍内容，只补拍新增 tile（逐 tile 改写）。
    const nextWidth = recovery.width;
    const nextHeight = recovery.height;
    const nextCanvas = new OffscreenCanvas(nextWidth, nextHeight);
    const nextContext = nextCanvas.getContext('2d');
    nextContext.drawImage(canvas, 0, 0);
    const added = await drawTiles(nextContext, nextWidth, nextHeight, deviceHeight);
    tiles += added.count;
    bands = await drawBands(nextContext, nextWidth, nextHeight);
    canvas = nextCanvas;
    context = nextContext;
    deviceWidth = nextWidth;
    deviceHeight = nextHeight;
    extended = true;
    staleRepairs = 1;
    log('长截图尾部增长：补拍 ' + recovery.y0 + '→' + nextHeight + '（dpr ' + scale + '）');
  } else if (freshness.stale && attempt < maxStaleAttempts - 1 && recovery.action === 'rewrite') {
    // 尺寸不变但 DOM 变了：重新扫描 tile，只重写内容变化的区域。
    const nextCanvas = new OffscreenCanvas(deviceWidth, deviceHeight);
    const nextContext = nextCanvas.getContext('2d');
    nextContext.drawImage(canvas, 0, 0);
    const repaired = await drawTiles(nextContext, deviceWidth, deviceHeight, 0, { onlyChanged: true });
    tiles += repaired.count;
    rewrittenTiles = repaired.rewritten;
    bands = await drawBands(nextContext, deviceWidth, deviceHeight);
    canvas = nextCanvas;
    context = nextContext;
    staleRepairs = 1;
    log('长截图内容变化：重写 ' + rewrittenTiles + ' 个 tile（尺寸 ' + deviceWidth + 'x' + deviceHeight + '）');
  } else if (freshness.stale && attempt < maxStaleAttempts - 1) {
    const retry = longshotRuns.transition(longshotId, LONGSHOT_EVENTS.STALE_RETRY, {
      attempts: attempt + 1,
      maxStaleAttempts,
      reason: JSON.stringify(freshness.changed),
    });
    if (!retry.ok) {
      log('长截图 stale 重试被拒绝（' + retry.code + '）：' + retry.error);
    } else {
      log('长截图 stale（' + JSON.stringify(freshness.changed) + '），重拍一次');
      const nextWidth = afterMetrics && Number(afterMetrics.scrollWidth) > 0 ? Number(afterMetrics.scrollWidth) : width;
      const nextHeight = afterMetrics && Number(afterMetrics.scrollHeight) > 0 ? Number(afterMetrics.scrollHeight) : height;
      return captureTiledFullPage(tabId, tabUrl, nextWidth, nextHeight, (afterMetrics && afterMetrics.dpr) || scale, attempt + 1, options);
    }
  }
  longshotRuns.transition(longshotId, LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles, segments: 1 });
  longshotRuns.transition(longshotId, LONGSHOT_EVENTS.STITCH_BEGIN, { tiles, segments: 1 });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  log('分块截图 ' + tiles + ' 块，尺寸 ' + deviceWidth + 'x' + deviceHeight + '（dpr ' + scale + '，顶栏 ' + bands.fixedTop + '，页脚 ' + bands.fixedFooter + '）');
  await persistLongshotCapture({ id: longshotId, url: tabUrl || '', width: deviceWidth, height: deviceHeight, frames: [{ dataUrl, width: deviceWidth, height: deviceHeight, drawY: 0 }] });

  // 分片索引 manifest：记录每个 tile 的 offset/bytes/hash，供 longshot.recover 断点恢复与 hash 校验。
  let manifest = null;
  let manifestVerified = { checked: 0, mismatched: 0, refetched: 0, hashVerified: true, skipped: tileRecords.length === 0 };
  if (tileRecords.length) {
    try {
      manifest = sealManifest(buildLongshotManifest({
        captureId: longshotId,
        tabId,
        url: tabUrl,
        dpr: scale,
        width: deviceWidth,
        height: deviceHeight,
        total: tileRecords.length,
        segments: tileRecords,
      }), { hashVerified: true });
      await saveLongshotManifest(manifest).catch(() => 0);
      manifestVerified = { checked: tileRecords.length, mismatched: 0, refetched: 0, hashVerified: true };
    } catch (error) {
      log('长截图索引封版失败（忽略）：' + ((error && error.message) || error));
      manifestVerified = { checked: 0, mismatched: 0, refetched: 0, hashVerified: false, error: (error && error.message) || String(error) };
    }
  }
  const seal = longshotRuns.transition(longshotId, LONGSHOT_EVENTS.SEAL, {
    totalSegments: 1,
    sealedSegments: 1,
    hashVerified: manifestVerified.hashVerified !== false,
  });
  if (!seal.ok) {
    log('长截图封版被拒绝（' + seal.code + '）：' + seal.error);
    longshotRuns.transition(longshotId, LONGSHOT_EVENTS.FAIL, { reason: String(seal.code).toLowerCase() });
  }
  return {
    dataUrl, width: deviceWidth, height: deviceHeight, via: 'cdp', tiled: tiles, tile_size: tileSize, full_page: true,
    fixedFooter: bands.fixedFooter, fixedTop: bands.fixedTop, dpr: scale,
    stale: freshness.stale === true,
    stale_repairs: staleRepairs,
    stale_attempts: attempt + 1,
    rewritten_tiles: rewrittenTiles,
    extended,
    longshot_id: longshotId,
    tiles_persisted: tilesPersisted,
    fixedBands: bands.measured && Array.isArray(bands.measured.fixedBands) ? bands.measured.fixedBands.length : 0,
    manifest: manifest ? manifestSummary(manifest) : null,
    manifest_verified: manifestVerified,
  };
}

export async function captureTiledFullPage(tabId, tabUrl, width, height, dprInput, attempt = 0, options = {}) {
  const budgetPlan = estimateLongshotBudget({
    scrollWidth: width,
    scrollHeight: height,
    dpr: dprInput,
    maxSegmentHeight: MAX_TILED_HEIGHT,
    maxDeviceDimension: MAX_TILED_WIDTH,
    maxTotalDeviceHeight: MAX_TOTAL_TILED_HEIGHT,
  });
  const scale = budgetPlan.dpr;
  const tileSize = Math.max(256, Math.min(8192, Math.round(Number(options.tileSize) || CAPTURE_TILE_HEIGHT)));
  const maxStaleAttempts = Math.max(1, Math.min(3, Number(options.staleAttempts) || 3));
  const captureId = newLongshotId();
  const begin = longshotRuns.transition(captureId, LONGSHOT_EVENTS.CAPTURE_BEGIN, {
    tabId,
    url: tabUrl || '',
    dpr: scale,
    totalSegments: budgetPlan.totalSegments,
    attempts: attempt,
    degraded: budgetPlan.degraded,
  });
  if (!begin.ok) log('长截图状态机拒绝 capture.begin（' + begin.code + '）：' + begin.error);
  log('长截图预算：' + describeBudget(budgetPlan));
  // 过期分片清理（在途 capture 显式保留），失败不阻断截图。
  try {
    cleanupLongshotManifests({ keep: [captureId] }).catch(() => 0);
  } catch { /* 忽略 */ }
  try {
    const result = budgetPlan.deviceHeight > MAX_TILED_HEIGHT
      ? await captureSegments(tabId, tabUrl, budgetPlan, tileSize, options, captureId)
      : await captureSingleTiled(tabId, tabUrl, width, height, scale, tileSize, options, attempt, maxStaleAttempts, captureId);
    // stale 重拍会把实际采集委派给新的 captureId；外层这次运行如实记为 failed(stale-delegated)。
    const delegated = result && result.state && result.state.captureId && result.state.captureId !== captureId;
    if (delegated) {
      longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, { reason: 'stale-delegated', attempts: attempt });
    }
    return {
      ...result,
      budget: budgetReport(budgetPlan),
      degraded: budgetPlan.degraded === true,
      truncated: budgetPlan.truncated === true,
      state: (result && result.state) || longshotRuns.evidence(captureId),
    };
  } catch (error) {
    longshotRuns.transition(captureId, LONGSHOT_EVENTS.FAIL, { reason: (error && error.message) || String(error) });
    throw error;
  }
}
