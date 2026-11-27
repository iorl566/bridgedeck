// lib/daemon-rpc.mjs —— 插件侧 daemon 直连（不经 CLI/Node 启动）。
// 与 SDK 共用 daemon.json + /rpc 约定；失败由调用方回退 CLI。
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export class DaemonRpcError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.name = 'DaemonRpcError';
    this.code = code;
    this.data = data;
  }
}

export function defaultHome() {
  const fromEnv = process.env.BB_HOME;
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : path.join(os.homedir(), '.browser-bridge');
}

export function readDaemonInfo(home = defaultHome()) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
    if (info && Number.isInteger(info.port) && typeof info.token === 'string') return info;
  } catch {
    // 没有 daemon 或文件正在替换
  }
  return null;
}

function requestJson(info, method, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = info.tls === true ? https : http;
    const request = transport.request({
      host: '127.0.0.1',
      port: info.port,
      path: method,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-bridge-token': info.token,
      },
      ...(info.tls === true ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode || 0, json: JSON.parse(text) });
        } catch {
          reject(new DaemonRpcError('E_DAEMON', 'daemon 返回非 JSON（HTTP ' + response.statusCode + '）'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new DaemonRpcError('E_TIMEOUT', 'daemon 请求超时')));
    request.on('error', (error) => {
      if (error instanceof DaemonRpcError) reject(error);
      else reject(new DaemonRpcError('E_DAEMON', '连接 daemon 失败：' + (error && error.message ? error.message : error)));
    });
    request.end(body);
  });
}

/** 调用 daemon 方法并返回 result；失败抛 DaemonRpcError。 */
export async function daemonRpc(method, params = {}, options = {}) {
  if (process.env.BB_PLUGIN_DIRECT_RPC === '0') {
    throw new DaemonRpcError('E_DIRECT_RPC_DISABLED', '插件直连已禁用');
  }
  const home = options.home || defaultHome();
  const info = readDaemonInfo(home);
  if (!info) throw new DaemonRpcError('E_DAEMON', 'daemon 未运行（' + path.join(home, 'daemon.json') + ' 不存在）');
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : 60000;
  // 请求层超时提前 1 秒触发，留出把 E_TIMEOUT 交回调用方的时间；但不能小于 1 秒，
  // 否则 `timeoutMs=1000` 时 http 的 timeout=0 会退化成“永不超时”（daemon 假死时挂住）。
  const requestTimeoutMs = Math.max(1000, timeoutMs - 1000);
  const { json } = await requestJson(info, '/rpc', { method, params, timeoutMs }, requestTimeoutMs);
  if (!json || json.ok !== true) {
    const error = (json && json.error) || {};
    throw new DaemonRpcError(error.code || 'E_RPC', error.message || 'daemon 返回失败', error.data);
  }
  return json.result;
}
