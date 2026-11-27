// extension/src/lib/replay-plan.js —— 确定性回放计划（纯函数，零 chrome 依赖）。
//
// 输入可以是：录制程序（record-program.js buildRecordProgram 的 {nodes,loops,segments}）、
// 一组 step、preflightReplay() 的 {replayPlan,token,...}、或录制事件数组（每条带 recordStep）。
// 输出一份“可执行、可解释、可校验”的计划：
//   - steps：展开 loop/repeat、插入 wait 与 human-gate、去重相邻幂等重复后的线性步骤；
//   - phases：按 replay-boundary 的 epoch 切出的阶段（换文档/换帧/换 tab）；
//   - checkpoints：边界/人工点/固定间隔处的恢复点；
//   - boundaries：边界还原计划（navigate / frame-switch / abort…）；
//   - targets：目标还原计划（exact / fallback / ambiguous / planned…）；
//   - schedule：纯相对时间线（不读时钟），预算与阻塞项；
//   - fingerprint/token：同输入必得同 token，用于幂等与“同一程序重复回放”判定。
//
// 不变量：
//   - 确定性：同输入 → 逐字节相同的计划（无 Date.now / Math.random / Map 迭代序依赖）；
//   - 只加字段：不消费/不修改既有命令结果，计划是“旁路证据”；
//   - 不猜：没有 URL 的换文档、无快照的验证、匿名目标都在 blockers 里显式列出。
//
// 运行时消费者：extension/src/replay.js（network.replay / debug replay / record export
// 三条路径共用 buildReplayPlan + summarizeReplayPlan）。

import { stableHash } from '../record-steps.js';
import {
  boundaryFromStep,
  boundaryScopeKey,
  normalizeBoundary,
  normalizeBoundaryMode,
} from './replay-boundary.js';
import {
  planBoundaryRestoration,
  summarizeBoundaries,
  boundaryBlockerCodes,
} from './replay-boundary-plan.js';
import {
  planTargetRestoration,
  summarizeTargetPlan,
  targetBlockerCodes,
  targetsNeedingHuman,
} from './replay-target.js';

/** 计划模型版本：与 token 绑定，规则变化即换版本。 */
export const REPLAY_PLAN_VERSION = 1;

/** 计划里的步骤种类。 */
export const PLAN_STEP_KINDS = Object.freeze(['action', 'branch', 'observe', 'wait', 'human', 'network']);

const KIND_SET = new Set(PLAN_STEP_KINDS);

/** 计划/回放的安全上限（可被 options.limits 覆盖；默认保守）。 */
export const DEFAULT_PLAN_LIMITS = Object.freeze({
  maxSteps: 4000,
  maxLoopIterations: 50,
  maxWaitMs: 60000,
  maxTotalMs: 900000,
  maxRetries: 200,
  maxHumanGates: 64,
  checkpointEvery: 25,
  maxParamText: 400,
  maxCheckpoints: 200,
});

/** 计划级阻断/警告码（与 replay-explain 目录对齐）。 */
export const PLAN_CODES = Object.freeze({
  EMPTY: 'PLAN_EMPTY',
  TOO_LARGE: 'PLAN_TOO_LARGE',
  HUMAN_VALUE: 'PLAN_HUMAN_VALUE_MISSING',
  DUPLICATE: 'PLAN_DUPLICATE',
  BOUNDARY_UNRESTORABLE: 'PLAN_BOUNDARY_UNRESTORABLE',
  TARGET_UNRESOLVED: 'PLAN_TARGET_UNRESOLVED',
  RETRY_BUDGET: 'PLAN_RETRY_BUDGET',
  WAIT_CAPPED: 'PLAN_WAIT_CAPPED',
  LOOP_CLAMPED: 'PLAN_LOOP_CLAMPED',
  LOOP_OVERLAP: 'PLAN_LOOP_OVERLAP',
  VALIDATION: 'PLAN_VALIDATION',
  NETWORK: 'PLAN_NETWORK_REQUEST',
  INVALID_INPUT: 'PLAN_INVALID_INPUT',
  TRUNCATED: 'PLAN_TRUNCATED',
});

/** 计划的阶段常量（summary 里用）。 */
export const PLAN_PHASE_KINDS = Object.freeze(['document', 'frame', 'tab', 'group', 'verify']);

// ---------------------------------------------------------------------------
// 确定性序列化 / 指纹
// ---------------------------------------------------------------------------

/** 稳定 JSON：对象键排序、数组保序、undefined 省略、非有限数字写 null。 */
export function stableStringify(value) {
  return stringifyValue(value, 0);
}

function stringifyValue(value, depth) {
  if (depth > 8) return '"[depth]"';
  if (value === undefined) return 'null';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type !== 'object') return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stringifyValue(item, depth + 1)).join(',') + ']';
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stringifyValue(value[key], depth + 1)).join(',') + '}';
}

/** 把任意值收敛成“可参与指纹/可安全打印”的标量或小对象。 */
function sanitizeValue(value, depth, maxText) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return value.length > maxText ? value.slice(0, maxText) : value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (depth <= 0) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item, depth - 1, maxText));
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 32)) {
      out[key] = sanitizeValue(value[key], depth - 1, maxText);
    }
    return out;
  }
  return null;
}

/** 归一化上限参数：options.limits / options 直接给数字都接受。 */
export function normalizePlanLimits(source = {}) {
  const limits = source && typeof source === 'object' ? source : {};
  const nested = limits.limits && typeof limits.limits === 'object' ? limits.limits : limits;
  const out = { ...DEFAULT_PLAN_LIMITS };
  for (const key of Object.keys(DEFAULT_PLAN_LIMITS)) {
    const value = Number(nested[key]);
    if (Number.isFinite(value) && value > 0) out[key] = Math.floor(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// step 归一化
// ---------------------------------------------------------------------------

/** 录制 kind → 计划 kind（human-gate 独立成 human 步骤，见 insertWaitsAndHuman）。 */
function planKindOf(node) {
  const raw = String(node && (node.kind || node.type) || '').toLowerCase();
  if (raw === 'branch') return 'branch';
  if (raw === 'wait') return 'wait';
  if (raw === 'observe') return 'observe';
  if (raw === 'human-gate' || raw === 'human') return 'human';
  if (raw === 'network') return 'network';
  if (!raw && node && node.method === 'navigate') return 'branch';
  return 'action';
}

/** 归一化单个 step/节点；index 由外层重新分配，sourceIndex 保留原始位置。 */
export function normalizePlanStep(node, index, options = {}) {
  const limits = normalizePlanLimits(options);
  const source = node && typeof node === 'object' ? node : {};
  const kind = planKindOf(source);
  const fallback = source.fallback && typeof source.fallback === 'object'
    ? {
      onError: ['stop', 'retry', 'skip'].includes(String(source.fallback.onError)) ? String(source.fallback.onError) : 'stop',
      retries: Math.max(0, Math.min(Number(source.fallback.retries) || 0, limits.maxLoopIterations)),
      retryDelayMs: Math.max(0, Math.min(Number(source.fallback.retryDelayMs) || 0, limits.maxWaitMs)),
      skipReason: typeof source.fallback.skipReason === 'string' ? source.fallback.skipReason.slice(0, 200) : '',
    }
    : { onError: 'stop', retries: 0, retryDelayMs: 0, skipReason: '' };
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {};
  let boundary = source.boundary && typeof source.boundary === 'object'
    ? normalizeBoundary(source.boundary)
    : boundaryFromStep(source);
  // 计划节点（未执行过的 navigate）常把 URL 放在 params/branch 里，而不是 evidence。
  if (!boundary.url) {
    const urlCandidate = (source.branch && source.branch.url)
      || (source.params && typeof source.params.url === 'string' ? source.params.url : '');
    if (urlCandidate) boundary = normalizeBoundary({ ...boundary, url: urlCandidate });
  }
  const step = {
    index: Number.isInteger(index) ? index : 0,
    sourceIndex: Number.isInteger(source.index) ? source.index : (Number.isInteger(index) ? index : 0),
    ref: typeof source.ref === 'string' ? source.ref.slice(0, 80) : '',
    kind: KIND_SET.has(kind) ? kind : 'action',
    sourceKind: typeof source.kind === 'string' ? source.kind.slice(0, 40) : '',
    method: typeof source.method === 'string' ? source.method.slice(0, 80) : '',
    params: sanitizeValue(source.params, 3, limits.maxParamText) || {},
    target: sanitizeValue(source.target, 2, limits.maxParamText),
    expect: sanitizeValue(source.expect, 2, limits.maxParamText),
    fallback,
    idempotent: source.idempotent === true,
    risk: typeof source.risk === 'string' ? source.risk.slice(0, 40) : 'read_only',
    humanGate: source.humanGate && typeof source.humanGate === 'object'
      ? {
        reason: String(source.humanGate.reason || '').slice(0, 240),
        valueKind: String(source.humanGate.valueKind || 'text').slice(0, 40),
      }
      : null,
    branch: source.branch && typeof source.branch === 'object' ? sanitizeValue(source.branch, 2, limits.maxParamText) : null,
    waitsForHuman: false,
    boundary,
  };
  if (Number.isFinite(Number(source.waitBeforeMs)) && Number(source.waitBeforeMs) > 0) {
    step.waitBeforeMs = Math.min(Math.floor(Number(source.waitBeforeMs)), limits.maxWaitMs);
  } else {
    step.waitBeforeMs = 0;
  }
  if (Number.isInteger(Number(source.repeat)) && Number(source.repeat) > 1) {
    step.repeat = Math.min(Math.floor(Number(source.repeat)), limits.maxLoopIterations);
  } else {
    step.repeat = 1;
  }
  if (evidence.at !== undefined) step.at = Number(evidence.at) || 0;
  if (evidence.seq !== undefined) step.seq = Number(evidence.seq) || 0;
  if (source.loop !== undefined && typeof source.loop === 'object') step.loop = sanitizeValue(source.loop, 2, 80);
  return step;
}

/**
 * 把多种输入形状归一成 {nodes, loops, segments, source}。
 * 支持：数组（step / 录制事件 / 节点）、{nodes}、{program}、{steps}、
 * preflight 结果（{replayPlan,...}）、buildReplayPlan 的输入对象。
 */
export function coercePlanInput(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let nodes = [];
  let loops = [];
  let segments = [];
  let sourceName = 'steps';
  if (Array.isArray(input)) {
    const list = input;
    if (list.length && list[0] && typeof list[0] === 'object' && list[0].recordStep) {
      nodes = list.map((event) => event.recordStep).filter(Boolean);
      sourceName = 'events';
    } else {
      nodes = list;
      sourceName = 'steps';
    }
  } else if (Array.isArray(source.nodes)) {
    nodes = source.nodes;
    loops = Array.isArray(source.loops) ? source.loops : [];
    segments = Array.isArray(source.segments) ? source.segments : [];
    sourceName = 'program';
  } else if (source.program && typeof source.program === 'object' && Array.isArray(source.program.nodes)) {
    nodes = source.program.nodes;
    loops = Array.isArray(source.program.loops) ? source.program.loops : [];
    segments = Array.isArray(source.program.segments) ? source.program.segments : [];
    sourceName = 'program';
  } else if (Array.isArray(source.steps)) {
    nodes = source.steps;
    sourceName = 'steps';
  } else if (Array.isArray(source.replayPlan)) {
    nodes = source.replayPlan.map(adaptPreflightEntry);
    sourceName = 'preflight';
  }
  return { nodes, loops, segments, source: sourceName };
}

/** preflightReplay 的 replayPlan 条目 → 计划节点（只做形状适配，不改语义）。 */
function adaptPreflightEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.kind === 'branch') {
    return {
      kind: 'branch',
      method: entry.method || 'navigate',
      params: entry.boundary && entry.boundary.url ? { url: entry.boundary.url } : {},
      ref: entry.ref || '',
      index: entry.index,
      idempotent: true,
      branch: { boundary: 'document', url: entry.boundary && entry.boundary.url || '' },
      boundary: entry.boundary || null,
      fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
    };
  }
  return {
    kind: entry.kind || 'action',
    method: entry.method || '',
    params: entry.params || {},
    target: entry.params && (entry.params.selector || entry.params.text) ? entry.params : (entry.target || null),
    ref: entry.ref || '',
    index: entry.index,
    expect: entry.expect,
    fallback: entry.fallback,
    idempotent: entry.idempotent === true,
    humanGate: entry.humanGate || null,
  };
}

// ---------------------------------------------------------------------------
// 展开 loop / repeat
// ---------------------------------------------------------------------------

/**
 * 展开录制里的 loop（program.loops 的 {from,to,count}）与 step.repeat。
 * 展开是确定性的：第 k 次重复的 step 带 iteration=k、loopOf=from；超过上限即 clamp 并告警。
 * @returns {{steps:Array<object>, warnings:Array<object>, expanded:number, clamped:number}}
 */
export function expandLoops(steps, loops, limits) {
  const list = Array.isArray(steps) ? steps : [];
  const lim = limits || DEFAULT_PLAN_LIMITS;
  const warnings = [];
  const blocks = [];
  const rawLoops = Array.isArray(loops) ? loops : [];
  for (const loop of rawLoops) {
    if (!loop || typeof loop !== 'object') continue;
    const from = Math.max(0, Math.floor(Number(loop.from) || 0));
    const to = Math.min(list.length - 1, Math.floor(Number(loop.to) || 0));
    const rawCount = Math.max(1, Math.floor(Number(loop.count) || 1));
    if (to < from) continue;
    const count = Math.min(rawCount, lim.maxLoopIterations);
    if (rawCount > count) {
      warnings.push({ code: PLAN_CODES.LOOP_CLAMPED, from, to, count, max: lim.maxLoopIterations, message: '循环次数超过上限，已截断' });
    }
    if (count > 1) blocks.push({ from, to, count });
  }
  // 重叠的循环块无法无语义地展开：只保留外层（更早开始、更晚结束），并告警。
  blocks.sort((left, right) => left.from - right.from || right.to - left.to);
  const kept = [];
  for (const block of blocks) {
    const overlap = kept.find((existing) => !(block.to < existing.from || block.from > existing.to));
    if (overlap) {
      warnings.push({ code: PLAN_CODES.LOOP_OVERLAP, from: block.from, to: block.to, message: '循环区间重叠，仅展开外层循环' });
      continue;
    }
    kept.push(block);
  }
  const blockAt = new Map(kept.map((block) => [block.from, block]));
  const out = [];
  let expanded = 0;
  for (let position = 0; position < list.length; position += 1) {
    const block = blockAt.get(position);
    const step = list[position];
    if (!block) {
      out.push(step);
      continue;
    }
    for (let iteration = 0; iteration < block.count; iteration += 1) {
      for (let cursor = block.from; cursor <= block.to; cursor += 1) {
        const base = list[cursor];
        const clone = iteration === 0
          ? { ...base, loopOf: block.from, iteration: 0, loopCount: block.count }
          : { ...base, loopOf: block.from, iteration, loopCount: block.count, synthetic: true, index: out.length };
        out.push(clone);
      }
      expanded += block.count > 1 ? 1 : 0;
    }
    position = block.to;
  }
  // step 级 repeat（录制期“同签名连续动作”的计数）在 loop 展开之后处理。
  const repeated = [];
  let repeatClamped = 0;
  for (const step of out) {
    const count = Math.min(Math.max(1, Number(step.repeat) || 1), lim.maxLoopIterations);
    if ((Number(step.repeat) || 1) > count) repeatClamped += 1;
    for (let iteration = 0; iteration < count; iteration += 1) {
      if (iteration === 0) {
        repeated.push({ ...step, repeat: count, iteration: step.iteration || 0 });
      } else {
        repeated.push({
          ...step,
          iterateOf: step.ref || '#' + step.index,
          iteration,
          repeat: count,
          synthetic: true,
          idempotent: step.idempotent === true,
        });
      }
    }
  }
  if (repeatClamped > 0) {
    warnings.push({ code: PLAN_CODES.LOOP_CLAMPED, repeatClamped, max: lim.maxLoopIterations, message: '重复次数超过上限，已截断' });
  }
  return { steps: repeated, warnings, expanded, clamped: repeatClamped };
}

// ---------------------------------------------------------------------------
// 插入 wait / human-gate
// ---------------------------------------------------------------------------

/**
 * 在动作前插入 wait 步骤（waitBeforeMs）与 human 步骤（humanGate）。
 * 插入只新增合成步骤，不改变原 step 的字段；合成步骤带 forIndex 指回原 step。
 * @returns {{steps:Array<object>, warnings:Array<object>, waits:number, humans:number}}
 */
export function insertWaitsAndHuman(steps, limits) {
  const list = Array.isArray(steps) ? steps : [];
  const lim = limits || DEFAULT_PLAN_LIMITS;
  const warnings = [];
  const out = [];
  let waits = 0;
  let humans = 0;
  let humanBudget = 0;
  for (const step of list) {
    const explicitWait = step.kind === 'wait' ? Math.max(0, Math.min(Number(step.ms !== undefined ? step.ms : step.params && step.params.ms) || 0, lim.maxWaitMs)) : 0;
    const waitMs = Math.max(0, Math.min(Number(step.waitBeforeMs) || 0, lim.maxWaitMs)) || explicitWait;
    if (step.kind === 'wait' && waitMs <= 0) continue;
    if (waitMs > 0) {
      const previous = out[out.length - 1];
      if (previous && previous.kind === 'wait') {
        // 连续等待合并（确定性：取上限截断后的和）。
        previous.ms = Math.min(previous.ms + waitMs, lim.maxWaitMs);
        previous.merged = (previous.merged || 1) + 1;
        if (step.kind === 'wait') continue;
      } else {
        out.push({
          index: out.length,
          sourceIndex: step.sourceIndex,
          ref: 'wait:' + (step.ref || step.sourceIndex),
          kind: 'wait',
          method: 'wait',
          params: { ms: waitMs },
          target: null,
          fallback: { onError: 'stop', retries: 0, retryDelayMs: 0, skipReason: '' },
          idempotent: true,
          risk: 'read_only',
          humanGate: null,
          waitsForHuman: false,
          boundary: step.boundary,
          at: step.at,
          ms: waitMs,
          synthetic: true,
          forIndex: step.sourceIndex,
        });
        waits += 1;
      }
    }
    // 显式 wait 步骤已经由上面的合成 wait 表达，不再原样入列。
    if (step.kind === 'wait' && waitMs > 0) {
      if (!(out[out.length - 1] && out[out.length - 1].kind === 'wait')) out.push(step);
      continue;
    }
    if (step.humanGate) {
      const insertHuman = humanBudget < lim.maxHumanGates;
      humanBudget += 1;
      if (insertHuman) {
        out.push({
          index: out.length,
          sourceIndex: step.sourceIndex,
          ref: 'human:' + (step.ref || step.sourceIndex),
          kind: 'human',
          method: 'human-gate',
          params: { valueKind: step.humanGate.valueKind },
          target: null,
          fallback: { onError: 'stop', retries: 0, retryDelayMs: 0, skipReason: '' },
          idempotent: true,
          risk: 'human_gate',
          humanGate: step.humanGate,
          waitsForHuman: false,
          boundary: step.boundary,
          at: step.at,
          synthetic: true,
          forIndex: step.sourceIndex,
        });
        humans += 1;
      } else {
        warnings.push({ code: PLAN_CODES.HUMAN_VALUE, ref: step.ref, message: 'human-gate 超过上限，已省略暂停点' });
      }
    }
    const gated = Boolean(step.humanGate) && humanBudget <= lim.maxHumanGates;
    out.push({
      ...step,
      index: out.length,
      waitsForHuman: gated,
      ...(gated ? { gateSourceIndex: step.sourceIndex } : {}),
    });
  }
  // 连续 wait 合并后可能超过 maxWaitMs：显式告警（不静默截断）。
  for (const step of out) {
    if (step.kind === 'wait' && Number(step.ms) >= lim.maxWaitMs) {
      warnings.push({ code: PLAN_CODES.WAIT_CAPPED, forIndex: step.forIndex, ms: step.ms, max: lim.maxWaitMs, message: '等待被上限截断' });
    }
  }
  return { steps: out, warnings, waits, humans };
}

// ---------------------------------------------------------------------------
// 去重 / 简化
// ---------------------------------------------------------------------------

/** 计划步骤签名：方法 + 目标签名 + 参数 + 边界作用域（不含 index）。 */
export function planStepSignature(step) {
  if (!step || typeof step !== 'object') return '';
  const target = step.target && typeof step.target === 'object'
    ? [step.target.selector, step.target.name, step.target.text, step.target.role].filter(Boolean).join('\u0001')
    : '';
  const params = step.params && typeof step.params === 'object' ? stableStringify(step.params) : '';
  const scope = boundaryScopeKey(step.boundary);
  const base = [step.kind, step.method, target, stableHash(params), scope, step.humanGate ? 'h' : ''].join('|');
  return stableHash(base);
}

/**
 * 只去重“相邻且签名相同”的幂等步骤；非幂等动作永不删除（可能改变服务端状态）。
 * @returns {{steps:Array<object>, removed:number, warnings:Array<object>}}
 */
export function dedupeSafe(steps, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  if (options.dedupeIdempotent === false) return { steps: list, removed: 0, warnings: [] };
  const out = [];
  let removed = 0;
  let previous = null;
  for (const step of list) {
    const signature = planStepSignature(step);
    // 只合并“同一次录制步骤的重复投递/合并残留”：ref 与 sourceIndex 必须相同，
    // 且循环/重复展开出来的不同迭代绝不能互相合并。
    const sameOrigin = previous
      && previous.signature === signature
      && String(step.ref || '') === String(previous.step.ref || '')
      && Number(step.sourceIndex) === Number(previous.step.sourceIndex)
      && Number(step.iteration || 0) === Number(previous.step.iteration || 0)
      && String(step.loopOf === undefined ? '' : step.loopOf) === String(previous.step.loopOf === undefined ? '' : previous.step.loopOf)
      && String(step.iterateOf || '') === String(previous.step.iterateOf || '');
    if (previous && sameOrigin && step.idempotent === true && previous.step.kind === step.kind) {
      previous.step.deduped = (previous.step.deduped || 1) + 1;
      removed += 1;
      continue;
    }
    out.push(step);
    previous = { step, signature };
  }
  return { steps: out, removed, warnings: [] };
}

// ---------------------------------------------------------------------------
// 时间线 / 预算 / 检查点
// ---------------------------------------------------------------------------

/**
 * 纯相对时间线：从 0 开始累加 wait 时长；不读时钟，不依赖录制时间戳
 * （录制时间只作为 step.at 证据保留，不进入调度，保证不同机器同样结果）。
 * @returns {{units:Array<object>, totalDelayMs:number, maxStepEndMs:number, capped:boolean}}
 */
export function schedulePlan(steps, limits) {
  const list = Array.isArray(steps) ? steps : [];
  const lim = limits || DEFAULT_PLAN_LIMITS;
  const units = [];
  let cursor = 0;
  let capped = false;
  for (const step of list) {
    const duration = step.kind === 'wait' ? Math.max(0, Math.min(Number(step.ms) || 0, lim.maxWaitMs)) : 0;
    let end = cursor + duration;
    if (end > lim.maxTotalMs) {
      end = lim.maxTotalMs;
      capped = true;
    }
    units.push({
      index: Number.isInteger(step.index) ? step.index : units.length,
      kind: step.kind,
      startMs: cursor,
      durationMs: Math.max(0, end - cursor),
      endMs: end,
    });
    cursor = end;
  }
  return {
    units,
    totalDelayMs: cursor,
    maxStepEndMs: cursor,
    capped,
  };
}

/** 计划的预算统计（步数/等待/重试/human/风险分布）。 */
export function planBudget(steps, limits) {
  const list = Array.isArray(steps) ? steps : [];
  const lim = limits || DEFAULT_PLAN_LIMITS;
  const budget = {
    steps: list.length,
    actions: 0,
    branches: 0,
    observes: 0,
    waits: 0,
    humans: 0,
    networks: 0,
    waitMs: 0,
    retries: 0,
    humanGates: 0,
    risks: {},
    methods: {},
    maxSteps: lim.maxSteps,
    maxRetries: lim.maxRetries,
    maxWaitMs: lim.maxWaitMs,
    maxTotalMs: lim.maxTotalMs,
    overBudget: false,
  };
  for (const step of list) {
    switch (step.kind) {
      case 'action': budget.actions += 1; break;
      case 'branch': budget.branches += 1; break;
      case 'observe': budget.observes += 1; break;
      case 'wait': budget.waits += 1; budget.waitMs += Math.max(0, Number(step.ms) || 0); break;
      case 'human': budget.humans += 1; break;
      case 'network': budget.networks += 1; break;
      default: break;
    }
    if (step.kind === 'human') budget.humanGates += 1;
    else if (step.humanGate && step.waitsForHuman !== true) budget.humanGates += 1;
    if (step.fallback && step.fallback.onError === 'retry') budget.retries += Math.max(0, Number(step.fallback.retries) || 0);
    const risk = String(step.risk || 'read_only');
    budget.risks[risk] = (budget.risks[risk] || 0) + 1;
    if (step.method) budget.methods[step.method] = (budget.methods[step.method] || 0) + 1;
  }
  budget.overBudget = budget.steps > lim.maxSteps || budget.retries > lim.maxRetries || budget.waitMs > lim.maxTotalMs;
  return budget;
}

/**
 * 检查点：每个 epoch 起点 + 每个 human 步骤前 + 每 checkpointEvery 步。
 * 检查点是“恢复点”，不是执行步骤（不改变 steps）。
 */
export function checkpointsFor(steps, boundaries, limits) {
  const list = Array.isArray(steps) ? steps : [];
  const lim = limits || DEFAULT_PLAN_LIMITS;
  const every = Math.max(1, Math.floor(Number(lim.checkpointEvery) || 25));
  const out = [];
  const seen = new Set();
  const push = (index, kind, extra = {}) => {
    if (!Number.isInteger(index) || index < 0 || index > list.length) return;
    const key = kind + '@' + index;
    if (seen.has(key)) return;
    if (out.length >= lim.maxCheckpoints) return;
    seen.add(key);
    const step = list[index] || null;
    out.push({
      id: 'cp-' + out.length,
      index,
      kind,
      boundaryScope: step ? boundaryScopeKey(step.boundary) : '',
      ref: step ? step.ref || '' : '',
      ...extra,
    });
  };
  const epochs = boundaries && Array.isArray(boundaries.epochs) ? boundaries.epochs : [];
  for (const epoch of epochs) push(epoch.startIndex, epoch.epoch === 0 ? 'start' : 'boundary');
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].kind === 'human') push(index, 'human');
    if (index > 0 && index % every === 0) push(index, 'interval');
  }
  push(list.length, 'end');
  out.sort((left, right) => left.index - right.index || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  return out.map((checkpoint, index) => ({ ...checkpoint, id: 'cp-' + index }));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 计划指纹：步骤签名 + 边界作用域 + 人工点 + human-gate 值的哈希（值不入指纹明文）。 */
export function planFingerprint(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const material = list.map((step) => [
    planStepSignature(step),
    String(step.kind),
    String(step.humanGate ? 'gate' : ''),
    step.waitsForHuman ? 'wait-human' : '',
    String(step.loopOf === undefined ? '' : 'loop' + step.loopOf),
  ].join(':'));
  return stableHash(material.join('>'));
}

/** 计划 token：版本 + 指纹 + 盐；用于“同一程序是否已回放”的幂等判定。 */
export function planToken(fingerprint, salt) {
  return 'rp' + REPLAY_PLAN_VERSION + '-' + stableHash([REPLAY_PLAN_VERSION, String(fingerprint || ''), String(salt === undefined || salt === null ? '' : salt)].join('|'));
}

/**
 * 构建确定性回放计划。
 * @param {unknown} input 见文件头。
 * @param {{salt?:string, knownTokens?:string[], token?:string, allowDuplicate?:boolean,
 *          current?:object, frames?:Array<object>, mode?:string, snapshots?:unknown,
 *          requireSnapshot?:boolean, requireHumanValues?:boolean, allowNonIdempotent?:boolean,
 *          allowTabSwitch?:boolean, strictCurrent?:boolean, dedupeIdempotent?:boolean,
 *          limits?:object, blockers?:Array<object>, validationIssues?:Array<object>,
 *          preflight?:object, source?:string, maxSteps?:number}} [options]
 * @returns {object}
 */
export function buildReplayPlan(input, options = {}) {
  const limits = normalizePlanLimits(options);
  const warnings = [];
  const blockers = [];
  const coerced = coercePlanInput(input);
  let nodes = coerced.nodes.filter(Boolean);
  if (options.maxSteps && Number(options.maxSteps) > 0) {
    nodes = nodes.slice(0, Math.floor(Number(options.maxSteps)));
  }
  if (nodes.length > limits.maxSteps) {
    warnings.push({ code: PLAN_CODES.TOO_LARGE, count: nodes.length, max: limits.maxSteps, message: '录制步骤超过计划上限，已截断' });
    nodes = nodes.slice(0, limits.maxSteps);
  }
  const baseSteps = nodes.map((node, index) => normalizePlanStep(node, index, limits));
  const looped = expandLoops(baseSteps, coerced.loops, limits);
  warnings.push(...looped.warnings);
  const inserted = insertWaitsAndHuman(looped.steps, limits);
  warnings.push(...inserted.warnings);
  const deduped = dedupeSafe(inserted.steps, options);
  const steps = deduped.steps.map((step, index) => ({ ...step, index }));
  if (steps.length > limits.maxSteps) {
    steps.length = limits.maxSteps;
    warnings.push({ code: PLAN_CODES.TRUNCATED, max: limits.maxSteps, message: '展开后超过步骤上限，已截断' });
  }

  const boundaries = planBoundaryRestoration(steps, {
    current: options.current,
    frames: options.frames,
    mode: normalizeBoundaryMode(options.mode),
    allowTabSwitch: options.allowTabSwitch !== false,
    strictCurrent: options.strictCurrent === true,
    maxSteps: limits.maxSteps,
  });
  for (const blocker of boundaries.blockers) {
    blockers.push({
      code: blocker.code || PLAN_CODES.BOUNDARY_UNRESTORABLE,
      index: blocker.index,
      message: blocker.message || '边界无法还原',
      reason: blocker.reason || '',
      epoch: blocker.epoch,
      source: 'boundary',
    });
  }

  const targets = planTargetRestoration(steps, options.snapshots, {
    requireSnapshot: options.requireSnapshot === true,
    includeHidden: options.includeHidden === true,
    ambiguityMargin: options.ambiguityMargin,
    minScore: options.minScore,
  });
  for (const blocker of targets.blockers) {
    blockers.push({
      code: blocker.code || PLAN_CODES.TARGET_UNRESOLVED,
      index: blocker.index,
      message: blocker.message || '目标无法还原',
      source: 'target',
    });
  }

  for (const warning of boundaries.warnings || []) {
    warnings.push({
      code: warning.code || PLAN_CODES.BOUNDARY_UNRESTORABLE,
      index: warning.index,
      message: warning.message || '边界还原提示',
      source: 'boundary',
    });
  }
  for (const warning of targets.warnings || []) {
    warnings.push({
      code: warning.code || PLAN_CODES.TARGET_UNRESOLVED,
      index: warning.index,
      message: warning.message || '目标还原提示',
      source: 'target',
    });
  }

  // 与 preflightReplay 对齐的语义：非幂等动作需显式允许；human-gate 缺值需阻断。
  if (options.allowNonIdempotent !== true) {
    for (const step of steps) {
      if (step.kind !== 'action' || step.idempotent === true) continue;
      blockers.push({
        code: 'REPLAY_SIDE_EFFECT',
        index: step.index,
        message: '非幂等副作用步骤需要显式允许（allowNonIdempotent）',
        method: step.method,
        source: 'plan',
      });
    }
  }
  if (options.requireHumanValues !== false) {
    for (const step of steps) {
      // 合成 human 步骤只是暂停点，补值检查看它后面的动作步骤。
      if (!step.humanGate || step.kind === 'human') continue;
      const value = step.params && step.params.value;
      if (value === undefined || value === '') {
        blockers.push({
          code: PLAN_CODES.HUMAN_VALUE,
          index: step.index,
          message: 'human-gate 需要人工补值',
          valueKind: step.humanGate.valueKind,
          source: 'plan',
        });
      }
    }
  }
  if (inserted.humans > limits.maxHumanGates) {
    blockers.push({ code: PLAN_CODES.HUMAN_VALUE, index: -1, message: 'human-gate 数量超过上限', count: inserted.humans, max: limits.maxHumanGates, source: 'plan' });
  }

  const budget = planBudget(steps, limits);
  if (budget.retries > limits.maxRetries) {
    blockers.push({ code: PLAN_CODES.RETRY_BUDGET, index: -1, message: '总重试次数超过回放预算', retryBudget: budget.retries, max: limits.maxRetries, source: 'plan' });
  }

  const schedule = schedulePlan(steps, limits);
  if (schedule.capped) {
    warnings.push({ code: PLAN_CODES.WAIT_CAPPED, max: limits.maxTotalMs, message: '总等待时长超过上限，已截断时间线' });
  }
  const fingerprints = planFingerprint(steps);
  const token = planToken(fingerprints, options.salt);
  const known = new Set(Array.isArray(options.knownTokens) ? options.knownTokens.map(String) : []);
  const duplicate = (known.has(token) && options.allowDuplicate !== true)
    || (options.token !== undefined && options.token !== null && String(options.token) === token && options.allowDuplicate !== true);
  if (duplicate) {
    blockers.push({ code: PLAN_CODES.DUPLICATE, index: -1, message: '同一计划已回放（幂等 token 命中）', token, source: 'plan' });
  }
  // 外部（preflight / 命令参数校验 / 网络请求校验）带来的阻断项：原样并入，带 source。
  for (const extra of Array.isArray(options.blockers) ? options.blockers : []) {
    if (!extra || typeof extra !== 'object') continue;
    blockers.push({
      code: String(extra.code || PLAN_CODES.NETWORK).slice(0, 80),
      index: Number.isInteger(extra.index) ? extra.index : -1,
      message: String(extra.message || extra.detail || '外部校验失败').slice(0, 300),
      source: String(extra.source || 'external'),
    });
  }
  for (const issue of Array.isArray(options.validationIssues) ? options.validationIssues : []) {
    if (!issue || typeof issue !== 'object') continue;
    const item = {
      code: String(issue.code || PLAN_CODES.VALIDATION).slice(0, 80),
      index: Number.isInteger(issue.index) ? issue.index : -1,
      message: String(issue.message || '计划校验问题').slice(0, 300),
      source: 'validation',
    };
    if (issue.severity === 'error') blockers.push(item);
    else warnings.push(item);
  }
  if (!steps.length) {
    blockers.push({ code: PLAN_CODES.EMPTY, index: -1, message: '没有可回放的步骤', source: 'plan' });
  }
  if (coerced.source === 'preflight' && input && typeof input === 'object') {
    for (const blocker of Array.isArray(input.blockers) ? input.blockers : []) {
      if (!blocker || typeof blocker !== 'object') continue;
      blockers.push({
        code: String(blocker.code || PLAN_CODES.VALIDATION).slice(0, 80),
        index: Number.isInteger(blocker.index) ? blocker.index : -1,
        message: String(blocker.message || '预检阻断').slice(0, 300),
        source: 'preflight',
      });
    }
  }
  const checkpoints = checkpointsFor(steps, boundaries, limits);
  const phases = phasesFor(boundaries, steps.length);
  const dedupedBlockers = dedupeBlockers(blockers);
  const dedupedWarnings = dedupeBlockers(warnings);
  return {
    version: REPLAY_PLAN_VERSION,
    ok: dedupedBlockers.length === 0,
    deterministic: true,
    hasWallClock: false,
    source: String(options.source || coerced.source),
    token,
    fingerprint: fingerprints,
    steps,
    phases,
    checkpoints,
    boundaries,
    targets,
    budget,
    schedule,
    blockers: dedupedBlockers,
    warnings: dedupedWarnings,
    humanGates: targetsNeedingHuman(steps, targets),
    stats: {
      inputNodes: coerced.nodes.length,
      inputLoops: coerced.loops.length,
      expandedLoops: looped.expanded,
      waits: inserted.waits,
      humans: inserted.humans,
      deduped: deduped.removed,
      steps: steps.length,
      phases: phases.length,
      checkpoints: checkpoints.length,
      blockers: dedupedBlockers.length,
      warnings: dedupedWarnings.length,
    },
    preflight: options.preflight && typeof options.preflight === 'object'
      ? {
        token: String(options.preflight.token || ''),
        fingerprint: String(options.preflight.fingerprint || ''),
        blockers: Array.isArray(options.preflight.blockers) ? options.preflight.blockers.length : 0,
        warnings: Array.isArray(options.preflight.warnings) ? options.preflight.warnings.length : 0,
      }
      : null,
  };
}

function dedupeBlockers(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.code) continue;
    const key = item.code + '@' + item.index + '@' + item.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 阶段：每个边界 epoch 一个阶段，末尾再补一个 verify 阶段（不占 step 下标）。 */
function phasesFor(boundaries, stepCount) {
  const out = [];
  const epochs = boundaries && Array.isArray(boundaries.epochs) ? boundaries.epochs : [];
  for (const epoch of epochs) {
    out.push({
      id: 'phase-' + epoch.epoch,
      kind: epoch.changedBy === 'initial' ? 'group' : (epoch.boundaryKind === 'document' ? 'document' : epoch.boundaryKind === 'frame' ? 'frame' : epoch.boundaryKind === 'tab-switch' ? 'tab' : 'group'),
      startIndex: epoch.startIndex,
      endIndex: Math.min(epoch.endIndex, Math.max(0, stepCount - 1)),
      boundaryScope: boundaryScopeKey(epoch.boundary),
      epoch: epoch.epoch,
    });
  }
  out.push({ id: 'phase-verify', kind: 'verify', startIndex: stepCount, endIndex: stepCount, boundaryScope: '', epoch: epochs.length });
  return out;
}

// ---------------------------------------------------------------------------
// 派生视图 / 适配
// ---------------------------------------------------------------------------

/**
 * 从 preflightReplay() 结果直接建计划（record 导出/草稿回放的主入口）。
 * @param {object} preflight
 * @param {object} [options]
 */
export function planFromPreflight(preflight, options = {}) {
  if (!preflight || typeof preflight !== 'object') {
    return buildReplayPlan([], { ...options, source: 'preflight', validationIssues: [{ severity: 'error', code: PLAN_CODES.INVALID_INPUT, message: '缺少 preflight 结果' }] });
  }
  return buildReplayPlan(preflight, {
    ...options,
    source: 'preflight',
    preflight,
  });
}

/** 计划摘要（RPC 输出字段用：有界、稳定、不含敏感参数值）。 */
export function summarizeReplayPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return {
      version: REPLAY_PLAN_VERSION,
      ok: false,
      token: '',
      fingerprint: '',
      steps: 0,
      blockers: 0,
      warnings: 0,
      deterministic: true,
    };
  }
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  return {
    version: REPLAY_PLAN_VERSION,
    ok: plan.ok === true,
    source: plan.source || '',
    token: plan.token || '',
    fingerprint: plan.fingerprint || '',
    deterministic: plan.deterministic === true,
    steps: Array.isArray(plan.steps) ? plan.steps.length : 0,
    phases: Array.isArray(plan.phases) ? plan.phases.length : 0,
    checkpoints: Array.isArray(plan.checkpoints) ? plan.checkpoints.length : 0,
    budgets: plan.budget ? {
      steps: plan.budget.steps,
      actions: plan.budget.actions,
      branches: plan.budget.branches,
      waits: plan.budget.waits,
      humans: plan.budget.humans,
      waitMs: plan.budget.waitMs,
      retries: plan.budget.retries,
      overBudget: plan.budget.overBudget,
    } : null,
    boundaries: summarizeBoundaries(plan.boundaries),
    targets: summarizeTargetPlan(plan.targets),
    schedule: plan.schedule ? { totalDelayMs: plan.schedule.totalDelayMs, capped: plan.schedule.capped } : null,
    humanGates: Array.isArray(plan.humanGates) ? plan.humanGates.length : 0,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    blockers: blockers.slice(0, 8).map(compactIssue),
    warnings: warnings.slice(0, 8).map(compactIssue),
    blockerCodes: boundaryBlockerCodes(plan.boundaries).concat(targetBlockerCodes(plan.targets)).slice(0, 16),
  };
}

function compactIssue(issue) {
  return {
    code: String(issue && issue.code || '').slice(0, 80),
    index: Number.isInteger(issue && issue.index) ? issue.index : -1,
    message: String(issue && issue.message || '').slice(0, 200),
  };
}

/** 计划结构自检（verify 用；不依赖运行时）。 */
export function validatePlanShape(plan) {
  const issues = [];
  if (!plan || typeof plan !== 'object') {
    return { ok: false, issues: [{ code: 'PLAN_SHAPE', message: '计划不是对象' }] };
  }
  if (!Array.isArray(plan.steps)) issues.push({ code: 'PLAN_SHAPE_STEPS', message: '缺少 steps 数组' });
  if (!Array.isArray(plan.checkpoints)) issues.push({ code: 'PLAN_SHAPE_CHECKPOINTS', message: '缺少 checkpoints 数组' });
  if (!Array.isArray(plan.blockers)) issues.push({ code: 'PLAN_SHAPE_BLOCKERS', message: '缺少 blockers 数组' });
  if (typeof plan.token !== 'string' || !plan.token) issues.push({ code: 'PLAN_SHAPE_TOKEN', message: '缺少 token' });
  if (typeof plan.fingerprint !== 'string' || !plan.fingerprint) issues.push({ code: 'PLAN_SHAPE_FINGERPRINT', message: '缺少 fingerprint' });
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const seenRefs = new Set();
  let previousIndex = -1;
  let pendingHuman = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== 'object') {
      issues.push({ code: 'PLAN_STEP_SHAPE', index, message: '空 step' });
      continue;
    }
    if (step.index !== index) issues.push({ code: 'PLAN_STEP_ORDER', index, message: 'step.index 与位置不一致', actual: step.index });
    if (step.index <= previousIndex) issues.push({ code: 'PLAN_STEP_ORDER', index, message: 'step.index 非单调' });
    previousIndex = step.index;
    if (!KIND_SET.has(step.kind)) issues.push({ code: 'PLAN_STEP_KIND', index, message: '未知 step.kind', kind: step.kind });
    if (step.kind === 'human') pendingHuman = true;
    if (step.kind === 'action' && step.waitsForHuman && !pendingHuman) {
      issues.push({ code: 'PLAN_HUMAN_ORDER', index, message: 'human-gate 动作前没有 human 暂停步骤' });
    }
    if (step.kind === 'action') pendingHuman = false;
    if (step.ref) {
      const key = step.ref + ':' + (step.loopOf === undefined ? '' : step.loopOf) + ':' + (step.iteration || 0);
      if (seenRefs.has(key)) issues.push({ code: 'PLAN_STEP_REF_DUPLICATE', index, message: 'ref 重复（同一次循环内）', ref: step.ref });
      seenRefs.add(key);
    }
  }
  if (plan.schedule && plan.schedule.totalDelayMs > DEFAULT_PLAN_LIMITS.maxTotalMs) {
    issues.push({ code: 'PLAN_SCHEDULE_RANGE', message: '时间线超出上限', totalDelayMs: plan.schedule.totalDelayMs });
  }
  return { ok: issues.length === 0, issues };
}
