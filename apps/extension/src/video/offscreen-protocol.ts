// src/video/offscreen-protocol.ts —— background ⇄ offscreen 文档的最小消息协议。
//
// 只放协议常量与载荷类型：background 侧（service.ts）与离屏侧（offscreen.ts）共用，
// 避免两处手写字符串漂移。消息都带 target:'offscreen'（SW → 离屏）或 from:'offscreen'（离屏 → SW）。
//
// 字节传输（第八批 E2E 修复的关键）：Chromium 的 extension messaging 走 JSON 序列化，
// `Uint8Array` 过 `chrome.runtime.sendMessage` 会变成 `{"0":..,"1":..}` 普通对象，
// 接收端 `instanceof Uint8Array` 必然为 false（E2E 20c/35r 的「离屏结果缺少视频字节」）。
// 因此跨上下文一律用 `data_base64` 字符串；`data` 只在同上下文/单测直接传递时存在。
// decodeOffscreenResultBytes 同时兼容：base64 / Uint8Array / ArrayBuffer / 数字键对象，
// 并对无法解码的载荷给出结构化 transport 证据（不伪造字节）。

import { base64FromBytes, bytesFromBase64 } from './hash.ts';
import type { FragmentEntry, JournalSummary } from './types.ts';

export const OFFSCREEN_TARGET = 'offscreen';
export const OFFSCREEN_SOURCE = 'offscreen';

/** 离屏文档算好的「一次录制结果」；SW 收到后补 storage 探测并落库。 */
export interface OffscreenRecordingResult {
  ok: true;
  id: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  mime: string;
  /** 原始容器字节：只在同上下文/单测直接传递时存在；跨消息用 data_base64。 */
  data: Uint8Array;
  /** 跨 chrome.runtime.sendMessage 的字节传输形式（JSON 安全）。 */
  data_base64?: string;
  /** 便于诊断的原始字节数（与 data_base64 长度对不上时可直接发现截断）。 */
  data_bytes?: number;
  completeness: 'complete' | 'partial';
  stop_reason: 'user' | 'duration';
  chunk_count: number;
  fragments: FragmentEntry[];
  finish_via: 'encoder' | 'worker' | 'main';
  complete_frames: boolean;
  faststart: boolean;
  journal: JournalSummary | null;
  indexed?: boolean;
  sidx_bytes?: number;
  raw_bytes?: number;
  trimmed_bytes?: number;
  mode: string;
}

export type OffscreenStartReply =
  | { ok: true; mime: string; startedAt: number; mode: string; encoder?: string }
  | { ok: false; error: string };

/**
 * 把结果转成可 JSON 序列化的线格式：字节 → base64，去掉 `data`（避免把每字节一个键的对象塞进失败路径）。
 * offscreen.ts 的 done/stop/last 三条回包都走这里。
 */
export function encodeOffscreenResult(result: OffscreenRecordingResult): Record<string, unknown> {
  const { data, ...rest } = result;
  const wire: Record<string, unknown> = { ...rest };
  if (data instanceof Uint8Array && data.byteLength > 0) {
    wire.data_base64 = base64FromBytes(data);
    wire.data_bytes = data.byteLength;
  }
  return wire;
}
export interface DecodedResultBytes {
  bytes: Uint8Array | null;
  /** 解码失败的结构化原因（成功时为 null）。 */
  reason: string | null;
  /** 载荷形状证据（写进错误 data，便于 CLI/E2E 看真实发生了什么）。 */
  transport: Record<string, unknown>;
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (typeof Blob !== 'undefined' && value instanceof Blob) return 'Blob';
  return typeof value;
}

function fromNumericObject(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  if (!keys.every((key) => /^\d+$/.test(key))) return null;
  const indices = keys.map((key) => Number(key)).sort((a, b) => a - b);
  if (indices[0] !== 0) return null;
  const last = indices[indices.length - 1] ?? -1;
  if (last + 1 !== keys.length) return null;
  const bytes = new Uint8Array(keys.length);
  for (const index of indices) {
    const value = Number(record[String(index)]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

/** 从离屏结果载荷里取出真实字节；任何失败都带回 transport 证据。 */
export function decodeOffscreenResultBytes(raw: unknown): DecodedResultBytes {
  const bag = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!bag) {
    return { bytes: null, reason: '离屏结果不是对象', transport: { shape: shapeOf(raw) } };
  }
  const transport: Record<string, unknown> = { shape: 'object' };
  const base64 = bag.data_base64 ?? bag.dataBase64;
  transport.has_base64 = typeof base64 === 'string';
  if (typeof base64 === 'string') {
    transport.base64_length = base64.length;
    if (!base64) return { bytes: null, reason: '离屏结果 base64 为空字符串', transport };
    try {
      const bytes = bytesFromBase64(base64);
      transport.decoded_bytes = bytes.length;
      const expected = Number(bag.data_bytes);
      if (Number.isFinite(expected) && expected > 0 && expected !== bytes.length) {
        return {
          bytes: null,
          reason: '离屏结果字节数不一致（base64 截断？）',
          transport: { ...transport, expected_bytes: expected },
        };
      }
      if (bytes.length === 0) return { bytes: null, reason: '离屏结果 base64 解码为空', transport };
      return { bytes, reason: null, transport };
    } catch (error) {
      return {
        bytes: null,
        reason: '离屏结果 base64 解码失败：' + (error instanceof Error ? error.message : String(error)),
        transport,
      };
    }
  }

  const data = bag.data;
  transport.data_shape = shapeOf(data);
  if (data instanceof Uint8Array) {
    transport.decoded_bytes = data.byteLength;
    if (data.byteLength === 0) return { bytes: null, reason: '离屏结果视频字节为空', transport };
    return { bytes: data, reason: null, transport };
  }
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    transport.decoded_bytes = bytes.length;
    if (bytes.length === 0) return { bytes: null, reason: '离屏结果视频字节为空', transport };
    return { bytes, reason: null, transport };
  }
  const rebuilt = fromNumericObject(data);
  if (rebuilt) {
    transport.rebuilt_from = 'numeric-keys';
    transport.decoded_bytes = rebuilt.length;
    return { bytes: rebuilt, reason: null, transport };
  }
  return {
    bytes: null,
    reason: '离屏结果缺少视频字节（JSON 序列化会丢掉 Uint8Array；应改用 data_base64）',
    transport,
  };
}

export const OFFSCREEN_MESSAGES = Object.freeze({
  PING: 'bb.rec.ping',
  START: 'bb.rec.start',
  START_FRAMES: 'bb.rec.start-frames',
  FRAME: 'bb.rec.frame',
  STOP: 'bb.rec.stop',
  ABORT: 'bb.rec.abort',
  STATUS: 'bb.rec.status',
  LAST: 'bb.rec.last',
  DONE: 'bb.rec.done',
  ERROR: 'bb.rec.error',
});

/** 判断是否离屏文档 → SW 的消息（service.handleMessage 用）。 */
export function isOffscreenMessage(raw: unknown): raw is Record<string, unknown> {
  const bag = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  return Boolean(bag && bag.from === OFFSCREEN_SOURCE && typeof bag.type === 'string' && bag.type.startsWith('bb.rec.'));
}
