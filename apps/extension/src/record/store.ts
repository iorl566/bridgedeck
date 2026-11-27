// src/record/store.ts —— 录制历史持久化（内存 + chrome.storage.session/local 可用时落盘）。
//
// 为什么不是只用内存：MV3 service worker 随时可能被回收，CLI 的 `record list/export` 要能
// 在 SW 重启后读到已结束的录制；为什么还要内存：无 chrome.* 环境（单测/受限上下文）必须
// 能工作，且配额不足时已捕获的步骤不能丢（内存里仍可读）。
//
// 存储策略：
// - 写入时同时尝试 session（SW 生命周期内快、配额大）与 local（跨浏览器重启）；任一处成功
//   即视为持久化成功，backend 记录实际落点；
// - 两处都失败时裁剪事件后保留在内存，返回 saved=false + warning（不抛异常，不让 stop 失败）；
// - 读取时按 local → session → 内存的顺序取第一份可解析的列表（同一份逻辑数据）；
// - 配额兜底：超过 RECORD_MAX_RECORDINGS 的旧录制、单条超过 RECORD_MAX_EVENTS 的事件直接裁剪。

import {
  RECORD_MAX_EVENTS,
  RECORD_MAX_RECORDINGS,
  type Recording,
  type RecordingSummary,
} from './types.ts';
import { kindCounts } from './sources.ts';

/** 录制存储键（与 JS 运行时的 bb.ops.recordings 区分：TS 运行时自己的历史）。 */
export const RECORDINGS_KEY = 'bb.record.recordings';

/** chrome.storage.StorageArea 的最小形状（可注入 fake）。 */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface RecordStorageAreas {
  session?: StorageAreaLike | null;
  local?: StorageAreaLike | null;
}

export interface RecordStoreOptions {
  maxRecordings?: number;
  maxEvents?: number;
}

export type RecordStoreBackend = 'session+local' | 'session' | 'local' | 'memory';

export interface RecordSaveResult {
  saved: boolean;
  backend: RecordStoreBackend;
  warning: string;
  recordings: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRecording(value: unknown): value is Recording {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (!Array.isArray(value.events)) return false;
  return true;
}

function cloneRecording(recording: Recording): Recording {
  return { ...recording, events: recording.events.map((event) => ({ ...event })) };
}

/** 列表摘要（record.list?includeEvents=false / 页面渲染用）。 */
export function summarizeRecording(recording: Recording): RecordingSummary {
  return {
    id: recording.id,
    tabId: recording.tabId ?? null,
    url: recording.url || '',
    title: recording.title || '',
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    events: Array.isArray(recording.events) ? recording.events.length : 0,
    includeAgent: recording.includeAgent === true,
    kinds: kindCounts(recording.events),
  };
}

/** 内存 + storage 双后端录制历史。 */
export class RecordStore {
  private readonly areas: RecordStorageAreas;
  private readonly maxRecordings: number;
  private readonly maxEvents: number;
  private memory: Recording[] = [];
  private lastBackend: RecordStoreBackend;

  constructor(areas: RecordStorageAreas = {}, options: RecordStoreOptions = {}) {
    this.areas = areas;
    const maxRecordings = Number(options.maxRecordings);
    const maxEvents = Number(options.maxEvents);
    this.maxRecordings = Number.isInteger(maxRecordings) && maxRecordings > 0 ? maxRecordings : RECORD_MAX_RECORDINGS;
    this.maxEvents = Number.isInteger(maxEvents) && maxEvents > 0 ? maxEvents : RECORD_MAX_EVENTS;
    this.lastBackend = this.areas.local && this.areas.session
      ? 'session+local'
      : this.areas.local
        ? 'local'
        : this.areas.session
          ? 'session'
          : 'memory';
  }

  /** 当前可用的存储后端描述（诊断/页面显示用）。 */
  backendKind(): RecordStoreBackend {
    return this.lastBackend;
  }

  /** 仅内存快照（不读 storage；测试/诊断用）。 */
  memorySnapshot(): Recording[] {
    return this.memory.map(cloneRecording);
  }

  private async readArea(area: StorageAreaLike | null | undefined): Promise<Recording[] | null> {
    if (!area) return null;
    try {
      const stored = await area.get(RECORDINGS_KEY);
      const list = stored ? stored[RECORDINGS_KEY] : null;
      if (!Array.isArray(list)) return null;
      const recordings = list.filter(isRecording).map((item) => cloneRecording(item));
      return recordings;
    } catch {
      return null;
    }
  }

  /** 读取历史录制（local → session → 内存）。 */
  async load(): Promise<Recording[]> {
    const local = await this.readArea(this.areas.local);
    if (local && local.length) {
      this.memory = local;
      this.lastBackend = this.areas.session ? 'session+local' : 'local';
      return local.map(cloneRecording);
    }
    const session = await this.readArea(this.areas.session);
    if (session && session.length) {
      this.memory = session;
      this.lastBackend = this.areas.local ? 'session+local' : 'session';
      return session.map(cloneRecording);
    }
    return this.memory.map(cloneRecording);
  }

  /** 写入一条录制（前插、裁剪；session/local 都尝试；都不行时留在内存）。 */
  async save(recording: Recording): Promise<RecordSaveResult> {
    if (!isRecording(recording)) {
      return { saved: false, backend: this.memory.length ? this.backendKind() : 'memory', warning: '录制形状非法，未持久化', recordings: this.memory.length };
    }
    const trimmed: Recording = this.trimRecording(recording);
    // 最新一条保留步骤截图（导出 trace 时用）；旧录制去掉截图，避免配额被历史图片吃光。
    const older = this.memory.filter((item) => item.id !== trimmed.id).map(stripScreenshots);
    const next: Recording[] = [trimmed, ...older].slice(0, this.maxRecordings);
    this.memory = next;
    const payload = next.map(cloneRecording);
    const warnings: string[] = [];
    let sessionOk = false;
    let localOk = false;
    if (this.areas.session) {
      try {
        await this.areas.session.set({ [RECORDINGS_KEY]: payload });
        sessionOk = true;
      } catch (error) {
        warnings.push('session 写入失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    if (this.areas.local) {
      try {
        await this.areas.local.set({ [RECORDINGS_KEY]: payload });
        localOk = true;
      } catch (error) {
        warnings.push('local 写入失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    if (!this.areas.session && !this.areas.local) {
      return { saved: false, backend: 'memory', warning: '没有可用的 chrome.storage，录制只在内存中（SW 重启会丢）', recordings: next.length };
    }
    if (sessionOk || localOk) {
      const backend: RecordStoreBackend = sessionOk && localOk
        ? 'session+local'
        : sessionOk
          ? 'session'
          : 'local';
      this.lastBackend = backend;
      return { saved: true, backend, warning: '', recordings: next.length };
    }
    // 两处都失败：退化为内存（已捕获步骤仍可 list），并如实给出 warning。
    this.lastBackend = 'memory';
    return { saved: false, backend: 'memory', warning: warnings.join('；') || '存储写入失败，录制只在内存中', recordings: next.length };
  }

  /** 删除一条录制；返回删除条数。 */
  async remove(id: string): Promise<number> {
    const wanted = String(id ?? '');
    if (!wanted) return 0;
    const before = this.memory.length;
    this.memory = this.memory.filter((item) => item.id !== wanted);
    const removed = before - this.memory.length;
    if (!removed) return 0;
    const payload = this.memory.map(cloneRecording);
    try {
      if (this.areas.session) await this.areas.session.set({ [RECORDINGS_KEY]: payload });
    } catch {
      // 删除失败不回滚内存：下一次 save/load 会再对齐
    }
    try {
      if (this.areas.local) await this.areas.local.set({ [RECORDINGS_KEY]: payload });
    } catch {
      // 同上
    }
    return removed;
  }

  private trimRecording(recording: Recording): Recording {
    const clone = cloneRecording(recording);
    if (clone.events.length > this.maxEvents) {
      clone.events = clone.events.slice(-this.maxEvents);
    }
    return clone;
  }
}

function stripScreenshots(recording: Recording): Recording {
  const clone = cloneRecording(recording);
  for (const event of clone.events) delete event.screenshot;
  return clone;
}
