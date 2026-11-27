// extension/src/record-program.js —— 录制 step 程序的合法性校验、指纹、diff/归并、回放前预检。
//
// record-steps.js 负责“单条事件 → step v2”的规范化；本模块负责“一批 step → 可回放程序”：
//
//   1) 合法性校验（validateRecordStep / validateRecordProgram）
//      - action 必须有 method；branch 必须有边界与目标；human-gate 必须可执行（reason/valueKind）；
//      - loop（由连续同签名步骤推断，录制侧不猜 if/while 意图）不能超长、不能包住“带重试的副作用”；
//      - 非幂等动作不允许 fallback=retry；retry 必须带 retries；
//      - 文档切换必须有 branch 步骤标记（否则回放会跨文档瞎点）；
//      - seq 回退、ref 重复、未知 kind、程序过大都会给出结构化问题（error/warning 分级）。
//
//   2) 程序指纹 + diff/归并（programFingerprint / programDiff / mergeTextDiff / mergeRecordPrograms）
//      - 指纹用于“同一段操作再次录制/再次回放”的幂等判定；
//      - diff 用 LCS 对齐步骤签名，输出 added/removed/modified 与 hunks；
//      - mergeTextDiff 是行级三方归并（录制 base、两个来源各一份观察文本），冲突显式列出；
//      - mergeRecordPrograms 按 ref 对齐多源程序，合并字段并记录冲突。
//
//   3) 回放预检（preflightReplay）
//      - 回放前把“不能自动执行”的因素一次性列清楚：非幂等副作用、需要人工补值的 human-gate、
//        loop 次数、分支边界、重试预算、校验 error、指纹是否已回放过（幂等 token）。
//
// 运行时消费点：src/record-events.js 的 handleRecordEvent 每条事件都会调用
// validateRecordStep；遇到分支边界/每 40 步时调用 buildRecordProgram 把紧凑程序摘要挂到事件上
// （recordProgram 字段），该字段随 record.list / record export 的既有 RPC 路径一起返回。

import { RECORD_STEP_VERSION, stableHash, stepSignature } from './record-steps.js';

export { stepSignature };

export const RECORD_PROGRAM_VERSION = 1;

/** 程序校验问题码（内部证据码，不是 wire 错误码，不带 E_ 前缀）。 */
export const PROGRAM_CODES = Object.freeze({
  STEP_MODEL_MISSING: 'STEP_MODEL_MISSING',
  STEP_REF_MISSING: 'STEP_REF_MISSING',
  STEP_REF_DUPLICATE: 'STEP_REF_DUPLICATE',
  SEQ_REGRESSION: 'SEQ_REGRESSION',
  ACTION_NO_METHOD: 'ACTION_NO_METHOD',
  HUMAN_GATE_NO_REASON: 'HUMAN_GATE_NO_REASON',
  HUMAN_GATE_NO_VALUE_KIND: 'HUMAN_GATE_NO_VALUE_KIND',
  HUMAN_GATE_NO_TARGET: 'HUMAN_GATE_NO_TARGET',
  HUMAN_GATE_IN_LOOP: 'HUMAN_GATE_IN_LOOP',
  BRANCH_MISSING: 'BRANCH_MISSING',
  BRANCH_NAVIGATE_NO_URL: 'BRANCH_NAVIGATE_NO_URL',
  BRANCH_SWITCH_NO_TARGET: 'BRANCH_SWITCH_NO_TARGET',
  BRANCH_DEAD_END: 'BRANCH_DEAD_END',
  RETRY_NON_IDEMPOTENT: 'RETRY_NON_IDEMPOTENT',
  RETRY_WITHOUT_RETRIES: 'RETRY_WITHOUT_RETRIES',
  FALLBACK_UNKNOWN: 'FALLBACK_UNKNOWN',
  EXPECT_SHAPE: 'EXPECT_SHAPE',
  LOOP_TOO_LONG: 'LOOP_TOO_LONG',
  LOOP_RETRY_SIDE_EFFECT: 'LOOP_RETRY_SIDE_EFFECT',
  UNKNOWN_STEP_KIND: 'UNKNOWN_STEP_KIND',
  DOCUMENT_SWITCH_UNMARKED: 'DOCUMENT_SWITCH_UNMARKED',
  PROGRAM_TOO_LARGE: 'PROGRAM_TOO_LARGE',
  WAIT_TOO_LONG: 'WAIT_TOO_LONG',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  MERGE_DUPLICATE: 'MERGE_DUPLICATE',
  REPLAY_EMPTY: 'REPLAY_EMPTY',
  REPLAY_DUPLICATE: 'REPLAY_DUPLICATE',
  REPLAY_SIDE_EFFECT: 'REPLAY_SIDE_EFFECT',
  REPLAY_HUMAN_REQUIRED: 'REPLAY_HUMAN_REQUIRED',
  REPLAY_RETRY_BUDGET: 'REPLAY_RETRY_BUDGET',
  REPLAY_LOOP: 'REPLAY_LOOP',
  REPLAY_VALIDATION: 'REPLAY_VALIDATION',
});

/** 程序/回放的安全上限（可被 options 覆盖，默认值偏保守）。 */
export const PROGRAM_LIMITS = Object.freeze({
  maxSteps: 4000,
  maxLoopIterations: 50,
  maxWaitMs: 60_000,
  maxHumanGates: 64,
  maxRetriesPerStep: 5,
  maxReplayRetries: 20,
  maxDiffCells: 400_000,
  maxMergeLines: 2_000,
});

export const STEP_KINDS = Object.freeze(['action', 'observe', 'wait', 'branch', 'human-gate']);

const BOUNDARY_METHODS = Object.freeze(['navigate']);
const FALLBACK_ACTIONS = Object.freeze(['stop', 'skip', 'retry']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function textOf(value, max = 160) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function targetText(target) {
  if (!isPlainObject(target)) return '';
  return textOf(target.selector || target.text || target.name, 160);
}

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function issueKey(item) {
  return [item.code, item.severity, item.index == null ? '' : item.index, item.ref || ''].join('|');
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const item of issues) {
    if (!item || typeof item !== 'object') continue;
    const key = issueKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function optionsLimits(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    maxSteps: nonNegative(source.maxSteps) || PROGRAM_LIMITS.maxSteps,
    maxLoopIterations: nonNegative(source.maxLoopIterations) || PROGRAM_LIMITS.maxLoopIterations,
    maxWaitMs: nonNegative(source.maxWaitMs) || PROGRAM_LIMITS.maxWaitMs,
    maxHumanGates: nonNegative(source.maxHumanGates) || PROGRAM_LIMITS.maxHumanGates,
    maxRetriesPerStep: nonNegative(source.maxRetriesPerStep) || PROGRAM_LIMITS.maxRetriesPerStep,
    maxReplayRetries: nonNegative(source.maxReplayRetries) || PROGRAM_LIMITS.maxReplayRetries,
    maxDiffCells: nonNegative(source.maxDiffCells) || PROGRAM_LIMITS.maxDiffCells,
    maxMergeLines: nonNegative(source.maxMergeLines) || PROGRAM_LIMITS.maxMergeLines,
  };
}

/** 把 step（或已归一化的 node）统一成 node 形状；无法识别返回 null。 */
export function normalizeStepNode(input, index = 0) {
  if (!input || typeof input !== 'object') return null;
  if (input.node === true || (input.signature !== undefined && input.evidence === undefined && input.seq !== undefined)) {
    return { ...input, index: Number.isSafeInteger(input.index) ? input.index : index };
  }
  const evidence = isPlainObject(input.evidence) ? input.evidence : {};
  const target = isPlainObject(input.target) ? input.target : null;
  const step = input;
  return {
    node: true,
    index: Number.isSafeInteger(input.index) ? input.index : (Number.isSafeInteger(evidence.index) ? evidence.index : index),
    model: finiteInt(step.model, 0) || null,
    ref: String(step.ref || ''),
    kind: String(step.kind || ''),
    method: String(step.method || ''),
    signature: stepSignature(step),
    idempotent: step.idempotent === true,
    risk: String(step.risk || ''),
    sourceKind: String(step.sourceKind || ''),
    params: isPlainObject(step.params) ? { ...step.params } : {},
    target,
    targetText: targetText(target),
    humanGate: isPlainObject(step.humanGate) ? { ...step.humanGate } : null,
    branch: isPlainObject(step.branch) ? { ...step.branch } : null,
    fallback: isPlainObject(step.fallback) ? { ...step.fallback } : null,
    expect: isPlainObject(step.expect) ? { ...step.expect } : null,
    expectInvalid: step.expect !== undefined && step.expect !== null && !isPlainObject(step.expect),
    repeat: nonNegative(step.repeat),
    waitBeforeMs: nonNegative(step.waitBeforeMs),
    seq: finiteInt(evidence.seq, finiteInt(step.seq, 0)),
    at: finiteInt(evidence.at, finiteInt(step.ts, 0)),
    documentId: String(evidence.documentId || step.documentId || ''),
    frameId: finiteInt(evidence.frameId, finiteInt(step.frameId, 0)),
    url: String(evidence.url || step.url || ''),
    actor: String(evidence.actor || step.actor || 'human'),
  };
}

function nodeToStep(node) {
  return {
    model: node.model || RECORD_STEP_VERSION,
    index: finiteInt(node.index, 0),
    ref: node.ref,
    kind: node.kind,
    type: node.kind,
    method: node.method,
    params: node.params || {},
    target: node.target || null,
    idempotent: node.idempotent === true,
    fallback: node.fallback || { onError: 'stop' },
    risk: node.risk || 'read_only',
    ...(node.humanGate ? { humanGate: node.humanGate } : {}),
    ...(node.branch ? { branch: node.branch } : {}),
    ...(node.expect ? { expect: node.expect } : {}),
    ...(node.repeat > 1 ? { repeat: node.repeat } : {}),
    ...(node.waitBeforeMs > 0 ? { waitBeforeMs: node.waitBeforeMs } : {}),
    evidence: {
      index: finiteInt(node.index, 0),
      seq: node.seq,
      at: node.at,
      frameId: node.frameId,
      documentId: node.documentId,
      actor: node.actor,
      url: node.url,
    },
    sourceKind: node.sourceKind,
  };
}

function normalizeProgramSteps(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (isPlainObject(input) && Array.isArray(input.nodes)) list = input.nodes;
  else if (isPlainObject(input) && Array.isArray(input.steps)) list = input.steps;
  const nodes = [];
  for (let index = 0; index < list.length; index += 1) {
    const node = normalizeStepNode(list[index], index);
    if (node) nodes.push(node);
  }
  return nodes;
}

function isBoundaryNode(node) {
  if (!node) return false;
  if (node.kind !== 'branch') return false;
  return BOUNDARY_METHODS.includes(node.method) || Boolean(node.branch && (node.branch.boundary === 'tab-switch' || node.branch.boundary === 'window-switch'));
}

function fallbackOf(node) {
  return isPlainObject(node && node.fallback) ? node.fallback : {};
}

/**
 * 单步 + 紧邻上下文校验（运行时热路径，O(1)）。
 * @param {object} step step v2
 * @param {{previous?:object|null, options?:object, seq?:number, now?:number}} context
 * @returns {{ok:boolean, issues:Array, codes:string[]}}
 */
export function validateRecordStep(step, context = {}) {
  const node = normalizeStepNode(step, 0);
  if (!node) return { ok: false, issues: [problem(PROGRAM_CODES.STEP_MODEL_MISSING, 'error', '空 step')], codes: [PROGRAM_CODES.STEP_MODEL_MISSING] };
  const limits = optionsLimits(context.options);
  const previous = normalizeStepNode(context.previous, 0, true) || null;
  const issues = [];
  const push = (code, severity, message, extra = {}) => issues.push(problem(code, severity, message, { index: node.index, ref: node.ref, ...extra }));

  if (context.options && context.options.requireModel === true && !node.model) {
    push(PROGRAM_CODES.STEP_MODEL_MISSING, 'warning', 'step 缺少模型版本');
  }
  if (!node.ref) push(PROGRAM_CODES.STEP_REF_MISSING, 'warning', 'step 缺少稳定 ref（导出/去重会退化）');
  if (previous && node.ref && previous.ref && node.ref === previous.ref) {
    push(PROGRAM_CODES.STEP_REF_DUPLICATE, 'error', '连续两个 step 使用同一个 ref（ref 冲突）', { previousRef: previous.ref });
  }
  if (previous && node.seq > 0 && previous.seq > 0 && node.seq < previous.seq) {
    push(PROGRAM_CODES.SEQ_REGRESSION, 'warning', 'step 序号回退（乱序投递）', { previousSeq: previous.seq, seq: node.seq });
  }
  if (node.kind === 'action' && !node.method) push(PROGRAM_CODES.ACTION_NO_METHOD, 'error', 'action 步骤缺少 method');
  if (node.kind && !STEP_KINDS.includes(node.kind)) push(PROGRAM_CODES.UNKNOWN_STEP_KIND, 'warning', '未知 step kind', { kind: node.kind });

  const fallback = fallbackOf(node);
  if (fallback.onError && !FALLBACK_ACTIONS.includes(String(fallback.onError))) {
    push(PROGRAM_CODES.FALLBACK_UNKNOWN, 'warning', '未知 fallback.onError', { onError: String(fallback.onError) });
  }
  if (fallback.onError === 'retry') {
    const retries = finiteInt(fallback.retries, 0);
    if (retries <= 0) push(PROGRAM_CODES.RETRY_WITHOUT_RETRIES, 'warning', 'fallback=retry 但没给 retries', {});
    if (!node.idempotent) push(PROGRAM_CODES.RETRY_NON_IDEMPOTENT, 'error', '非幂等动作不允许自动重试', { method: node.method });
    if (retries > limits.maxRetriesPerStep && limits.maxRetriesPerStep > 0) {
      push(PROGRAM_CODES.RETRY_WITHOUT_RETRIES, 'warning', 'retries 超过单步上限', { retries, max: limits.maxRetriesPerStep });
    }
  }
  if (node.humanGate) {
    if (!textOf(node.humanGate.reason, 400)) push(PROGRAM_CODES.HUMAN_GATE_NO_REASON, 'warning', 'human-gate 缺少说明');
    if (!textOf(node.humanGate.valueKind, 40)) push(PROGRAM_CODES.HUMAN_GATE_NO_VALUE_KIND, 'warning', 'human-gate 缺少 valueKind');
    if (node.kind === 'action' && !node.target && !node.params.selector && !node.params.text) {
      push(PROGRAM_CODES.HUMAN_GATE_NO_TARGET, 'warning', 'human-gate 没有目标，回放时无法定位');
    }
  }
  if (node.kind === 'branch') {
    if (!node.branch) push(PROGRAM_CODES.BRANCH_MISSING, 'error', 'branch 步骤缺少 branch 描述');
    else if (node.method === 'navigate' && !textOf(node.branch.url, 2000) && !textOf(node.params.url, 2000)) {
      push(PROGRAM_CODES.BRANCH_NAVIGATE_NO_URL, 'error', 'navigate 分支缺少 url');
    } else if ((node.branch.boundary === 'tab-switch' || node.branch.boundary === 'window-switch')
      && !Number.isInteger(node.branch.tabId) && !Number.isInteger(node.branch.windowId)) {
      push(PROGRAM_CODES.BRANCH_SWITCH_NO_TARGET, 'warning', 'tab/window 切换分支没有目标 id');
    }
  }
  if (node.expectInvalid || (node.expect && !isPlainObject(node.expect))) push(PROGRAM_CODES.EXPECT_SHAPE, 'warning', 'expect 必须是对象');
  if (node.repeat > limits.maxLoopIterations && limits.maxLoopIterations > 0) {
    push(PROGRAM_CODES.LOOP_TOO_LONG, 'error', '连续重复次数超过循环上限', { repeat: node.repeat, max: limits.maxLoopIterations });
  }
  if (node.waitBeforeMs > limits.maxWaitMs && limits.maxWaitMs > 0) {
    push(PROGRAM_CODES.WAIT_TOO_LONG, 'warning', '步骤前等待超过上限（会被截断）', { waitBeforeMs: node.waitBeforeMs, max: limits.maxWaitMs });
  }
  const ok = issues.every((item) => item.severity !== 'error');
  return { ok, issues, codes: issues.map((item) => item.code) };
}

function validateNodes(nodes, options = {}) {
  const limits = optionsLimits(options);
  const issues = [];
  const add = (code, severity, message, extra = {}) => issues.push(problem(code, severity, message, extra));
  const seenRefs = new Map();
  const loopGroups = detectLoopGroups(nodes, limits);
  let seqRegressions = 0;
  let documentSwitches = 0;
  let previous = null;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const stepCheck = validateRecordStep(nodeToStep({ ...node, index }), { previous, options });
    for (const item of stepCheck.issues) {
      // 单步问题里 seq 回退/ref 重复由程序级统一计数，避免重复。
      if (item.code === PROGRAM_CODES.SEQ_REGRESSION || item.code === PROGRAM_CODES.STEP_REF_DUPLICATE) continue;
      issues.push({ ...item, index, scope: item.scope || 'step' });
    }
    if (node.ref) {
      if (seenRefs.has(node.ref)) {
        add(PROGRAM_CODES.STEP_REF_DUPLICATE, 'error', '重复的 step ref', { index, ref: node.ref, firstIndex: seenRefs.get(node.ref) });
      } else {
        seenRefs.set(node.ref, index);
      }
    }
    if (previous && node.seq > 0 && previous.seq > 0 && node.seq < previous.seq) {
      seqRegressions += 1;
      if (seqRegressions <= 8) add(PROGRAM_CODES.SEQ_REGRESSION, 'warning', 'step 序号回退', { index, seq: node.seq, previousSeq: previous.seq });
    }
    if (node.documentId && previous && previous.documentId && node.documentId !== previous.documentId && !isBoundaryNode(node) && !isBoundaryNode(previous)) {
      documentSwitches += 1;
      if (documentSwitches <= 8) add(PROGRAM_CODES.DOCUMENT_SWITCH_UNMARKED, 'warning', '文档切换没有 branch 步骤标记', { index, from: previous.documentId, to: node.documentId });
    }
    if (node.kind === 'branch' && index === nodes.length - 1) {
      add(PROGRAM_CODES.BRANCH_DEAD_END, 'warning', 'branch 出现在程序末尾（切换后没有后续步骤）', { index, ref: node.ref });
    }
    previous = node;
  }
  const humanGates = nodes.filter((node) => node.humanGate);
  if (humanGates.length > limits.maxHumanGates) {
    add(PROGRAM_CODES.REPLAY_HUMAN_REQUIRED, 'warning', 'human-gate 数量超过上限', { humanGates: humanGates.length, max: limits.maxHumanGates });
  }
  for (const group of loopGroups) {
    if (group.count > limits.maxLoopIterations && limits.maxLoopIterations > 0) {
      add(PROGRAM_CODES.LOOP_TOO_LONG, 'error', '连续重复次数超过循环上限', { from: group.from, to: group.to, count: group.count, max: limits.maxLoopIterations });
    }
    if (group.containsHumanGate) {
      add(PROGRAM_CODES.HUMAN_GATE_IN_LOOP, 'warning', '循环体内包含 human-gate（每轮都需要人工）', { from: group.from, to: group.to, count: group.count });
    }
    if (group.containsSideEffect) {
      add(PROGRAM_CODES.LOOP_RETRY_SIDE_EFFECT, 'error', '循环体内包含带重试的副作用步骤', { from: group.from, to: group.to, count: group.count });
    }
  }
  if (nodes.length > limits.maxSteps) {
    add(PROGRAM_CODES.PROGRAM_TOO_LARGE, 'error', '程序步骤数超过上限', { steps: nodes.length, max: limits.maxSteps });
  }
  const deduped = dedupeIssues(issues);
  const errors = deduped.filter((item) => item.severity === 'error').length;
  const warnings = deduped.filter((item) => item.severity !== 'error').length;
  const byCode = {};
  for (const item of deduped) byCode[item.code] = (byCode[item.code] || 0) + 1;
  return {
    ok: errors === 0,
    issues: deduped.slice(0, 64),
    errors,
    warnings,
    byCode,
    rules_evaluated: 12,
    checked_steps: nodes.length,
    limits,
  };
}

/** 程序校验：接受 steps 数组 / program / {steps} / {nodes}。 */
export function validateRecordProgram(input, options = {}) {
  const nodes = normalizeProgramSteps(input);
  return validateNodes(nodes, options);
}

function detectLoopGroups(nodes, limits) {
  const groups = [];
  let start = 0;
  for (let index = 1; index <= nodes.length; index += 1) {
    const same = index < nodes.length && nodes[index] && nodes[start] && nodes[index].signature && nodes[index].signature === nodes[start].signature;
    if (same) continue;
    const count = index - start;
    const declared = Math.max(count, nonNegative(nodes[start] && nodes[start].repeat));
    if (count >= 2 || declared > 1) {
      const members = nodes.slice(start, index);
      groups.push({
        from: start,
        to: index - 1,
        count: Math.max(count, declared),
        declaredRepeat: declared,
        signature: (nodes[start] && nodes[start].signature) || '',
        method: (nodes[start] && nodes[start].method) || '',
        containsHumanGate: members.some((node) => Boolean(node.humanGate)),
        containsSideEffect: members.some((node) => !node.idempotent && fallbackOf(node).onError === 'retry'),
        maxRetries: members.reduce((max, node) => Math.max(max, finiteInt(fallbackOf(node).retries, 0)), 0),
        limit: limits.maxLoopIterations,
      });
    }
    start = index;
  }
  return groups;
}

function computeSegments(nodes) {
  const segments = [];
  let start = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isBoundaryNode(node)) continue;
    segments.push({
      id: 'seg-' + (segments.length + 1),
      from: start,
      to: index,
      steps: index - start,
      boundary: {
        kind: node.kind,
        method: node.method,
        ...(node.branch && node.branch.url ? { url: textOf(node.branch.url, 500) } : {}),
        ...(node.branch && Number.isInteger(node.branch.tabId) ? { tabId: node.branch.tabId } : {}),
        ...(node.branch && Number.isInteger(node.branch.windowId) ? { windowId: node.branch.windowId } : {}),
      },
    });
    start = index + 1;
  }
  if (start <= nodes.length - 1) {
    segments.push({ id: 'seg-' + (segments.length + 1), from: start, to: nodes.length - 1, steps: nodes.length - start, boundary: null });
  }
  return segments;
}

function programStats(nodes, loops, segments) {
  const byKind = {};
  const methods = new Set();
  let idempotent = 0;
  let nonIdempotent = 0;
  let humanGates = 0;
  let boundaries = 0;
  let waits = 0;
  let repeats = 0;
  const documents = new Set();
  for (const node of nodes) {
    byKind[node.kind || 'unknown'] = (byKind[node.kind || 'unknown'] || 0) + 1;
    if (node.method) methods.add(node.method);
    if (node.idempotent) idempotent += 1;
    else nonIdempotent += 1;
    if (node.humanGate) humanGates += 1;
    if (isBoundaryNode(node)) boundaries += 1;
    if (node.waitBeforeMs > 0) waits += 1;
    if (node.repeat > 1) repeats += 1;
    if (node.documentId) documents.add(node.documentId);
  }
  return {
    total: nodes.length,
    byKind,
    methods: [...methods].slice(0, 16),
    idempotent,
    nonIdempotent,
    humanGates,
    loops: loops.length,
    loopIterations: loops.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0),
    boundaries,
    segments: segments.length,
    waits,
    repeats,
    documents: documents.size,
  };
}

function fingerprintOfNodes(nodes) {
  const canonical = nodes.map((node) => [node.kind, node.method, node.signature, node.ref, node.humanGate ? 1 : 0, node.branch ? 1 : 0]);
  return 'p' + stableHash(JSON.stringify(canonical)) + '-' + nodes.length.toString(36);
}

/**
 * 构建录制程序模型（节点/边界段/循环组/human-gate/校验/指纹）。
 * @param {Array|object} steps
 * @param {{maxSteps?:number, maxLoopIterations?:number}} options
 */
export function buildRecordProgram(steps, options = {}) {
  const nodes = normalizeProgramSteps(steps);
  const validation = validateNodes(nodes, options);
  const loops = detectLoopGroups(nodes, optionsLimits(options));
  const segments = computeSegments(nodes);
  const humanGates = nodes
    .filter((node) => Boolean(node.humanGate))
    .map((node) => ({
      index: node.index,
      ref: node.ref,
      method: node.method,
      reason: textOf(node.humanGate.reason, 240),
      valueKind: textOf(node.humanGate.valueKind, 40),
      inLoop: loops.some((group) => node.index >= group.from && node.index <= group.to),
    }));
  const edges = [];
  for (let index = 0; index < nodes.length - 1 && edges.length < 400; index += 1) {
    edges.push({
      from: nodes[index].ref || '#' + nodes[index].index,
      to: nodes[index + 1].ref || '#' + nodes[index + 1].index,
      kind: isBoundaryNode(nodes[index]) ? 'boundary' : 'linear',
    });
  }
  const program = {
    version: RECORD_PROGRAM_VERSION,
    model: RECORD_STEP_VERSION,
    fingerprint: fingerprintOfNodes(nodes),
    nodes,
    edges,
    segments,
    loops,
    humanGates,
    validation,
    stats: programStats(nodes, loops, segments),
  };
  return program;
}

/** 程序指纹（可传 program/steps）。 */
export function programFingerprint(input) {
  if (isPlainObject(input) && typeof input.fingerprint === 'string' && input.fingerprint) return input.fingerprint;
  return fingerprintOfNodes(normalizeProgramSteps(input));
}

/** 对外紧凑摘要（挂到录制事件上；必须小）。 */
export function summarizeRecordProgram(program) {
  if (!program || typeof program !== 'object') return null;
  const stats = program.stats && typeof program.stats === 'object' ? program.stats : {};
  const validation = program.validation && typeof program.validation === 'object' ? program.validation : {};
  return {
    version: finiteInt(program.version, RECORD_PROGRAM_VERSION),
    model: finiteInt(program.model, RECORD_STEP_VERSION),
    fingerprint: String(program.fingerprint || ''),
    steps: finiteInt(stats.total, 0),
    actions: finiteInt(stats.byKind && stats.byKind.action, 0),
    observes: finiteInt(stats.byKind && stats.byKind.observe, 0),
    branches: finiteInt(stats.boundaries, 0),
    segments: finiteInt(stats.segments, 0),
    loops: finiteInt(stats.loops, 0),
    humanGates: finiteInt(stats.humanGates, 0),
    idempotent: finiteInt(stats.idempotent, 0),
    nonIdempotent: finiteInt(stats.nonIdempotent, 0),
    errors: finiteInt(validation.errors, 0),
    warnings: finiteInt(validation.warnings, 0),
    ...(Array.isArray(validation.issues) && validation.issues.length
      ? { issues: validation.issues.slice(0, 4).map((item) => ({ code: item.code, severity: item.severity, ...(item.index != null ? { index: item.index } : {}) })) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 文本 diff / 三方归并
// ---------------------------------------------------------------------------

function toLines(text) {
  const value = String(text == null ? '' : text);
  if (value === '') return [];
  return value.split('\n');
}

function lcsPairs(left, right, maxCells = PROGRAM_LIMITS.maxDiffCells) {
  const n = left.length;
  const m = right.length;
  if (n === 0 || m === 0) return [];
  if (n * m > maxCells) {
    // 退化为公共前缀 + 公共后缀（避免大文本 O(n*m) 爆内存）
    const pairs = [];
    let prefix = 0;
    while (prefix < n && prefix < m && left[prefix] === right[prefix]) {
      pairs.push([prefix, prefix]);
      prefix += 1;
    }
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && left[n - 1 - suffix] === right[m - 1 - suffix]) suffix += 1;
    for (let index = 0; index < suffix; index += 1) pairs.push([n - suffix + index, m - suffix + index]);
    return pairs;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function diffLines(base, variant, maxCells) {
  const left = toLines(base);
  const right = toLines(variant);
  const pairs = lcsPairs(left, right, maxCells);
  const ops = [];
  let i = 0;
  let j = 0;
  for (const [bi, rj] of pairs.concat([[left.length, right.length]])) {
    while (i < bi) {
      ops.push({ type: 'delete', line: left[i], base: i });
      i += 1;
    }
    while (j < rj) {
      ops.push({ type: 'insert', line: right[j], variant: j });
      j += 1;
    }
    if (bi < left.length) {
      ops.push({ type: 'equal', line: left[bi], base: bi, variant: rj });
      i += 1;
      j += 1;
    }
  }
  return { ops, left, right, pairs };
}

/**
 * 行级三方归并：base 为录制时的文本，left/right 为两份来源（例如两个 frame 的观察文本）。
 * 冲突不抛异常：按 prefer 选择一侧写进 merged，同时把两侧内容放进 conflicts 供人工/上层决策。
 * @returns {{ok:boolean, merged:string, conflicts:Array, stats:object}}
 */
export function mergeTextDiff(base, left, right, options = {}) {
  const prefer = options.prefer === 'right' ? 'right' : 'left';
  const baseText = String(base == null ? '' : base);
  const leftText = String(left == null ? '' : left);
  const rightText = String(right == null ? '' : right);
  if (leftText === baseText) {
    return { ok: true, merged: rightText, conflicts: [], stats: { baseLines: toLines(baseText).length, leftLines: toLines(leftText).length, rightLines: toLines(rightText).length, conflicts: 0, leftChanges: 0, rightChanges: 1 } };
  }
  if (rightText === baseText) {
    return { ok: true, merged: leftText, conflicts: [], stats: { baseLines: toLines(baseText).length, leftLines: toLines(leftText).length, rightLines: toLines(rightText).length, conflicts: 0, leftChanges: 1, rightChanges: 0 } };
  }
  if (leftText === rightText) {
    return { ok: true, merged: leftText, conflicts: [], stats: { baseLines: toLines(baseText).length, leftLines: toLines(leftText).length, rightLines: toLines(rightText).length, conflicts: 0, leftChanges: 1, rightChanges: 1 } };
  }
  const limits = optionsLimits(options);
  const baseLines = toLines(baseText);
  const leftLines = toLines(leftText);
  const rightLines = toLines(rightText);
  if (baseLines.length > limits.maxMergeLines || leftLines.length > limits.maxMergeLines || rightLines.length > limits.maxMergeLines) {
    return {
      ok: false,
      merged: prefer === 'right' ? rightText : leftText,
      conflicts: [{ reason: 'too_large', baseStart: 0, baseEnd: baseLines.length, leftLines: leftLines.length, rightLines: rightLines.length }],
      stats: { baseLines: baseLines.length, leftLines: leftLines.length, rightLines: rightLines.length, conflicts: 1, leftChanges: 0, rightChanges: 0, prefer },
    };
  }
  const leftPairs = lcsPairs(baseLines, leftLines, limits.maxDiffCells);
  const rightPairs = lcsPairs(baseLines, rightLines, limits.maxDiffCells);
  const leftMap = new Map(leftPairs);
  const rightMap = new Map(rightPairs);
  const merged = [];
  const conflicts = [];
  let baseIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  let leftChanges = 0;
  let rightChanges = 0;
  while (baseIndex < baseLines.length || leftIndex < leftLines.length || rightIndex < rightLines.length) {
    const leftMatch = leftMap.has(baseIndex) ? leftMap.get(baseIndex) : undefined;
    const rightMatch = rightMap.has(baseIndex) ? rightMap.get(baseIndex) : undefined;
    if (baseIndex < baseLines.length && leftMatch === leftIndex && rightMatch === rightIndex) {
      merged.push(baseLines[baseIndex]);
      baseIndex += 1;
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    // 找下一处“base 两侧都对齐”的位置，作为本次变更区的右边界。
    let sync = baseIndex + 1;
    while (sync <= baseLines.length) {
      const leftSync = leftMap.has(sync) ? leftMap.get(sync) : undefined;
      const rightSync = rightMap.has(sync) ? rightMap.get(sync) : undefined;
      if (sync < baseLines.length) {
        if (leftSync !== undefined && rightSync !== undefined && leftSync >= leftIndex && rightSync >= rightIndex) break;
        if ((leftSync === undefined || rightSync === undefined) && sync === baseLines.length) break;
      }
      sync += 1;
    }
    const baseEnd = Math.min(sync, baseLines.length);
    const leftEnd = leftMap.has(sync) ? leftMap.get(sync) : leftLines.length;
    const rightEnd = rightMap.has(sync) ? rightMap.get(sync) : rightLines.length;
    const leftChunk = leftLines.slice(leftIndex, Math.max(leftIndex, leftEnd));
    const rightChunk = rightLines.slice(rightIndex, Math.max(rightIndex, rightEnd));
    const baseChunk = baseLines.slice(baseIndex, baseEnd);
    const sameChange = leftChunk.length === rightChunk.length && leftChunk.every((line, index) => line === rightChunk[index]);
    if (sameChange) {
      for (const line of leftChunk) merged.push(line);
      if (leftChunk.length || baseChunk.length) leftChanges += 1;
      if (leftChunk.length || baseChunk.length) rightChanges += 1;
    } else if (leftChunk.length === 0 && baseChunk.length === 0) {
      for (const line of rightChunk) merged.push(line);
      rightChanges += 1;
    } else if (rightChunk.length === 0 && baseChunk.length === 0) {
      for (const line of leftChunk) merged.push(line);
      leftChanges += 1;
    } else {
      conflicts.push({
        baseStart: baseIndex,
        baseEnd,
        baseLines: baseChunk,
        leftLines: leftChunk,
        rightLines: rightChunk,
      });
      const chosen = prefer === 'right' ? rightChunk : leftChunk;
      for (const line of chosen) merged.push(line);
      leftChanges += 1;
      rightChanges += 1;
    }
    if (sync < baseLines.length) {
      merged.push(baseLines[sync]);
      baseIndex = sync + 1;
      leftIndex = (leftMap.get(sync) ?? leftIndex) + 1;
      rightIndex = (rightMap.get(sync) ?? rightIndex) + 1;
    } else {
      baseIndex = baseLines.length;
      leftIndex = leftLines.length;
      rightIndex = rightLines.length;
    }
  }
  return {
    ok: conflicts.length === 0,
    merged: merged.join('\n'),
    conflicts: conflicts.slice(0, 32),
    stats: {
      baseLines: baseLines.length,
      leftLines: leftLines.length,
      rightLines: rightLines.length,
      conflicts: conflicts.length,
      leftChanges,
      rightChanges,
      prefer,
    },
  };
}

// ---------------------------------------------------------------------------
// 程序 diff（LCS 对齐步骤签名）
// ---------------------------------------------------------------------------

/**
 * 两个录制程序的步骤级 diff。
 * @returns {{ok:boolean, equal:boolean, ops:Array, hunks:Array, stats:object,
 *   fingerprints:{left:string,right:string}}}
 */
export function programDiff(leftInput, rightInput, options = {}) {
  const left = normalizeProgramSteps(leftInput);
  const right = normalizeProgramSteps(rightInput);
  const limits = optionsLimits(options);
  const leftKeys = left.map((node) => node.signature || node.ref || node.kind);
  const rightKeys = right.map((node) => node.signature || node.ref || node.kind);
  const pairs = lcsPairs(leftKeys, rightKeys, limits.maxDiffCells);
  const ops = [];
  let li = 0;
  let ri = 0;
  for (const [lIndex, rIndex] of pairs.concat([[left.length, right.length]])) {
    while (li < lIndex) {
      ops.push({ type: 'removed', leftIndex: li, ref: left[li].ref, signature: leftKeys[li] });
      li += 1;
    }
    while (ri < rIndex) {
      ops.push({ type: 'added', rightIndex: ri, ref: right[ri].ref, signature: rightKeys[ri] });
      ri += 1;
    }
    if (lIndex < left.length) {
      ops.push({ type: 'equal', leftIndex: lIndex, rightIndex: rIndex, ref: left[lIndex].ref, signature: leftKeys[lIndex] });
      li = lIndex + 1;
      ri = rIndex + 1;
    }
  }
  // 同 ref 的删+增紧邻出现时，归并为 modified（同一目标的参数/值变化）。
  for (let index = 0; index < ops.length - 1; index += 1) {
    const current = ops[index];
    const next = ops[index + 1];
    if (current.type === 'removed' && next.type === 'added' && current.ref && current.ref === next.ref) {
      ops.splice(index, 2, {
        type: 'modified',
        leftIndex: current.leftIndex,
        rightIndex: next.rightIndex,
        ref: current.ref,
        before: left[current.leftIndex] ? nodeToStep(left[current.leftIndex]) : null,
        after: right[next.rightIndex] ? nodeToStep(right[next.rightIndex]) : null,
      });
    }
  }
  const hunks = [];
  let current = null;
  for (const item of ops) {
    if (item.type === 'equal') {
      if (current) {
        hunks.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { ops: [], leftIndexes: [], rightIndexes: [] };
    current.ops.push(item);
    if (item.leftIndex != null) current.leftIndexes.push(item.leftIndex);
    if (item.rightIndex != null) current.rightIndexes.push(item.rightIndex);
    if (current.ops.length >= 200) {
      hunks.push(current);
      current = null;
    }
  }
  if (current) hunks.push(current);
  const stats = {
    leftSteps: left.length,
    rightSteps: right.length,
    equal: ops.filter((item) => item.type === 'equal').length,
    added: ops.filter((item) => item.type === 'added').length,
    removed: ops.filter((item) => item.type === 'removed').length,
    modified: ops.filter((item) => item.type === 'modified').length,
    hunks: hunks.length,
  };
  return {
    ok: true,
    equal: stats.added === 0 && stats.removed === 0 && stats.modified === 0,
    ops: ops.slice(0, 400),
    hunks: hunks.slice(0, 32).map((hunk) => ({
      leftIndexes: hunk.leftIndexes,
      rightIndexes: hunk.rightIndexes,
      ops: hunk.ops.map((item) => item.type),
    })),
    stats,
    fingerprints: { left: fingerprintOfNodes(left), right: fingerprintOfNodes(right) },
  };
}

// ---------------------------------------------------------------------------
// 多源程序合并
// ---------------------------------------------------------------------------

/**
 * 合并多个来源的录制程序（同一段操作由两路录制/两份导出各一份）。
 * 对齐键：ref 优先，其次 签名+seq。冲突（同 ref 不同方法/签名）保留先到者并记录。
 * @param {Array<{source?:string, steps?:Array, program?:object}|object>} inputs
 * @returns {{ok:boolean, program:object, sources:object, conflicts:Array, duplicates:number, stats:object}}
 */
export function mergeRecordPrograms(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  const merged = new Map();
  const order = [];
  const sources = {};
  const conflicts = [];
  let duplicates = 0;
  for (const input of list) {
    if (!input || typeof input !== 'object') continue;
    const source = String(input.source || 'primary');
    sources[source] = (sources[source] || 0) + 1;
    const rawSteps = Array.isArray(input.steps)
      ? input.steps
      : (isPlainObject(input.program) && Array.isArray(input.program.nodes)
        ? input.program.nodes.map(nodeToStep)
        : (Array.isArray(input.nodes) ? input.nodes.map(nodeToStep) : []));
    for (const rawStep of rawSteps) {
      const node = normalizeStepNode(rawStep, order.length);
      if (!node) continue;
      const key = node.ref || (node.signature + '#' + node.seq);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...node, sources: [source] });
        order.push(key);
        continue;
      }
      duplicates += 1;
      const mergedNode = { ...existing, sources: [...new Set([...(existing.sources || []), source])] };
      const sameShape = existing.kind === node.kind
        && existing.method === node.method
        && String(existing.targetText || '') === String(node.targetText || '');
      if (!sameShape) {
        conflicts.push({ code: PROGRAM_CODES.MERGE_CONFLICT, ref: node.ref || key, source, field: 'signature', kept: existing.signature, incoming: node.signature });
      } else {
        // 同一目标的参数/值差异不算冲突：缺的值补上，已有值优先。
        const params = { ...(existing.params || {}) };
        let filledValue = false;
        for (const [field, value] of Object.entries(node.params || {})) {
          if (params[field] === undefined || params[field] === '' || params[field] === null) {
            if (value !== undefined && value !== '') filledValue = true;
            params[field] = value;
          }
        }
        mergedNode.params = params;
        if (filledValue) mergedNode.signature = node.signature;
        if (!existing.expect && node.expect) mergedNode.expect = node.expect;
        if (!existing.humanGate && node.humanGate) mergedNode.humanGate = node.humanGate;
        if (!existing.branch && node.branch) mergedNode.branch = node.branch;
        if (!existing.fallback && node.fallback) mergedNode.fallback = node.fallback;
      }
      merged.set(key, mergedNode);
    }
  }
  const steps = order.map((key) => nodeToStep(merged.get(key)));
  // 已合并节点上的 sources 需要带回（nodeToStep 不带），在此补一行。
  const program = buildRecordProgram(steps, options);
  for (let index = 0; index < program.nodes.length; index += 1) {
    const key = order[index];
    const source = merged.get(key);
    if (source && Array.isArray(source.sources)) program.nodes[index].sources = source.sources;
  }
  return {
    ok: conflicts.length === 0,
    program,
    sources,
    conflicts: conflicts.slice(0, 32),
    duplicates,
    stats: {
      sources: Object.keys(sources).length,
      inputs: list.length,
      steps: program.stats.total,
      duplicates,
      conflicts: conflicts.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 回放预检（幂等 token + 阻断项清单）
// ---------------------------------------------------------------------------

/**
 * 回放/导出前的预检：把“不能自动跑”的因素一次性列清楚，并给出幂等 token。
 * @param {Array|object} stepsOrProgram
 * @param {{knownTokens?:string[], token?:string, salt?:string, allowNonIdempotent?:boolean,
 *          prefer?:'left'|'right', maxLoopIterations?:number, maxReplayRetries?:number,
 *          requireHumanValues?:boolean}} options
 */
export function preflightReplay(stepsOrProgram, options = {}) {
  const program = isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes)
    ? stepsOrProgram
    : buildRecordProgram(stepsOrProgram, options);
  const limits = optionsLimits(options);
  const blockers = [];
  const requiresHuman = [];
  const warnings = [];
  const replayPlan = [];
  const steps = program.nodes.map((node) => nodeToStep(node));
  const validation = program.validation || validateRecordProgram(program, options);

  for (const issue of validation.issues || []) {
    if (issue.severity === 'error') {
      blockers.push({ code: PROGRAM_CODES.REPLAY_VALIDATION, severity: 'error', message: issue.message, issue: issue.code, index: issue.index });
    } else {
      warnings.push({ code: issue.code, severity: 'warning', index: issue.index, message: issue.message });
    }
  }
  let retryBudget = 0;
  for (const node of program.nodes) {
    const fallback = fallbackOf(node);
    if (fallback.onError === 'retry') retryBudget += finiteInt(fallback.retries, 0);
    if (!node.idempotent && options.allowNonIdempotent !== true) {
      blockers.push({ code: PROGRAM_CODES.REPLAY_SIDE_EFFECT, severity: 'error', index: node.index, ref: node.ref, message: '非幂等副作用步骤需要显式允许（allowNonIdempotent）', method: node.method });
    }
    if (node.humanGate) {
      const hasValue = node.params && node.params.value !== undefined && node.params.value !== '';
      if (options.requireHumanValues !== false && !hasValue) {
        requiresHuman.push({ index: node.index, ref: node.ref, method: node.method, valueKind: textOf(node.humanGate.valueKind, 40), reason: textOf(node.humanGate.reason, 240) });
      }
    }
  }
  if (requiresHuman.length) {
    blockers.push({ code: PROGRAM_CODES.REPLAY_HUMAN_REQUIRED, severity: 'error', message: 'human-gate 需要人工补值', count: requiresHuman.length });
  }
  if (retryBudget > limits.maxReplayRetries) {
    blockers.push({ code: PROGRAM_CODES.REPLAY_RETRY_BUDGET, severity: 'error', message: '总重试次数超过回放预算', retryBudget, max: limits.maxReplayRetries });
  } else if (retryBudget > 0) {
    warnings.push({ code: PROGRAM_CODES.REPLAY_RETRY_BUDGET, severity: 'warning', message: '回放包含自动重试', retryBudget });
  }
  for (const group of program.loops || []) {
    if (group.count > 1) {
      warnings.push({ code: PROGRAM_CODES.REPLAY_LOOP, severity: 'warning', message: '回放包含连续重复步骤', from: group.from, to: group.to, count: group.count });
    }
  }
  for (const segment of program.segments || []) {
    if (segment.boundary) {
      replayPlan.push({
        index: segment.from,
        kind: 'branch',
        method: segment.boundary.method,
        boundary: segment.boundary,
        ref: program.nodes[segment.from] ? program.nodes[segment.from].ref : '',
      });
    }
  }
  for (const node of program.nodes) {
    if (node.kind !== 'action') continue;
    replayPlan.push({
      index: node.index,
      ref: node.ref,
      kind: node.kind,
      method: node.method,
      params: node.params || {},
      ...(node.expect ? { expect: node.expect } : {}),
      ...(node.fallback ? { fallback: node.fallback } : {}),
      idempotent: node.idempotent === true,
      ...(node.humanGate ? { humanGate: node.humanGate } : {}),
    });
  }
  if (!steps.length) blockers.push({ code: PROGRAM_CODES.REPLAY_EMPTY, severity: 'error', message: '没有可回放的步骤' });
  const token = 'rp-' + stableHash([program.fingerprint, String(options.salt || ''), RECORD_PROGRAM_VERSION].join('|'));
  const known = new Set(Array.isArray(options.knownTokens) ? options.knownTokens.map(String) : []);
  const duplicate = known.has(token) || (options.token !== undefined && options.token !== null && String(options.token) === token && options.allowDuplicate !== true);
  if (duplicate) blockers.push({ code: PROGRAM_CODES.REPLAY_DUPLICATE, severity: 'error', message: '同一程序已回放过（幂等 token 命中）', token });
  const ok = blockers.length === 0 && duplicate === false;
  return {
    ok,
    allowed: ok,
    duplicate,
    token,
    fingerprint: program.fingerprint,
    blockers,
    requiresHuman: requiresHuman.slice(0, 32),
    warnings: warnings.slice(0, 32),
    replayPlan: replayPlan.slice(0, 400),
    stats: {
      steps: steps.length,
      actions: replayPlan.filter((item) => item.kind === 'action').length,
      branches: replayPlan.filter((item) => item.kind === 'branch').length,
      humanGates: requiresHuman.length,
      blockers: blockers.length,
      warnings: warnings.length,
      retryBudget,
    },
    program: summarizeRecordProgram(program),
  };
}
