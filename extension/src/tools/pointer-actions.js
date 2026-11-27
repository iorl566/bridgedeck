// src/tools/pointer-actions.js —— click/hover/drag/backend 的 trusted 路径。
import { bridgeError } from '../errors.js';
import { execPage, waitForPaint } from '../inject.js';
import { sleep } from '../tabs.js';
import { acquire, isTabArmed, release, send as cdpSend } from '../debugger.js';
import { withForegroundTab } from '../background-execution.js';
import { withOverlaysHidden } from '../overlay-suppress.js';
import { acquireInputLease, releaseInputLease } from '../input-lease.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';
import { shadowRefClick } from './shadow.js';
import { shadowRefs } from './state.js';
import { projectCrossFramePoint } from '../cross-frame-geometry.js';
import { humanHoldDelay, planHumanMove } from '../lib/human-input.js';
import { focusRequested } from '../lib/focus-policy.js';
import { committedEffect } from '../lib/transaction-ledger.js';
import { beginJournaledTransaction } from '../lib/action-journal.js';
import { beginInput } from './keyboard.js';
import {
  coalescePointerMoves,
  guardActionRowAnchor,
  inputEventStamp,
  pointerMoveSummary,
  trustedClickPoint,
} from './pointer-primitives.js';
import { retryTarget, ensureInputFocus } from './action-common.js';
import { withImageDrag } from './visual-drag.js';

const rawClick = pageAction('click');
const rawHover = pageAction('hover');

async function trustedOrFallback(kind, params, fallback) {
  const tabId = requireTabId(params);
  // 复合 frame ref 的坐标是 frame-local；先投影到顶层，再派发 trusted 点击。
  if (Number.isInteger(Number(params.frameId)) && Number(params.frameId) > 0) {
    if (kind === 'click' && params.frameUrl) {
      try {
        const local = await execPage(tabId, 'point', params, Number(params.frameId));
        let projected = await execPage(tabId, 'frame-project-point', { url: params.frameUrl, x: local.x, y: local.y }, 0);
        if (!projected) projected = await projectCrossFramePoint(tabId, { url: params.frameUrl, x: local.x, y: local.y });
        if (projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
          const lease = acquireInputLease(tabId, 'trusted:frame-click');
          let projectedMoves = null;
          try {
            const clickResult = await trustedClickPoint(tabId, projected, { human: params.human === true });
            projectedMoves = clickResult && clickResult.moves ? clickResult.moves : null;
          } finally { releaseInputLease(tabId, lease.token); }
          return { ok: true, trusted: true, via: projected.via || 'frame-projected', x: projected.x, y: projected.y, frameUrl: projected.frameUrl || params.frameUrl, ...(projectedMoves ? { pointer_moves: projectedMoves } : {}) };
        }
      } catch {
        // 投影失败时回退 frame 内 page-lib 点击。
      }
    }
    return fallback(params);
  }
  if (kind === 'click' && params && params.ref) {
    const map = shadowRefs.get(tabId);
    const entry = map && map.get(params.ref);
    if (entry) {
      const point = await shadowRefClick(tabId, entry).catch(() => null);
      if (point) return { ok: true, trusted: true, via: 'closed-shadow-ref', x: point.x, y: point.y };
    }
  }
  if (!(params && params.trusted === true)) return fallback(params);
  if (params && (params.modifiers || (params.button && params.button !== 'left'))) return fallback(params);
  await ensureInputFocus(tabId, params);
  const target = params && params.ref ? { ref: params.ref } : (params && params.selector ? { selector: params.selector } : null);
  if (target && params.force !== true) {
    const hit = await execPage(tabId, 'hit-test', target).catch(() => null);
    if (hit && (hit.state === 'blocked' || hit.state === 'pointer-events-none')) {
      throw bridgeError(
        'E_OCCLUDED',
        '目标在动作前被遮挡（' + hit.state + '）：请先关闭浮层/弹窗，或用 --force 强制派发',
        { hitTest: hit.state, occludedBy: hit.occludedBy || null, rect: hit.rect || null, dispatched: false },
      );
    }
  }
  if (target) {
    let point = null;
    try {
      point = await execPage(tabId, 'point', target);
    } catch {
      point = null;
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const lease = acquireInputLease(tabId, 'trusted:' + kind);
      try {
        // 原生输入事务：每个 CDP 指针事件带单调 timestamp；时钟回退时拒绝派发。
        const endInput = beginInput(tabId, kind);
        try {
          try {
            await acquire(tabId, 'input');
            try {
              await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
              await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
              const path = kind === 'click'
                ? [[point.x - 36, point.y - 18], [point.x - 18, point.y - 6], [point.x, point.y]]
                : [[point.x - 24, point.y - 10], [point.x, point.y]];
              // 连续移动按距离合并：过密采样点不逐条派发，首末点与落点保持不变。
              const movePlan = coalescePointerMoves(path.map(([x, y]) => ({ x, y })), { minDistancePx: 1, maxEvents: 3 });
              for (const step of movePlan.events) {
                const stamp = inputEventStamp(tabId, kind + '-move');
                await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.x, y: step.y, button: 'none', buttons: 0, clickCount: 0, timestamp: stamp.timestamp });
              }
              if (kind === 'click') {
                let pressed = false;
                let pressedAt = null;
                try {
                  const downStamp = inputEventStamp(tabId, 'click-press');
                  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, timestamp: downStamp.timestamp });
                  pressed = true;
                  pressedAt = { x: point.x, y: point.y };
                  const upStamp = inputEventStamp(tabId, 'click-release');
                  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, timestamp: upStamp.timestamp });
                  pressed = false;
                  pressedAt = null;
                } catch (error) {
                  if (pressedAt) {
                    const unknown = new Error('点击已按下但结果未知：' + ((error && error.message) || error));
                    unknown.code = 'E_INTERNAL';
                    unknown.data = { effect_state: 'unknown', cleanup_state: 'failed', phase: 'pointer' };
                    throw unknown;
                  }
                  throw error;
                } finally {
                  if (pressed) {
                    try {
                      const releaseStamp = inputEventStamp(tabId, 'click-release');
                      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, timestamp: releaseStamp.timestamp }).catch(() => {});
                    } catch {
                      // 时钟异常时放弃补发：宁可不发，也不发乱序事件。
                    }
                  }
                }
              }
              return { ok: true, trusted: true, x: point.x, y: point.y, ...committedEffect(), pointer_moves: pointerMoveSummary(movePlan) };
            } finally {
              if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
              await release(tabId, 'input').catch(() => {});
            }
          } catch (error) {
            // 已按下但释放失败：结果未知，禁止再回退成第二次点击；输入时钟异常同样不再派发。
            if (error && error.data && error.data.effect_state === 'unknown') throw error;
            if (error && error.data && error.data.cause === 'clock_regression') throw error;
            // debugger 不可用：回退到页面内点击
          }
        } finally {
          endInput();
        }
      } finally {
        releaseInputLease(tabId, lease.token);
      }
    }
  }
  return fallback(params);
}

async function trustedDrag(params, fallback, tx) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId, params);
  let start;
  if (params.fromPoint && Number.isFinite(params.fromPoint.x) && Number.isFinite(params.fromPoint.y)) {
    // 视觉坐标拖拽：起点已经由 resolveCapturePoint 换算好，不需要再查元素。
    start = { x: params.fromPoint.x, y: params.fromPoint.y };
  } else {
    const fromPoint = await execPage(tabId, 'point', params.from).catch(() => null);
    if (!fromPoint) return fallback(params);
    start = {
      x: fromPoint.x + (Number(params.fromOffsetX) || 0),
      y: fromPoint.y + (Number(params.fromOffsetY) || 0),
    };
  }
  let toPoint = null;
  if (params.to) toPoint = await execPage(tabId, 'point', params.to).catch(() => null);
  const end = toPoint
    ? { x: toPoint.x + (Number(params.toOffsetX) || 0), y: toPoint.y + (Number(params.toOffsetY) || 0) }
    : { x: start.x + (Number(params.dx) || 0), y: start.y + (Number(params.dy) || 0) };
  const steps = Math.max(2, Math.min(60, Number(params.steps) || 10));
  const modifiers = Number(params.modifiers) || 0;
  const holdMs = Math.max(0, Math.min(5000, Number(params.holdMs) || 0));
  const durationMs = Math.max(0, Math.min(5000, Number(params.durationMs) || 0));
  const pause = durationMs > 0 ? Math.min(200, Math.round(durationMs / steps)) : 0;
  const lease = acquireInputLease(tabId, 'trusted:drag', 30000);
  const endInput = beginInput(tabId, 'pointer');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      const startStamp = inputEventStamp(tabId, 'drag-move');
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, clickCount: 0, modifiers, timestamp: startStamp.timestamp });
      // 拖拽路径按距离合并（保留首末点与落点），避免 60 步逐条往返。
      const dragPath = [];
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        dragPath.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, delay: pause });
      }
      const movePlan = coalescePointerMoves(dragPath, {
        minDistancePx: params.moveMinDistancePx !== undefined ? params.moveMinDistancePx : 1,
        maxEvents: steps,
      });
      let pressed = false;
      let pressedAtDrag = null;
      if (tx) tx.markDispatched({ phase: 'drag-press', steps: movePlan.kept });
      try {
        const downStamp = inputEventStamp(tabId, 'drag-press');
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers, timestamp: downStamp.timestamp });
        pressed = true;
        pressedAtDrag = { x: start.x, y: start.y };
        if (holdMs > 0) await sleep(holdMs);
        for (const step of movePlan.events) {
          const stepStamp = inputEventStamp(tabId, 'drag-move');
          await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.x, y: step.y, button: 'left', buttons: 1, modifiers, timestamp: stepStamp.timestamp });
          if (step.delay) await sleep(step.delay);
        }
        const upStamp = inputEventStamp(tabId, 'drag-release');
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers, timestamp: upStamp.timestamp });
        pressed = false;
        pressedAtDrag = null;
      } catch (error) {
        if (pressedAtDrag) {
          throw bridgeError('E_INTERNAL', '拖拽已按下但结果未知：' + ((error && error.message) || error), {
            effect_state: 'unknown', cleanup_state: 'failed', phase: 'pointer',
          });
        }
        throw error;
      } finally {
        if (pressed) {
          try {
            const releaseStamp = inputEventStamp(tabId, 'drag-release');
            await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers, timestamp: releaseStamp.timestamp }).catch(() => {});
          } catch {
            // 时钟异常时放弃补发。
          }
        }
      }
      return { ok: true, trusted: true, from: start, to: end, hit: params.hitAt || undefined, ...committedEffect(), pointer_moves: pointerMoveSummary(movePlan) };
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
    endInput();
  }
}

/** 动作前行锚点守卫：params.rowAnchor 存在才启用；不稳定抛 E_TARGET_MISMATCH（data.guard='virtual-row'）。 */
async function guardRowAnchorForAction(params) {
  const rowAnchor = params && (params.rowAnchor || params.row_anchor);
  if (!rowAnchor || typeof rowAnchor !== 'object') return null;
  const tabId = Number.isInteger(Number(params.tabId)) ? Number(params.tabId) : null;
  return guardActionRowAnchor(tabId, params);
}

export async function click(params = {}) {
  // 复合 RefKey 命中 backendNodeId 时优先走 CDP 节点路由；页面内 @eN 只做回退。
  // clickBackend 自带守卫与事务，避免同一次点击落两条 journal。
  if (Number.isInteger(params.backendNodeId) && params.backendNodeId > 0) return clickBackend(params);
  const rowGuard = await guardRowAnchorForAction(params);
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'click', params, phase: 'pointer' });
  try {
    const result = await retryTarget(params, () => {
      if (params && params.trusted === true && Number.isInteger(params.tabId)) {
        return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('click', params, rawClick)), { focus: focusRequested(params) });
      }
      return trustedOrFallback('click', params, rawClick);
    });
    await tx.commit({ details: { via: result && result.via ? result.via : null } });
    return {
      ...result,
      ...tx.fields(),
      ...(degraded ? { journal_degraded: true } : {}),
      ...(recovered.length ? { journal_recovered: recovered } : {}),
      ...(rowGuard ? { row_guard: rowGuard } : {}),
    };
  } catch (error) {
    // UNKNOWN 且清理失败（例如按下滑块后释放失败）：单独落一条 cleanup 证据。
    await tx.fail(error);
    if (error && error.data && error.data.effect_state === 'unknown' && error.data.cleanup_state === 'failed') {
      await tx.cleanupFailed({ release: 'failed', phase: tx.phase });
    }
    throw error;
  }
}

/**
 * click-backend：按 backendNodeId 点击 AX/DOMSnapshot 发现、但没有 @eN ref 的元素
 *（closed shadow、page-lib 漏掉的节点）。动作前做滚动/可见性/遮挡检查，
 * 然后派发 CDP 原生鼠标事件（isTrusted=true）。
 */
export async function clickBackend(params = {}) {
  const rowGuard = await guardRowAnchorForAction(params);
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'click-backend', params, phase: 'pointer' });
  try {
    const result = await clickBackendTrusted(params, tx);
    await tx.commit({ details: { backendNodeId: result && result.backendNodeId ? result.backendNodeId : null } });
    return {
      ...result,
      ...tx.fields(),
      ...(degraded ? { journal_degraded: true } : {}),
      ...(recovered.length ? { journal_recovered: recovered } : {}),
      ...(rowGuard ? { row_guard: rowGuard } : {}),
    };
  } catch (error) {
    // UNKNOWN 且清理失败（例如按下滑块后释放失败）：单独落一条 cleanup 证据。
    await tx.fail(error);
    if (error && error.data && error.data.effect_state === 'unknown' && error.data.cleanup_state === 'failed') {
      await tx.cleanupFailed({ release: 'failed', phase: tx.phase });
    }
    throw error;
  }
}

async function clickBackendTrusted(params, tx) {
  const tabId = requireTabId(params);
  const backendId = Number(params.backendId != null ? params.backendId : params.backendNodeId);
  if (!Number.isInteger(backendId) || backendId <= 0) {
    throw bridgeError('E_BAD_ARG', 'click-backend 需要 backendId 正整数');
  }
  await acquire(tabId, 'click-backend');
  await ensureInputFocus(tabId, params).catch(() => {});
  await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  let endInput = null;
  try {
    endInput = beginInput(tabId, 'click-backend');
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: backendId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) throw bridgeError('E_NOT_FOUND', 'backendNodeId 已失效或不在当前文档');
    const checked = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      awaitPromise: false,
      functionDeclaration: `function () {
        const el = this;
        if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'zero-size' };
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
          return { ok: false, reason: 'not-actionable' };
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const root = el.getRootNode();
        if (root === document) {
          const hit = document.elementFromPoint(x, y);
          if (!hit) return { ok: false, reason: 'no-hit' };
          if (hit !== el && !el.contains(hit)) return { ok: false, reason: 'occluded', by: hit.tagName };
        }
        return { ok: true, x, y };
      }`,
    });
    const value = checked && checked.result ? checked.result.value : null;
    if (!value || value.ok !== true) {
      const reason = value && value.reason ? value.reason : 'unknown';
      if (reason === 'occluded') {
        throw bridgeError('E_OCCLUDED', '目标被遮挡：' + (value.by || 'unknown'), {
          hitTest: 'blocked', backendNodeId: backendId, dispatched: false,
        });
      }
      throw bridgeError('E_NOT_ACTIONABLE', 'backend 节点当前不可点击（' + reason + '）', {
        backendNodeId: backendId, reason, dispatched: false,
      });
    }
    const x = Math.round(Number(value.x) * 100) / 100;
    const y = Math.round(Number(value.y) * 100) / 100;
    const moveStamp = inputEventStamp(tabId, 'click-backend-move');
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, timestamp: moveStamp.timestamp });
    let pressed = false;
    let pressedAtBackend = null;
    if (tx) tx.markDispatched({ phase: 'click-backend-press', backendNodeId: backendId });
    try {
      const downStamp = inputEventStamp(tabId, 'click-backend-press');
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, timestamp: downStamp.timestamp });
      pressed = true;
      pressedAtBackend = { x, y };
      const upStamp = inputEventStamp(tabId, 'click-backend-release');
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, timestamp: upStamp.timestamp });
      pressed = false;
      pressedAtBackend = null;
    } catch (error) {
      if (pressedAtBackend) {
        throw bridgeError('E_INTERNAL', 'click-backend 已按下但结果未知：' + ((error && error.message) || error), {
          effect_state: 'unknown', cleanup_state: 'failed', phase: 'pointer', backendNodeId: backendId,
        });
      }
      throw error;
    } finally {
      if (pressed) {
        try {
          const releaseStamp = inputEventStamp(tabId, 'click-backend-release');
          await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, timestamp: releaseStamp.timestamp }).catch(() => {});
        } catch {
          // 时钟异常时放弃补发。
        }
      }
    }
    return { ok: true, trusted: true, via: 'cdp-backend', backendNodeId: backendId, x, y, ...committedEffect() };
  } finally {
    if (!isTabArmed(tabId)) await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    if (endInput) endInput();
    await release(tabId, 'click-backend').catch(() => {});
  }
}

/**
 * 3–4 步 fast path：页面内聚焦并选中 → CDP insertText → 页面内校验。
 * 省掉鼠标点击、Ctrl+A、焦点仿真与置前；不适合的控件返回 null 走原 trustedFill。
 */
/** fill 校验结果的对外字段：敏感字段只回 formatted，其余回 actual_value（截断 200）。 */

const rawDrag = pageAction('drag');
export async function drag(params = {}) {
  const effective = await withImageDrag(params);
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'drag', params: effective || params, phase: 'pointer' });
  try {
    if (!effective || effective.trusted !== true) {
      const result = await rawDrag(effective);
      await tx.commit({ details: { via: result && result.via ? result.via : 'page-drag' } });
      return { ...result, ...tx.fields(), ...(degraded ? { journal_degraded: true } : {}), ...(recovered.length ? { journal_recovered: recovered } : {}) };
    }
    const run = () => trustedDrag(effective, rawDrag, tx).catch((error) => {
      if (error && error.code === 'E_INPUT_BUSY') throw error;
      // 已按下/时钟回退：结果不可信，不再派发任何回退事件（unknown 不得自动重放）。
      if (error && error.data && (error.data.effect_state === 'unknown' || error.data.cause === 'clock_regression')) throw error;
      if (tx && tx.effectState === 'unknown') throw error;
      // 视觉坐标拖拽没有页面内等价物：起点是像素坐标，页面库拿不到元素。
      if (effective.capture != null) throw error;
      return rawDrag(effective);
    });
    const result = Number.isInteger(effective.tabId) ? await withForegroundTab(effective.tabId, () => withOverlaysHidden(effective.tabId, run), { focus: focusRequested(effective) }) : await run();
    await tx.commit({ details: { from: result && result.from ? result.from : null, to: result && result.to ? result.to : null } });
    return { ...result, ...tx.fields(), ...(degraded ? { journal_degraded: true } : {}), ...(recovered.length ? { journal_recovered: recovered } : {}) };
  } catch (error) {
    // UNKNOWN 且清理失败（例如按下滑块后释放失败）：单独落一条 cleanup 证据。
    await tx.fail(error);
    if (error && error.data && error.data.effect_state === 'unknown' && error.data.cleanup_state === 'failed') {
      await tx.cleanupFailed({ release: 'failed', phase: tx.phase });
    }
    throw error;
  }
}

/**
 * 视觉坐标拖拽：把截图像素坐标换成页面坐标，并强制走可信输入。
 * 页面内合成事件对 canvas 验证码一类控件无效，所以这里不做回退——
 * 坐标拖拽只有 CDP 这一条路，失败就让调用方看到真实错误。
 */

export async function hover(params = {}) {
  const rowGuard = await guardRowAnchorForAction(params);
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'hover', params, phase: 'pointer' });
  try {
    const result = await retryTarget(params, () => {
      if (params && params.trusted === true && Number.isInteger(params.tabId)) {
        return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('hover', params, rawHover)), { focus: focusRequested(params) });
      }
      return trustedOrFallback('hover', params, rawHover);
    });
    await tx.commit({ details: { via: result && result.via ? result.via : null } });
    return {
      ...result,
      ...tx.fields(),
      ...(degraded ? { journal_degraded: true } : {}),
      ...(recovered.length ? { journal_recovered: recovered } : {}),
      ...(rowGuard ? { row_guard: rowGuard } : {}),
    };
  } catch (error) {
    // UNKNOWN 且清理失败（例如按下滑块后释放失败）：单独落一条 cleanup 证据。
    await tx.fail(error);
    if (error && error.data && error.data.effect_state === 'unknown' && error.data.cleanup_state === 'failed') {
      await tx.cleanupFailed({ release: 'failed', phase: tx.phase });
    }
    throw error;
  }
}

