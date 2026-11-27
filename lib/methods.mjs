// lib/methods.mjs —— 方法路由分类与变异判定的运行时入口。
//
// 收口后本文件不再手写任何方法名清单：LOCAL/SESSION/INSTANCE/EXT、
// SESSION_QUEUE_BYPASS 与 isMutating 全部从 lib/method-catalog.mjs 的单一目录派生。
// 导出名与形状保持与收口前一致，所有调用点零改动：
// - daemon 路由：LOCAL_METHODS / SESSION_METHODS / EXT_METHODS / SESSION_QUEUE_BYPASS
// - 意图账本与远程作用域：isMutating / remoteScopeAllows / methodScope
// - 门禁：catalogRegistryErrors / validateMethodRegistry
//
// 依赖方向：lib/methods.mjs → lib/method-catalog.mjs（+ 只读引用 METHOD_EFFECT）。
// 方法名只能出现在 lib/method-catalog.mjs；本文件出现方法名字面量会被
// tools/protocol-single-source.mjs 的 runtime 审计判为“手工表回流”。

import {
  CATALOG_BY_METHOD,
  DAEMON_ONLY_METHODS,
  LEGACY_MUTATING_METHODS,
  OWNER_METHODS,
  SESSION_QUEUE_BYPASS_METHODS,
  isMutatingInCatalog,
  validateRuntimeLists,
} from './method-catalog.mjs';
import { METHOD_EFFECT } from './protocol.mjs';

const asSet = (methods) => new Set(methods);

// daemon 自己处理的方法（PROTOCOL §4）：目录 local owner + daemon 专用生命周期/账本方法。
export const LOCAL_METHODS = asSet([...OWNER_METHODS.local, ...DAEMON_ONLY_METHODS]);

// 需要会话上下文、由 daemon 注入 tabId 的扩展方法（PROTOCOL §5.2 + window.resize）。
export const SESSION_METHODS = asSet(OWNER_METHODS.session);

// 不需要会话、但要选一个浏览器实例的方法（PROTOCOL §5.1）。
export const INSTANCE_METHODS = asSet(OWNER_METHODS.instance);

export const EXT_METHODS = asSet([...SESSION_METHODS, ...INSTANCE_METHODS]);

// 这些方法本身在等待/解除另一个命令，不能排在它后面，否则会死锁。
export const SESSION_QUEUE_BYPASS = asSet(SESSION_QUEUE_BYPASS_METHODS);

// 非 canonical 的历史别名：旧 CLI/脚本仍可能把调用送到账本/预检路径。
const LEGACY_MUTATING_SET = asSet(LEGACY_MUTATING_METHODS);

/**
 * 是否属于需要预写意图账本的变异操作。
 * canonical 方法：完全由目录的 receipt effect + MUTATING_OVERRIDES 推导
 * （与生成物 MUTATING_METHODS 同一口径，杜绝两套判定）。
 * 目录外方法：保持收口前手工 MUTATING 集合的历史行为——只有历史别名算变异。
 */
export function isMutating(method) {
  const name = String(method || '');
  if (Object.prototype.hasOwnProperty.call(CATALOG_BY_METHOD, name)) return isMutatingInCatalog(name);
  return LEGACY_MUTATING_SET.has(name);
}

/** 'local' | 'session' | 'instance' | null，供路由与门禁使用。 */
export function methodScope(method) {
  const name = String(method || '');
  if (LOCAL_METHODS.has(name)) return 'local';
  if (SESSION_METHODS.has(name)) return 'session';
  if (INSTANCE_METHODS.has(name)) return 'instance';
  return null;
}

/** 远程实例作用域门禁：read 只允许非变异方法，control 全放行。 */
export function remoteScopeAllows(scope, method) {
  return String(scope || 'control') !== 'read' || !isMutating(method);
}

/** 手工分类表与 lib/method-catalog.mjs 单一目录的交叉校验（protocol-check 与单测共用）。 */
export function catalogRegistryErrors() {
  const errors = [];
  for (const [method, row] of Object.entries(CATALOG_BY_METHOD)) {
    const scope = methodScope(method);
    if (scope !== row.owner) errors.push(`方法 ${method} 派生 scope=${scope || '<无>'}，目录 owner=${row.owner}`);
    const mutating = isMutating(method);
    if (mutating !== isMutatingInCatalog(method)) errors.push(`方法 ${method} 派生 isMutating=${mutating}，目录=${isMutatingInCatalog(method)}`);
  }
  return errors;
}

/**
 * 返回分类清单的错误列表；空数组表示一致。protocol-check 与单测共用。
 * 收口后方法清单由目录派生，这里的检查从“手工表是否漂移”变为
 * “派生结果是否仍满足路由/账本/特性门不变量”，作为最后一道防线保留。
 */
export function validateMethodRegistry() {
  const errors = [];
  for (const method of SESSION_METHODS) {
    if (!METHOD_EFFECT[method]) errors.push(`会话方法 ${method} 不在 METHOD_EFFECT`);
  }
  for (const method of INSTANCE_METHODS) {
    if (!METHOD_EFFECT[method]) errors.push(`实例方法 ${method} 不在 METHOD_EFFECT`);
  }
  for (const method of LOCAL_METHODS) {
    if (EXT_METHODS.has(method)) errors.push(`方法 ${method} 同时被声明为 local 与扩展方法`);
  }
  for (const method of SESSION_METHODS) {
    if (INSTANCE_METHODS.has(method)) errors.push(`方法 ${method} 同时被声明为 session 与 instance`);
  }
  for (const method of SESSION_QUEUE_BYPASS) {
    if (!SESSION_METHODS.has(method) && !LOCAL_METHODS.has(method)) errors.push(`队列旁路方法 ${method} 没有归属`);
  }
  errors.push(...catalogRegistryErrors());
  errors.push(...validateRuntimeLists());
  return errors;
}
