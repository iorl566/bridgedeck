// src/screenshot.js —— screenshot 命令：chrome.tabs.captureVisibleTab + 整页拼接
import { bridgeError, mapChromeError } from './errors.js';
import { withTimeout } from './timeout.js';
import { acquire, release, send as cdpSend } from './debugger.js';
import { execPage } from './inject.js';
import { getTab, sleep } from './tabs.js';
import { log } from './log.js';
import { withOverlaysHidden } from './overlay-suppress.js';
import { planCaptureTiles, pruneCaptures, sameFrame } from './longshot.js';
import { layoutCanvas } from './longshot-render.js';
import { nextGrowthTiles, tileForScroll } from './longshot-schedule.js';

const CAPTURE_INTERVAL_MS = 550; // captureVisibleTab 限速约 2 次/秒
const MAX_FULL_PAGE_FRAMES = 8;
const MAX_CANVAS_HEIGHT = 16000;
let lastCdpFailure = '';
const captures = new Map(); // captureId -> { tabId, scale, scrollX, scrollY, width, height, refs, at, url }
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

function rememberCapture(capture) {
  captures.set(capture.id, capture);
  pruneCaptures(captures, { ttlMs: CAPTURE_TTL_MS, max: CAPTURE_MAX });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

/** 在截图上画 @eN 方框与标签。 */
async function annotateShot(dataUrl, refs, scale) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  ctx.lineWidth = 2;
  ctx.font = 'bold ' + Math.max(12, Math.round(12 * scale)) + 'px Segoe UI, sans-serif';
  for (const item of refs) {
    const x = Math.round(item.x * scale);
    const y = Math.round(item.y * scale);
    const width = Math.round(item.width * scale);
    const height = Math.round(item.height * scale);
    ctx.strokeStyle = 'rgba(47,111,237,0.95)';
    ctx.fillStyle = 'rgba(47,111,237,0.12)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    const label = item.ref;
    const metrics = ctx.measureText(label);
    const padX = Math.round(4 * scale);
    const padY = Math.round(2 * scale);
    const labelHeight = Math.round(14 * scale);
    const labelWidth = Math.round(metrics.width + padX * 2);
    const labelY = y - labelHeight < 0 ? y : y - labelHeight;
    ctx.fillStyle = 'rgba(47,111,237,0.95)';
    ctx.fillRect(x, labelY, labelWidth, labelHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + padX, labelY + labelHeight - padY * 2);
  }
  const output = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(output);
}

/** 按截图坐标点击（Canvas/视觉引用）。 */
export async function clickByImage(params = {}) {
  const tabId = Number(params.tabId);
  const capture = getCapture(params.capture);
  if (!capture) throw bridgeError('E_CAPTURE_STALE', 'capture 不存在或已过期，请重新截图');
  if (Number.isInteger(tabId) && capture.tabId !== tabId) {
    throw bridgeError('E_BAD_ARG', 'capture 属于另一个标签页');
  }
  const imageX = Number(params.imageX);
  const imageY = Number(params.imageY);
  if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
    throw bridgeError('E_BAD_ARG', '需要 imageX/imageY');
  }
  const x = capture.scrollX + imageX / capture.scale;
  const y = capture.scrollY + imageY / capture.scale;
  try {
    await acquire(capture.tabId, 'image-click');
    try {
      await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdpSend(capture.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } finally {
      await release(capture.tabId, 'image-click').catch(() => {});
    }
    return { ok: true, x: Math.round(x), y: Math.round(y), via: 'cdp', capture: capture.id };
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

export async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
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
      if (!/readback|failed to capture/i.test(message)) break;
      log(`截图失败第 ${attempt + 1} 次（${message}），置前后重试`);
      try {
        await withTimeout(chrome.windows.update(windowId, { state: 'normal' }), 3000, 'windows.update');
        await withTimeout(chrome.windows.update(windowId, { focused: true }), 3000, 'windows.update');
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
  for (const placement of layout.placements) {
    const frame = frames[placement.index];
    context.drawImage(frame.bitmap, 0, placement.drawY);
    frame.bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  log(`整页截图拼合 ${frames.length} 帧，尺寸 ${width}x${height}`);
  return { dataUrl, width, height };
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
async function captureRegion(tab, region) {
  const x = Math.max(0, Number(region.x) || 0);
  const y = Math.max(0, Number(region.y) || 0);
  const width = Math.max(1, Number(region.width) || 1);
  const height = Math.max(1, Number(region.height) || 1);
  const result = await withTimeout(cdpSend(tab.id, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale: 1 },
    captureBeyondViewport: true,
  }), 10000, 'Page.captureScreenshot region');
  if (!result || typeof result.data !== 'string' || !result.data) throw bridgeError('E_INTERNAL', '区域截图没有返回数据');
  const dataUrl = 'data:image/png;base64,' + result.data;
  const size = pngSize(dataUrl);
  return { dataUrl, width: size.width, height: size.height };
}

/** CDP 截图：不受窗口焦点影响，后台标签页也能拍；失败时由调用方回退。 */
async function captureViaCdp(tab, params) {
  const tabId = tab.id;
  const dbg = await withTimeout(acquire(tabId, 'screenshot'), 5000, 'debugger.attach');
  try {
    let options = { format: 'png' };
    if (params.region && typeof params.region === 'object') {
      const x = Math.max(0, Number(params.region.x) || 0);
      const y = Math.max(0, Number(params.region.y) || 0);
      const width = Math.max(1, Number(params.region.width) || 1);
      const height = Math.max(1, Number(params.region.height) || 1);
      options = { format: 'png', captureBeyondViewport: true, clip: { x, y, width, height, scale: 1 } };
    } else if (params.fullPage === true) {
      const metrics = await execPage(tabId, 'page-metrics', {});
      const width = Math.max(1, Math.round(metrics.scrollWidth || metrics.innerWidth));
      const height = Math.max(1, Math.round(metrics.scrollHeight));
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
    if (params.annotate === true && params.fullPage !== true && !params.ref && !params.selector) {
      const visual = await execPage(tabId, 'visual-refs', {}).catch(() => null);
      if (visual && Array.isArray(visual.refs) && visual.innerWidth > 0) {
        const scale = size.width / visual.innerWidth;
        dataUrl = await annotateShot(dataUrl, visual.refs, scale);
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
          visual_refs: visual.refs.map((item) => ({
            ref: item.ref,
            role: item.role,
            name: item.name,
            image_x: Math.round(item.x * scale + item.width * scale / 2),
            image_y: Math.round(item.y * scale + item.height * scale / 2),
            x: Math.round(item.x * scale),
            y: Math.round(item.y * scale),
            width: Math.round(item.width * scale),
            height: Math.round(item.height * scale),
          })),
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
  // 截图需要目标窗口可见可读（后台/最小化窗口会 readback failed），临时置前后恢复
  let previousFocusedId = null;
  try {
    const focused = await withTimeout(chrome.windows.getLastFocused(), 3000, 'windows.getLastFocused');
    previousFocusedId = focused && focused.id != null ? focused.id : null;
  } catch {
    previousFocusedId = null;
  }
  let focusedByUs = false;
  if (previousFocusedId !== windowId) {
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
  if (!tab.active) {
    try {
      await withTimeout(chrome.tabs.update(tabId, { active: true }), 3000, 'tabs.update');
      activated = true;
      await sleep(150);
    } catch (error) {
      throw mapChromeError(error, '激活截图目标 tab 失败');
    }
  }

  try {
    if (params.region && typeof params.region === 'object') return await captureRegion(tab, params.region);
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
  if (!Number.isInteger(tabId)) return takeScreenshotRaw(input);
  return withOverlaysHidden(tabId, () => takeScreenshotRaw(input));
}
