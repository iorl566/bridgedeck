// src/debug/cdp-channel.ts —— CDP 业务域共用窄接口 + 编解码小工具（M-C 第六批 wave 2）。
//
// 为什么需要它：`src/cdp/**` 是通道单源（attach 去重/超时/子 session/teardown），
// 但 debug/Fetch/trace/pdf/emulate/shadow 这些业务域只需要其中 4 个能力：
//   acquire/release（feature 租约）、send（命令）、onEvent（事件）、sendToSession。
// 这里用结构化子集描述它，任何满足形状的对象都能注入（单测用假通道，运行时用
// `new CdpClient()`）——业务模块不 import chrome.debugger，也不重复造 attach。

import type { CdpClient } from '../cdp/index.ts';

/** 事件来源（root target 只有 tabId；flatten 子 session 带 sessionId）。 */
export interface CdpChannelSource {
  tabId?: number;
  sessionId?: string;
}

export type CdpChannelHandler = (params: Record<string, unknown>, source: CdpChannelSource) => void;

/**
 * CDP 业务的窄通道：`CdpClient` 直接满足。
 *
 * 注意：`acquire` 会同时完成 attach；业务不应自己调用 chrome.debugger.attach。
 */
export interface CdpChannel {
  acquire(tabId: number, feature: string): Promise<void>;
  release(tabId: number, feature: string): void;
  send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; sessionId?: string },
  ): Promise<T>;
  onEvent(tabId: number, method: string, handler: CdpChannelHandler): () => void;
}

/** 判断一个对象是否满足窄通道形状（用于集成期防御，不在模块加载期读 chrome）。 */
export function isCdpChannel(value: unknown): value is CdpChannel {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['acquire'] === 'function'
    && typeof record['release'] === 'function'
    && typeof record['send'] === 'function'
    && typeof record['onEvent'] === 'function';
}

/** `CdpClient` → `CdpChannel` 的类型断言助手（结构子集，零运行时开销）。 */
export function asCdpChannel(client: CdpClient | null | undefined): CdpChannel | null {
  return isCdpChannel(client) ? client : null;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 文本 → base64（不依赖 btoa/atob/Buffer，浏览器 SW 与 Node 单测同源）。 */
export function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    out += b === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 0x3f];
    out += c === undefined ? '=' : BASE64_ALPHABET[triple & 0x3f];
  }
  return out;
}

/** base64 → UTF-8 文本（容错：非法字符跳过）。 */
export function base64DecodeUtf8(value: string): string {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === '=') break;
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** 通配规则（`*` 任意串、大小写不敏感）→ RegExp；与 JS 兼容目标的语义一致。 */
export function wildcardRegExp(pattern: unknown): RegExp {
  const parts = String(pattern ?? '*').split('*').map((part) => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'));
  return new RegExp('^' + parts.join('.*') + '$', 'i');
}

/** 头部记录 → CDP 头数组（[{name,value}]）。 */
export function headerArray(headers: unknown): Array<{ name: string; value: string }> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
}

/** CDP 头数组 → 头部记录。 */
export function headerRecord(headers: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const item of headers) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const name = String(entry['name'] ?? '');
      if (!name) continue;
      record[name] = String(entry['value'] ?? '');
    }
  } else if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) record[name] = String(value);
  }
  return record;
}

/** 数值收敛（未知/非有限 → fallback），避免把 undefined 写进 CDP 命令。 */
export function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
