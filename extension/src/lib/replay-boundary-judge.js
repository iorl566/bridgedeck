// extension/src/lib/replay-boundary-judge.js —— 边界还原判定（第二轮，从 replay-boundary-exec.js 拆出）。
//
// 只做判定：用真实身份轨迹判断每个 epoch 是 matched / needs-action / blocked，
// 并给出阻断证据；另含 resume 起点判定。不执行任何副作用（执行在 replay-boundary-exec.js）。

import { stableHash } from '../record-steps.js';
import { compareBoundary, findFrame, normalizeBoundary, normalizeFrameId, normalizeFrameList } from './replay-boundary.js';
import { matchBoundaryEpoch, planBoundaryRestoration, resumeFromBoundary } from './replay-boundary-plan.js';
import { REPLAY_BOUNDARY_EXEC_VERSION, BOUNDARY_EXEC_CODES, BOUNDARY_EXEC_LIMITS, normalizeBoundaryTrace, summarizeBoundaryTrace, summarizeIdentity, matchTraceIdentity, isObject, nonNegativeInt, shortText, uniqueStrings } from './replay-boundary-trace.js';

// ---------------------------------------------------------------------------
// 边界计划适配
// ---------------------------------------------------------------------------

/** 从 plan / boundaries / steps 里取边界还原计划（拿不到返回 null）。 */
export function boundaryPlanOf(input) {
  if (!isObject(input)) return null;
  if (Array.isArray(input.epochs) && Array.isArray(input.plans)) return input;
  if (isObject(input.boundaries) && Array.isArray(input.boundaries.epochs)) return input.boundaries;
  if (Array.isArray(input.steps)) {
    return planBoundaryRestoration(input.steps, isObject(input.context) ? input.context : {});
  }
  return null;
}

function epochActionOf(boundaryPlan, epoch) {
  const plans = boundaryPlan && Array.isArray(boundaryPlan.plans) ? boundaryPlan.plans : [];
  const plan = plans[epoch.startIndex];
  return isObject(plan) ? plan : null;
}

/** 从 epoch/动作里取“录制时该去哪”的目标（URL/frameId/tabId）。 */
function restoreTargetOf(epoch, actionPlan) {
  const boundary = epoch && isObject(epoch.boundary) ? epoch.boundary : normalizeBoundary(epoch);
  const action = String((actionPlan && actionPlan.action) || epoch.boundaryKind || 'continue');
  const recordedFrameUrl = action === 'frame-switch'
    ? ((actionPlan && actionPlan.frameUrl) || epoch.url || boundary.url || '')
    : ((actionPlan && actionPlan.frameUrl) || '');
  return {
    action,
    url: (actionPlan && actionPlan.url) || epoch.url || boundary.url || '',
    urlKey: (actionPlan && actionPlan.urlKey) || epoch.urlKey || boundary.urlKey || '',
    frameId: actionPlan && actionPlan.frameId !== undefined && actionPlan.frameId !== null
      ? normalizeFrameId(actionPlan.frameId)
      : epoch.frameId,
    frameUrl: recordedFrameUrl,
    tabId: actionPlan && actionPlan.tabId !== undefined && actionPlan.tabId !== null ? actionPlan.tabId : epoch.tabId,
    reason: actionPlan && actionPlan.reason ? String(actionPlan.reason) : String(epoch.changedBy || ''),
  };
}

/** 录制边界：优先 epoch.boundary，其次按 epoch 字段合成。 */
function epochBoundaryOf(epoch) {
  if (epoch && isObject(epoch.boundary)) return normalizeBoundary(epoch.boundary);
  return normalizeBoundary(epoch);
}

// ---------------------------------------------------------------------------
// 轨迹判定（不执行）
// ---------------------------------------------------------------------------

/**
 * 用真实身份轨迹判定每个 epoch 的可还原性：
 *   matched      = 轨迹里出现过录制身份 → 可证明同一窗口；
 *   needs-action = 轨迹里没出现，但录制里有 URL/帧/tab → 可执行还原（执行后再证明）；
 *   blocked      = 连“该去哪”都没有 → 拒绝猜测（带阻断证据）。
 *
 * @param {object} boundaryPlanInput plan / boundaries / {steps}
 * @param {Array<object>|object} traceInput 真实身份轨迹
 * @param {{current?:object, frames?:Array<object>, mode?:string, requireUrl?:boolean}} [options]
 * @returns {object}
 */
export function evaluateBoundaryExecution(boundaryPlanInput, traceInput, options = {}) {
  const boundaryPlan = boundaryPlanOf(boundaryPlanInput);
  const trace = isObject(traceInput) && Array.isArray(traceInput.entries)
    ? traceInput
    : normalizeBoundaryTrace(traceInput, options);
  const mode = options.mode || 'frame';
  if (!boundaryPlan) {
    return {
      version: REPLAY_BOUNDARY_EXEC_VERSION,
      ok: false,
      code: BOUNDARY_EXEC_CODES.PLAN_MISSING,
      deterministic: true,
      trace: { summary: summarizeBoundaryTrace(trace), digest: trace.digest },
      current: null,
      epochs: [],
      matched: 0,
      needsAction: 0,
      blocked: 1,
      blockers: [{ code: BOUNDARY_EXEC_CODES.PLAN_MISSING, epoch: -1, message: '没有可判定的边界还原计划' }],
      resume: null,
      evidence: null,
      digest: stableHash([REPLAY_BOUNDARY_EXEC_VERSION, 'plan-missing', trace.digest].join('|')),
    };
  }
  const epochs = Array.isArray(boundaryPlan.epochs) ? boundaryPlan.epochs : [];
  const frames = normalizeFrameList(options.frames);
  const lastTraceIdentity = trace.entries.length ? trace.entries[trace.entries.length - 1].identity : null;
  const current = options.current
    ? normalizeBoundary(options.current)
    : (lastTraceIdentity ? normalizeBoundary(lastTraceIdentity) : null);
  const observedDocuments = uniqueStrings(trace.entries.map((entry) => entry.documentId));
  const observedUrls = uniqueStrings(trace.entries.map((entry) => entry.urlKey));
  const observedFrames = [...new Set(trace.entries.map((entry) => entry.frameId))].sort((left, right) => left - right);
  const rows = [];
  const blockers = [];
  let matched = 0;
  let needsAction = 0;
  let previousMatchedIndex = -1;

  for (const epoch of epochs) {
    const expected = epochBoundaryOf(epoch);
    const actionPlan = epochActionOf(boundaryPlan, epoch);
    const target = restoreTargetOf(epoch, actionPlan);
    if (target.action === 'frame-switch' && !target.frameUrl && frames.length) {
      const recordedFrame = findFrame(frames, target.frameId);
      if (recordedFrame) target.frameUrl = recordedFrame.url;
    }
    const baseRow = {
      epoch: epoch.epoch,
      startIndex: epoch.startIndex,
      endIndex: epoch.endIndex,
      recorded: summarizeIdentity(expected),
      expected: summarizeIdentity(expected),
      target: {
        action: target.action,
        urlKey: shortText(target.urlKey, 300),
        frameId: target.frameId,
        frameUrl: shortText(target.frameUrl, 300),
        tabId: target.tabId,
        reason: shortText(target.reason, 120),
      },
      status: 'check',
      feasible: false,
      code: '',
      match: { found: false, index: -1, relation: '', source: 'none' },
      blockers: [],
      evidence: {
        matchedEntries: 0,
        observedDocuments,
        observedUrls,
        observedFrames,
      },
    };
    // 计划显式 abort（第一轮已判定不可还原）：即使轨迹里“碰巧”有同文档同帧，
    // 也不能当作已还原——录制要求进入的窗口本身无法证明。
    if (actionPlan && actionPlan.action === 'abort') {
      const reason = String((actionPlan && actionPlan.reason) || target.reason || '');
      const mapped = reason === 'frame-missing'
        ? BOUNDARY_EXEC_CODES.FRAME_MISSING
        : reason === 'url-missing'
          ? BOUNDARY_EXEC_CODES.URL_MISSING
          : (reason === 'tab-id-missing' || reason === 'tab-switch-disabled')
            ? BOUNDARY_EXEC_CODES.TAB_MISSING
            : BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN;
      baseRow.status = 'blocked';
      baseRow.code = mapped;
      baseRow.blockers.push({
        code: mapped,
        epoch: epoch.epoch,
        action: 'abort',
        message: '边界计划明确要求中止：' + shortText(reason, 120),
        evidence: {
          reason: shortText(reason, 120),
          frameId: target.frameId,
          availableFrames: frames.slice(0, BOUNDARY_EXEC_LIMITS.maxEvidence).map((item) => ({ frameId: item.frameId, url: shortText(item.url, 200) })),
        },
      });
      rows.push(baseRow);
      blockers.push(...baseRow.blockers);
      continue;
    }
    const match = matchTraceIdentity(trace, expected, { mode, requireUrl: options.requireUrl === true });
    // 调用方显式给了当前身份（真实采样）时，也构成“同一窗口”的证据。
    const currentMatch = !match.found && current ? compareBoundary(expected, current, { mode }) : null;
    const matchedByCurrent = Boolean(currentMatch && currentMatch.ok);
    const found = match.found || matchedByCurrent;
    const row = {
      ...baseRow,
      match: {
        found,
        index: match.found ? match.index : -1,
        relation: match.found ? match.relation : (currentMatch ? currentMatch.relation : match.relation),
        source: match.found ? 'trace' : matchedByCurrent ? 'current' : 'none',
      },
      evidence: { ...baseRow.evidence, matchedEntries: match.found ? 1 : 0 },
    };
    if (found) {
      row.status = 'matched';
      row.feasible = true;
      row.code = BOUNDARY_EXEC_CODES.MATCHED;
      matched += 1;
      if (previousMatchedIndex >= 0 && match.found && match.index < previousMatchedIndex) {
        row.blockers.push({
          code: BOUNDARY_EXEC_CODES.ORDER,
          epoch: epoch.epoch,
          message: 'epoch 匹配位置早于上一个 epoch（轨迹顺序与录制顺序矛盾）',
          evidence: { previousMatchedIndex, currentIndex: match.index },
        });
        row.status = 'blocked';
        row.feasible = false;
        row.code = BOUNDARY_EXEC_CODES.ORDER;
      }
      if (match.found) previousMatchedIndex = match.index;
      rows.push(row);
      if (row.status === 'blocked') blockers.push(...row.blockers);
      continue;
    }
    // 轨迹里没有录制身份：按“该去哪”的可证明性决定可以执行还是必须阻断。
    if (target.action === 'frame-switch') {
      const frame = frames.length ? findFrame(frames, target.frameId) : null;
      if (frames.length && !frame) {
        row.status = 'blocked';
        row.code = BOUNDARY_EXEC_CODES.FRAME_MISSING;
        row.blockers.push({
          code: BOUNDARY_EXEC_CODES.FRAME_MISSING,
          epoch: epoch.epoch,
          message: '录制的 iframe 在当前帧树里不存在，回放无法切回该帧（拒绝猜测）',
          evidence: {
            frameId: target.frameId,
            availableFrames: frames.slice(0, BOUNDARY_EXEC_LIMITS.maxEvidence).map((item) => ({ frameId: item.frameId, url: shortText(item.url, 200) })),
          },
        });
      } else {
        row.status = 'needs-action';
        row.feasible = true;
        row.code = BOUNDARY_EXEC_CODES.NEEDS_ACTION;
        row.blockers = [];
        row.evidence.frameUrl = frame ? shortText(frame.url, 300) : '';
        needsAction += 1;
      }
    } else if (target.action === 'tab-switch') {
      if (target.tabId === null || target.tabId === undefined) {
        row.status = 'blocked';
        row.code = BOUNDARY_EXEC_CODES.TAB_MISSING;
        row.blockers.push({
          code: BOUNDARY_EXEC_CODES.TAB_MISSING,
          epoch: epoch.epoch,
          message: '录制包含 tab 切换但没有 tabId，回放无法还原',
          evidence: { epoch: epoch.epoch },
        });
      } else {
        row.status = 'needs-action';
        row.feasible = true;
        row.code = BOUNDARY_EXEC_CODES.NEEDS_ACTION;
        needsAction += 1;
      }
    } else if (target.action === 'navigate') {
      if (!target.urlKey) {
        row.status = 'blocked';
        row.code = BOUNDARY_EXEC_CODES.URL_MISSING;
        row.blockers.push({
          code: BOUNDARY_EXEC_CODES.URL_MISSING,
          epoch: epoch.epoch,
          message: '录制里这处换文档没有 URL，回放无法证明目标页面（拒绝猜测）',
          evidence: { epoch: epoch.epoch, startIndex: epoch.startIndex },
        });
      } else {
        row.status = 'needs-action';
        row.feasible = true;
        row.code = BOUNDARY_EXEC_CODES.NEEDS_ACTION;
        row.evidence.expectedUrlKey = shortText(target.urlKey, 300);
        row.evidence.mustChangeDocument = true;
        needsAction += 1;
      }
    } else {
      // continue / check-document / re-resolve：没有匹配轨迹就没有可证明的当前身份。
      row.status = 'blocked';
      row.code = BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN;
      row.blockers.push({
        code: BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN,
        epoch: epoch.epoch,
        message: '轨迹里找不到录制身份，且没有可执行的导航/帧切换动作可证明位置',
        evidence: { expected: summarizeIdentity(expected), nearest: match.nearest ? summarizeIdentity(match.nearest.entry.identity) : null },
      });
    }
    rows.push(row);
    blockers.push(...row.blockers);
  }

  if (!trace.entries.length && epochs.length) {
    blockers.unshift({
      code: BOUNDARY_EXEC_CODES.TRACE_EMPTY,
      epoch: -1,
      message: '没有真实身份轨迹，无法判定任何边界（拒绝用当前页面猜测）',
      evidence: { epochs: epochs.length },
    });
  }
  const blocked = blockers.length;
  const ok = blocked === 0;
  const code = !ok
    ? BOUNDARY_EXEC_CODES.BLOCKED
    : needsAction > 0
      ? BOUNDARY_EXEC_CODES.NEEDS_ACTION
      : BOUNDARY_EXEC_CODES.OK;
  const resume = resumeFromRealTrace(boundaryPlan, trace, { current, mode });
  const digest = stableHash([
    REPLAY_BOUNDARY_EXEC_VERSION,
    trace.digest || '',
    rows.map((row) => [row.epoch, row.status, row.code, row.match.found ? row.match.index : -1].join(':')).join('>'),
    blockers.map((blocker) => blocker.code).join(','),
    resume ? resume.code : '',
  ].join('|'));
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    ok,
    code,
    deterministic: true,
    mode,
    trace: { summary: summarizeBoundaryTrace(trace), digest: trace.digest, issues: trace.issues.slice(0, 8) },
    current: current ? summarizeIdentity(current) : null,
    epochs: rows,
    matched,
    needsAction,
    blocked: rows.filter((row) => row.status === 'blocked').length,
    blockers,
    resume,
    evidence: {
      observedDocuments,
      observedUrls,
      observedFrames,
      framesKnown: frames.length > 0,
      epochs: epochs.length,
    },
    digest,
  };
}

// ---------------------------------------------------------------------------
// 恢复（resume）
// ---------------------------------------------------------------------------

/**
 * 用轨迹的当前身份定位“从哪一步继续”。
 * - 轨迹最后身份 = 当前身份（调用方可用 options.current 覆盖）；
 * - 用第一轮 matchBoundaryEpoch / resumeFromBoundary 找到 epoch；
 * - 找不到 → RESUME_NO_MATCH + 最近 epoch 证据（不猜一个起点硬跑）。
 */
export function resumeFromRealTrace(boundaryPlanInput, traceInput, options = {}) {
  const boundaryPlan = boundaryPlanOf(boundaryPlanInput);
  const trace = isObject(traceInput) && Array.isArray(traceInput.entries)
    ? traceInput
    : normalizeBoundaryTrace(traceInput, options);
  if (!boundaryPlan || !Array.isArray(boundaryPlan.epochs) || !boundaryPlan.epochs.length) {
    return { version: REPLAY_BOUNDARY_EXEC_VERSION, ok: false, code: BOUNDARY_EXEC_CODES.PLAN_MISSING, fromIndex: 0, reason: 'no-plan' };
  }
  const current = options.current
    ? normalizeBoundary(options.current)
    : (trace.entries.length ? normalizeBoundary(trace.entries[trace.entries.length - 1].identity) : null);
  if (!current || (!current.documentId && !current.urlKey)) {
    return {
      version: REPLAY_BOUNDARY_EXEC_VERSION,
      ok: false,
      code: BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN,
      fromIndex: 0,
      reason: 'current-identity-unknown',
      current: null,
      traceDigest: trace.digest,
    };
  }
  const mode = options.mode || 'frame';
  const resume = resumeFromBoundary(boundaryPlan, current, { mode });
  if (resume.ok !== true) {
    const nearest = matchBoundaryEpoch({ epochs: boundaryPlan.epochs }, current, { mode });
    return {
      version: REPLAY_BOUNDARY_EXEC_VERSION,
      ok: false,
      code: BOUNDARY_EXEC_CODES.RESUME_NO_MATCH,
      fromIndex: 0,
      reason: resume.reason || 'no-match',
      current: summarizeIdentity(current),
      nearest: nearest.epoch
        ? {
          epoch: nearest.epoch.epoch,
          startIndex: nearest.epoch.startIndex,
          recorded: summarizeIdentity(nearest.epoch.boundary),
          relation: nearest.comparison ? nearest.comparison.relation : '',
        }
        : null,
      traceDigest: trace.digest,
    };
  }
  const epoch = resume.epoch;
  const detail = compareBoundary(epochBoundaryOf(epoch), current, { mode });
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    ok: true,
    code: BOUNDARY_EXEC_CODES.RESUME_OK,
    fromIndex: nonNegativeInt(resume.fromIndex),
    epoch: epoch.epoch,
    reason: 'matched',
    current: summarizeIdentity(current),
    recorded: summarizeIdentity(epochBoundaryOf(epoch)),
    relation: detail.relation,
    evidence: {
      startIndex: epoch.startIndex,
      endIndex: epoch.endIndex,
      traceEntries: trace.entries.length,
      traceDigest: trace.digest,
      documentChanged: detail.documentChanged === true,
      frameChanged: detail.frameChanged === true,
      revisionChanged: detail.revisionChanged === true,
    },
    traceDigest: trace.digest,
  };
}
