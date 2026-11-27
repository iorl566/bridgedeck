// tools/quality/lib/registry.mjs —— gate 注册表与受控执行器（超时/取消/预算）。
//
// 执行器把"门禁框架自身是否反脆弱"也变成可测对象：
//   * 每个 gate 都有硬超时；超时产生 QUALITY_GATE_TIMEOUT（category=harness）；
//   * 外部 AbortSignal 取消时，正在跑的 gate 以 QUALITY_GATE_CANCELLED 结构化结束，
//     未开始的 gate 也显式记录（不能悄悄漏跑）；
//   * 预算耗尽（次数/毫秒）时剩余 gate 标记 QUALITY_BUDGET_EXHAUSTED 并停止；
//   * 无论走哪条路径，本进程创建的定时器与 abort 监听器都会被清理（stats 可断言）。
//
// gate 形状：{ id, title, run(ctx) -> Finding[] | Promise<Finding[]>, consumes?: string[] }
// 约定：gate 自己用 result.makeFinding 构造 finding，registry 只负责调度与兜底。

import { makeFinding, sanitizeText, sortFindings, summarizeFindings, summarizeGate } from './result.mjs';

export const DEFAULT_GATE_TIMEOUT_MS = 15000;

/** 校验 gate 形状；返回问题列表（空 = 合法）。 */
export function validateGates(gates) {
  const problems = [];
  const seen = new Set();
  for (const gate of Array.isArray(gates) ? gates : []) {
    if (!gate || typeof gate !== 'object') {
      problems.push('gate 不是对象');
      continue;
    }
    if (typeof gate.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(gate.id)) problems.push('gate.id 非法：' + gate.id);
    if (typeof gate.title !== 'string' || !gate.title) problems.push('gate.title 缺失：' + gate.id);
    if (typeof gate.run !== 'function') problems.push('gate.run 不是函数：' + gate.id);
    if (seen.has(gate.id)) problems.push('gate.id 重复：' + gate.id);
    seen.add(gate.id);
  }
  return problems;
}

export function createRegistry(gates = []) {
  const list = [];
  const problems = [];
  const registry = {
    register(gate) {
      const gateProblems = validateGates([gate]);
      if (gateProblems.length) {
        problems.push(...gateProblems);
        return registry;
      }
      if (list.some((entry) => entry.id === gate.id)) {
        problems.push('gate.id 重复：' + gate.id);
        return registry;
      }
      list.push(gate);
      return registry;
    },
    gates() {
      return list.slice();
    },
    problems() {
      return problems.slice();
    },
  };
  for (const gate of Array.isArray(gates) ? gates : []) registry.register(gate);
  return registry;
}

export function listGates(gates = []) {
  return (Array.isArray(gates) ? gates : []).map((gate) => ({
    id: gate.id,
    title: gate.title,
    consumes: Array.isArray(gate.consumes) ? gate.consumes.slice() : [],
  }));
}

function defaultTimers() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

/**
 * 执行一个 gate，把超时/取消/异常都收敛成 finding。
 * @returns {Promise<{findings: Finding[], outcome: 'ok'|'timeout'|'cancelled'|'threw'}>}
 */
async function runGate(gate, ctx, options) {
  const gateId = gate.id;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_GATE_TIMEOUT_MS);
  const timers = options.timers || defaultTimers();
  const signal = options.signal || null;
  const stats = options.stats;
  let timeoutHandle = null;
  let abortHandler = null;

  const cancelFinding = () => makeFinding({
    gate: gateId,
    id: gateId + '/cancelled',
    title: '门禁被取消（AbortSignal）',
    ok: false,
    code: 'QUALITY_GATE_CANCELLED',
    detail: '外部取消信号在 gate 执行期间触发；已完成部分不构成完整结论',
    evidence: { gate: gateId, cancelled: true },
  });
  const timeoutFinding = () => makeFinding({
    gate: gateId,
    id: gateId + '/timeout',
    title: '门禁超时（' + timeoutMs + 'ms）',
    ok: false,
    code: 'QUALITY_GATE_TIMEOUT',
    detail: 'gate 在 ' + timeoutMs + 'ms 内未结束，已按失败处理；检查是否有未清理的等待/死循环',
    evidence: { gate: gateId, timeoutMs },
  });
  const threwFinding = (error) => makeFinding({
    gate: gateId,
    id: gateId + '/threw',
    title: '门禁执行抛错',
    ok: false,
    code: 'QUALITY_GATE_THREW',
    detail: sanitizeText((error && error.message) || String(error), { max: 400 }),
    evidence: {
      gate: gateId,
      errorName: sanitizeText((error && error.name) || 'Error', { max: 80 }),
      errorCode: (error && error.code) || null,
    },
  });

  if (signal && signal.aborted) {
    return { findings: [cancelFinding()], outcome: 'cancelled' };
  }

  const raceParts = [Promise.resolve().then(() => gate.run(ctx)).then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'threw', error }))];
  if (timeoutMs > 0) {
    raceParts.push(new Promise((resolve) => {
      timeoutHandle = timers.setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      if (stats) stats.timersCreated += 1;
    }));
  }
  if (signal) {
    raceParts.push(new Promise((resolve) => {
      abortHandler = () => resolve({ kind: 'cancelled' });
      signal.addEventListener('abort', abortHandler, { once: true });
      if (stats) stats.abortListeners += 1;
    }));
  }

  let winner;
  try {
    winner = await Promise.race(raceParts);
  } finally {
    if (timeoutHandle != null) {
      try { timers.clearTimeout(timeoutHandle); } catch { /* 忽略 */ }
      timeoutHandle = null;
      if (stats) stats.timersCleared += 1;
    }
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
      if (stats) stats.abortListeners = Math.max(0, stats.abortListeners - 1);
    }
  }

  if (!winner || winner.kind === 'timeout') {
    if (stats) stats.timeouts += 1;
    return { findings: [timeoutFinding()], outcome: 'timeout' };
  }
  if (winner.kind === 'cancelled') {
    if (stats) stats.cancelled += 1;
    return { findings: [cancelFinding()], outcome: 'cancelled' };
  }
  if (winner.kind === 'threw') {
    if (stats) stats.threw += 1;
    return { findings: [threwFinding(winner.error)], outcome: 'threw' };
  }
  const raw = winner.value;
  const findings = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.findings) ? raw.findings : null);
  if (!findings) {
    if (stats) stats.threw += 1;
    return {
      findings: [threwFinding(new Error('gate.run 必须返回 finding 数组'))],
      outcome: 'threw',
    };
  }
  const normalized = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') {
      if (stats) stats.threw += 1;
      normalized.push(threwFinding(new Error('gate 返回了非对象 finding')));
      continue;
    }
    if (finding.gate !== gateId) {
      if (stats) stats.threw += 1;
      normalized.push(makeFinding({
        gate: gateId,
        id: gateId + '/bad-finding-gate',
        title: 'finding 的 gate 与所属 gate 不一致',
        ok: false,
        code: 'QUALITY_GATE_THREW',
        detail: '不能把 gate A 的 finding 塞进 gate B：' + String(finding.id || ''),
        evidence: { expected: gateId, actual: String(finding.gate || '') },
      }));
      continue;
    }
    normalized.push(finding);
  }
  return { findings: normalized, outcome: 'ok' };
}

/**
 * 执行整组 gate。
 * options: {timeoutMs, timers, signal, budget, gateOrder}
 * 返回 {findings, gates: [gateSummary], outcomes, stats}
 */
export async function runSuite(options = {}) {
  const gates = Array.isArray(options.gates) ? options.gates : [];
  const ctx = options.ctx && typeof options.ctx === 'object' ? options.ctx : {};
  const timers = options.timers || defaultTimers();
  const signal = options.signal || null;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_GATE_TIMEOUT_MS);
  const budget = options.budget || null;
  const stats = {
    gates: gates.length,
    ran: 0,
    skipped: 0,
    timeouts: 0,
    cancelled: 0,
    threw: 0,
    timersCreated: 0,
    timersCleared: 0,
    abortListeners: 0,
  };
  const findings = [];
  const gateSummaries = [];
  const outcomes = [];

  for (const gate of gates) {
    if (signal && signal.aborted) {
      stats.skipped += 1;
      findings.push(makeFinding({
        gate: gate.id,
        id: gate.id + '/cancelled',
        title: '门禁未执行（取消在前）',
        ok: false,
        code: 'QUALITY_GATE_CANCELLED',
        detail: '取消信号在 gate 开始前已触发，本次运行不构成完整检查',
        evidence: { gate: gate.id, cancelled: true },
      }));
      gateSummaries.push(summarizeGate(gate.id, findings.filter((finding) => finding.gate === gate.id)));
      outcomes.push({ gate: gate.id, outcome: 'cancelled' });
      continue;
    }
    if (budget && typeof budget.exhausted === 'function' && budget.exhausted()) {
      stats.skipped += 1;
      findings.push(makeFinding({
        gate: gate.id,
        id: gate.id + '/budget',
        title: '门禁未执行（预算耗尽）',
        ok: false,
        code: 'QUALITY_BUDGET_EXHAUSTED',
        detail: '预算在 gate 开始前耗尽：本次运行不构成完整检查',
        evidence: budget.snapshot ? budget.snapshot() : { exhausted: true },
      }));
      gateSummaries.push(summarizeGate(gate.id, findings.filter((finding) => finding.gate === gate.id)));
      outcomes.push({ gate: gate.id, outcome: 'budget' });
      continue;
    }
    if (budget && typeof budget.checkTime === 'function') budget.checkTime();
    const result = await runGate(gate, ctx, { timeoutMs, timers, signal, stats });
    stats.ran += 1;
    findings.push(...result.findings);
    outcomes.push({ gate: gate.id, outcome: result.outcome });
    gateSummaries.push(summarizeGate(gate.id, result.findings));
    if (budget && typeof budget.consume === 'function') {
      budget.consume('checks', result.findings.length);
      budget.consume('bytes', JSON.stringify(result.findings).length);
    }
  }

  const gateOrder = gates.map((gate) => gate.id);
  const ordered = sortFindings(findings, gateOrder);
  const summary = summarizeFindings(ordered);
  return {
    findings: ordered,
    gates: gateSummaries,
    outcomes,
    summary,
    stats: {
      ...stats,
      timersPending: Math.max(0, stats.timersCreated - stats.timersCleared),
      abortListenersPending: Math.max(0, stats.abortListeners),
    },
  };
}
