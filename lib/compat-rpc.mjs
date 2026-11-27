// lib/compat-rpc.mjs —— 兼容 RPC 线名表（不进入 canonical 方法目录）。
//
// 背景：部分外部调用方按兼容目标 0.5.0 的线名直接调用 daemon RPC。
// 本表只描述“daemon 本地面已经接受/应答的兼容方法”，不改变 method-catalog 的 canonical 方法集，
// 也不改变扩展协议；矩阵把它记为 partial（可达但非 canonical）。
//
// 维护规则：
// - 新增条目时必须在 daemon 本地 dispatch 中有真实实现，并在 docs/COMPAT-RPC.md 记录语义；
// - canonical 迁移需要单独走 method-catalog/协议生成流程，不在本表偷偷做。
export const COMPAT_RPC_METHODS = Object.freeze({
  cancel: Object.freeze({
    wire: 'cancel',
    route: 'daemon-local',
    canonical: 'command.cancel',
    note: '通用取消 { rpc_id }：复用 daemon in-flight 表 + 扩展 WS cancel，非 canonical 别名。',
  }),
  'ledger.request': Object.freeze({
    wire: 'ledger.request',
    route: 'daemon-local',
    canonical: 'ledger.resolve',
    note: '账本通用入口 { action: status|resolve }：复用 IntentLedger 与 ledger-report。',
  }),
  'system.ping': Object.freeze({
    wire: 'system.ping',
    route: 'daemon-local',
    canonical: null,
    note: '连接健康检查：daemon 本地应答 { pong, protocol, ts }，不触达扩展。',
  }),
  'system.handshake': Object.freeze({
    wire: 'system.handshake',
    route: 'daemon-local',
    canonical: null,
    note: '握手兼容：daemon 本地返回 { protocol, version }，用于旧客户端探测。',
  }),
});

export const COMPAT_RPC_NAMES = Object.freeze(Object.keys(COMPAT_RPC_METHODS));

export function isCompatRpcMethod(name) {
  return Object.prototype.hasOwnProperty.call(COMPAT_RPC_METHODS, String(name || ''));
}
