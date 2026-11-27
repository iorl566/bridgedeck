// src/record-events.js —— 录制事件的规范化 + 去重/合并 + step 程序摘要（运行时热路径）。
//
// 进程内职责：
//   - 把 content script 投递的原始录制事件归一化（document/frame/actor 边界），
//   - 用 record-steps.buildRecordStep 生成 step v2，并补 wait/loop 提示，
//   - 用 record-program.validateRecordStep 做单步合法性检查（branch/loop/human-gate/retry），
//   - 用 record-merge.createMergeIndex 做“同一次动作多源上报”的去重与合并，
//   - 每 40 步或遇到 branch 边界时用 record-program.buildRecordProgram 生成紧凑程序摘要。
//
// 只新增字段、不改变既有字段与既有计数语义：
//   recordStep        —— 既有字段（形状不变）
//   recordStepVersion —— 既有字段
//   recordStepIssues  —— 仅在发现问题时出现（<=6 条）
//   recordDedupe      —— 仅在发生重复/合并时出现
//   recordMerge       —— 仅在多源同动作合并时出现在后到的那条上
//   recordProgram     —— 仅在边界/周期采样时出现（紧凑摘要）
// 正常录制（无重复/无问题）的事件形状与之前完全一致。

import { isAgentInputWindow } from './dispatch.js';
import { collectEvent } from './ops.js';
import { buildRecordStep, RECORD_STEP_VERSION, stepSignature, summarizeRecordSteps } from './record-steps.js';
import { buildRecordProgram, summarizeRecordProgram, validateRecordStep } from './record-program.js';
import { createMergeIndex, mergeEventPair } from './record-merge.js';
// 第三轮：step 图（分支/并发/取消）+ program 执行器（dry-run/回放前置）。
// 只在既有的“程序摘要采样点”（branch 边界 / 每 40 步）追加 recordGraph / recordExec 两个字段：
// 采样前的事件形状、recordProgram 字段、以及所有既有计数完全不变。
import { buildStepGraph, summarizeStepGraph } from './lib/record-step-graph.js';
import { dryRunProgram, summarizeExecReport } from './lib/record-exec-plan.js';
// 第三轮：回放会话（record export 的“回放前置”产物）。只给 summarizeRecording 增加
// replay 字段：token 可交给回放器做幂等去重，批次/状态供导出与诊断核对；不影响既有字段。
import { beginReplay, summarizeReplaySession } from './lib/record-exec-replay.js';

/** 每个 tab 的录制 step 计数（只存计数/摘要/最近步骤元信息，不缓存整段事件历史）。 */
const stepState = new Map();
const STEP_STATE_MAX_TABS = 50;
/** 程序摘要采样：保留最近 N 步用于 buildRecordProgram；最多每 40 步或每个 branch 生成一次。 */
const TRACKED_PROGRAM_STEPS = 120;
const PROGRAM_SUMMARY_EVERY = 40;

function stateOf(tabId) {
  let state = stepState.get(tabId);
  if (!state) {
    state = {
      nextIndex: 0,
      lastSeq: 0,
      refs: [],
      lastRef: '',
      kinds: {},
      lastTs: 0,
      lastSignature: '',
      repeat: 0,
      waits: 0,
      mergeIndex: createMergeIndex(),
      recentStep: null,
      programSteps: [],
      stepsSinceProgram: 0,
      duplicates: 0,
      merged: 0,
      issues: 0,
      lastProgram: null,
      lastGraph: null,
      lastExec: null,
    };
    stepState.set(tabId, state);
    if (stepState.size > STEP_STATE_MAX_TABS) {
      const oldest = stepState.keys().next();
      if (!oldest.done) stepState.delete(oldest.value);
    }
  }
  return state;
}

/** 程序采样用的瘦身 step：保留校验/回放需要的信息，参数值/URL 截断，避免内存膨胀。 */
function compactStep(step, seq, index) {
  return {
    model: step.model,
    ref: step.ref,
    kind: step.kind,
    type: step.type,
    method: step.method,
    params: step.params && typeof step.params === 'object' ? { ...step.params } : {},
    target: step.target || null,
    idempotent: step.idempotent === true,
    risk: step.risk,
    fallback: step.fallback || null,
    ...(step.expect ? { expect: step.expect } : {}),
    ...(step.humanGate ? { humanGate: step.humanGate } : {}),
    ...(step.branch ? { branch: step.branch } : {}),
    ...(step.repeat > 1 ? { repeat: step.repeat } : {}),
    ...(step.waitBeforeMs > 0 ? { waitBeforeMs: step.waitBeforeMs } : {}),
    sourceKind: step.sourceKind,
    evidence: {
      seq,
      index,
      frameId: step.evidence && step.evidence.frameId,
      documentId: step.evidence && step.evidence.documentId,
      revision: step.evidence && step.evidence.revision,
      actor: step.evidence && step.evidence.actor,
      url: String((step.evidence && step.evidence.url) || '').slice(0, 500),
      at: step.evidence && step.evidence.at,
    },
  };
}

/** 把合并后的字段就地写回 canonical 事件（ops 里保存的是同一对象引用）。 */
function applyMergedEvent(canonical, mergedEvent) {
  if (!canonical || !mergedEvent) return canonical;
  for (const key of Object.keys(mergedEvent)) {
    if (key === 'recordDedupe') continue;
    canonical[key] = mergedEvent[key];
  }
  if (mergedEvent.recordDedupe) canonical.recordDedupe = mergedEvent.recordDedupe;
  return canonical;
}

function bumpDuplicate(canonical, decision) {
  if (!canonical) return;
  const previous = canonical.recordDedupe && typeof canonical.recordDedupe === 'object' ? canonical.recordDedupe : null;
  canonical.recordDedupe = {
    version: 1,
    merged: true,
    duplicates: (previous ? Number(previous.duplicates) || 0 : 0) + 1,
    sources: [...new Set([...(previous && Array.isArray(previous.sources) ? previous.sources : []), ...(decision.sources || [])])].slice(0, 8),
    ...(decision.identity ? { identity: String(decision.identity).slice(0, 200) } : {}),
    ...(decision.gapMs ? { gapMs: decision.gapMs } : {}),
  };
}

/** Normalize a page record event, attach document/frame boundary, actor and step model v2. */
export function handleRecordEvent(message, sender) {
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  if (tabId == null) return false;
  const actor = isAgentInputWindow(tabId) ? 'agent' : (message && message.actor);
  const event = Object.assign({}, message, actor ? { actor } : {}, {
    frameId: sender && Number.isInteger(sender.frameId) ? sender.frameId : 0,
    documentId: (message && message.documentId) || (sender && sender.documentId) || null,
    frameUrl: (message && message.frameUrl) || null,
  });
  event.boundary = {
    documentId: event.documentId || null,
    frameId: event.frameId || 0,
    revision: Number.isInteger(event.revision) ? event.revision : null,
  };
  const state = stateOf(tabId);
  const seq = Number.isInteger(event.seq) && event.seq > 0 ? event.seq : state.lastSeq + 1;
  if (Number.isInteger(event.seq) && event.seq > 0) state.lastSeq = Math.max(state.lastSeq, event.seq);
  else state.lastSeq = seq;
  const index = state.nextIndex;
  const step = buildRecordStep(event, {
    seq,
    index,
    frameId: event.frameId,
    documentId: event.documentId,
  });
  if (step) {
    event.recordStep = step;
    // 1) 去重/多源合并：同一 document+seq+kind+签名 = 可证明的重传，丢弃后到者并把增量字段合并回先到者。
    const decision = state.mergeIndex.classify(event, { seq, documentId: event.documentId });
    if (decision.kind === 'duplicate' && decision.canonical) {
      const merged = mergeEventPair(decision.canonical, event, {
        now: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
        windowMs: state.mergeIndex.windowMs,
      });
      applyMergedEvent(decision.canonical, merged.event);
      bumpDuplicate(decision.canonical, decision);
      state.mergeIndex.touch(decision.canonicalIndex, decision.canonical);
      state.duplicates += 1;
      return true;
    }
    if (decision.kind === 'merged' && decision.canonical) {
      // 同动作多源（不同 source、时间窗内、签名相同）：不丢弃，标注合并并补空缺观察字段。
      const merged = mergeEventPair(decision.canonical, event, {
        now: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
        windowMs: state.mergeIndex.windowMs,
      });
      applyMergedEvent(decision.canonical, merged.event);
      if (decision.canonical.recordStep) state.mergeIndex.touch(decision.canonicalIndex, decision.canonical);
      event.recordMerge = {
        version: 1,
        mergedInto: decision.canonical.recordStep ? decision.canonical.recordStep.ref : '',
        source: (decision.sources || [])[(decision.sources || []).length - 1] || '',
        gapMs: decision.gapMs || 0,
        action: decision.action || '',
        ...(merged.conflicts.length ? { conflicts: merged.conflicts.length } : {}),
      };
      state.merged += 1;
    }
    // 2) step 级合法性校验（branch/loop/human-gate/retry/seq/ref），仅在有问题时附证据。
    const check = validateRecordStep(step, { previous: state.recentStep, options: { maxLoopIterations: 200 } });
    if (check.issues.length) {
      step.recordStepIssues = check.issues.slice(0, 6);
      state.issues += check.issues.length;
    }
    // 3) 既有行为：事件间隔 → wait 提示；连续同签名动作 → loop 建议计数。
    const at = Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now();
    const gap = state.lastTs > 0 ? at - state.lastTs : 0;
    if (gap > 1200) {
      step.waitBeforeMs = Math.min(gap, 60_000);
      state.waits += 1;
    }
    const signature = stepSignature(step);
    if (signature && signature === state.lastSignature) {
      state.repeat += 1;
      step.repeat = state.repeat + 1;
    } else {
      state.repeat = 0;
    }
    state.lastSignature = signature;
    state.lastTs = at;
    // 4) 程序摘要：最近步骤滚动采样，遇到 branch 边界或每 40 步生成一次紧凑摘要。
    state.programSteps.push(compactStep(step, seq, index));
    if (state.programSteps.length > TRACKED_PROGRAM_STEPS) state.programSteps.shift();
    state.stepsSinceProgram += 1;
    if (step.kind === 'branch' || state.stepsSinceProgram >= PROGRAM_SUMMARY_EVERY) {
      try {
        const program = buildRecordProgram(state.programSteps);
        state.lastProgram = summarizeRecordProgram(program);
        state.stepsSinceProgram = 0;
        if (state.lastProgram) event.recordProgram = state.lastProgram;
        // 第三轮：同一批步骤的执行图 + 内存 dry-run 摘要（只加字段；失败不影响录制）。
        const graph = buildStepGraph(state.programSteps);
        state.lastGraph = summarizeStepGraph(graph);
        if (state.lastGraph) event.recordGraph = state.lastGraph;
        const executed = dryRunProgram(state.programSteps, {
          program,
          allowNonIdempotent: true,
          humanPolicy: 'allow',
          tag: 'record-sample:' + tabId,
          at,
        });
        state.lastExec = summarizeExecReport(executed);
        if (state.lastExec) event.recordExec = state.lastExec;
      } catch {
        // 摘要失败不影响录制
      }
    }
    event.recordStepVersion = RECORD_STEP_VERSION;
    state.nextIndex += 1;
    state.lastRef = step.ref;
    state.kinds[step.kind] = (state.kinds[step.kind] || 0) + 1;
    if (state.refs.length >= 20) state.refs.shift();
    state.refs.push(step.ref);
    state.recentStep = compactStep(step, seq, index);
    state.mergeIndex.remember(event, index);
  }
  collectEvent(tabId, event);
  return true;
}

/** 当前 tab 的 step 模型摘要（只读；导出/诊断用）。 */
export function recordStepSnapshot(tabId) {
  const id = Number(tabId);
  const state = stepState.get(id);
  if (!state) {
    return {
      model: RECORD_STEP_VERSION,
      index: 0,
      lastRef: '',
      refs: [],
      kinds: {},
      waits: 0,
      duplicates: 0,
      merged: 0,
      issues: 0,
      program: null,
      graph: null,
      exec: null,
    };
  }
  return {
    model: RECORD_STEP_VERSION,
    index: state.nextIndex,
    lastRef: state.lastRef,
    refs: [...state.refs],
    kinds: { ...state.kinds },
    waits: state.waits,
    repeat: state.repeat,
    duplicates: state.duplicates,
    merged: state.merged,
    issues: state.issues,
    program: state.lastProgram || null,
    graph: state.lastGraph || null,
    exec: state.lastExec || null,
  };
}

/** 一批已落库事件的 step 摘要 + 程序摘要 + 去重统计（record export / 草拟质量检查可直接用）。 */
export function summarizeRecording(events) {
  const list = Array.isArray(events) ? events : [];
  const steps = list.map((event) => event && event.recordStep).filter(Boolean);
  const summary = summarizeRecordSteps(steps);
  let program = null;
  let graph = null;
  let exec = null;
  let replay = null;
  try {
    const built = buildRecordProgram(steps);
    program = summarizeRecordProgram(built);
    // 第三轮：导出/草拟质量检查同时给出图与 dry-run 摘要（都只是新增字段）。
    graph = summarizeStepGraph(buildStepGraph(steps));
    exec = summarizeExecReport(dryRunProgram(steps, { program: built, allowNonIdempotent: true, humanPolicy: 'allow', tag: 'recording-export' }));
    // 回放前置：把同一份 program 变成可恢复回放会话（导出后可直接按 replay.token 去重启动）。
    const begun = beginReplay(built, { allowNonIdempotent: true, requireHumanValues: false, tag: 'recording-export' });
    replay = begun && begun.session
      ? { ok: begun.ok === true, ...summarizeReplaySession(begun.session), ...(begun.token ? { token: begun.token } : {}) }
      : null;
  } catch {
    program = null;
  }
  let duplicates = 0;
  let merged = 0;
  let issues = 0;
  const issueCodes = {};
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    if (event.recordDedupe && typeof event.recordDedupe === 'object') duplicates += Number(event.recordDedupe.duplicates) || 0;
    if (event.recordMerge) merged += 1;
    const stepIssues = event.recordStep && Array.isArray(event.recordStep.recordStepIssues) ? event.recordStep.recordStepIssues : [];
    for (const item of stepIssues) {
      issues += 1;
      if (item && item.code) issueCodes[item.code] = (issueCodes[item.code] || 0) + 1;
    }
  }
  return {
    ...summary,
    program,
    graph,
    exec,
    replay,
    duplicates,
    merged,
    issues,
    issueCodes,
  };
}

/** 录制结束/tab 关闭时释放计数（避免 SW 长期运行时 Map 无界增长）。 */
export function forgetRecordStepState(tabId) {
  const state = stepState.get(Number(tabId));
  if (state && state.mergeIndex) state.mergeIndex.clear();
  stepState.delete(Number(tabId));
}
