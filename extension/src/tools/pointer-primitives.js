// src/tools/pointer-primitives.js —— 指针位置、移动合并、trusted 点位点击与行锚点守卫。
import { sleep } from '../tabs.js';
import { bridgeError } from '../errors.js';
import { evalInMain, execPage } from '../inject.js';
import { send as cdpSend } from '../debugger.js';
import { armCooperationExpectation } from '../cooperation.js';
import { humanHoldDelay, planHumanMove } from '../lib/human-input.js';
import { inputTransactions } from '../lib/input-transaction.js';
import {
  buildRowAnchorProbeExpression,
  checkRowAnchor,
  compareRowAnchor,
  hasLegacyRowFacts,
  normalizeRowAnchor,
  parseRowAnchorProbe,
} from '../lib/virtual-row-guard.js';
import { beginInput } from './keyboard.js';

const pointerPositions = new Map();

/** 给 CDP 指针事件取单调时间戳（秒）；时钟回退/乱序时不派发，直接抛结构化错误。 */
export function inputEventStamp(tabId, phase) {
  const stamp = inputTransactions.stamp(tabId);
  if (stamp.ok !== true) {
    throw bridgeError('E_INTERNAL', '原生输入时钟异常（' + String(stamp.cause || 'unknown') + '），本次 ' + phase + ' 未派发', {
      ...stamp.evidence,
      clock: 'input',
      cause: stamp.cause || 'clock_regression',
      phase,
      dispatched: false,
    });
  }
  return stamp;
}

/** tab 关闭时清掉鼠标位置缓存，避免按 tabId 无界增长。 */
export function forgetPointerPosition(tabId) {
  const id = Number(tabId);
  if (Number.isInteger(id)) pointerPositions.delete(id);
}

// ---------------------------------------------------------------------------
// 指针移动合并（coalesce）：连续移动事件按“最小距离 + 最大事件数”节流。
// 原生输入只关心终点是否到达；合并掉过密的中间点能降低 CDP 往返与页面抖动，
// 同时保留首点/末点，保证轨迹方向与落点不变。返回结构化结果供调用方记录证据。
// ---------------------------------------------------------------------------

export const POINTER_COALESCE_DEFAULTS = Object.freeze({
  minDistancePx: 2,
  maxEvents: 24,
  keepFirst: true,
  keepLast: true,
});

function normalizeMove(move) {
  if (!move || typeof move !== 'object') return null;
  const x = Number(move.x);
  const y = Number(move.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    ...(Number.isFinite(Number(move.delay)) && Number(move.delay) > 0 ? { delay: Number(move.delay) } : {}),
  };
}

function thinEvents(events, maxEvents, dropped) {
  if (!Number.isInteger(maxEvents) || maxEvents <= 1 || events.length <= maxEvents) return events;
  const step = (events.length - 1) / (maxEvents - 1);
  const keepIndexes = new Set();
  for (let index = 0; index < maxEvents; index += 1) {
    const pick = index === maxEvents - 1 ? events.length - 1 : Math.round(index * step);
    keepIndexes.add(pick);
  }
  const kept = [];
  events.forEach((event, index) => {
    if (keepIndexes.has(index)) kept.push(event);
    else dropped.push({ index: event.index, reason: 'over-cap', x: event.x, y: event.y });
  });
  return kept;
}

/**
 * 合并连续指针移动。
 * @param {Array<{x:number,y:number,delay?:number}>} moves
 * @param {{minDistancePx?:number,maxEvents?:number,keepLast?:boolean}} [options]
 * @returns {{ok:boolean,events:Array,dropped:Array,planned:number,kept:number,minDistancePx:number,maxEvents:number,droppedReasons:object,last:object|null}}
 */
export function coalescePointerMoves(moves, options = {}) {
  const input = Array.isArray(moves) ? moves : [];
  const minDistancePx = Number.isFinite(options.minDistancePx)
    ? Math.max(0, Number(options.minDistancePx))
    : POINTER_COALESCE_DEFAULTS.minDistancePx;
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0
    ? Number(options.maxEvents)
    : POINTER_COALESCE_DEFAULTS.maxEvents;
  const dropped = [];
  const events = [];
  let last = null;
  input.forEach((move, index) => {
    const point = normalizeMove(move);
    if (!point) {
      dropped.push({ index, reason: 'bad-point' });
      return;
    }
    if (!last) {
      events.push({ ...point, index, merged: 0 });
      last = point;
      return;
    }
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const distancePx = Math.hypot(dx, dy);
    if (distancePx < minDistancePx) {
      dropped.push({ index, reason: 'too-close', x: point.x, y: point.y, distancePx: Math.round(distancePx * 100) / 100 });
      return;
    }
    const previousIndex = events.length ? events[events.length - 1].index : index;
    events.push({ ...point, index, merged: Math.max(0, index - previousIndex - 1) });
    last = point;
  });
  let kept = thinEvents(events, maxEvents, dropped);
  // 末点必须保留：合并后最后一个事件坐标就是调用方要落的位置。
  const finalMove = input.length ? normalizeMove(input[input.length - 1]) : null;
  if (options.keepLast !== false && finalMove && kept.length) {
    const tail = kept[kept.length - 1];
    if (tail.x !== finalMove.x || tail.y !== finalMove.y) {
      kept[kept.length - 1] = { ...tail, x: finalMove.x, y: finalMove.y, snappedToLast: true };
    }
  }
  if (options.keepFirst !== false && kept.length === 0 && finalMove) {
    kept = [{ ...finalMove, index: input.length - 1, merged: Math.max(0, input.length - 1) }];
  }
  const droppedReasons = {};
  for (const item of dropped) droppedReasons[item.reason] = (droppedReasons[item.reason] || 0) + 1;
  return {
    ok: true,
    events: kept,
    dropped,
    planned: input.length,
    kept: kept.length,
    minDistancePx,
    maxEvents,
    droppedReasons,
    last: kept.length ? { x: kept[kept.length - 1].x, y: kept[kept.length - 1].y } : null,
  };
}

/** 供动作结果复用的移动计划摘要（不包含每个点坐标，避免回执膨胀）。 */
export function pointerMoveSummary(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    planned: Number.isInteger(plan.planned) ? plan.planned : 0,
    kept: Number.isInteger(plan.kept) ? plan.kept : 0,
    dropped: Array.isArray(plan.dropped) ? plan.dropped.length : 0,
    min_distance_px: plan.minDistancePx,
    max_events: plan.maxEvents,
    dropped_reasons: plan.droppedReasons || {},
    last: plan.last || null,
  };
}

// ---------------------------------------------------------------------------
// 行锚点守卫（动作层）：读取“当前行事实”，与 observe 时的 anchor 比对。
// 读取链路：page-lib 只读命令 row-anchor（W1 提供）→ 回退 MAIN world 等价探针
// （旧页面库/未刷新 tab）。两路都失败时 fail-closed：拒绝派发，而不是盲填。
// ---------------------------------------------------------------------------

const ROW_GUARD_SKIP_CAUSES = new Set(['no-expected-anchor', 'no-anchor-identity']);

function rowGuardError(comparison, probe, extra = {}) {
  return bridgeError('E_TARGET_MISMATCH', comparison && comparison.message
    ? comparison.message
    : '目标所在行不稳定，请重新 observe 后再操作', {
    guard: 'virtual-row',
    stable: false,
    reason: comparison && comparison.reason ? comparison.reason : 'unknown',
    row_index: comparison && comparison.rowIndex !== undefined ? comparison.rowIndex : null,
    kind: comparison && comparison.kind ? comparison.kind : null,
    checks: comparison && Array.isArray(comparison.checks) ? comparison.checks : [],
    evidence: comparison && comparison.evidence ? comparison.evidence : null,
    anchor_source: probe && probe.via ? probe.via : null,
    probe_cause: probe && probe.cause ? probe.cause : null,
    probe_ok: Boolean(probe && probe.ok === true),
    dispatched: false,
    replay: false,
    ...extra,
  });
}

/**
 * 读取动作前的当前行事实。
 * deps.execPage / deps.evalInMain 可注入，便于单测模拟页面侧行为。
 */
export async function readRowAnchorFacts(tabId, params, deps = {}) {
  const execPageFn = typeof deps.execPage === 'function' ? deps.execPage : execPage;
  const evalInMainFn = typeof deps.evalInMain === 'function' ? deps.evalInMain : evalInMain;
  const source = params && typeof params === 'object' ? params : {};
  const target = source.ref ? { ref: source.ref } : (source.selector ? { selector: source.selector } : null);
  const frameId = Number.isInteger(Number(source.frameId)) ? Number(source.frameId) : 0;
  if (!target) return { ok: false, cause: 'no-target', anchor: null, via: null };
  // MAIN world 探针只能覆盖主文档；frame 内目标 fail-closed（不可证明稳定）。
  if (frameId > 0) return { ok: false, cause: 'frame-unsupported', anchor: null, via: null };

  // 1) 首选 page-lib 只读命令：与 observe 侧共用 rowFactsOf，字段完全一致。
  try {
    const answer = await execPageFn(tabId, 'row-anchor', { ...target }, frameId);
    if (answer && typeof answer === 'object' && Object.prototype.hasOwnProperty.call(answer, 'anchor')) {
      const anchor = answer.anchor == null ? null : normalizeRowAnchor(answer.anchor);
      return {
        ok: true,
        cause: anchor ? 'anchor' : 'no-anchor',
        anchor,
        via: 'page-lib:row-anchor',
        revision: Number.isInteger(Number(answer.revision)) ? Number(answer.revision) : null,
      };
    }
  } catch (error) {
    const code = error && error.code ? String(error.code) : '';
    if (code === 'E_STALE_REF') return { ok: false, cause: 'target-detached', anchor: null, via: 'page-lib:row-anchor', code };
    if (code === 'E_NOT_FOUND') return { ok: false, cause: 'target-not-found', anchor: null, via: 'page-lib:row-anchor', code };
    // E_UNKNOWN_METHOD（旧页面库）以及注入类错误：回退到 MAIN world 探针。
  }

  // 2) 回退：ref-selector 换稳定 selector，再在主世界跑等价探针。
  let selector = target.selector ? String(target.selector) : null;
  if (!selector && target.ref) {
    try {
      const meta = await execPageFn(tabId, 'ref-selector', { ref: target.ref }, frameId);
      selector = meta && meta.selector ? String(meta.selector) : null;
    } catch (error) {
      const code = error && error.code ? String(error.code) : '';
      if (code === 'E_STALE_REF' || code === 'E_NOT_FOUND') {
        return { ok: false, cause: code === 'E_NOT_FOUND' ? 'target-not-found' : 'target-detached', anchor: null, via: 'main-world-probe', code };
      }
    }
  }
  if (!selector) return { ok: false, cause: 'no-selector', anchor: null, via: 'main-world-probe' };
  try {
    const raw = await evalInMainFn(tabId, buildRowAnchorProbeExpression({ selector }));
    const payload = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'value') ? raw.value : raw;
    const parsed = parseRowAnchorProbe(payload);
    return { ...parsed, via: 'main-world-probe' };
  } catch (error) {
    return { ok: false, cause: 'probe-failed', anchor: null, via: 'main-world-probe', code: error && error.code ? String(error.code) : null };
  }
}

/**
 * fill/click 的动作前守卫：params.rowAnchor 存在才启用。
 * - 期望 anchor 自带 recycled/previous* 证据时，先做一次纯函数分类（不需要碰页面）；
 * - 然后读取当前 anchor 比对；不稳定抛 E_TARGET_MISMATCH（data.guard='virtual-row'）；
 * - 稳定返回 row_guard 字段（含来源、revision、检查项与摘要）。
 */
export async function guardActionRowAnchor(tabId, params, deps = {}) {
  const source = params && typeof params === 'object' ? params : {};
  const expected = source.rowAnchor && typeof source.rowAnchor === 'object' ? source.rowAnchor
    : (source.row_anchor && typeof source.row_anchor === 'object' ? source.row_anchor : null);
  if (!expected) return null;
  if (deps.precheckError) throw deps.precheckError;
  // 没有可定位目标（纯坐标动作）：行锚点无意义，按“未启用”处理。
  if (!source.ref && !source.selector) return null;
  // legacy 分类字段（previous*/detached/containerRecycled）：纯函数先判，不碰页面。
  if (hasLegacyRowFacts(expected)) {
    const classification = checkRowAnchor(expected);
    if (classification.ok !== true) {
      throw bridgeError('E_TARGET_MISMATCH', classification.message, {
        guard: 'virtual-row',
        stable: false,
        reason: classification.classification.reason,
        row_index: classification.classification.rowIndex,
        kind: classification.classification.kind,
        checks: classification.classification.checks,
        evidence: classification.evidence,
        anchor_source: 'legacy-classifier',
        dispatched: false,
        replay: false,
      });
    }
  }
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) {
    return null;
  }
  const probe = await readRowAnchorFacts(Number(tabId), source, deps);
  let comparison;
  if (probe.ok === false && ROW_GUARD_SKIP_CAUSES.has(probe.cause)) {
    comparison = { ok: true, stable: null, guard: 'virtual-row', skipped: true, reason: probe.cause };
  } else {
    comparison = compareRowAnchor(expected, probe.anchor, {
      cause: probe.cause,
      scrollTolerancePx: deps.scrollTolerancePx,
      transformTolerancePx: deps.transformTolerancePx,
    });
  }
  if (comparison.ok !== true) throw rowGuardError(comparison, probe);
  return {
    guard: 'virtual-row',
    stable: comparison.stable === true,
    skipped: comparison.skipped === true,
    reason: comparison.reason,
    row_index: comparison.rowIndex !== undefined ? comparison.rowIndex : null,
    kind: comparison.kind || null,
    anchor_source: probe.via || null,
    revision: probe.revision == null ? null : probe.revision,
    probe_cause: probe.cause || null,
    checks: Array.isArray(comparison.checks) ? comparison.checks : [],
    expected: comparison.evidence ? comparison.evidence.expected || null : null,
    current: comparison.evidence ? comparison.evidence.current || null : null,
    dispatched: false,
  };
}

// ---------------------------------------------------------------------------
// trusted 点位点击
// ---------------------------------------------------------------------------

export async function trustedClickPoint(tabId, point, options = {}) {
  const endInput = beginInput(tabId, 'pointer');
  try {
    const human = options && options.human === true;
    let movePlan = null;
    if (human) {
      const from = pointerPositions.get(tabId) || { x: point.x, y: point.y };
      // 人形轨迹按距离合并：过密的采样点不逐条派发，保留首末点与方向。
      movePlan = coalescePointerMoves(planHumanMove(from, point), {
        minDistancePx: options.minMoveDistancePx !== undefined ? options.minMoveDistancePx : 2,
        maxEvents: options.maxMoveEvents !== undefined ? options.maxMoveEvents : 12,
      });
      for (const step of movePlan.events) {
        const stamp = inputEventStamp(tabId, 'click-move');
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.x, y: step.y, button: 'none', buttons: 0, clickCount: 0, timestamp: stamp.timestamp });
        if (step.delay) await sleep(step.delay);
      }
      pointerPositions.set(tabId, { x: point.x, y: point.y });
    } else {
      pointerPositions.set(tabId, { x: point.x, y: point.y });
    }
    await armCooperationExpectation(tabId, { kinds: ['pointer', 'focus'], x: point.x, y: point.y }).catch(() => {});
    const moveStamp = inputEventStamp(tabId, 'click-move');
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, clickCount: 0, timestamp: moveStamp.timestamp });
    let pressed = false;
    try {
      if (human) await sleep(humanHoldDelay());
      const downStamp = inputEventStamp(tabId, 'click-press');
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, timestamp: downStamp.timestamp });
      pressed = true;
      if (human) await sleep(humanHoldDelay());
      const upStamp = inputEventStamp(tabId, 'click-release');
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, timestamp: upStamp.timestamp });
      pressed = false;
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
    return { ok: true, moves: movePlan ? pointerMoveSummary(movePlan) : null };
  } finally {
    endInput();
  }
}
