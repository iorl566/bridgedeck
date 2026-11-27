// packages/protocol/src/state.ts —— 五维方法状态（owner/effect/partial/unknown/reconcile）。
//
// 数据来自生成物（lib/method-catalog.mjs 的 METHOD_STATE 投影），本文件实现：
// - 查询：methodState / ownerOf / floorOf / isMutatingInCatalog / catalogRow；
// - 派生：ownerBuckets / partialMethodNames / unknownMethodNames；
// - 不变量：stateInvariantErrors（移植 JS validateMethodStates 的全部检查）。
//
// 语义约定（与 JS 源注释一致）：
// - partial 只允许出现在只读方法（passive_read/read）上；
// - unknown 只允许出现在“需要回执的变异”上（变异目标准确性优先于乐观成功）；
// - 非变异方法的 reconcile 必须是 none；变异方法必须有收敛策略；
// - status 收敛必须给出目录内的只读证据方法。

import {
  DAEMON_ONLY_METHODS,
  FEATURE_FLOORS,
  METHOD_CATALOG,
  MUTATING_OVERRIDES,
  PARTIAL_METHODS,
  RECEIPT_EFFECTS,
  RECONCILE_DEFAULT,
  RECONCILE_OVERRIDES,
  RECONCILE_STRATEGIES,
} from './generated.ts';
import type { MethodName } from './generated.ts';
import { methodFeature } from './features.ts';
import type {
  CatalogRow,
  CatalogRowCandidate,
  MethodEffect,
  MethodOwner,
  MethodReconcileState,
  MethodState,
  ReconcileStrategy,
} from './types.ts';

const OWNER_KINDS: ReadonlySet<string> = new Set<MethodOwner>(['local', 'session', 'instance']);
const READ_EFFECTS: ReadonlySet<string> = new Set<MethodEffect>(['passive_read', 'read']);
const RECEIPT_EFFECT_SET: ReadonlySet<string> = new Set(RECEIPT_EFFECTS);
const MUTATING_OVERRIDE_SET: ReadonlySet<string> = new Set(MUTATING_OVERRIDES);
const PARTIAL_METHOD_SET: ReadonlySet<string> = new Set(PARTIAL_METHODS);
const RECONCILE_STRATEGY_SET: ReadonlySet<string> = new Set(RECONCILE_STRATEGIES);
const DAEMON_ONLY_SET: ReadonlySet<string> = new Set(DAEMON_ONLY_METHODS);

const CATALOG_BY_METHOD: Readonly<Record<string, CatalogRow<MethodName> | undefined>> =
  Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row]));

const RECONCILE_OVERRIDE_LOOKUP: Readonly<Record<string, string | undefined>> =
  RECONCILE_OVERRIDES as Readonly<Record<string, string | undefined>>;

/** 方法名归一：与 JS 侧 `String(method || '')` 同义，且不把原型链键当方法。 */
export function normalizeMethodName(method: unknown): string {
  return String(method || '');
}

/** 目录行；未知方法返回 null。 */
export function catalogRow(method: unknown): CatalogRow<MethodName> | null {
  const name = normalizeMethodName(method);
  if (!Object.hasOwn(CATALOG_BY_METHOD, name)) return null;
  return CATALOG_BY_METHOD[name] ?? null;
}

/**
 * 单方法的五维状态快照；未知方法返回 null。
 * 返回新对象（不是目录行本身），调用方改不动单源数据。
 */
export function methodState(method: unknown): MethodState<MethodName> | null {
  const row = catalogRow(method);
  if (!row) return null;
  return Object.freeze({
    owner: row.owner,
    effect: row.effect,
    partial: row.partial,
    unknown: row.unknown,
    reconcile: Object.freeze({
      strategy: row.reconcile.strategy,
      method: row.reconcile.method,
    }),
  });
}

/** 方法 owner：local/session/instance；daemon 专用生命周期方法按 local 处理；未知返回 null。 */
export function ownerOf(method: unknown): MethodOwner | null {
  const row = catalogRow(method);
  if (row) return row.owner;
  return DAEMON_ONLY_SET.has(normalizeMethodName(method)) ? 'local' : null;
}

/** 方法要求的协议 floor；无方法级特性门返回 null。 */
export function floorOf(method: unknown): string | null {
  const feature = methodFeature(method);
  return feature ? FEATURE_FLOORS[feature] : null;
}

/** 目录口径的“是否变异”（供回执/意图账本判定）。 */
export function isMutatingInCatalog(method: unknown): boolean {
  const row = catalogRow(method);
  if (!row) return false;
  return RECEIPT_EFFECT_SET.has(row.effect) || MUTATING_OVERRIDE_SET.has(row.method);
}

/**
 * 解析一个方法的收敛策略（override → 默认推导）。
 * override 形如 'observe' 或 'status:video.status'；未列出的方法按 effect 默认推导，
 * 只读方法恒为 none（它们不会产生“可能已生效但不知道”的状态）。
 */
export function reconcileOf(method: unknown, effect: MethodEffect): MethodReconcileState {
  const name = normalizeMethodName(method);
  const override = Object.hasOwn(RECONCILE_OVERRIDE_LOOKUP, name)
    ? RECONCILE_OVERRIDE_LOOKUP[name]
    : undefined;
  if (override) {
    const [strategy, target = null] = override.split(':');
    return Object.freeze({
      strategy: strategy as ReconcileStrategy,
      method: target ? target : null,
    });
  }
  if (!isMutatingInCatalog(method)) {
    return Object.freeze({ strategy: 'none', method: null });
  }
  const fallback = (RECONCILE_DEFAULT as Readonly<Record<string, ReconcileStrategy | undefined>>)[effect];
  return Object.freeze({ strategy: fallback ?? 'ledger', method: null });
}

/**
 * 五维状态不变量校验：返回人类可读错误列表（空数组 = 合法）。
 * 移植 lib/method-catalog.mjs 的 validateMethodStates，逐条检查都保留：
 * owner 合法、effect 非空、unknown/partial 与目录口径一致、partial 只出现在只读方法、
 * reconcile 策略合法且与变异口径自洽、status 目标必须是目录内的只读方法。
 */
export function stateInvariantErrors(
  rows: readonly CatalogRowCandidate[] = METHOD_CATALOG,
): string[] {
  const errors: string[] = [];
  for (const row of rows) {
    const name = row && row.method;
    if (!name) {
      errors.push('状态行缺少方法名');
      continue;
    }
    if (!OWNER_KINDS.has(String(row.owner))) {
      errors.push(name + ' owner 非法：' + String(row.owner));
    }
    if (!row.effect) errors.push(name + ' effect 为空');
    const mutating = isMutatingInCatalog(name);
    if (row.unknown !== undefined && Boolean(row.unknown) !== mutating) {
      errors.push(name + ' unknown=' + String(row.unknown) + '，目录口径=' + String(mutating));
    }
    if (row.partial !== undefined && Boolean(row.partial) !== PARTIAL_METHOD_SET.has(name)) {
      errors.push(name + ' partial=' + String(row.partial) + '，目录口径=' + String(PARTIAL_METHOD_SET.has(name)));
    }
    if (row.partial && !READ_EFFECTS.has(String(row.effect))) {
      errors.push(name + ' 只有只读方法可以 partial（effect=' + String(row.effect) + '）');
    }
    const reconcile = row.reconcile && typeof row.reconcile === 'object' ? row.reconcile : null;
    if (!reconcile) {
      errors.push(name + ' 缺少 reconcile 状态');
      continue;
    }
    const strategy = String(reconcile.strategy);
    if (!RECONCILE_STRATEGY_SET.has(strategy)) {
      errors.push(name + ' reconcile 策略非法：' + strategy);
    }
    if (!mutating && strategy !== 'none') {
      errors.push(name + ' 非变异方法 reconcile 必须是 none');
    }
    if (mutating && strategy === 'none') {
      errors.push(name + ' 变异方法必须有收敛策略');
    }
    const targetName = reconcile.method;
    if (targetName) {
      const target = catalogRow(targetName);
      if (!target) {
        errors.push(name + ' reconcile 目标不在目录：' + targetName);
      } else if (target.effect === 'browser_mutation' || target.effect === 'transient_input') {
        errors.push(name + ' reconcile 目标必须是只读方法：' + targetName);
      }
    }
    if (strategy === 'status' && !targetName) {
      errors.push(name + ' status 收敛必须给出目标方法');
    }
  }
  return errors;
}

/**
 * 不变量断言：目录不可信时立刻失败（生成器与测试都调用）。
 * 抛出的错误带 E_CATALOG_INVARIANT 前缀，错误正文是逐条明细。
 */
export function assertCatalogInvariants(
  rows: readonly CatalogRowCandidate[] = METHOD_CATALOG,
): void {
  const errors = stateInvariantErrors(rows);
  if (errors.length) {
    throw new Error('E_CATALOG_INVARIANT：方法状态表不合法（' + errors.length + ' 项）：' + errors.join('；'));
  }
}

/** owner 分桶（local/session/instance），保持目录顺序。 */
export function ownerBuckets(): Readonly<Record<MethodOwner, readonly MethodName[]>> {
  const local: MethodName[] = [];
  const session: MethodName[] = [];
  const instance: MethodName[] = [];
  for (const row of METHOD_CATALOG) {
    if (row.owner === 'local') local.push(row.method);
    else if (row.owner === 'session') session.push(row.method);
    else instance.push(row.method);
  }
  return Object.freeze({
    local: Object.freeze(local),
    session: Object.freeze(session),
    instance: Object.freeze(instance),
  });
}

/** 结果可能被截断/分页/分段的方法（调用方必须看 partial/cursor）。 */
export function partialMethodNames(): readonly MethodName[] {
  return METHOD_CATALOG.filter((row) => row.partial).map((row) => row.method);
}

/** 派发后可能“未知是否生效”的方法。 */
export function unknownMethodNames(): readonly MethodName[] {
  return METHOD_CATALOG.filter((row) => row.unknown).map((row) => row.method);
}

/** 需要回执的方法（目录口径）。 */
export function receiptMethodNames(): readonly MethodName[] {
  return METHOD_CATALOG.filter((row) => row.receipt).map((row) => row.method);
}

/** 按方法名查行；找不到抛错（供生成器/测试断言“必须存在”）。 */
export function requireCatalogRow(method: unknown): CatalogRow<MethodName> {
  const row = catalogRow(method);
  if (!row) throw new Error('E_UNKNOWN_METHOD：方法不在协议目录：' + normalizeMethodName(method));
  return row;
}
