// extension/src/lib/replay-boundary-exec.js —— 边界还原执行编排（第二轮：真实 documentId/URL 轨迹）。
//
// 只留执行编排：navigate / frame-switch / tab-switch 通过注入 providers 真正执行，
// 执行后用 sampleIdentity() 采样真实身份证明“确实进入录制目标”，证不出就带 before/after
// 证据阻断；另含失败解释/摘要/自检。判定与轨迹模型已拆分（经本模块 re-export，公开 API 不变）：
//   - replay-boundary-trace.js：轨迹归一化/身份序列/身份匹配/providers 归一；
//   - replay-boundary-judge.js：epoch 判定（matched/needs-action/blocked）与 resume 起点。
//
// 运行时消费者：extension/src/replay.js（replayBoundaryCommand / replayNetworkCommand 的
// boundaryExecution 字段）与 replay-executor.js 的 restoreBoundary provider 契约。

import { stableHash } from '../record-steps.js';
import { BOUNDARY_CODES, frameUrlMatches, normalizeBoundary, normalizeUrlKey } from './replay-boundary.js';
import { explainFailure } from './replay-explain.js';
import { REPLAY_BOUNDARY_EXEC_VERSION, BOUNDARY_EXEC_CODES, BOUNDARY_EXEC_LIMITS, normalizeBoundaryTrace, summarizeBoundaryTrace, summarizeIdentity, normalizeBoundaryProviders, isObject, nonNegativeInt, shortText } from './replay-boundary-trace.js';
import { boundaryPlanOf, evaluateBoundaryExecution, resumeFromRealTrace } from './replay-boundary-judge.js';

/** 阻断码 → 失败目录码（解释层用；未知走 PLAN 层）。 */
export const BOUNDARY_EXEC_CATALOG_CODES = Object.freeze({
  [BOUNDARY_EXEC_CODES.URL_MISSING]: 'BOUNDARY_URL_MISSING',
  [BOUNDARY_EXEC_CODES.FRAME_MISSING]: 'BOUNDARY_FRAME_UNAVAILABLE',
  [BOUNDARY_EXEC_CODES.TAB_MISSING]: 'BOUNDARY_TAB_MISSING',
  [BOUNDARY_EXEC_CODES.CURRENT_UNKNOWN]: 'BOUNDARY_CURRENT_UNKNOWN',
  [BOUNDARY_EXEC_CODES.PROVIDER_MISSING]: 'BOUNDARY_NAVIGATION_REQUIRED',
  [BOUNDARY_EXEC_CODES.NAVIGATE_URL_MISMATCH]: 'BOUNDARY_DOCUMENT_CHANGED',
  [BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED]: 'BOUNDARY_DOCUMENT_CHANGED',
  [BOUNDARY_EXEC_CODES.FRAME_URL_MISMATCH]: 'BOUNDARY_FRAME_CHANGED',
  [BOUNDARY_EXEC_CODES.FRAME_NOT_CONFIRMED]: 'BOUNDARY_FRAME_CHANGED',
  [BOUNDARY_EXEC_CODES.TAB_NOT_CONFIRMED]: 'BOUNDARY_TAB_MISSING',
  [BOUNDARY_EXEC_CODES.RESUME_NO_MATCH]: 'BOUNDARY_DOCUMENT_CHANGED',
  [BOUNDARY_EXEC_CODES.STALE_DOCUMENT]: 'BOUNDARY_STALE_DOCUMENT',
  [BOUNDARY_EXEC_CODES.TRACE_EMPTY]: 'BOUNDARY_CURRENT_UNKNOWN',
  [BOUNDARY_EXEC_CODES.TRACE_INVALID]: 'BOUNDARY_CURRENT_UNKNOWN',
  [BOUNDARY_EXEC_CODES.ORDER]: 'BOUNDARY_DOCUMENT_CHANGED',
});

// ---------------------------------------------------------------------------
// 真实执行（navigate / frame-switch / tab-switch）
// ---------------------------------------------------------------------------

/** 动作 → provider 字段名。 */
const PROVIDER_OF_ACTION = Object.freeze({
  navigate: 'navigate',
  'frame-switch': 'switchFrame',
  'tab-switch': 'switchTab',
});

/** 动作 → 成功码。 */
const SUCCESS_CODE_OF_ACTION = Object.freeze({
  navigate: BOUNDARY_EXEC_CODES.NAVIGATE_OK,
  'frame-switch': BOUNDARY_EXEC_CODES.FRAME_OK,
  'tab-switch': BOUNDARY_EXEC_CODES.TAB_OK,
});

/** 动作执行后的证明失败码。 */
const UNPROVEN_CODE_OF_ACTION = Object.freeze({
  navigate: BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED,
  'frame-switch': BOUNDARY_EXEC_CODES.FRAME_NOT_CONFIRMED,
  'tab-switch': BOUNDARY_EXEC_CODES.TAB_NOT_CONFIRMED,
});

/**
 * 执行边界还原动作，并在每个动作后用真实身份采样证明“确实进入了录制目标”。
 *
 * providers：
 *   - navigate({url, expected, epoch}) → 执行导航；
 *   - switchFrame({frameId, frameUrl, epoch}) → 切换帧；
 *   - switchTab({tabId, epoch}) → 切换 tab；
 *   - sampleIdentity() → 采样当前身份 {documentId?, frameId?, url?, tabId?}；
 *   - resumeAt({fromIndex, epoch}) → 跳到恢复点（可选，只做记录）。
 *
 * 证明规则（fail-closed）：
 *   - navigate：执行后 URL 键必须等于录制 URL 键；且身份必须发生变化（否则视为“没真的导航”）；
 *   - frame-switch：执行后 frameId 必须等于录制帧；帧 URL 已知时必须匹配；
 *   - tab-switch：执行后 tabId 必须等于录制 tabId。
 * 任何一步证不出来 → 带 before/after 证据阻断，绝不继续往下跑。
 *
 * @param {object} boundaryPlanInput
 * @param {Array<object>|object} traceInput
 * @param {object} providers
 * @param {{current?:object, frames?:Array<object>, mode?:string, continueOnBlock?:boolean}} [options]
 * @returns {Promise<object>}
 */
export async function executeBoundaryRestoration(boundaryPlanInput, traceInput, providers = {}, options = {}) {
  const boundaryPlan = boundaryPlanOf(boundaryPlanInput);
  const trace = isObject(traceInput) && Array.isArray(traceInput.entries)
    ? traceInput
    : normalizeBoundaryTrace(traceInput, options);
  const evaluation = evaluateBoundaryExecution(boundaryPlan, trace, options);
  const p = normalizeBoundaryProviders(providers);
  const base = {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    deterministic: true,
    evaluation,
    trace: { summary: summarizeBoundaryTrace(trace), digest: trace.digest },
    actions: [],
    blocked: [],
    resume: evaluation.resume || null,
    ok: false,
    code: BOUNDARY_EXEC_CODES.BLOCKED,
    digest: '',
  };
  if (!evaluation.ok) {
    base.blocked = evaluation.blockers.slice(0, BOUNDARY_EXEC_LIMITS.maxEvidence);
    base.digest = stableHash([REPLAY_BOUNDARY_EXEC_VERSION, 'blocked', evaluation.digest].join('|'));
    return base;
  }
  let current = evaluation.current ? normalizeBoundary(evaluation.current) : (options.current ? normalizeBoundary(options.current) : null);
  const rows = evaluation.epochs.filter((row) => row.status === 'needs-action');
  for (const row of rows) {
    const action = String(row.target.action);
    const providerKey = PROVIDER_OF_ACTION[action];
    const provider = providerKey ? p[providerKey] : null;
    const epoch = boundaryPlan && Array.isArray(boundaryPlan.epochs)
      ? boundaryPlan.epochs[row.epoch]
      : null;
    const actionRecord = {
      epoch: row.epoch,
      startIndex: row.startIndex,
      action,
      ok: false,
      code: '',
      expected: row.target,
      before: current ? summarizeIdentity(current) : null,
      after: null,
      evidence: null,
    };
    if (!provider) {
      actionRecord.code = BOUNDARY_EXEC_CODES.PROVIDER_MISSING;
      actionRecord.evidence = { provider: providerKey || action, message: '缺少该边界动作的执行 provider' };
      base.actions.push(actionRecord);
      base.blocked.push({
        code: BOUNDARY_EXEC_CODES.PROVIDER_MISSING,
        epoch: row.epoch,
        action,
        message: '边界动作 ' + action + ' 需要注入 ' + (providerKey || action) + ' provider（拒绝假装已还原）',
      });
      base.digest = stableHash([
        REPLAY_BOUNDARY_EXEC_VERSION,
        'provider-missing',
        row.epoch,
        evaluation.digest,
      ].join('|'));
      return base;
    }
    let providerResult = null;
    try {
      providerResult = await provider({
        epoch: row.epoch,
        startIndex: row.startIndex,
        url: row.target.urlKey,
        frameId: row.target.frameId,
        frameUrl: row.target.frameUrl,
        tabId: row.target.tabId,
        expected: row.expected,
      });
    } catch (error) {
      actionRecord.code = UNPROVEN_CODE_OF_ACTION[action] || BOUNDARY_EXEC_CODES.BLOCKED;
      actionRecord.evidence = { error: shortText(error && error.message, 200) };
      base.actions.push(actionRecord);
      base.blocked.push({
        code: actionRecord.code,
        epoch: row.epoch,
        action,
        message: '边界动作执行抛错：' + shortText(error && error.message, 200),
      });
      base.digest = stableHash([REPLAY_BOUNDARY_EXEC_VERSION, 'provider-error', row.epoch, evaluation.digest].join('|'));
      return base;
    }
    if (isObject(providerResult) && providerResult.ok === false) {
      actionRecord.code = shortText(providerResult.code, 120) || (UNPROVEN_CODE_OF_ACTION[action] || BOUNDARY_EXEC_CODES.BLOCKED);
      actionRecord.evidence = { reason: shortText(providerResult.reason, 200) };
      base.actions.push(actionRecord);
      base.blocked.push({
        code: actionRecord.code,
        epoch: row.epoch,
        action,
        message: '边界动作执行失败：' + shortText(providerResult.reason, 200),
      });
      base.digest = stableHash([REPLAY_BOUNDARY_EXEC_VERSION, 'provider-failed', row.epoch, evaluation.digest].join('|'));
      return base;
    }
    const before = current;
    const after = await sampleBoundaryIdentity(p, providerResult);
    actionRecord.before = before ? summarizeIdentity(before) : null;
    actionRecord.after = after ? summarizeIdentity(after) : null;
    const proof = proveBoundaryAction(action, row, before, after);
    actionRecord.code = proof.code;
    actionRecord.ok = proof.ok;
    actionRecord.evidence = proof.evidence;
    base.actions.push(actionRecord);
    if (!proof.ok) {
      base.blocked.push({
        code: proof.code,
        epoch: row.epoch,
        action,
        message: proof.message,
        evidence: proof.evidence,
      });
      base.resume = resumeFromRealTrace(boundaryPlan, trace, { current: after || before, mode: evaluation.mode });
      base.digest = stableHash([
        REPLAY_BOUNDARY_EXEC_VERSION,
        'unproven',
        row.epoch,
        proof.code,
        evaluation.digest,
      ].join('|'));
      return base;
    }
    current = after || before;
    if (p.resumeAt && row.epoch === rows[rows.length - 1].epoch) {
      try {
        await p.resumeAt({ fromIndex: row.startIndex, epoch: row.epoch });
      } catch (error) {
        actionRecord.evidence = { ...(actionRecord.evidence || {}), resumeError: shortText(error && error.message, 160) };
      }
    }
  }
  base.ok = true;
  base.code = BOUNDARY_EXEC_CODES.RESUME_OK;
  base.current = current ? summarizeIdentity(current) : null;
  base.digest = stableHash([
    REPLAY_BOUNDARY_EXEC_VERSION,
    evaluation.digest,
    base.actions.map((actionRecord) => [actionRecord.epoch, actionRecord.action, actionRecord.code].join(':')).join('>'),
  ].join('|'));
  return base;
}

/** 采样执行后的真实身份：provider 优先，其次是 provider 返回值里携带的 identity。 */
async function sampleBoundaryIdentity(providers, providerResult) {
  if (typeof providers.sampleIdentity === 'function') {
    const sampled = await providers.sampleIdentity();
    if (isObject(sampled)) return normalizeBoundary(sampled);
    return null;
  }
  if (isObject(providerResult) && isObject(providerResult.identity)) return normalizeBoundary(providerResult.identity);
  return null;
}

/** 动作后证明：录制目标 vs 真实采样身份。 */
function proveBoundaryAction(action, row, before, after) {
  if (!after) {
    return {
      ok: false,
      code: UNPROVEN_CODE_OF_ACTION[action] || BOUNDARY_EXEC_CODES.BLOCKED,
      message: '动作执行后没有采样到真实身份，无法证明已进入录制目标',
      evidence: { expected: row.target, before: before ? summarizeIdentity(before) : null },
    };
  }
  if (action === 'navigate') {
    const expectedKey = normalizeUrlKey(row.target.urlKey || row.target.url);
    const afterKey = normalizeUrlKey(after.url || after.urlKey);
    if (expectedKey.key && afterKey.key !== expectedKey.key) {
      return {
        ok: false,
        code: BOUNDARY_EXEC_CODES.NAVIGATE_URL_MISMATCH,
        message: '导航后的 URL 与录制 URL 不一致（expected ' + shortText(expectedKey.key, 120) + '）',
        evidence: { expectedUrlKey: expectedKey.key, actualUrlKey: afterKey.key, before: before ? summarizeIdentity(before) : null, after: summarizeIdentity(after) },
      };
    }
    const changed = !before
      || (before.documentId && after.documentId ? before.documentId !== after.documentId : before.urlKey !== after.urlKey);
    if (!changed) {
      return {
        ok: false,
        code: BOUNDARY_EXEC_CODES.NAVIGATE_NOT_CONFIRMED,
        message: '导航 provider 返成功，但身份没有变化（没有真的发生文档切换）',
        evidence: { before: summarizeIdentity(before), after: summarizeIdentity(after) },
      };
    }
    return {
      ok: true,
      code: BOUNDARY_EXEC_CODES.NAVIGATE_OK,
      message: '导航已证明：URL 与录制一致且文档已切换',
      evidence: { expectedUrlKey: expectedKey.key, actualUrlKey: afterKey.key, documentChanged: true },
    };
  }
  if (action === 'frame-switch') {
    if (after.frameId !== row.target.frameId) {
      return {
        ok: false,
        code: BOUNDARY_EXEC_CODES.FRAME_NOT_CONFIRMED,
        message: '帧切换后的 frameId 与录制不一致（expected f' + row.target.frameId + '）',
        evidence: { expectedFrameId: row.target.frameId, actualFrameId: after.frameId },
      };
    }
    if (row.target.frameUrl && after.url) {
      // 帧还原证明要求 URL 键精确匹配（同源不同路径不算“回到录制帧”）。
      const comparison = frameUrlMatches(row.target.frameUrl, after.url);
      if (!comparison.ok) {
        return {
          ok: false,
          code: BOUNDARY_EXEC_CODES.FRAME_URL_MISMATCH,
          message: '录制帧的 URL 与当前帧 URL 不一致',
          evidence: { expectedUrlKey: normalizeUrlKey(row.target.frameUrl).key, actualUrlKey: normalizeUrlKey(after.url).key, reason: comparison.reason },
        };
      }
    }
    return {
      ok: true,
      code: BOUNDARY_EXEC_CODES.FRAME_OK,
      message: '帧切换已证明：frameId 与录制一致',
      evidence: { frameId: after.frameId, frameUrl: shortText(after.url, 300) },
    };
  }
  if (action === 'tab-switch') {
    if (after.tabId === null || after.tabId === undefined || String(after.tabId) !== String(row.target.tabId)) {
      return {
        ok: false,
        code: BOUNDARY_EXEC_CODES.TAB_NOT_CONFIRMED,
        message: 'tab 切换后的 tabId 与录制不一致（expected t' + row.target.tabId + '）',
        evidence: { expectedTabId: row.target.tabId, actualTabId: after.tabId },
      };
    }
    return {
      ok: true,
      code: BOUNDARY_EXEC_CODES.TAB_OK,
      message: 'tab 切换已证明：tabId 与录制一致',
      evidence: { tabId: after.tabId },
    };
  }
  return {
    ok: false,
    code: BOUNDARY_EXEC_CODES.BLOCKED,
    message: '未知边界动作：' + action,
    evidence: { action },
  };
}

// ---------------------------------------------------------------------------
// 解释 / 摘要 / 文本
// ---------------------------------------------------------------------------

/** 边界执行结果 → 失败解释（成功返回 null；消费 replay-explain 目录）。 */
export function explainBoundaryExecution(result) {
  if (!result || result.ok === true) return null;
  const list = Array.isArray(result.blocked)
    ? result.blocked
    : (Array.isArray(result.blockers) ? result.blockers : []);
  const first = list.length ? list[0] : null;
  if (!first) return null;
  const code = BOUNDARY_EXEC_CATALOG_CODES[first.code] || 'PLAN_BLOCKED';
  const explanation = explainFailure({
    code,
    boundary: {
      relation: first.action || String(first.code || ''),
      reason: first.message,
      documentChanged: first.code === BOUNDARY_EXEC_CODES.NAVIGATE_URL_MISMATCH,
      frameChanged: first.code === BOUNDARY_EXEC_CODES.FRAME_NOT_CONFIRMED || first.code === BOUNDARY_EXEC_CODES.FRAME_URL_MISMATCH,
    },
    detail: first.message,
  });
  explanation.boundaryExecution = {
    code: first.code,
    epoch: Number.isInteger(first.epoch) ? first.epoch : -1,
    action: String(first.action || ''),
    traceDigest: String(result.trace && result.trace.digest || ''),
    digest: String(result.digest || ''),
  };
  return explanation;
}

/** 边界执行摘要（RPC 字段：有界、稳定）。 */
export function summarizeBoundaryExecution(result) {
  if (!isObject(result)) return null;
  // 兼容两种输入：executeBoundaryRestoration 的输出（含 evaluation 子对象）与
  // evaluateBoundaryExecution 的判定输出（本身就有 matched/needsAction/blocked）。
  const evaluation = isObject(result.evaluation)
    ? result.evaluation
    : (Array.isArray(result.epochs) && (result.matched !== undefined || result.needsAction !== undefined || result.blocked !== undefined)
      ? result
      : null);
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const blocked = Array.isArray(result.blocked)
    ? result.blocked
    : (Array.isArray(result.blockers) ? result.blockers : []);
  const resume = isObject(result.resume) ? result.resume : (evaluation && evaluation.resume) || null;
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    ok: result.ok === true,
    code: String(result.code || ''),
    deterministic: result.deterministic !== false,
    trace: {
      entries: nonNegativeInt(result.trace && result.trace.summary && result.trace.summary.entries),
      documents: nonNegativeInt(result.trace && result.trace.summary && result.trace.summary.documents),
      frames: nonNegativeInt(result.trace && result.trace.summary && result.trace.summary.frames),
      digest: String(result.trace && result.trace.digest || ''),
    },
    evaluation: evaluation
      ? {
        ok: evaluation.ok === true,
        code: String(evaluation.code || ''),
        matched: nonNegativeInt(evaluation.matched),
        needsAction: nonNegativeInt(evaluation.needsAction),
        blocked: nonNegativeInt(evaluation.blocked),
        digest: String(evaluation.digest || ''),
      }
      : null,
    actions: actions.slice(0, 8).map((actionRecord) => ({
      epoch: nonNegativeInt(actionRecord.epoch),
      action: String(actionRecord.action || ''),
      ok: actionRecord.ok === true,
      code: String(actionRecord.code || ''),
    })),
    blocked: blocked.slice(0, 6).map((blocker) => ({
      code: String(blocker.code || ''),
      epoch: Number.isInteger(blocker.epoch) ? blocker.epoch : -1,
      action: String(blocker.action || ''),
      message: shortText(blocker.message, 200),
    })),
    resume: resume
      ? {
        ok: resume.ok === true,
        code: String(resume.code || ''),
        fromIndex: nonNegativeInt(resume.fromIndex),
        reason: shortText(resume.reason, 80),
        epoch: Number.isInteger(resume.epoch) ? resume.epoch : -1,
      }
      : null,
    digest: String(result.digest || ''),
  };
}

/** 文本摘要（日志/CLI 展示；有界）。 */
export function formatBoundaryExecution(result, options = {}) {
  const summary = summarizeBoundaryExecution(result);
  if (!summary) return '边界还原：无结果';
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 20;
  const lines = [];
  lines.push('边界还原 ' + (summary.ok ? '成功' : '阻断（' + summary.code + '）')
    + '：轨迹 ' + summary.trace.entries + ' 条，matched ' + (summary.evaluation ? summary.evaluation.matched : 0)
    + '，needs-action ' + (summary.evaluation ? summary.evaluation.needsAction : 0));
  for (const actionRecord of summary.actions) {
    lines.push('- epoch#' + actionRecord.epoch + ' ' + actionRecord.action + ' → ' + (actionRecord.ok ? '已证明' : '失败') + ' [' + actionRecord.code + ']');
  }
  for (const blocker of summary.blocked) {
    lines.push('- 阻断 epoch#' + blocker.epoch + (blocker.action ? ' ' + blocker.action : '') + ' [' + blocker.code + '] ' + blocker.message);
  }
  if (summary.resume) {
    lines.push('恢复点：' + (summary.resume.ok ? 'step#' + summary.resume.fromIndex + '（epoch ' + summary.resume.epoch + '）' : '未找到（' + summary.resume.reason + '）'));
  }
  if (summary.trace.digest) lines.push('轨迹指纹：' + summary.trace.digest);
  return lines.slice(0, maxLines).join('\n');
}

/** 边界执行结果自检：证据字段是否齐全（报告/测试用）。 */
export function verifyBoundaryExecutionEvidence(result) {
  const issues = [];
  if (!isObject(result)) return { ok: false, issues: [{ code: 'BOUNDARY_EXEC_NO_RESULT' }] };
  const actions = Array.isArray(result.actions) ? result.actions : [];
  for (const actionRecord of actions) {
    if (!actionRecord.code) issues.push({ code: 'BOUNDARY_EXEC_ACTION_CODE_MISSING', epoch: actionRecord.epoch });
    if (!actionRecord.before && actionRecord.code !== BOUNDARY_EXEC_CODES.PROVIDER_MISSING) {
      issues.push({ code: 'BOUNDARY_EXEC_BEFORE_MISSING', epoch: actionRecord.epoch });
    }
  }
  const blocked = Array.isArray(result.blocked) ? result.blocked : [];
  for (const blocker of blocked) {
    if (!blocker.code || !blocker.message) issues.push({ code: 'BOUNDARY_EXEC_BLOCKER_INCOMPLETE', epoch: blocker.epoch });
  }
  if (!result.trace || !result.trace.digest) issues.push({ code: 'BOUNDARY_EXEC_TRACE_DIGEST_MISSING' });
  return { ok: issues.length === 0, issues };
}

/** 边界执行结果指纹（跨次比较用）。 */
export function boundaryExecutionDigest(result) {
  if (!isObject(result)) return '';
  if (result.digest) return String(result.digest);
  return stableHash([
    REPLAY_BOUNDARY_EXEC_VERSION,
    String(result.code || ''),
    (Array.isArray(result.actions) ? result.actions : []).map((actionRecord) => [actionRecord.epoch, actionRecord.action, actionRecord.code].join(':')).join('>'),
  ].join('|'));
}

// 记录一个显式的常量引用，说明边界码与既有 BOUNDARY_CODES 同源（避免码表漂移）。
export const BOUNDARY_EXEC_BOUNDARY_CODES = Object.freeze({
  URL_MISSING: BOUNDARY_CODES.URL_MISSING,
  FRAME_UNAVAILABLE: BOUNDARY_CODES.FRAME_UNAVAILABLE,
  TAB_MISSING: BOUNDARY_CODES.TAB_MISSING,
  CURRENT_UNKNOWN: BOUNDARY_CODES.CURRENT_UNKNOWN,
  STALE_DOCUMENT: BOUNDARY_CODES.NAVIGATION_REQUIRED,
});

// 公开 API 保持：轨迹/判定模型在此 re-export（replay.js 与单测零改动）。
export * from './replay-boundary-trace.js';
export * from './replay-boundary-judge.js';
