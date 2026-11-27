// src/cdp/api.ts —— 从运行时全局解析 chrome.debugger（惰性、不抛错、可注入）。
//
// 为什么惰性：单测在 Node 里跑，没有 chrome；background 的模块加载期也不应该因为
// 拿不到 chrome.debugger 而崩。解析失败一律返回 null，由上层降级（via=frame-projected）。

import type { ChromeDebuggerApi } from './types.ts';

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' ? value as AnyRecord : null;
}

/** 判断一个对象是否长得像 chrome.debugger 命名空间（三个核心方法齐备）。 */
export function isChromeDebuggerApi(value: unknown): value is ChromeDebuggerApi {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.attach === 'function'
    && typeof record.detach === 'function'
    && typeof record.sendCommand === 'function';
}

/**
 * 从 `globalThis`（或注入的 scope）解析 chrome.debugger。
 * 依次尝试 `scope.chrome.debugger` 与 `scope.browser.debugger`（WXT 的 polyfill 命名空间）。
 * 任何 getter 抛错都收敛成 null。
 */
export function resolveDebuggerApi(scope: unknown = globalThis): ChromeDebuggerApi | null {
  try {
    const root = asRecord(scope);
    if (!root) return null;
    for (const key of ['chrome', 'browser'] as const) {
      const namespace = asRecord(root[key]);
      if (!namespace) continue;
      const candidate = namespace.debugger;
      if (isChromeDebuggerApi(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** 当前运行时是否声明了 debugger 权限（只做能力探测，不 attach）。 */
export function hasDebuggerPermission(scope: unknown = globalThis): boolean {
  try {
    const root = asRecord(scope);
    const runtime = asRecord(asRecord(root?.['chrome'])?.['runtime']) ?? asRecord(asRecord(root?.['browser'])?.['runtime']);
    if (!runtime) return false;
    const getManifest = runtime['getManifest'];
    const manifest = asRecord(typeof getManifest === 'function' ? getManifest() : null);
    if (!manifest) return false;
    const permissions = Array.isArray(manifest['permissions']) ? manifest['permissions'] : [];
    return permissions.includes('debugger');
  } catch {
    return false;
  }
}
