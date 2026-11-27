// src/daemon/index.ts —— daemon 接入层公共入口。
//
// 两条传输 + 一套错误映射：
//   import { DaemonHttpClient, DaemonSocket, mapDaemonError } from '@/src/daemon';
//
// - DaemonHttpClient：POST /rpc + GET /health（CLI/诊断/带 token 的远程场景）；
// - DaemonSocket：/ws 长连接（扩展 background 的只读转发与事件通道）；
// - errors：daemon 错误码 → DaemonRpcError / ProtocolError。

export * from './types.ts';
export * from './errors.ts';
export { DaemonHttpClient, createDaemonHttpClient } from './client.ts';
export type { DaemonFetch, DaemonHttpClientOptions, DaemonHttpRetryPolicy } from './client.ts';
export * from './ws.ts';
