// extension/src/lib/replay-boundary-plan.js —— 边界“还原”规划（纯函数，零 chrome 依赖）。
//
// replay-boundary.js 只回答“两个边界是否同一窗口”；本文件回答“录制里跨了哪些窗口、
// 回放时每一步之前要先做什么才能进入录制的那个窗口”：
//   - boundaryEpochs：按硬边界把 step 切成 epoch（文档/帧/tab 切换），revision/URL
//     这类软变化不切 epoch，而是记进 epoch.revisions / epoch.urlChanges 供重新绑定；
//   - planBoundaryRestoration：与 steps 等长的逐步动作（continue / navigate /
//     frame-switch / tab-switch / re-resolve / check-document / abort）；
//   - matchBoundaryEpoch / resumeFromBoundary：从当前身份定位可恢复的起点；
//   - verifyBoundarySequence：录制顺序自检（丢事件、覆盖缺口、documentId 复用）。
//
// 不变量：换文档拿不到 URL、换帧拿不到帧、换 tab 拿不到 tabId 时一律 abort + 原因，
// 绝不用“当前页面”或“最后一个已知 URL”去猜；同输入同输出（无时钟/随机数）。
//
// 运行时消费者：extension/src/lib/replay-plan.js（组织回放计划）与
// extension/src/replay.js（命令路径接线、输出 replay 字段）。

import {
  BOUNDARY_CODES,
  BOUNDARY_LIMITS,
  BOUNDARY_RELATIONS,
  REPLAY_BOUNDARY_VERSION,
  boundaryFromStep,
  compareBoundary,
  findFrame,
  normalizeBoundary,
  normalizeBoundaryMode,
  normalizeFrameId,
  normalizeFrameList,
} from './replay-boundary.js';
import { stableHash } from '../record-steps.js';

// ---------------------------------------------------------------------------
// 边界分段（epoch）
// ---------------------------------------------------------------------------

/** 从 step 判断边界类型：document / tab / window / frame / step。 */
export function boundaryKindOfStep(step) {
  if (!step || typeof step !== 'object') return 'step';
  const branch = step.branch && typeof step.branch === 'object' ? step.branch : null;
  if (branch && typeof branch.boundary === 'string' && branch.boundary) {
    return String(branch.boundary);
  }
  if (step.method === 'navigate' || step.kind === 'branch') return 'document';
  return 'step';
}

/** step 是否是导航边界（录制模型里只有 branch/navigate 才算边界，普通动作不算）。 */
export function isNavigationStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.kind !== undefined && step.kind !== 'branch') return false;
  return boundaryKindOfStep(step) === 'document' && step.method === 'navigate';
}

/** 记录一处问题（内部用；保持返回结构统一）。 */
function issue(code, index, message, extra = {}) {
  return { code, index, message, ...extra };
}

/**
 * 把一串 step 按“硬边界”切成 epoch：
 *   - document / tab / window 切换、frameId 变化 → 新 epoch；
 *   - revision 变化不切 epoch（同文档重渲染），记进 epoch.revisions 供重新绑定；
 *   - 同文档同帧的 URL 变化也不切 epoch（SPA 路由），记进 epoch.urlChanges。
 * @param {Array<object>} steps
 * @param {{maxSteps?:number}} [options]
 * @returns {{
 *   epochs:Array<object>, transitions:Array<object>, issues:Array<object>,
 *   summary:{epochs:number, documents:number, frames:number, revisions:number, transitions:number, navigations:number, softChanges:number},
 *   fingerprint:string
 * }}
 */
export function boundaryEpochs(steps, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const maxSteps = Number.isFinite(Number(options.maxSteps)) && Number(options.maxSteps) > 0
    ? Math.floor(Number(options.maxSteps))
    : BOUNDARY_LIMITS.maxSteps;
  const capped = list.slice(0, maxSteps);
  const epochs = [];
  const transitions = [];
  const issues = [];
  let current = null;

  const startEpoch = (index, boundary, kind, previous) => {
    const epoch = {
      epoch: epochs.length,
      startIndex: index,
      endIndex: index,
      count: 0,
      boundary,
      documentId: boundary.documentId,
      documentKind: boundary.documentKind,
      frameId: boundary.frameId,
      revision: boundary.revision,
      url: boundary.url,
      urlKey: boundary.urlKey,
      tabId: boundary.tabId,
      boundaryKind: kind,
      revisions: boundary.revision === null ? [] : [{ index, revision: boundary.revision }],
      urlChanges: [],
      changedBy: kind === 'initial' ? 'initial' : kind,
    };
    epochs.push(epoch);
    current = epoch;
    if (previous) {
      transitions.push({
        from: previous.epoch,
        to: epoch.epoch,
        fromIndex: previous.endIndex,
        toIndex: index,
        kind: kind === 'document' ? 'document' : kind === 'tab-switch' ? 'tab' : kind === 'window-switch' ? 'window' : kind === 'frame' ? 'frame' : 'document',
        recordedBoundary: boundary,
        previousBoundary: previous.boundary,
        url: boundary.url,
        canNavigate: Boolean(boundary.urlKey),
        reason: kind,
      });
    }
    return epoch;
  };

  for (let index = 0; index < capped.length; index += 1) {
    const step = capped[index];
    const boundary = boundaryFromStep(step);
    const kind = boundaryKindOfStep(step);
    if (!current) {
      startEpoch(index, boundary, 'initial', null);
      continue;
    }
    const tabChanged = boundary.tabId !== null && current.tabId !== null && boundary.tabId !== current.tabId;
    const docChanged = Boolean(boundary.documentId && current.documentId && boundary.documentId !== current.documentId);
    const frameChanged = boundary.frameId !== current.frameId;
    const explicit = kind === 'document' || kind === 'tab-switch' || kind === 'window-switch';
    if (tabChanged) {
      startEpoch(index, boundary, 'tab-switch', current);
      continue;
    }
    if (docChanged) {
      startEpoch(index, boundary, 'document', current);
      continue;
    }
    if (frameChanged) {
      startEpoch(index, boundary, 'frame', current);
      continue;
    }
    if (explicit) {
      startEpoch(index, boundary, kind, current);
      continue;
    }
    // 同 epoch：只记录可能影响元素绑定的软变化。
    current.endIndex = index;
    current.count += 1;
    if (boundary.revision !== null && (current.revision === null || boundary.revision !== current.revision)) {
      current.revision = boundary.revision;
      current.revisions.push({ index, revision: boundary.revision });
    }
    if (boundary.urlKey && current.urlKey && boundary.urlKey !== current.urlKey) {
      current.urlChanges.push({ index, from: current.urlKey, to: boundary.urlKey });
      current.urlKey = boundary.urlKey;
    }
    if (!current.documentId && boundary.documentId) {
      current.documentId = boundary.documentId;
      current.documentKind = boundary.documentKind;
      current.boundary = { ...current.boundary, documentId: boundary.documentId };
    }
  }
  if (list.length > maxSteps) {
    issues.push(issue('BOUNDARY_STEPS_TRUNCATED', maxSteps, '边界分段超过上限，已截断', { total: list.length, maxSteps }));
  }
  // 结构性自检：导航边界没有 URL 就无法还原。
  for (const transition of transitions) {
    if (transition.kind === 'document' && !transition.url) {
      issues.push(issue(BOUNDARY_CODES.URL_MISSING, transition.toIndex, '换文档但录制里没有 URL，回放无法导航', {
        from: transition.from,
        to: transition.to,
      }));
    }
  }
  for (const epoch of epochs) {
    if (epoch.revisions.length > 1) {
      const revisions = epoch.revisions.map((item) => item.revision);
      for (let i = 1; i < revisions.length; i += 1) {
        if (revisions[i] < revisions[i - 1]) {
          issues.push(issue(BOUNDARY_CODES.REVISION_REGRESSION, epoch.revisions[i].index, '同一文档内 revision 回退，疑似录制顺序异常', {
            previous: revisions[i - 1],
            next: revisions[i],
          }));
        }
      }
    }
  }
  const documents = new Set(epochs.map((epoch) => epoch.documentId).filter(Boolean)).size;
  const frames = new Set(epochs.map((epoch) => epoch.frameId)).size;
  const revisions = epochs.reduce((sum, epoch) => sum + epoch.revisions.length, 0);
  return {
    epochs,
    transitions,
    issues,
    summary: {
      epochs: epochs.length,
      documents,
      frames,
      revisions,
      transitions: transitions.length,
      navigations: transitions.filter((item) => item.kind === 'document').length,
      softChanges: epochs.reduce((sum, epoch) => sum + epoch.urlChanges.length, 0),
    },
    fingerprint: boundaryFingerprint(epochs),
  };
}

/** 找到某 step 下标所属的 epoch（找不到返回 null）。 */
export function epochOfIndex(boundaryResult, index) {
  if (!boundaryResult || !Array.isArray(boundaryResult.epochs)) return null;
  const target = Number(index);
  if (!Number.isInteger(target) || target < 0) return null;
  for (const epoch of boundaryResult.epochs) {
    if (target >= epoch.startIndex && target <= epoch.endIndex) return epoch;
  }
  return null;
}

/** 一个 epoch 的规范键（文档|帧|tab，与 revision 无关）。 */
export function epochKey(epoch) {
  if (!epoch || typeof epoch !== 'object') return '-';
  const parts = [epoch.documentId || '-', 'f' + normalizeFrameId(epoch.frameId)];
  if (epoch.tabId !== null && epoch.tabId !== undefined) parts.push('t' + epoch.tabId);
  return parts.join('|');
}

/** epoch 序列指纹：只包含“文档/帧/tab + 起始下标”，不含 revision 与时间。 */
export function boundaryFingerprint(epochs) {
  const list = Array.isArray(epochs) ? epochs : [];
  const material = list.map((epoch) => [epochKey(epoch), Number(epoch.startIndex) || 0, String(epoch.changedBy || '')].join('@'));
  return stableHash(material.join('>'));
}

// ---------------------------------------------------------------------------
// 还原规划
// ---------------------------------------------------------------------------

/**
 * 为一个 epoch 的首个 step 计算“要做什么才能进入这个 epoch”。
 * 严格遵循“不猜”：没有 URL 的换文档 → abort；帧不在帧树里 → abort；
 * 只缺 revision/URL 键 → 继续 + 重新绑定。
 */
function restorationForEpoch(epoch, previousEpoch, context) {
  const boundary = epoch.boundary;
  const current = context.current ? normalizeBoundary(context.current) : null;
  const mode = normalizeBoundaryMode(context.mode);
  if (!previousEpoch) {
    if (!current) {
      return {
        action: 'check-document',
        reason: 'current-boundary-unknown',
        code: BOUNDARY_CODES.CURRENT_UNKNOWN,
        boundary,
        requires: 'sample-identity',
      };
    }
    const comparison = compareBoundary(boundary, current, { mode });
    if (comparison.ok) return { action: 'continue', reason: 'same-window', comparison, boundary, requires: 'none' };
    return restorationForRelation(epoch, current, comparison, context);
  }
  // 非首个 epoch：录制里已经明确换了窗口，必须按录制顺序还原。
  if (epoch.boundaryKind === 'tab-switch' || epoch.boundaryKind === 'window-switch') {
    if (epoch.tabId === null || epoch.tabId === undefined) {
      return {
        action: 'abort',
        reason: 'tab-id-missing',
        code: BOUNDARY_CODES.TAB_MISSING,
        boundary,
        requires: 'tab-switch',
      };
    }
    return { action: 'tab-switch', reason: 'recorded-tab-change', tabId: epoch.tabId, boundary, requires: 'tab-switch' };
  }
  if (epoch.boundaryKind === 'frame') {
    const frames = context.frames ? normalizeFrameList(context.frames) : [];
    const frame = findFrame(frames, epoch.frameId);
    if (frames.length && !frame) {
      return {
        action: 'abort',
        reason: 'frame-missing',
        code: BOUNDARY_CODES.FRAME_UNAVAILABLE,
        boundary,
        requires: 'frame-switch',
      };
    }
    return {
      action: 'frame-switch',
      reason: 'recorded-frame-change',
      frameId: epoch.frameId,
      frameUrl: frame ? frame.url : '',
      boundary,
      requires: 'frame-switch',
    };
  }
  // document（含显式 navigate 边界）
  if (!epoch.url) {
    return {
      action: 'abort',
      reason: 'url-missing',
      code: BOUNDARY_CODES.URL_MISSING,
      boundary,
      requires: 'navigate',
    };
  }
  return {
    action: 'navigate',
    reason: 'recorded-document-change',
    url: epoch.url,
    urlKey: epoch.urlKey,
    boundary,
    requires: 'navigate',
  };
}

/** 依据单点比较结果给出还原动作（当前 epoch 与运行期身份的差异）。 */
function restorationForRelation(epoch, current, comparison, context) {
  const boundary = epoch.boundary;
  if (comparison.relation === BOUNDARY_RELATIONS.FRAME_CHANGED) {
    const frames = context.frames ? normalizeFrameList(context.frames) : [];
    const recordedFrame = findFrame(frames, epoch.frameId);
    if (frames.length && !recordedFrame) {
      return {
        action: 'abort',
        reason: 'frame-missing',
        code: BOUNDARY_CODES.FRAME_UNAVAILABLE,
        boundary,
        comparison,
        requires: 'frame-switch',
      };
    }
    return {
      action: 'frame-switch',
      reason: 'frame-changed',
      frameId: epoch.frameId,
      frameUrl: recordedFrame ? recordedFrame.url : '',
      boundary,
      comparison,
      requires: 'frame-switch',
    };
  }
  if (comparison.relation === BOUNDARY_RELATIONS.DOCUMENT_CHANGED || comparison.relation === 'tab-changed') {
    if (!epoch.url) {
      return {
        action: 'abort',
        reason: 'url-missing',
        code: BOUNDARY_CODES.URL_MISSING,
        boundary,
        comparison,
        requires: 'navigate',
      };
    }
    return {
      action: 'navigate',
      reason: 'document-changed',
      url: epoch.url,
      urlKey: epoch.urlKey,
      boundary,
      comparison,
      requires: 'navigate',
    };
  }
  if (comparison.relation === BOUNDARY_RELATIONS.MISSING) {
    return {
      action: 'check-document',
      reason: 'missing-boundary',
      code: BOUNDARY_CODES.CURRENT_UNKNOWN,
      boundary,
      comparison,
      requires: 'sample-identity',
    };
  }
  // revision / url 变化：层级还在，只是元素身份需要重建。
  return {
    action: 're-resolve',
    reason: comparison.relation,
    boundary,
    comparison,
    requires: 'rebind-targets',
  };
}

/**
 * 生成边界还原计划：与 steps 等长，逐步说明“进入这一步前要做什么”。
 * @param {Array<object>} steps
 * @param {{current?:object, frames?:Array<object>, mode?:string, maxSteps?:number,
 *          allowTabSwitch?:boolean, strictCurrent?:boolean}} [context]
 * @returns {{
 *   ok:boolean, mode:string, current:object|null, epochs:Array<object>,
 *   transitions:Array<object>, plans:Array<object>, blockers:Array<object>,
 *   warnings:Array<object>, resumeFromIndex:number,
 *   summary:{epochs:number, navigations:number, frameSwitches:number, tabSwitches:number,
 *     reregisters:number, aborts:number, blockers:number, warnings:number}
 * }}
 */
export function planBoundaryRestoration(steps, context = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const mode = normalizeBoundaryMode(context.mode);
  const allowTabSwitch = context.allowTabSwitch !== false;
  const boundaryResult = boundaryEpochs(list, { maxSteps: context.maxSteps });
  const plans = new Array(list.length);
  const blockers = [];
  const warnings = [];
  let resumeFromIndex = 0;
  let resumeFound = false;

  for (let epochIndex = 0; epochIndex < boundaryResult.epochs.length; epochIndex += 1) {
    const epoch = boundaryResult.epochs[epochIndex];
    const previousEpoch = epochIndex > 0 ? boundaryResult.epochs[epochIndex - 1] : null;
    const restoration = restorationForEpoch(epoch, previousEpoch, {
      current: context.current || null,
      frames: context.frames || [],
      mode,
    });
    let action = restoration.action;
    if (action === 'tab-switch' && !allowTabSwitch) {
      action = 'abort';
      restoration.reason = 'tab-switch-disabled';
      restoration.code = BOUNDARY_CODES.TAB_MISSING;
    }
    if (action === 'abort') {
      blockers.push({
        code: restoration.code || BOUNDARY_CODES.DOCUMENT_CONFLICT,
        index: epoch.startIndex,
        epoch: epoch.epoch,
        action,
        reason: restoration.reason,
        message: boundaryBlockerMessage(restoration.reason),
        detail: restoration.reason,
      });
    } else if (action === 'check-document' && context.strictCurrent) {
      blockers.push({
        code: BOUNDARY_CODES.CURRENT_UNKNOWN,
        index: epoch.startIndex,
        epoch: epoch.epoch,
        action,
        reason: restoration.reason,
        message: '严格模式下需要当前文档身份，但计划生成时没有采样',
      });
    } else if (action === 'check-document') {
      warnings.push({
        code: BOUNDARY_CODES.CURRENT_UNKNOWN,
        index: epoch.startIndex,
        epoch: epoch.epoch,
        action,
        reason: restoration.reason,
        message: '当前窗口身份未知，运行期需先采样 documentId 才能判定是否可继续',
      });
    }
    // 首个“可继续/可还原”的 epoch 起点 = 建议的 resume 位置。
    if (!resumeFound && (action === 'continue' || action === 're-resolve' || action === 'navigate' || action === 'frame-switch')) {
      resumeFromIndex = epoch.startIndex;
      resumeFound = true;
    }
    for (let index = epoch.startIndex; index <= epoch.endIndex && index < list.length; index += 1) {
      const isFirst = index === epoch.startIndex;
      const previousStep = index > epoch.startIndex ? list[index - 1] : null;
      const step = list[index];
      const stepBoundary = boundaryFromStep(step);
      const previousBoundary = previousStep ? boundaryFromStep(previousStep) : null;
      const rebind = Boolean(
        previousBoundary
        && (previousBoundary.revision === null || stepBoundary.revision === null || previousBoundary.revision !== stepBoundary.revision
          || previousBoundary.urlKey !== stepBoundary.urlKey),
      );
      plans[index] = {
        index,
        epoch: epoch.epoch,
        kind: boundaryKindOfStep(step),
        action: isFirst ? action : 'continue',
        requires: isFirst ? restoration.requires : rebind ? 'rebind-targets' : 'none',
        rebind: isFirst ? action === 're-resolve' : rebind,
        reason: isFirst ? restoration.reason : rebind ? 'revision-or-url-changed' : 'same-window',
        url: isFirst && restoration.url ? restoration.url : '',
        frameId: isFirst && restoration.frameId !== undefined ? restoration.frameId : null,
        tabId: isFirst && restoration.tabId !== undefined ? restoration.tabId : null,
        boundary: stepBoundary,
        previousBoundary,
        firstOfEpoch: isFirst,
      };
    }
  }
  // epoch 为空但 list 非空（例如全部被截断）时兜底。
  if (!boundaryResult.epochs.length && list.length) {
    for (let index = 0; index < list.length; index += 1) {
      plans[index] = {
        index,
        epoch: 0,
        kind: boundaryKindOfStep(list[index]),
        action: 'check-document',
        requires: 'sample-identity',
        rebind: false,
        reason: 'current-boundary-unknown',
        url: '',
        frameId: null,
        tabId: null,
        boundary: boundaryFromStep(list[index]),
        previousBoundary: null,
        firstOfEpoch: index === 0,
      };
    }
  }
  const counts = {
    epochs: boundaryResult.epochs.length,
    navigations: plans.filter((plan) => plan && plan.action === 'navigate').length,
    frameSwitches: plans.filter((plan) => plan && plan.action === 'frame-switch').length,
    tabSwitches: plans.filter((plan) => plan && plan.action === 'tab-switch').length,
    reregisters: plans.filter((plan) => plan && (plan.action === 're-resolve' || plan.rebind)).length,
    aborts: plans.filter((plan) => plan && plan.action === 'abort').length,
    blockers: blockers.length,
    warnings: warnings.length,
  };
  return {
    ok: blockers.length === 0,
    mode,
    current: context.current ? normalizeBoundary(context.current) : null,
    epochs: boundaryResult.epochs,
    transitions: boundaryResult.transitions,
    issues: boundaryResult.issues,
    plans,
    blockers,
    warnings,
    resumeFromIndex,
    summary: counts,
    fingerprint: boundaryResult.fingerprint,
  };
}

function boundaryBlockerMessage(reason) {
  switch (reason) {
    case 'url-missing':
      return '录制里这处换文档没有 URL，回放无法证明目标页面（拒绝猜测）';
    case 'frame-missing':
      return '录制里的 iframe 在当前帧树中不存在，无法切回该帧（拒绝猜测）';
    case 'tab-id-missing':
      return '录制里的 tab 切换没有 tabId，无法还原';
    case 'tab-switch-disabled':
      return '回放不允许切换 tab，但录制包含 tab 切换';
    default:
      return '边界无法还原';
  }
}

/**
 * 在 epoch 列表里找与当前身份最匹配的 epoch（用于“从中间恢复回放”）。
 * 严格：exact 模式下只有 compareBoundary ok 才算命中；否则按证据打分返回诊断。
 * @returns {{found:boolean, index:number, epoch:object|null, comparison:object|null, reason:string}}
 */
export function matchBoundaryEpoch(boundaryResult, currentInput, options = {}) {
  const epochs = boundaryResult && Array.isArray(boundaryResult.epochs) ? boundaryResult.epochs : [];
  if (!epochs.length) return { found: false, index: -1, epoch: null, comparison: null, reason: 'no-epochs' };
  const current = normalizeBoundary(currentInput);
  // 默认按“文档 + 帧”匹配 epoch：revision/URL 是 epoch 内的软变化，不该让整段失配。
  const mode = normalizeBoundaryMode(options.mode || 'frame');
  let best = null;
  for (const epoch of epochs) {
    const comparison = compareBoundary(epoch.boundary, current, { mode });
    if (comparison.ok) {
      return { found: true, index: epoch.epoch, epoch, comparison, reason: 'matched' };
    }
    const score = comparison.documentChanged === false ? 2 : 1;
    if (!best || score > best.score) best = { score, index: epoch.epoch, epoch, comparison };
  }
  return {
    found: false,
    index: best ? best.index : -1,
    epoch: best ? best.epoch : null,
    comparison: best ? best.comparison : null,
    reason: best ? best.comparison.relation : 'no-match',
  };
}

/** 从边界还原计划推导 resume 起点：给定当前身份，返回应从哪一步继续。 */
export function resumeFromBoundary(boundaryPlan, currentInput, options = {}) {
  if (!boundaryPlan || !Array.isArray(boundaryPlan.plans)) {
    return { ok: false, fromIndex: 0, reason: 'no-plan' };
  }
  const match = matchBoundaryEpoch({ epochs: boundaryPlan.epochs }, currentInput, options);
  if (!match.found) {
    return {
      ok: false,
      fromIndex: 0,
      reason: match.reason,
      epoch: match.epoch,
      comparison: match.comparison,
    };
  }
  return {
    ok: true,
    fromIndex: match.epoch.startIndex,
    epoch: match.epoch,
    reason: 'matched',
  };
}

/** 汇总边界计划（报告/输出字段用；字段少而稳定）。 */
export function summarizeBoundaries(boundaryPlan) {
  if (!boundaryPlan || typeof boundaryPlan !== 'object') {
    return {
      version: REPLAY_BOUNDARY_VERSION,
      epochs: 0,
      documents: 0,
      frames: 0,
      transitions: 0,
      navigations: 0,
      frameSwitches: 0,
      tabSwitches: 0,
      reregisters: 0,
      aborts: 0,
      blockers: 0,
      warnings: 0,
      fingerprint: '',
    };
  }
  const summary = boundaryPlan.summary || {};
  const epochs = Array.isArray(boundaryPlan.epochs) ? boundaryPlan.epochs : [];
  return {
    version: REPLAY_BOUNDARY_VERSION,
    mode: boundaryPlan.mode || 'exact',
    ok: boundaryPlan.ok !== false,
    epochs: summary.epochs || epochs.length,
    documents: new Set(epochs.map((epoch) => epoch.documentId).filter(Boolean)).size,
    frames: new Set(epochs.map((epoch) => epoch.frameId)).size,
    transitions: Array.isArray(boundaryPlan.transitions) ? boundaryPlan.transitions.length : 0,
    navigations: summary.navigations || 0,
    frameSwitches: summary.frameSwitches || 0,
    tabSwitches: summary.tabSwitches || 0,
    reregisters: summary.reregisters || 0,
    aborts: summary.aborts || 0,
    blockers: Array.isArray(boundaryPlan.blockers) ? boundaryPlan.blockers.length : 0,
    warnings: Array.isArray(boundaryPlan.warnings) ? boundaryPlan.warnings.length : 0,
    resumeFromIndex: boundaryPlan.resumeFromIndex || 0,
    fingerprint: boundaryPlan.fingerprint || '',
  };
}

/** 边界计划里所有 blocker 的码（去重、稳定排序）。 */
export function boundaryBlockerCodes(boundaryPlan) {
  const blockers = boundaryPlan && Array.isArray(boundaryPlan.blockers) ? boundaryPlan.blockers : [];
  return [...new Set(blockers.map((blocker) => String(blocker && blocker.code || '')).filter(Boolean))].sort();
}

/**
 * 与“根 replay-timeline”同语义的批量判定：一批 step 里有哪些能在当前窗口重放。
 * 返回每组连续的“同窗口”区间，供计划器批量执行 + 在边界处插入还原动作。
 * @returns {{segments:Array<object>, blocked:number, replayable:number}}
 */
/**
 * 校验“边界的记录顺序”是否自洽（录制侧丢事件会露出来）：
 *  - 同一 documentId 不应该在中间消失再出现（帧重建可能，但需要显式 branch）；
 *  - transition 的 toIndex 必须单调递增；
 *  - epoch 必须连续覆盖 [0, steps.length)。
 * @returns {{ok:boolean, issues:Array<object>}}
 */

export function verifyBoundarySequence(boundaryResult, stepCount) {
  const issues = [];
  const epochs = boundaryResult && Array.isArray(boundaryResult.epochs) ? boundaryResult.epochs : [];
  const transitions = boundaryResult && Array.isArray(boundaryResult.transitions) ? boundaryResult.transitions : [];
  if (!epochs.length) {
    if (Number(stepCount) > 0) issues.push({ code: 'BOUNDARY_EMPTY', message: '有 step 但没有边界分段' });
    return { ok: issues.length === 0, issues };
  }
  if (epochs[0].startIndex !== 0) issues.push({ code: 'BOUNDARY_GAP', message: '首个 epoch 不从 0 开始', index: epochs[0].startIndex });
  for (let index = 1; index < epochs.length; index += 1) {
    if (epochs[index].startIndex !== epochs[index - 1].endIndex + 1) {
      issues.push({
        code: 'BOUNDARY_GAP',
        message: 'epoch 覆盖不连续',
        from: epochs[index - 1].endIndex,
        to: epochs[index].startIndex,
      });
    }
  }
  const last = epochs[epochs.length - 1];
  if (Number.isInteger(Number(stepCount)) && last.endIndex !== Number(stepCount) - 1) {
    issues.push({ code: 'BOUNDARY_TAIL', message: '末个 epoch 未覆盖到最后一步', last: last.endIndex, steps: Number(stepCount) });
  }
  let previousTo = -1;
  for (const transition of transitions) {
    if (transition.toIndex <= previousTo) {
      issues.push({ code: 'BOUNDARY_ORDER', message: '边界 transition 顺序回退', toIndex: transition.toIndex });
    }
    previousTo = transition.toIndex;
  }
  const seen = new Map();
  for (const epoch of epochs) {
    if (!epoch.documentId) continue;
    if (seen.has(epoch.documentId)) {
      const previous = seen.get(epoch.documentId);
      if (epoch.epoch !== previous + 1) {
        issues.push({
          code: 'BOUNDARY_DOC_REUSE',
          message: '同一 documentId 在不相邻的 epoch 复用（可能丢事件或真实重渲染）',
          documentId: epoch.documentId,
          previousEpoch: previous,
          epoch: epoch.epoch,
        });
      }
    }
    seen.set(epoch.documentId, epoch.epoch);
  }
  return { ok: issues.length === 0, issues };
}
