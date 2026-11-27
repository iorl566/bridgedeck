// daemon/request-context.js —— RPC 调用上下文（兼容目标 0.5.0 通用 `cancel { rpc_id }` 的锚点）。
//
// 背景：兼容目标 的通用 cancel 按**调用方视角**的 rpc_id 取消进行中的请求。我方 daemon→扩展
// 的命令 id 是 daemon 自己生成的 UUID（inflight Map 的 key），调用方看不到。为了让
// `cancel { rpc_id }` 真实可用，传输层（daemon/rpc.js）在每次 dispatch 外面 run 一个
// AsyncLocalStorage 上下文，把调用方给的 rpc_id 带下去；daemon/server.mjs 的 sendCommand
// 在创建 in-flight 条目时用 currentRpcId() 把它挂到 entry.rpcId 上。
//
// 边界（刻意不做的事）：
// - 不改变 inflight.list / status 的默认载荷（entry.rpcId 只在 daemon 内部使用）；
// - 不伪造取消：找不到 in-flight 时 cancel 回 cancelled:false（与 兼容目标 “RPC 本身不报错”一致）；
// - 不跨请求泄漏：AsyncLocalStorage 随 dispatch 结束回收，随机 rpc_id 不会污染别的调用。
import { AsyncLocalStorage } from 'node:async_hooks';

/** 每个入站 RPC 的上下文：{ rpcId: string|null }。 */
export const RPC_CONTEXT = new AsyncLocalStorage();

/** 归一化调用方提供的 rpc id（数字/字符串都接受；空值视为未提供）。 */
export function normalizeRpcId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value.trim() || null;
  return null;
}

/** 在带 rpc_id 的上下文里执行一次 dispatch。 */
export function runWithRpcId(rpcId, fn) {
  return RPC_CONTEXT.run({ rpcId: normalizeRpcId(rpcId) }, fn);
}

/** 当前 dispatch 的调用方 rpc_id（没有则 null）。 */
export function currentRpcId() {
  const store = RPC_CONTEXT.getStore();
  return store && store.rpcId ? store.rpcId : null;
}
