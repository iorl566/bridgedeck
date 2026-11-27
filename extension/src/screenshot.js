// src/screenshot.js —— screenshot 命令：chrome.tabs.captureVisibleTab + 整页拼接
import { bridgeError, mapChromeError } from './errors.js';
import { withTimeout } from './timeout.js';
import { acquire, release, send as cdpSend } from './debugger.js';
import { execPage } from './inject.js';
import { getTab, sleep } from './tabs.js';
import { log } from './log.js';
import { annotateShot, gridShot, profileShot, blobToDataUrl } from './screenshot-visual.js';
export { blobToDataUrl } from './screenshot-visual.js';
import { withOverlaysHidden } from './overlay-suppress.js';
import { planCaptureTiles, pruneCaptures, sameFrame } from './longshot.js';
import { layoutCanvas } from './longshot-render.js';
import { nextGrowthTiles, tileForScroll } from './longshot-schedule.js';
import { persistLongshotCapture } from './capture-persist.js';
import { captureTiledFullPage } from './tiled-capture.js';
import { staleMetrics, planStaleRecovery } from './lib/capture-freshness.js';
import { planFinalExposure } from './lib/longshot-final.js';
import { diffRgba } from './lib/pixel-diff.js';
import { focusRequested } from './lib/focus-policy.js';
import { createCaptureStore } from './lib/capture-stream.js';

const captureStreams = createCaptureStore();

/** screenshot.read：按 base64 字符 offset 分块读取暂存的大截图。 */
export function screenshotRead(params = {}) {
  const chunk = captureStreams.read(params.captureId, { offset: params.offset, length: params.length });
  if (!chunk) throw bridgeError('E_NOT_FOUND', '截图 capture 不存在或已过期（重新截图）');
  return chunk;
}

/** screenshot.release：释放暂存的大截图。 */
export function screenshotRelease(params = {}) {
  return { ok: true, released: captureStreams.release(params.captureId) };
}

/** 大截图改走 captureId + 分块读取，避免单次 RPC 携带数 MB base64。 */
function maybeStreamCapture(result, input = {}) {
  if (!result || typeof result.dataUrl !== 'string') return result;
  const wantStream = input.stream === true || result.dataUrl.length > 1_500_000;
  if (!wantStream) return result;
  const stored = captureStreams.put({ dataUrl: result.dataUrl, width: result.width, height: result.height, via: result.via });
  if (!stored) return result;
  const streamed = { ...result };
  delete streamed.dataUrl;
  streamed.captureId = stored.captureId;
  streamed.streamed = true;
  streamed.bytes = stored.bytes;
  return streamed;
}

const CAPTURE_INTERVAL_MS = 550; // captureVisibleTab 限速约 2 次/秒
const MAX_FULL_PAGE_FRAMES = 8;
const MAX_CANVAS_HEIGHT = 16000;
const MAX_SINGLE_CAPTURE_HEIGHT = 12000;
const MAX_SINGLE_CAPTURE_WIDTH = 12000;
let lastCdpFailure = '';
const captures = new Map(); // captureId -> { tabId, scale, scrollX, scrollY, width, height, refs, at, url }

/** tab 关闭时清掉该 tab 的视觉 capture 与差分基线。 */
export function forgetScreenshotTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  lastShots.delete(id);
  for (const [captureId, capture] of captures) {
    if (Number(capture && capture.tabId) === id) captures.delete(captureId);
  }
}
const lastShots = new Map(); // tabId -> { dataUrl, width, height, at }
const CAPTURE_TTL_MS = 10 * 60 * 1000;
const CAPTURE_MAX = 20;

export function getCapture(id) {
  const capture = captures.get(String(id));
  if (!capture) return null;
  if (Date.now() - capture.at > CAPTURE_TTL_MS) {
    captures.delete(String(id));
    return null;
  }
  return capture;
}

/**
 * 取走 capture（单次消费）：坐标只允许用同一张图派发一次动作。
 * 重复用同一张图点击/拖拽，在页面已经变化时会把动作打到错误位置，而且很难从结果里发现。
 */
export function consumeCapture(id) {
  const capture = getCapture(id);
  if (capture) captures.delete(String(id));
  return capture;
}

function rememberCapture(capture) {
  captures.set(capture.id, capture);
  pruneCaptures(captures, { ttlMs: CAPTURE_TTL_MS, max: CAPTURE_MAX });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

/** 在截图上画 @eN 方框与标签。 */
/**
 * 把截图像素坐标换算成页面坐标（含滚动与缩放）。
 * 视觉定位的统一入口：clickByImage / dragByImage 都走这里，保证两处换算一致。
 * @param {string} captureId
 * @param {number|undefined} tabId 给了就校验 capture 归属
 * @param {number} imageX
 * @param {number} imageY
 * @param {{ consume?: boolean }} [options] consume=true 时取走 capture（单次消费）
 * @returns {{ capture: object, x: number, y: number, scale: number }}
 */
export function resolveCapturePoint(captureId, tabId, imageX, imageY, options = {}) {
  const capture = options.consume === true ? consumeCapture(captureId) : getCapture(captureId);
  if (!capture) throw bridgeError('E_CAPTURE_STALE', 'capture 不存在或已过期，请重新截图');
  if (Number.isInteger(tabId) && capture.tabId !== tabId) {
    throw bridgeError('E_BAD_ARG', 'capture 属于另一个标签页');
  }
  if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
    throw bridgeError('E_BAD_ARG', '需要 imageX/imageY');
  }
  const scale = capture.scale || 1;
  if (capture.candidateIndex != null && capture.region) {
    // 视觉候选 capture：坐标相对区域图，归一化回页面坐标。
    return {
      capture,
      scale,
      x: capture.region.x + (imageX / Math.max(1, capture.width)) * capture.region.width,
      y: capture.region.y + (imageY / Math.max(1, capture.height)) * capture.region.height,
    };
  }
  return {
    capture,
    scale,
    x: capture.scrollX + imageX / scale,
    y: capture.scrollY + imageY / scale,
  };
}

/**
 * 在截图上叠加坐标网格，并把图片像素坐标直接标在图上。
 * 目的：让"看图取坐标"有据可依，而不是凭感觉估。
 */
/**
 * 返回图像的一维差分剖面：沿 axis 求相邻像素亮度差的累计。
 * 不判断"那是什么"，只给出"哪里变化最剧烈"的位置与强度，
 * 由调用方（模型或脚本）自己决定要不要用、怎么用。
 */
/**
 * 视觉命中校验：派发前确认"这个页面坐标下面真的是可操作的东西"。
 * 把"点被浮层吃掉/页面已变"从"事后看结果"变成"派发前就失败"，
 * 并把落点元素带进错误里，方便定位。
 * @param {number} tabId
 * @param {number} x 页面坐标（CSS px）
 * @param {number} y 页面坐标（CSS px）
 * @returns {Promise<object>} 命中简报
 */
export async function verifyVisualHit(tabId, x, y, expectedIndex) {
  let hit = null;
  try {
    const args = { x, y };
    if (Number.isFinite(Number(expectedIndex))) args.index = Number(expectedIndex);
    hit = await execPage(tabId, 'hit-at', args);
  } catch (error) {
    throw bridgeError('E_INTERNAL', '命中校验不可用（页面能力库 ' + ((error && error.message) || error) + '）；视觉坐标动作拒绝盲发');
  }
  if (!hit.hit) {
    throw bridgeError('E_NOT_ACTIONABLE', '坐标 (' + Math.round(x) + ',' + Math.round(y) + ') 下面没有元素');
  }
  if (hit.anchored) {
    throw bridgeError('E_NOT_ACTIONABLE', '坐标落在文档根元素上（页面可能还没渲染完）');
  }
  if (hit.pointerEvents === 'none') {
    throw bridgeError('E_NOT_ACTIONABLE', '落点 <' + hit.tag + '> 设置了 pointer-events:none，动作不会生效');
  }
  if (hit.inert) {
    throw bridgeError('E_NOT_ACTIONABLE', '落点在 inert 子树内，动作不会生效');
  }
  if (hit.coversViewport && !hit.ownOverlay) {
    throw bridgeError('E_OBSCURED', '落点被铺满视口的元素遮住：<' + hit.tag + (hit.id ? '#' + hit.id : '') + '>');
  }
  if (hit.matches === false) {
    throw bridgeError('E_TARGET_MISMATCH', '落点不是预期的视觉候选 #' + Number(expectedIndex)
      + '（实际是 <' + hit.tag + (hit.id ? '#' + hit.id : '') + '>）');
  }
  return hit;
}

/** 按截图坐标点击（Canvas/视觉引用）。 */
export async function clickByImage(params = {}) {
  const tabId = Number(params.tabId);
  const { capture, x, y } = resolveCapturePoint(params.capture, Number.isInteger(tabId) ? tabId : undefined, Number(params.imageX), Number(params.imageY), { consume: true });
  const hit = await verifyVisualHit(capture.tabId, x, y, capture.candidateIndex);
  try {
    await acquire(capture.tabId, 'image-click');
    try {
      await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      let pressed = false;
      try {
        await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        pressed = true;
        await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        pressed = false;
      } finally {
        if (pressed) await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
      }
    } finally {
      await release(capture.tabId, 'image-click').catch(() => {});
    }
    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      via: 'cdp',
      capture: capture.id,
      hit: hit ? { tag: hit.tag, id: hit.id, cls: hit.cls } : undefined,
    };
  } catch (error) {
    const result = await execPage(capture.tabId, 'click-point', { x, y });
    return { ok: true, x: Math.round(x), y: Math.round(y), via: 'page', tag: result && result.tag, capture: capture.id };
  }
}

/** 从 PNG dataUrl 的 IHDR 读取宽高。 */
export function pngSize(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const head = atob(base64.slice(0, 40));
  const bytes = new Uint8Array(head.length);
  for (let i = 0; i < head.length; i += 1) bytes[i] = head.charCodeAt(i);
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return { width: 0, height: 0 };
  }
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function bitmapToDataUrl(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

/**
 * 抓当前可见区域。窗口未聚焦、或页面刚重绘时 captureVisibleTab 会偶发
 * "image readback failed"，因此按退避重试几次；非渲染类错误（如窗口已关闭）直接抛。
 */
async function captureVisible(windowId) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // 窗口最小化/被遮挡/桌面锁定时 captureVisibleTab 可能既不回包也不报错：加硬超时。
      return await withTimeout(
        chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
        10000,
        'captureVisibleTab',
      );
    } catch (error) {
      lastError = error;
      const message = String((error && error.message) || error);
      if (!/readback|failed to capture|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message)) break;
      log(`截图失败第 ${attempt + 1} 次（${message}），置前后重试`);
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message)) {
        await sleep(1200 + CAPTURE_INTERVAL_MS * attempt);
        continue;
      }
      try {
        await withTimeout(chrome.windows.update(windowId, { state: 'normal' }), 3000, 'windows.update');
      } catch {
        // 窗口可能已关闭，交给下面统一报错
      }
      await sleep(700 + CAPTURE_INTERVAL_MS * attempt); // 也避免撞上 captureVisibleTab 的 2 次/秒配额
    }
  }
  throw mapChromeError(
    lastError,
    '截图失败（窗口可能被最小化或页面未完成绘制）' + (lastCdpFailure ? '；CDP 失败：' + lastCdpFailure : ''),
  );
}

async function captureFullPage(tab, options = {}) {
  if (options.growth === true) {
    await execPage(tab.id, 'auto-scroll', {}).catch(() => {});
  }
  let metrics;
  try {
    metrics = await execPage(tab.id, 'page-metrics', {});
  } catch (error) {
    throw error;
  }
  if (!metrics || !Number.isFinite(metrics.scrollHeight) || metrics.scrollHeight <= metrics.innerHeight + 4) {
    return captureSingle(tab);
  }

  const scale = Number.isFinite(metrics.dpr) && metrics.dpr > 0 ? metrics.dpr : 1;
  const overlap = Math.max(0, Math.min(Number(options.overlap) || 0, metrics.innerHeight - 1));
  const step = Math.max(1, metrics.innerHeight - overlap);
  let totalHeight = Math.min(Math.ceil(metrics.scrollHeight * scale), MAX_CANVAS_HEIGHT);
  const positions = planCaptureTiles({
    scrollHeight: metrics.scrollHeight,
    viewportHeight: metrics.innerHeight,
    maxTiles: MAX_FULL_PAGE_FRAMES,
    overlap,
  });
  if (!positions.length) positions.push(0);

  const frames = [];
  let viewport = null;
  try {
    for (let i = 0; i < positions.length; i += 1) {
      await execPage(tab.id, 'scroll-to-y', { y: positions[i] });
      await sleep(CAPTURE_INTERVAL_MS);
      const before = await execPage(tab.id, 'page-metrics', {});
      const grab = async () => {
        const dataUrl = await captureVisible(tab.windowId);
        const blob = await (await fetch(dataUrl)).blob();
        return createImageBitmap(blob);
      };
      let bitmap = await grab();
      let current = await execPage(tab.id, 'page-metrics', {});
      if (!sameFrame(before, current)) {
        await sleep(200);
        bitmap = await grab();
        current = await execPage(tab.id, 'page-metrics', {});
      }
      if (!viewport) viewport = { width: bitmap.width, height: bitmap.height };
      const scrollY = tileForScroll(current && current.scrollY, step, i);
      if (Number(current && current.scrollHeight) > metrics.scrollHeight) {
        const grown = nextGrowthTiles(positions, {
          scrollHeight: current.scrollHeight,
          step,
          maxTiles: MAX_FULL_PAGE_FRAMES,
        });
        if (grown.length > positions.length) {
          positions.length = 0;
          positions.push(...grown);
          totalHeight = Math.min(Math.ceil(current.scrollHeight * scale), MAX_CANVAS_HEIGHT);
        }
      }
      const drawY = Math.max(0, Math.min(Math.round(scrollY * scale), totalHeight - bitmap.height));
      frames.push({ bitmap, drawY });
      if (i + 1 >= positions.length && positions[i] + step >= metrics.scrollHeight) break;
    }
    // final exposure：底部尚未被完整覆盖时，再滚到底拍一帧并贴底绘制。
    const last = frames[frames.length - 1];
    const finalPlan = planFinalExposure({
      scrollHeight: metrics.scrollHeight,
      innerHeight: metrics.innerHeight,
      scale,
      lastBottom: last ? last.drawY + last.bitmap.height : 0,
      viewportHeight: viewport ? viewport.height : 0,
    });
    if (finalPlan) {
      await execPage(tab.id, 'scroll-to-y', { y: finalPlan.scrollY });
      await sleep(CAPTURE_INTERVAL_MS);
      const dataUrl = await captureVisible(tab.windowId);
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      if (!viewport) viewport = { width: bitmap.width, height: bitmap.height };
      const drawY = Math.max(0, Math.min(finalPlan.drawY, totalHeight - bitmap.height));
      frames.push({ bitmap, drawY });
    }
  } finally {
    await execPage(tab.id, 'scroll-to-y', { y: metrics.scrollY || 0 }).catch(() => {});
  }
  if (!viewport) return captureSingle(tab);

  // 帧数被上限截断时按实际已捕获的高度出图，避免底部留白
  const layout = layoutCanvas(frames.map((frame) => ({ drawY: frame.drawY, bitmapHeight: frame.bitmap.height })), {
    width: viewport.width,
    totalHeight,
  });
  const width = layout.width;
  const height = layout.height;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const chunks = [];
  for (const placement of layout.placements) {
    const frame = frames[placement.index];
    try {
      chunks.push({
        dataUrl: await bitmapToDataUrl(frame.bitmap),
        width: frame.bitmap.width,
        height: frame.bitmap.height,
        drawY: placement.drawY,
      });
    } catch (error) {
      log('长截图分片序列化失败：' + ((error && error.message) || error));
    }
    context.drawImage(frame.bitmap, 0, placement.drawY);
    frame.bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  log(`整页截图拼合 ${frames.length} 帧，尺寸 ${width}x${height}`);
  await persistLongshotCapture({ url: tab.url || '', width, height, frames: chunks });
  const afterMetrics = await execPage(tab.id, 'page-metrics', {}).catch(() => null);
  const freshness = staleMetrics(metrics, afterMetrics, { tolerance: 1 });
  if (freshness.stale && options.__staleRetry !== true) {
    log('滚动长截图 stale（' + JSON.stringify(freshness.changed) + '），重拍一次');
    return captureFullPage(tab, { ...options, __staleRetry: true });
  }
  return {
    dataUrl, width, height,
    stale: freshness.stale === true,
    stale_retries: options.__staleRetry === true ? 1 : 0,
    fixedBands: Array.isArray(metrics.fixedBands) ? metrics.fixedBands.length : 0,
  };
}

async function captureElement(tab, params) {
  const rect = await execPage(tab.id, 'element-rect', {
    ref: params.ref,
    selector: params.selector,
  });
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw bridgeError('E_NOT_FOUND', '元素没有可截图的区域（尺寸为 0 或不可见）');
  }
  const dataUrl = await captureVisible(tab.windowId);
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const dpr = Number(rect.dpr) > 0 ? Number(rect.dpr) : 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
  if (sw <= 0 || sh <= 0) {
    bitmap.close();
    throw bridgeError('E_NOT_FOUND', '元素在当前视口外，无法截图');
  }
  const canvas = new OffscreenCanvas(sw, sh);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  const croppedUrl = await blobToDataUrl(croppedBlob);
  return {
    dataUrl: croppedUrl,
    width: sw,
    height: sh,
    clipped: Math.round(rect.width * dpr) > sw || Math.round(rect.height * dpr) > sh,
  };
}

async function captureSingle(tab) {
  const dataUrl = await captureVisible(tab.windowId);
  const size = pngSize(dataUrl);
  return { dataUrl, width: size.width, height: size.height };
}

/** 按视口 CSS 像素区域截图（Canvas/任意像素区域）。 */
async function captureRegion(tab, region, scale) {
  const x = Math.max(0, Number(region.x) || 0);
  const y = Math.max(0, Number(region.y) || 0);
  const width = Math.max(1, Number(region.width) || 1);
  const height = Math.max(1, Number(region.height) || 1);
  const zoom = Math.min(8, Math.max(1, Number(scale) || 1));
  const result = await withTimeout(cdpSend(tab.id, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale: zoom },
    captureBeyondViewport: true,
  }), 10000, 'Page.captureScreenshot region');
  if (!result || typeof result.data !== 'string' || !result.data) throw bridgeError('E_INTERNAL', '区域截图没有返回数据');
  const dataUrl = 'data:image/png;base64,' + result.data;
  const size = pngSize(dataUrl);
  return { dataUrl, width: size.width, height: size.height };
}

/** 超长/超宽页面：单次 captureScreenshot 会超出纹理/内存上限，按 8000px 网格分块拍再拼。
 *  支持分数 DPR：tile 边界按设备像素推进，裁剪坐标用 CSS 像素（x/scale），
 *  绘制时按设备像素拉伸，避免 1px 接缝；同时重绘固定顶栏与固定页脚。 */
/** CDP 截图：不受窗口焦点影响，后台标签页也能拍；失败时由调用方回退。 */
async function captureViaCdp(tab, params) {
  const tabId = tab.id;
  const dbg = await withTimeout(acquire(tabId, 'screenshot'), 5000, 'debugger.attach');
  try {
    let options = { format: 'png' };
    let visualRegion = null;
    if (params.visualIndex != null) {
      // 视觉候选截图：只拍候选区域，自动放大到够看，并把坐标语义改成"区域相对"。
      const scan = await execPage(tabId, 'visual-scan', {}).catch(() => null);
      const candidate = scan && Array.isArray(scan.candidates)
        ? scan.candidates.find((item) => item.index === Number(params.visualIndex))
        : null;
      if (!candidate) {
        throw bridgeError('E_NOT_FOUND', '视觉候选 #' + params.visualIndex + ' 不存在；先 observe --visual 或重新扫描');
      }
      const scrollX = (scan.viewport && scan.viewport.scrollX) || 0;
      const scrollY = (scan.viewport && scan.viewport.scrollY) || 0;
      const width = Math.max(1, candidate.rect.width);
      const height = Math.max(1, candidate.rect.height);
      const zoom = Math.min(4, Math.max(1, Math.ceil(360 / Math.max(width, 1))));
      visualRegion = { candidate, scrollX, scrollY };
      options = {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: candidate.rect.x + scrollX,
          y: candidate.rect.y + scrollY,
          width,
          height,
          scale: zoom,
        },
      };
    } else if (params.region && typeof params.region === 'object') {
      const x = Math.max(0, Number(params.region.x) || 0);
      const y = Math.max(0, Number(params.region.y) || 0);
      const width = Math.max(1, Number(params.region.width) || 1);
      const height = Math.max(1, Number(params.region.height) || 1);
      const zoom = Math.min(8, Math.max(1, Number(params.scale) || 1));
      options = { format: 'png', captureBeyondViewport: true, clip: { x, y, width, height, scale: zoom } };
    } else if (params.fullPage === true) {
      const metrics = await execPage(tabId, 'page-metrics', {});
      const width = Math.max(1, Math.round(metrics.scrollWidth || metrics.innerWidth));
      const height = Math.max(1, Math.round(metrics.scrollHeight));
      if (height > MAX_SINGLE_CAPTURE_HEIGHT || width > MAX_SINGLE_CAPTURE_WIDTH) {
        return await captureTiledFullPage(tabId, tab.url || '', width, height, metrics.dpr, 0, { segmented: params.segmented !== false, tileSize: params.tileSize, staleAttempts: params.staleAttempts });
      }
      options = {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      };
    } else if (params.ref || params.selector) {
      // 元素截图：先把视口拍下来再按元素盒子裁剪。比 captureBeyondViewport + clip
      // 更稳（后者在部分页面状态下会失败），也能覆盖后台标签页。
      const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw bridgeError('E_NOT_FOUND', '元素没有可截图的区域（尺寸为 0 或不可见）');
      }
      let shot = null;
    for (let attempt = 0; attempt < 2 && !shot; attempt += 1) {
      try {
        shot = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', { format: 'png' }), 8000, 'Page.captureScreenshot');
      } catch (error) {
        if (attempt === 1) throw error;
        await sleep(400);
      }
    }
      if (!shot || typeof shot.data !== 'string' || !shot.data) {
        throw bridgeError('E_INTERNAL', 'Page.captureScreenshot 没有返回数据');
      }
      const blob = await (await fetch('data:image/png;base64,' + shot.data)).blob();
      const bitmap = await createImageBitmap(blob);
      const dpr = Number(rect.dpr) > 0 ? Number(rect.dpr) : 1;
      const sx = Math.max(0, Math.round(rect.x * dpr));
      const sy = Math.max(0, Math.round(rect.y * dpr));
      const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
      const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
      if (sw <= 0 || sh <= 0) {
        bitmap.close();
        throw bridgeError('E_NOT_FOUND', '元素在当前视口外，无法截图');
      }
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      bitmap.close();
      const cropped = await canvas.convertToBlob({ type: 'image/png' });
      return { dataUrl: await blobToDataUrl(cropped), width: sw, height: sh, via: 'cdp' };
    }
    let result = null;
    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      try {
        result = await withTimeout(cdpSend(tabId, 'Page.captureScreenshot', options), 8000, 'Page.captureScreenshot');
      } catch (error) {
        if (attempt === 1) throw error;
        await sleep(400);
      }
    }
    if (!result || typeof result.data !== 'string' || !result.data) {
      throw bridgeError('E_INTERNAL', 'Page.captureScreenshot 没有返回数据');
    }
    let dataUrl = 'data:image/png;base64,' + result.data;
    const size = pngSize(dataUrl);
    if (params.fullPage === true) {
      await persistLongshotCapture({
        url: tab.url || '',
        width: size.width,
        height: size.height,
        frames: [{ dataUrl, width: size.width, height: size.height, drawY: 0 }],
      });
    }
    if (visualRegion) {
      // 候选截图：坐标语义是"区域相对"，由 resolveCapturePoint 归一化回页面坐标。
      const captureId = uuid();
      rememberCapture({
        id: captureId,
        tabId,
        scale: 1,
        scrollX: visualRegion.scrollX,
        scrollY: visualRegion.scrollY,
        width: size.width,
        height: size.height,
        region: visualRegion.candidate.rect,
        candidateIndex: visualRegion.candidate.index,
        candidate: {
          tag: visualRegion.candidate.tag,
          id: visualRegion.candidate.id,
          cls: visualRegion.candidate.cls,
          kind: visualRegion.candidate.kind,
        },
        at: Date.now(),
        url: '',
      });
      return {
        dataUrl,
        width: size.width,
        height: size.height,
        via: 'cdp',
        capture_id: captureId,
        capture_mode: 'visual-region',
        visual: {
          index: visualRegion.candidate.index,
          kind: visualRegion.candidate.kind,
          tag: visualRegion.candidate.tag,
          id: visualRegion.candidate.id,
          cls: visualRegion.candidate.cls,
          rect: visualRegion.candidate.rect,
        },
      };
    }
    const wantsOverlay = params.annotate === true || params.grid === true || params.profile != null;
    if (wantsOverlay && params.fullPage !== true && !params.ref && !params.selector) {
      const visual = await execPage(tabId, 'visual-refs', {}).catch(() => null);
      if (visual && Array.isArray(visual.refs) && visual.innerWidth > 0) {
        const scale = size.width / visual.innerWidth;
        let profile = null;
        if (params.profile != null) {
          profile = await profileShot(dataUrl, params.profile === 'y' ? 'y' : 'x').catch(() => null);
        }
        if (params.annotate === true) dataUrl = await annotateShot(dataUrl, visual.refs, scale);
        if (params.grid === true) dataUrl = await gridShot(dataUrl, scale, params.gridStep);
        // 截图之后再量一次几何，变化了就不给可用的 capture。
        // 否则"看图时页面已经滚了/改了"，坐标会打到错误位置而且很难发现。
        const after = await execPage(tabId, 'visual-refs', {}).catch(() => null);
        const geometryStable = Boolean(after)
          && after.innerWidth === visual.innerWidth
          && Math.abs((after.scrollX || 0) - (visual.scrollX || 0)) < 1
          && Math.abs((after.scrollY || 0) - (visual.scrollY || 0)) < 1;
        if (!geometryStable) {
          log('截图期间页面几何变化，capture 作废 tab=' + tabId);
          return {
            dataUrl,
            width: size.width,
            height: size.height,
            via: 'cdp',
            capture_skipped: 'geometry-changed',
            profile: profile || undefined,
          };
        }
        const captureId = uuid();
        rememberCapture({
          id: captureId,
          tabId,
          scale,
          scrollX: visual.scrollX || 0,
          scrollY: visual.scrollY || 0,
          width: size.width,
          height: size.height,
          refs: visual.refs,
          at: Date.now(),
          url: visual.url || '',
        });
        return {
          dataUrl,
          width: size.width,
          height: size.height,
          via: 'cdp',
          capture_id: captureId,
          profile: profile || undefined,
          visual_refs: params.annotate === true ? visual.refs.map((item) => ({
            ref: item.ref,
            role: item.role,
            name: item.name,
            image_x: Math.round(item.x * scale + item.width * scale / 2),
            image_y: Math.round(item.y * scale + item.height * scale / 2),
            x: Math.round(item.x * scale),
            y: Math.round(item.y * scale),
            width: Math.round(item.width * scale),
            height: Math.round(item.height * scale),
          })) : undefined,
        };
      }
    }
    return { dataUrl, width: size.width, height: size.height, via: 'cdp' };
  } finally {
    await release(tabId, 'screenshot').catch(() => {});
  }
}

/** screenshot 命令入口。 */
async function takeScreenshotRaw(input = {}) {
  const params = input.scope === 'viewport' ? { ...input, fullPage: false } : input;
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'screenshot 需要 tabId');
  const tab = await getTab(tabId);
  try {
    return await captureViaCdp(tab, params);
  } catch (error) {
    lastCdpFailure = String((error && error.message) || error);
    log('CDP 截图失败，回退 captureVisibleTab：' + lastCdpFailure);
  }
  const windowId = tab.windowId;

  let previousActiveId = null;
  try {
    const activeTabs = await withTimeout(chrome.tabs.query({ windowId, active: true }), 3000, 'tabs.query');
    previousActiveId = activeTabs.length ? activeTabs[0].id : null;
  } catch {
    previousActiveId = null;
  }
  // captureVisibleTab 回退需要目标窗口可见可读；只有显式 --focus 才置前，避免普通截图抢焦点。
  const focusWanted = focusRequested(params);
  let previousFocusedId = null;
  if (focusWanted) {
    try {
      const focused = await withTimeout(chrome.windows.getLastFocused(), 3000, 'windows.getLastFocused');
      previousFocusedId = focused && focused.id != null ? focused.id : null;
    } catch {
      previousFocusedId = null;
    }
  }
  let focusedByUs = false;
  if (focusWanted && previousFocusedId !== windowId) {
    try {
      const targetWindow = await withTimeout(chrome.windows.get(windowId), 3000, 'windows.get');
      if (targetWindow.state === 'minimized') {
        await withTimeout(chrome.windows.update(windowId, { state: 'normal' }), 3000, 'windows.update');
      }
      await withTimeout(chrome.windows.update(windowId, { focused: true }), 3000, 'windows.update');
      focusedByUs = true;
      await sleep(250);
    } catch (error) {
      log('截图临时置前失败，继续尝试直接抓取', error && error.message);
    }
  }

  let activated = false;
  if (focusWanted && !tab.active) {
    try {
      await withTimeout(chrome.tabs.update(tabId, { active: true }), 3000, 'tabs.update');
      activated = true;
      await sleep(150);
    } catch (error) {
      throw mapChromeError(error, '激活截图目标 tab 失败');
    }
  }

  try {
    if (params.region && typeof params.region === 'object') return await captureRegion(tab, params.region, params.scale);
    if (params.ref || params.selector) return await captureElement(tab, params);
    if (params.fullPage === true) return await captureFullPage(tab, params);
    return await captureSingle(tab);
  } finally {
    if (activated && previousActiveId != null) {
      try {
        await withTimeout(chrome.tabs.update(previousActiveId, { active: true }), 3000, 'tabs.update');
      } catch {
        // 原 tab 可能已关闭，忽略
      }
    }
    if (focusedByUs && previousFocusedId != null) {
      try {
        await withTimeout(chrome.windows.update(previousFocusedId, { focused: true }), 3000, 'windows.update');
      } catch {
        // 原窗口可能已关闭，忽略
      }
    }
  }
}


export async function takeScreenshot(input = {}) {
  const tabId = input && input.tabId;
  if (!Number.isInteger(tabId)) return maybeStreamCapture(await takeScreenshotRaw(input), input);
  const result = await withOverlaysHidden(tabId, () => takeScreenshotRaw(input));
  return maybeStreamCapture(await attachScreenshotDiff(tabId, result, input), input);
}

async function decodePixels(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally {
    bitmap.close();
  }
}

async function attachScreenshotDiff(tabId, result, input = {}) {
  if (!result || typeof result.dataUrl !== 'string') return result;
  const previous = lastShots.get(tabId);
  if (lastShots.size >= 12 && !lastShots.has(tabId)) lastShots.delete(lastShots.keys().next().value);
  lastShots.set(tabId, { dataUrl: result.dataUrl, width: result.width, height: result.height, at: Date.now() });
  if (input.diff !== true) return result;
  if (!previous || Date.now() - previous.at > 5 * 60 * 1000) {
    return { ...result, diff: { baseline: true, changed: 0, total: 0, ratio: 0, sizeMatch: true } };
  }
  try {
    const [before, after] = await Promise.all([decodePixels(previous.dataUrl), decodePixels(result.dataUrl)]);
    if (before.width !== after.width || before.height !== after.height) {
      return { ...result, diff: { sizeMatch: false, before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height }, changed: 0, total: 0, ratio: 0 } };
    }
    const diff = diffRgba(before.data, after.data, after.width, after.height, { threshold: 0.1 });
    return { ...result, diff: diff ? { sizeMatch: true, ...diff } : { sizeMatch: false, changed: 0, total: 0, ratio: 0 } };
  } catch (error) {
    log('截图差分失败（忽略）：' + ((error && error.message) || error));
    return { ...result, diff: { error: String((error && error.message) || error) } };
  }
}
