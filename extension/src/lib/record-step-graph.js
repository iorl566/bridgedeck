// src/lib/record-step-graph.js —— 录制 step 模型深化：分支 / 并发 / 取消 的图模型（纯函数）。
//
// record-steps.js 产出的是“线性的 step v2 列表”。真实流程里还有三件事录制器无法线性表达：
//   1. 分支：同一个点击在不同条件下走向不同目标（URL 已跳转 / 选择器出现 / 文本变化）；
//   2. 并发：多个独立动作可以同时跑（多 tab 并行、同一页多个独立控件），但回放必须
//      在“汇合点”之前等齐，否则顺序不可复现；
//   3. 取消：一段步骤有超时/人工中止/兼容目标失败时，后续步骤必须整体跳过（而不是继续点）。
//
// 本模块把线性步骤升级成可校验的执行图：
//   nodes      —— 规整后的图节点（只新增 parallel/cancel/branchOptions 字段，旧 step 形状照常）
//   edges      —— linear / fork / join / branch 四类有向边（只连“真的会执行到”的下一步）
//   branches   —— 分支点：条件谓词 + 目标 + fallthrough（没有命中就顺序执行）
//   parallel   —— 并发区：fork/join 配对、按 arm 分组的成员、等待语义（all/any/race）
//   cancels    —— 取消域：作用范围（from/to）、触发方式（abort/skip/continue）、超时
//   schedule   —— 可执行批次（serial / branch / parallel），fork 与 join 之间是一个批次，
//                 回放器照批次推进即可，不需要自己再猜并发边界
//
// 关键约定：
//   - 只是“加字段”：完全没有 parallel/cancel/branchOptions 的线性步骤，图就是一条链，
//     schedule 全是 serial 批次，与原回放顺序完全一致；
//   - 图节点按“输入顺序 + index”确定性生成，digest 只依赖规整后的结构，便于回放前置做幂等；
//   - 本模块不 import record-program.js / record-events.js（record-steps.js 是唯一叶子依赖），
//     依赖方向 record-events → lib/record-exec-plan → lib/record-step-graph → record-steps，无环。

import { stableHash } from '../record-steps.js';

export const STEP_GRAPH_VERSION = 1;

/** 批次类型：回放器按这个顺序推进（serial/branch/parallel 三选一）。 */
export const BATCH_KINDS = Object.freeze({
  SERIAL: 'serial',
  BRANCH: 'branch',
  PARALLEL: 'parallel',
});

/** 并发等待语义：all=等齐、any=任一成功即可继续、race=第一个完成就继续（其余取消）。 */
export const PARALLEL_MODES = Object.freeze({ ALL: 'all', ANY: 'any', RACE: 'race' });
export const PARALLEL_MODE_LIST = Object.freeze(Object.values(PARALLEL_MODES));

/** 取消语义：abort=中止整段（默认）、skip=跳过剩余、continue=记录后继续。 */
export const CANCEL_MODES = Object.freeze({ ABORT: 'abort', SKIP: 'skip', CONTINUE: 'continue' });
export const CANCEL_MODE_LIST = Object.freeze(Object.values(CANCEL_MODES));

/** 并发区里节点的角色：fork=开闸、arm=并行支、join=汇合。 */
export const PARALLEL_ROLES = Object.freeze({ FORK: 'fork', ARM: 'arm', JOIN: 'join' });
export const PARALLEL_ROLE_LIST = Object.freeze(Object.values(PARALLEL_ROLES));

/** 图问题码（内部证据码，不是 wire 错误码，不带 E_ 前缀）。 */
export const GRAPH_CODES = Object.freeze({
  GRAPH_EMPTY: 'GRAPH_EMPTY',
  UNKNOWN_STEP_KIND: 'UNKNOWN_STEP_KIND',
  BRANCH_NO_OPTIONS: 'BRANCH_NO_OPTIONS',
  BRANCH_OPTION_INVALID: 'BRANCH_OPTION_INVALID',
  BRANCH_TARGET_UNKNOWN: 'BRANCH_TARGET_UNKNOWN',
  BRANCH_TARGET_BACKWARD: 'BRANCH_TARGET_BACKWARD',
  FORK_NO_JOIN: 'FORK_NO_JOIN',
  JOIN_WITHOUT_FORK: 'JOIN_WITHOUT_FORK',
  PARALLEL_ARM_EMPTY: 'PARALLEL_ARM_EMPTY',
  PARALLEL_TOO_WIDE: 'PARALLEL_TOO_WIDE',
  PARALLEL_NESTED: 'PARALLEL_NESTED',
  PARALLEL_GROUP_UNKNOWN: 'PARALLEL_GROUP_UNKNOWN',
  PARALLEL_ORDER: 'PARALLEL_ORDER',
  CANCEL_SCOPE_UNKNOWN: 'CANCEL_SCOPE_UNKNOWN',
  CANCEL_SCOPE_OVERLAP: 'CANCEL_SCOPE_OVERLAP',
  CANCEL_SCOPE_TOO_LONG: 'CANCEL_SCOPE_TOO_LONG',
  CANCEL_AFTER_JOIN: 'CANCEL_AFTER_JOIN',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  EDGE_UNKNOWN: 'EDGE_UNKNOWN',
  HUMAN_GATE_IN_PARALLEL: 'HUMAN_GATE_IN_PARALLEL',
  GRAPH_TOO_LARGE: 'GRAPH_TOO_LARGE',
});

/** 图的规模上限（可被 build 的 options 覆盖，默认偏保守）。 */
export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 4000,
  maxEdges: 12000,
  maxParallelArms: 16,
  maxBranchOptions: 16,
  maxCancelScopes: 64,
  maxCancelNodes: 400,
  maxDepth: 128,
});

const STEP_KINDS = Object.freeze(['action', 'observe', 'wait', 'branch', 'human-gate']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

function limitOf(options, key) {
  const source = options && typeof options === 'object' ? options : {};
  return positive(source[key], GRAPH_LIMITS[key]);
}

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function targetText(target) {
  if (!target || typeof target !== 'object') return '';
  return clip(target.selector || target.text || target.name || '', 160);
}

/**
 * 并发描述规整。旧 step 没有 parallel 字段 → null（默认完全串行，行为不变）。
 * 支持形状：
 *   { groupId | group: string, role?: 'fork'|'arm'|'join', arm?: number,
 *     waitFor?: 'all'|'any'|'race', label?: string, failFast?: boolean }
 * role 缺省：group 第一次出现视为 fork，显式 `join: true` 视为 join，其余视为 arm。
 * @param {object|null|undefined} parallel
 * @param {{index?:number, seenGroups?:Set<string>}} [context]
 * @returns {null|{groupId:string, role:string, arm:number, waitFor:string, label:string, failFast:boolean}}
 */
export function normalizeParallel(parallel, context = {}) {
  if (parallel == null) return null;
  if (parallel === false) return null;
  const input = parallel === true ? {} : (isPlainObject(parallel) ? parallel : null);
  if (!input) return null;
  const groupId = clip(input.groupId || input.group || input.id || 'group-' + (integer(context.index, 0) + 1), 48);
  if (!groupId) return null;
  const seen = context.seenGroups instanceof Set ? context.seenGroups : new Set();
  const explicitRole = String(input.role || '').toLowerCase();
  let role = PARALLEL_ROLE_LIST.includes(explicitRole) ? explicitRole : null;
  if (!role && input.join === true) role = PARALLEL_ROLES.JOIN;
  if (!role && input.fork === true) role = PARALLEL_ROLES.FORK;
  // 没写角色时标成 auto：由 buildParallelRegions 按组内顺序推断（首=fork、尾=join），
  // 这样单独写 groupId 的旧数据也能得到确定的并发区，而不是每步都被误判成 fork。
  const roleExplicit = role != null;
  if (!role) role = 'auto';
  const waitForInput = String(input.waitFor || input.mode || '').toLowerCase();
  const waitFor = PARALLEL_MODE_LIST.includes(waitForInput) ? waitForInput : PARALLEL_MODES.ALL;
  return {
    groupId,
    role,
    roleExplicit,
    arm: Math.max(0, integer(input.arm != null ? input.arm : input.armIndex, 0)),
    waitFor,
    label: clip(input.label || '', 64),
    failFast: input.failFast === true,
  };
}

/**
 * 取消域描述规整。旧 step 没有 cancel 字段 → null（默认没有取消域，行为不变）。
 * 支持形状：{ scope | id: string, onCancel?: 'abort'|'skip'|'continue', afterMs?: number,
 *            reason?: string, close?: boolean, token?: string }
 * @param {object|null|undefined} cancel
 * @param {{index?:number}} [context]
 * @returns {null|{scope:string, onCancel:string, afterMs:number, reason:string, close:boolean, token:string}}
 */
export function normalizeCancel(cancel, context = {}) {
  if (cancel == null || cancel === false) return null;
  const input = cancel === true ? {} : (isPlainObject(cancel) ? cancel : null);
  if (!input) return null;
  const scope = clip(input.scope || input.id || input.name || 'scope-' + (integer(context.index, 0) + 1), 48);
  if (!scope) return null;
  const onCancelInput = String(input.onCancel || input.mode || '').toLowerCase();
  const modeExplicit = CANCEL_MODE_LIST.includes(onCancelInput);
  const onCancel = modeExplicit ? onCancelInput : CANCEL_MODES.ABORT;
  return {
    scope,
    onCancel,
    modeExplicit,
    afterMs: Math.max(0, num(input.afterMs)),
    reason: clip(input.reason || '', 120),
    close: input.close === true || input.end === true,
    token: clip(input.token || '', 64),
  };
}

/**
 * 分支选项规整：`step.branch.options` / `step.branch.arms` 都会被接受。
 * 条件谓词（when）只保留白名单字段，回放器按“第一个命中的选项”走，都不命中则顺序执行。
 * @param {object|null|undefined} step
 * @param {number} [index]
 * @returns {Array<{label:string, when:object|null, to:number|string|null, expect:object|null}>}
 */
export function normalizeBranchOptions(step, index = 0) {
  if (!step || typeof step !== 'object') return [];
  const branch = isPlainObject(step.branch) ? step.branch : {};
  const raw = Array.isArray(branch.options) ? branch.options : (Array.isArray(branch.arms) ? branch.arms : []);
  const out = [];
  for (let position = 0; position < raw.length; position += 1) {
    const item = raw[position];
    if (!isPlainObject(item)) continue;
    const when = isPlainObject(item.when) ? item.when : (isPlainObject(item.expect) ? item.expect : null);
    const normalizedWhen = when ? {
      ...(typeof when.urlIncludes === 'string' ? { urlIncludes: clip(when.urlIncludes, 300) } : {}),
      ...(typeof when.urlEquals === 'string' ? { urlEquals: clip(when.urlEquals, 500) } : {}),
      ...(typeof when.selector === 'string' ? { selector: clip(when.selector, 200) } : {}),
      ...(typeof when.selectorValue === 'string' ? { selectorValue: clip(when.selectorValue, 200) } : {}),
      ...(typeof when.textIncludes === 'string' ? { textIncludes: clip(when.textIncludes, 200) } : {}),
      ...(typeof when.status === 'string' ? { status: clip(when.status, 24) } : {}),
      ...(Number.isInteger(when.refIndex) ? { refIndex: when.refIndex } : {}),
    } : null;
    let to = null;
    if (Number.isInteger(item.to)) to = item.to;
    else if (Number.isInteger(item.next)) to = item.next;
    else if (Number.isInteger(item.nextIndex)) to = item.nextIndex;
    else if (typeof item.to === 'string' && item.to) to = clip(item.to, 64);
    else if (typeof item.next === 'string' && item.next) to = clip(item.next, 64);
    out.push({
      label: clip(item.label || item.name || 'option-' + (position + 1), 64),
      when: normalizedWhen,
      to,
      expect: isPlainObject(item.expect) ? { ...item.expect } : null,
    });
  }
  return out;
}

/**
 * 把 step（v2）规整成图节点；非法返回 null。旧 step 只多出 parallel/cancel/branchOptions=null。
 * @param {object} step
 * @param {number} [index]
 * @returns {object|null}
 */
export function normalizeGraphNode(step, index = 0) {
  if (!step || typeof step !== 'object') return null;
  const evidence = isPlainObject(step.evidence) ? step.evidence : {};
  const target = isPlainObject(step.target) ? step.target : null;
  return {
    index: integer(step.index, integer(evidence.index, index)),
    ref: clip(step.ref || '', 64),
    kind: clip(step.kind || '', 32),
    method: clip(step.method || '', 64),
    idempotent: step.idempotent === true,
    signature: clip(step.signature || '', 200),
    target,
    targetText: targetText(target),
    params: isPlainObject(step.params) ? { ...step.params } : {},
    humanGate: isPlainObject(step.humanGate) ? { ...step.humanGate } : null,
    branch: isPlainObject(step.branch) ? { ...step.branch } : null,
    branchOptions: normalizeBranchOptions(step, index),
    parallel: normalizeParallel(step.parallel, { index }),
    cancel: normalizeCancel(step.cancel, { index }),
    fallback: isPlainObject(step.fallback) ? { ...step.fallback } : null,
    repeat: Math.max(0, integer(step.repeat, 0)),
    waitBeforeMs: Math.max(0, num(step.waitBeforeMs)),
    documentId: clip(evidence.documentId || step.documentId || '', 160),
    frameId: integer(evidence.frameId, integer(step.frameId, 0)),
    seq: integer(evidence.seq, integer(step.seq, 0)),
    at: num(evidence.at || step.at),
  };
}

function normalizeNodes(steps, limits) {
  let list = [];
  if (Array.isArray(steps)) list = steps;
  else if (isPlainObject(steps) && Array.isArray(steps.nodes)) list = steps.nodes;
  else if (isPlainObject(steps) && Array.isArray(steps.steps)) list = steps.steps;
  const nodes = [];
  for (let index = 0; index < list.length && nodes.length < limits.maxNodes; index += 1) {
    const node = normalizeGraphNode(list[index], index);
    if (node) {
      node.index = nodes.length;
      nodes.push(node);
    }
  }
  return nodes;
}

/** 输入里声明的步骤数（用于“超上限被截断”的诊断，不影响 normalize）。 */
function countInputSteps(steps) {
  if (Array.isArray(steps)) return steps.length;
  if (isPlainObject(steps) && Array.isArray(steps.nodes)) return steps.nodes.length;
  if (isPlainObject(steps) && Array.isArray(steps.steps)) return steps.steps.length;
  return 0;
}

function nodeKey(node) {
  return node && node.ref ? node.ref : '#' + (node ? node.index : '?');
}

/** 分支目标解析：数字按 index、字符串按 ref 找节点下标；找不到返回 -1。 */
function resolveTarget(nodes, to) {
  if (Number.isInteger(to)) return to >= 0 && to < nodes.length ? to : -1;
  if (typeof to === 'string' && to) {
    const found = nodes.findIndex((node) => node.ref === to);
    return found;
  }
  return -1;
}

function buildBranches(nodes, limits, issues) {
  const branches = [];
  for (const node of nodes) {
    if (node.kind !== 'branch') {
      if (node.branchOptions.length) {
        issues.push(problem(GRAPH_CODES.BRANCH_OPTION_INVALID, 'warning', '非 branch 步骤携带分支选项（会被忽略）', { index: node.index, ref: node.ref }));
      }
      continue;
    }
    const options = node.branchOptions.slice(0, limits.maxBranchOptions);
    if (node.branchOptions.length > limits.maxBranchOptions) {
      issues.push(problem(GRAPH_CODES.BRANCH_OPTION_INVALID, 'warning', '分支选项超过上限', { index: node.index, ref: node.ref, options: node.branchOptions.length, max: limits.maxBranchOptions }));
    }
    const resolved = [];
    for (const option of options) {
      let to = -1;
      if (option.to != null) {
        to = resolveTarget(nodes, option.to);
        if (to < 0) issues.push(problem(GRAPH_CODES.BRANCH_TARGET_UNKNOWN, 'error', '分支目标不存在', { index: node.index, ref: node.ref, to: option.to }));
        else if (to <= node.index) issues.push(problem(GRAPH_CODES.BRANCH_TARGET_BACKWARD, 'warning', '分支目标不是前向步骤（回放会回退）', { index: node.index, ref: node.ref, to }));
      }
      resolved.push({ label: option.label, when: option.when, to: to < 0 ? null : to, expect: option.expect });
    }
    if (!resolved.length) issues.push(problem(GRAPH_CODES.BRANCH_NO_OPTIONS, 'warning', 'branch 没有条件选项（按顺序执行）', { index: node.index, ref: node.ref }));
    branches.push({
      index: node.index,
      ref: node.ref,
      boundary: node.branch ? clip(node.branch.boundary || '', 32) : '',
      url: node.branch ? clip(node.branch.url || '', 500) : '',
      options: resolved,
      fallthrough: node.index + 1 < nodes.length ? node.index + 1 : null,
    });
  }
  return branches;
}

/**
 * 并发区识别：按 groupId 配对 fork/join，按 arm 切分成员。
 * 返回 regions: [{groupId, forkIndex, joinIndex, mode, waitFor, label, arms:[{arm, from, to, memberIndexes}]}]
 */
function buildParallelRegions(nodes, limits, issues) {
  const groups = new Map();
  for (const node of nodes) {
    if (!node.parallel) continue;
    const group = groups.get(node.parallel.groupId) || { groupId: node.parallel.groupId, members: [], forks: [], joins: [] };
    group.members.push(node);
    if (node.parallel.role === PARALLEL_ROLES.FORK) group.forks.push(node);
    if (node.parallel.role === PARALLEL_ROLES.JOIN) group.joins.push(node);
    groups.set(node.parallel.groupId, group);
  }
  const regions = [];
  for (const group of groups.values()) {
    const members = group.members.sort((left, right) => left.index - right.index);
    // 角色推断：显式 fork/join 优先；没写角色的成员里，组内第一个当 fork、最后一个当 join。
    const autoMembers = members.filter((node) => node.parallel.role === 'auto');
    const explicitForks = group.forks.slice();
    const explicitJoins = group.joins.slice();
    const fork = explicitForks[0] || autoMembers[0] || members[0];
    if (!fork) continue;
    const joinCandidates = explicitJoins.filter((node) => node.index > fork.index);
    const autoAfterFork = autoMembers.filter((node) => node.index > fork.index);
    const join = joinCandidates[0] || (autoAfterFork.length ? autoAfterFork[autoAfterFork.length - 1] : null);
    if (!join) {
      issues.push(problem(GRAPH_CODES.FORK_NO_JOIN, 'error', '并发区缺少 join（回放无法确定汇合点）', { groupId: group.groupId, forkIndex: fork.index, ref: fork.ref }));
    }
    for (const strayJoin of joinCandidates.slice(1)) {
      issues.push(problem(GRAPH_CODES.PARALLEL_ORDER, 'warning', '并发区出现多个 join', { groupId: group.groupId, index: strayJoin.index }));
    }
    for (const strayFork of explicitForks.slice(1)) {
      issues.push(problem(GRAPH_CODES.PARALLEL_ORDER, 'warning', '并发区出现多个 fork（按第一个开闸）', { groupId: group.groupId, index: strayFork.index }));
    }
    const endIndex = join ? join.index : (members.length ? members[members.length - 1].index : fork.index);
    const inside = members.filter((node) => node.index >= fork.index && node.index <= endIndex);
    const armsByIndex = new Map();
    for (const node of inside) {
      if (node.index === fork.index || (join && node.index === join.index)) continue;
      const arm = node.parallel.arm;
      const armValue = armsByIndex.get(arm) || { arm, members: [] };
      armValue.members.push(node);
      armsByIndex.set(arm, armValue);
    }
    const arms = [...armsByIndex.values()]
      .sort((left, right) => left.arm - right.arm)
      .map((armValue) => ({
        arm: armValue.arm,
        ...(armValue.members[0] ? { from: armValue.members[0].index } : {}),
        ...(armValue.members.length ? { to: armValue.members[armValue.members.length - 1].index } : {}),
        memberIndexes: armValue.members.map((node) => node.index),
        refs: armValue.members.map(nodeKey),
        humanGates: armValue.members.filter((node) => Boolean(node.humanGate)).length,
      }));
    if (!arms.length) {
      issues.push(problem(GRAPH_CODES.PARALLEL_ARM_EMPTY, 'warning', '并发区没有 arm 成员', { groupId: group.groupId, forkIndex: fork.index }));
    }
    if (arms.length > limits.maxParallelArms) {
      issues.push(problem(GRAPH_CODES.PARALLEL_TOO_WIDE, 'error', '并发宽度超过上限', { groupId: group.groupId, arms: arms.length, max: limits.maxParallelArms }));
    }
    for (const arm of arms) {
      if (arm.humanGates > 0) {
        issues.push(problem(GRAPH_CODES.HUMAN_GATE_IN_PARALLEL, 'warning', '并发 arm 里包含 human-gate（会同时等人工）', { groupId: group.groupId, arm: arm.arm }));
      }
    }
    // 并发区不能嵌套：任何 group 的 [fork, join] 区间不得与其他 group 交叉。
    for (const other of regions) {
      if (group.groupId === other.groupId) continue;
      const overlaps = fork.index <= other.joinIndex && endIndex >= other.forkIndex;
      const nested = (fork.index > other.forkIndex && endIndex < other.joinIndex) || (other.forkIndex > fork.index && other.joinIndex < endIndex);
      if (overlaps && !nested) {
        issues.push(problem(GRAPH_CODES.PARALLEL_NESTED, 'error', '并发区与其他并发区交叉（图不可按批执行）', { groupId: group.groupId, other: other.groupId }));
      }
    }
    regions.push({
      groupId: group.groupId,
      forkIndex: fork.index,
      joinIndex: join ? join.index : null,
      mode: join ? 'paired' : 'open',
      waitFor: fork.parallel.waitFor,
      failFast: fork.parallel.failFast === true,
      label: fork.parallel.label,
      arms,
      memberIndexes: inside.map((node) => node.index),
    });
  }
  return regions.sort((left, right) => left.forkIndex - right.forkIndex);
}

/**
 * 取消域识别：每个 scope 的第一次出现开启、close:true 或最后一次出现关闭。
 * 返回 cancels: [{scope, from, to, mode, afterMs, reason, token, nodes}]
 */
function buildCancelScopes(nodes, limits, issues) {
  const scopes = new Map();
  for (const node of nodes) {
    if (!node.cancel) continue;
    const entry = scopes.get(node.cancel.scope) || { scope: node.cancel.scope, indexes: [], modes: new Set(), closeAt: null, reason: '', token: '', afterMs: 0 };
    entry.indexes.push(node.index);
    if (node.cancel.modeExplicit) entry.modes.add(node.cancel.onCancel);
    entry.afterMs = Math.max(entry.afterMs, node.cancel.afterMs);
    if (node.cancel.reason) entry.reason = node.cancel.reason;
    if (node.cancel.token) entry.token = node.cancel.token;
    if (node.cancel.close) entry.closeAt = node.index;
    scopes.set(node.cancel.scope, entry);
  }
  const cancels = [];
  for (const entry of scopes.values()) {
    const from = entry.indexes[0];
    const to = entry.closeAt != null ? entry.closeAt : entry.indexes[entry.indexes.length - 1];
    const mode = entry.modes.size === 1 ? [...entry.modes][0] : CANCEL_MODES.ABORT;
    if (to < from) issues.push(problem(GRAPH_CODES.CANCEL_AFTER_JOIN, 'warning', '取消域关闭点早于起点', { scope: entry.scope, from, to }));
    if (to - from + 1 > limits.maxCancelNodes) {
      issues.push(problem(GRAPH_CODES.CANCEL_SCOPE_TOO_LONG, 'warning', '取消域覆盖过多步骤', { scope: entry.scope, steps: to - from + 1, max: limits.maxCancelNodes }));
    }
    cancels.push({ scope: entry.scope, from, to, mode, afterMs: entry.afterMs, reason: clip(entry.reason, 120), token: entry.token, nodes: to - from + 1 });
  }
  cancels.sort((left, right) => left.from - right.from);
  if (cancels.length > limits.maxCancelScopes) {
    issues.push(problem(GRAPH_CODES.CANCEL_SCOPE_UNKNOWN, 'error', '取消域数量超过上限', { scopes: cancels.length, max: limits.maxCancelScopes }));
  }
  // 部分重叠（非包含）的取消域语义歧义：直接报错，回放器不必猜。
  for (let left = 0; left < cancels.length; left += 1) {
    for (let right = left + 1; right < cancels.length; right += 1) {
      const a = cancels[left];
      const b = cancels[right];
      const overlap = a.from <= b.to && b.from <= a.to;
      const contains = (a.from <= b.from && a.to >= b.to) || (b.from <= a.from && b.to >= a.to);
      if (overlap && !contains) {
        issues.push(problem(GRAPH_CODES.CANCEL_SCOPE_OVERLAP, 'error', '取消域部分重叠（无法判定谁负责中止）', { left: a.scope, right: b.scope, leftRange: [a.from, a.to], rightRange: [b.from, b.to] }));
      }
    }
  }
  return cancels;
}

/**
 * 构建执行边：默认线性连边；并发区里 fork 连到各 arm 首节点、arm 尾连到 join，
 * arm 之间的顺延边被抑制（否则回放会把并行当成串行）。
 */
function buildEdges(nodes, regions, branches, limits, issues) {
  const forkAt = new Map();
  const joinAt = new Map();
  const insideRegion = new Map();
  for (const region of regions) {
    forkAt.set(region.forkIndex, region);
    if (region.joinIndex != null) joinAt.set(region.joinIndex, region);
    for (const index of region.memberIndexes) insideRegion.set(index, region);
  }
  const edges = [];
  const pushEdge = (from, to, kind) => {
    if (from == null || to == null) return;
    if (edges.length >= limits.maxEdges) return;
    edges.push({ from, to, kind, fromRef: nodeKey(nodes[from]), toRef: nodeKey(nodes[to]) });
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const region = insideRegion.get(index);
    if (forkAt.has(index)) {
      for (const arm of forkAt.get(index).arms) {
        if (arm.memberIndexes.length) pushEdge(index, arm.memberIndexes[0], 'fork');
      }
      continue;
    }
    if (region && !joinAt.has(index)) {
      const arm = region.arms.find((item) => item.memberIndexes.includes(index));
      if (arm) {
        const position = arm.memberIndexes.indexOf(index);
        if (position < arm.memberIndexes.length - 1) {
          pushEdge(index, arm.memberIndexes[position + 1], 'arm');
        } else if (region.joinIndex != null) {
          pushEdge(index, region.joinIndex, 'join');
        }
        continue;
      }
    }
    if (index + 1 < nodes.length) pushEdge(index, index + 1, 'linear');
  }
  // 分支显式目标：额外分支边（条件边，回放器决定是否走）。
  for (const branch of branches) {
    for (const option of branch.options) {
      if (option.to == null) continue;
      if (option.to >= nodes.length) {
        issues.push(problem(GRAPH_CODES.EDGE_UNKNOWN, 'warning', '分支边目标越界', { index: branch.index, to: option.to }));
        continue;
      }
      pushEdge(branch.index, option.to, 'branch');
    }
  }
  if (edges.length >= limits.maxEdges) {
    issues.push(problem(GRAPH_CODES.GRAPH_TOO_LARGE, 'error', '执行边数量超过上限', { edges: edges.length, max: limits.maxEdges }));
  }
  return edges;
}

/** 邻接表 + DFS 找环（只统计会无条件执行的线性/并发边；branch 是条件边，回退由 BRANCH_TARGET_BACKWARD 报告）。 */
function findCycles(nodes, edges) {
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.index, []);
  for (const edge of edges) {
    if (edge.kind === 'branch') continue;
    if (!adjacency.has(edge.from)) continue;
    adjacency.get(edge.from).push(edge.to);
  }
  const state = new Map();
  const cycles = [];
  const stack = [];
  const visit = (index) => {
    state.set(index, 1);
    stack.push(index);
    for (const next of adjacency.get(index) || []) {
      const nextState = state.get(next) || 0;
      if (nextState === 0) {
        if (visit(next)) return true;
      } else if (nextState === 1) {
        const start = stack.indexOf(next);
        cycles.push(stack.slice(start >= 0 ? start : 0).concat(next));
        return true;
      }
    }
    stack.pop();
    state.set(index, 2);
    return false;
  };
  for (const node of nodes) {
    if ((state.get(node.index) || 0) === 0 && visit(node.index)) break;
  }
  return cycles;
}

/**
 * 可执行批次：serial（单步）/ branch（条件分支点）/ parallel（fork..join 整段）。
 * 回放器只需顺序消费批次，并发边界与取消域归属都已在这一步确定。
 * @returns {Array<object>}
 */
export function planStepBatches(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  const nodes = graph.nodes;
  const regions = Array.isArray(graph.parallel) ? graph.parallel : [];
  const regionByFork = new Map(regions.map((region) => [region.forkIndex, region]));
  const branches = new Map((Array.isArray(graph.branches) ? graph.branches : []).map((branch) => [branch.index, branch]));
  const batches = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    const region = regionByFork.get(index);
    if (region) {
      batches.push({
        kind: BATCH_KINDS.PARALLEL,
        groupId: region.groupId,
        forkIndex: region.forkIndex,
        joinIndex: region.joinIndex,
        waitFor: region.waitFor,
        failFast: region.failFast,
        arms: region.arms.map((arm) => ({
          arm: arm.arm,
          steps: arm.memberIndexes.map((memberIndex) => nodes[memberIndex]).filter(Boolean).map((member) => compactBatchNode(member)),
        })),
        ...(Array.isArray(region.memberIndexes) ? { members: region.memberIndexes.length } : {}),
      });
      index = region.joinIndex != null ? region.joinIndex + 1 : (region.memberIndexes.length ? Math.max(...region.memberIndexes) + 1 : index + 1);
      continue;
    }
    const branch = branches.get(index);
    if (branch) {
      batches.push({
        kind: BATCH_KINDS.BRANCH,
        index,
        ref: node.ref,
        boundary: branch.boundary,
        options: branch.options.map((option) => ({ label: option.label, to: option.to, when: option.when })),
        fallthrough: branch.fallthrough,
      });
      index += 1;
      continue;
    }
    batches.push({ kind: BATCH_KINDS.SERIAL, index, node: compactBatchNode(node) });
    index += 1;
  }
  return batches;
}

function compactBatchNode(node) {
  return {
    index: node.index,
    ref: node.ref,
    kind: node.kind,
    method: node.method,
    idempotent: node.idempotent,
    ...(node.humanGate ? { humanGate: true } : {}),
    ...(node.cancel ? { cancel: node.cancel.scope } : {}),
    ...(node.parallel ? { parallel: node.parallel.groupId } : {}),
    ...(node.waitBeforeMs > 0 ? { waitBeforeMs: node.waitBeforeMs } : {}),
    ...(node.repeat > 1 ? { repeat: node.repeat } : {}),
  };
}

/** 某节点如果位于并发区，返回该区（否则 null）。 */
export function parallelRegionAt(graph, index) {
  const number = integer(index, -1);
  if (!graph || !Array.isArray(graph.parallel)) return null;
  return graph.parallel.find((region) => number >= region.forkIndex && (region.joinIndex == null || number <= region.joinIndex)) || null;
}

/** 某节点归属的取消域（可能多个；嵌套时取最内层 = from 最大的那个）。 */
export function cancelScopeAt(graph, index) {
  const number = integer(index, -1);
  if (!graph || !Array.isArray(graph.cancels)) return null;
  const hits = graph.cancels.filter((scope) => number >= scope.from && number <= scope.to);
  if (!hits.length) return null;
  return hits.sort((left, right) => right.from - left.from)[0];
}

/** 图节点的后继（按执行边，去重保序）。 */
export function graphSuccessors(graph, index) {
  const number = integer(index, -1);
  const seen = new Set();
  const out = [];
  for (const edge of (graph && Array.isArray(graph.edges) ? graph.edges : [])) {
    if (edge.from !== number || seen.has(edge.to)) continue;
    seen.add(edge.to);
    out.push(edge.to);
  }
  return out;
}

/** 校验图结构（也接受步骤数组：先 build 再校验）。 */
export function validateStepGraph(graphOrSteps, options = {}) {
  const graph = graphOrSteps && Array.isArray(graphOrSteps.nodes) ? graphOrSteps : buildStepGraph(graphOrSteps, options);
  const issues = Array.isArray(graph.issues) ? [...graph.issues] : [];
  const limits = { ...GRAPH_LIMITS, ...(options.limits || {}) };
  if (!graph.nodes.length) issues.push(problem(GRAPH_CODES.GRAPH_EMPTY, 'warning', '空图（没有可执行步骤）', {}));
  if (graph.nodes.length > limits.maxNodes) issues.push(problem(GRAPH_CODES.GRAPH_TOO_LARGE, 'error', '节点数超过上限', { nodes: graph.nodes.length, max: limits.maxNodes }));
  const deduped = dedupeIssues(issues);
  const errors = deduped.filter((item) => item.severity === 'error').length;
  const warnings = deduped.length - errors;
  const byCode = {};
  for (const item of deduped) byCode[item.code] = (byCode[item.code] || 0) + 1;
  return {
    ok: errors === 0,
    issues: deduped.slice(0, 64),
    errors,
    warnings,
    byCode,
    checked: { nodes: graph.nodes.length, edges: graph.edges.length, batches: graph.schedule.length },
    rules_evaluated: 14,
  };
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const item of issues) {
    if (!item || typeof item !== 'object' || !item.code) continue;
    const key = [item.code, item.index == null ? '' : item.index, item.ref || '', item.scope || '', item.groupId || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function graphStats(nodes, edges, branches, regions, cancels, schedule) {
  const byKind = {};
  const methods = new Set();
  let humanGates = 0;
  let waits = 0;
  let repeats = 0;
  let idempotent = 0;
  for (const node of nodes) {
    byKind[node.kind || 'unknown'] = (byKind[node.kind || 'unknown'] || 0) + 1;
    if (node.method) methods.add(node.method);
    if (node.humanGate) humanGates += 1;
    if (node.waitBeforeMs > 0) waits += 1;
    if (node.repeat > 1) repeats += 1;
    if (node.idempotent) idempotent += 1;
  }
  const parallelArms = regions.reduce((sum, region) => sum + region.arms.length, 0);
  const maxWidth = regions.reduce((max, region) => Math.max(max, region.arms.length), 0);
  return {
    total: nodes.length,
    edges: edges.length,
    batches: schedule.length,
    byKind,
    methods: [...methods].slice(0, 16),
    branches: branches.length,
    parallelGroups: regions.length,
    parallelArms,
    maxWidth,
    cancels: cancels.length,
    cancelNodes: cancels.reduce((sum, scope) => sum + scope.nodes, 0),
    humanGates,
    waits,
    repeats,
    idempotent,
    serial: schedule.filter((batch) => batch.kind === BATCH_KINDS.SERIAL).length,
  };
}

function canonicalGraph(nodes, edges, branches, regions, cancels) {
  return {
    nodes: nodes.map((node) => [
      node.index, node.ref, node.kind, node.method, node.idempotent,
      node.humanGate ? 1 : 0, node.branchOptions.length,
      node.parallel ? node.parallel.groupId + ':' + node.parallel.role + ':' + node.parallel.arm : '',
      node.cancel ? node.cancel.scope + ':' + node.cancel.onCancel : '',
      node.waitBeforeMs, node.repeat,
    ]),
    edges: edges.map((edge) => [edge.from, edge.to, edge.kind]),
    branches: branches.map((branch) => [branch.index, branch.options.map((option) => option.label + '|' + option.to)]),
    regions: regions.map((region) => [region.groupId, region.forkIndex, region.joinIndex, region.waitFor, region.arms.map((arm) => arm.memberIndexes)]),
    cancels: cancels.map((scope) => [scope.scope, scope.from, scope.to, scope.mode]),
  };
}

/** 图 digest：只依赖规整后的结构（与参数值无关，参数值在节点 params 里单独摘要）。 */
export function stepGraphDigest(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return '';
  return 'g' + stableHash(JSON.stringify(canonicalGraph(
    graph.nodes,
    Array.isArray(graph.edges) ? graph.edges : [],
    Array.isArray(graph.branches) ? graph.branches : [],
    Array.isArray(graph.parallel) ? graph.parallel : [],
    Array.isArray(graph.cancels) ? graph.cancels : [],
  ))) + '-' + graph.nodes.length.toString(36);
}

/**
 * 构建执行图。
 * @param {Array|object} steps step 数组 / program / {steps} / {nodes}
 * @param {{maxNodes?:number, maxParallelArms?:number, maxBranchOptions?:number, maxCancelScopes?:number}} [options]
 */
export function buildStepGraph(steps, options = {}) {
  const limits = {
    maxNodes: limitOf(options, 'maxNodes'),
    maxEdges: limitOf(options, 'maxEdges'),
    maxParallelArms: limitOf(options, 'maxParallelArms'),
    maxBranchOptions: limitOf(options, 'maxBranchOptions'),
    maxCancelScopes: limitOf(options, 'maxCancelScopes'),
    maxCancelNodes: limitOf(options, 'maxCancelNodes'),
    maxDepth: limitOf(options, 'maxDepth'),
  };
  const issues = [];
  const rawListLength = countInputSteps(steps);
  const nodes = normalizeNodes(steps, limits);
  if (rawListLength > limits.maxNodes) {
    issues.push(problem(GRAPH_CODES.GRAPH_TOO_LARGE, 'error', '输入步骤数超过图规模上限（已截断）', { steps: rawListLength, max: limits.maxNodes }));
  }
  for (const node of nodes) {
    if (node.kind && !STEP_KINDS.includes(node.kind)) {
      issues.push(problem(GRAPH_CODES.UNKNOWN_STEP_KIND, 'warning', '未知 step kind', { index: node.index, ref: node.ref, kind: node.kind }));
    }
    if (!node.ref) issues.push(problem(GRAPH_CODES.EDGE_UNKNOWN, 'warning', '节点缺少 ref（边只能按序号引用）', { index: node.index }));
  }
  const branches = buildBranches(nodes, limits, issues);
  const regions = buildParallelRegions(nodes, limits, issues);
  const cancels = buildCancelScopes(nodes, limits, issues);
  const edges = buildEdges(nodes, regions, branches, limits, issues);
  const cycles = findCycles(nodes, edges);
  for (const cycle of cycles.slice(0, 4)) {
    issues.push(problem(GRAPH_CODES.CYCLE_DETECTED, 'error', '执行图存在环', { cycle: cycle.slice(0, 12) }));
  }
  const graph = {
    version: STEP_GRAPH_VERSION,
    nodes,
    edges,
    branches,
    parallel: regions,
    cancels,
    schedule: [],
    issues: dedupeIssues(issues),
    limits,
  };
  graph.schedule = planStepBatches(graph);
  graph.stats = graphStats(nodes, edges, branches, regions, cancels, graph.schedule);
  graph.digest = stepGraphDigest(graph);
  return graph;
}

/** 对外紧凑摘要（挂到录制事件/诊断上；必须小）。 */
export function summarizeStepGraph(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return null;
  const stats = graph.stats || {};
  return {
    version: STEP_GRAPH_VERSION,
    digest: String(graph.digest || ''),
    nodes: Math.max(0, integer(stats.total, graph.nodes.length)),
    batches: Math.max(0, integer(stats.batches, 0)),
    branches: Math.max(0, integer(stats.branches, 0)),
    parallel: Math.max(0, integer(stats.parallelGroups, 0)),
    arms: Math.max(0, integer(stats.parallelArms, 0)),
    cancels: Math.max(0, integer(stats.cancels, 0)),
    humanGates: Math.max(0, integer(stats.humanGates, 0)),
    issues: Array.isArray(graph.issues) && graph.issues.length
      ? graph.issues.slice(0, 4).map((item) => ({ code: item.code, severity: item.severity }))
      : undefined,
  };
}

/** 一行文本摘要：诊断/CLI 默认输出用。 */
export function describeStepGraph(graph) {
  if (!graph || typeof graph !== 'object') return 'record-graph: 无图';
  const stats = graph.stats || {};
  const parts = ['nodes=' + integer(stats.total, 0), 'batches=' + integer(stats.batches, 0)];
  if (stats.branches > 0) parts.push('branches=' + stats.branches);
  if (stats.parallelGroups > 0) parts.push('parallel=' + stats.parallelGroups + 'x' + (stats.maxWidth || 0));
  if (stats.cancels > 0) parts.push('cancels=' + stats.cancels);
  if (stats.humanGates > 0) parts.push('human=' + stats.humanGates);
  if (graph.digest) parts.push('digest=' + graph.digest);
  return parts.join(' ');
}
