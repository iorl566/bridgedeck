// src/runtime/settings.ts —— 扩展设置读写与 daemon 视图映射。
//
// TS 侧设置（shared/settings.ts）是 M-A 就定下的最小集合；0.3.0 JS 扩展的设置面更大
// （instanceLabel/borrowConfirm/allowHelp/longShotMode/pageGuard/...），CLI `bridge settings`
// 读的是 JS 形状。这里做一个**只读投影**：把 TS 设置映射成 daemon/CLI 期望的字段，
// 不存在的字段给与 JS 默认值一致的常量（并如实标注来源）。
//
// 人工开关（borrowConfirm/cooperationGuard/daemonUrl/daemonToken/daemonCode）只允许用户
// 在扩展设置页修改；CLI/daemon 的 settings.set 写入一律 E_FORBIDDEN —— E2E 第 13 项
// 验证的就是这条安全边界，TS 侧必须保留。

import { normalizeSettings, type BridgeSettings } from '../../shared/settings.ts';

/** 存储形状（只依赖 get/set；chrome.storage.local 与测试假实现都满足）。 */
export interface SettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const SETTINGS_KEY = 'bridgeSettings';

/** 只能由用户在扩展设置页修改的字段（与 JS settings.js 的 HUMAN_ONLY_KEYS 一致）。 */
export const HUMAN_ONLY_KEYS: readonly string[] = Object.freeze([
  'borrowConfirm',
  'cooperationGuard',
  'daemonUrl',
  'daemonToken',
  'daemonCode',
]);

/** daemon/CLI 视角的设置形状（与 0.3.0 JS settingsGet 的字段对齐）。 */
export interface DaemonSettingsView {
  settings: Record<string, unknown>;
  label: string;
}

/** TS 设置 → daemon/CLI 视图（人工开关也投影真实值，CLI 只读）。 */
export function daemonSettingsView(settings: BridgeSettings): DaemonSettingsView {
  const normalized = normalizeSettings(settings);
  return {
    settings: {
      instanceLabel: normalized.instanceLabel,
      borrowConfirm: normalized.borrowRequireConfirm,
      allowHelp: normalized.allowHelp,
      longShotMode: normalized.longShotMode,
      pageGuard: normalized.pageGuard,
      connectionEnabled: true,
      controlHint: normalized.controlHint,
      cooperationGuard: false,
      auditEnabled: false,
      daemonUrl: normalized.daemonUrl,
      daemonToken: normalized.daemonToken,
      daemonCode: normalized.daemonCode,
      // 本运行时已迁移的字段（诊断用；CLI 可忽略未知键）。
      daemonPort: normalized.daemonPort,
      language: normalized.language,
    },
    label: normalized.instanceLabel,
  };
}

/** 设置存储封装。 */
export class SettingsStore {
  private readonly storage: SettingsStorage;

  constructor(storage: SettingsStorage) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new TypeError('SettingsStore 需要 storage.get/set');
    }
    this.storage = storage;
  }

  /** 读设置（畸形存储 → 默认值，不抛）。 */
  async read(): Promise<BridgeSettings> {
    try {
      const stored = await this.storage.get(SETTINGS_KEY);
      return normalizeSettings(stored?.[SETTINGS_KEY]);
    } catch {
      return normalizeSettings(null);
    }
  }

  /** 局部更新（只接受已知的 TS 设置键；未知键忽略并回 evidence）。 */
  async write(patch: Record<string, unknown>): Promise<{ settings: BridgeSettings; applied: string[]; ignored: string[] }> {
    const current = await this.read();
    const next: BridgeSettings = { ...current };
    const applied: string[] = [];
    const ignored: string[] = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      switch (key) {
        case 'controlHint':
          if (typeof value === 'boolean') {
            next.controlHint = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'recordOverlay':
          if (typeof value === 'boolean') {
            next.recordOverlay = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'borrowRequireConfirm':
          if (typeof value === 'boolean') {
            next.borrowRequireConfirm = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'allowHelp':
          if (typeof value === 'boolean') {
            next.allowHelp = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'language':
          if (typeof value === 'string' && value.trim()) {
            next.language = value.trim();
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'daemonPort': {
          const port = Number(value);
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            next.daemonPort = port;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        }
        case 'instanceLabel':
          if (typeof value === 'string') {
            next.instanceLabel = value.slice(0, 64);
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'pageGuard':
          if (typeof value === 'boolean') {
            next.pageGuard = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'longShotMode':
          if (value === 'auto' || value === 'manual') {
            next.longShotMode = value;
            applied.push(key);
          } else {
            ignored.push(key);
          }
          break;
        case 'daemonUrl':
        case 'daemonToken':
        case 'daemonCode': {
          // 配对字段只允许设置页（人工）写入：长度上限防止把大段文本塞进 storage。
          if (typeof value === 'string') {
            const trimmed = key === 'daemonUrl' ? value.trim().slice(0, 512) : value.trim().slice(0, 512);
            if (key === 'daemonCode' && trimmed && !/^\d{0,6}$/.test(trimmed)) {
              ignored.push(key);
            } else {
              next[key] = trimmed;
              applied.push(key);
            }
          } else {
            ignored.push(key);
          }
          break;
        }
        default:
          // 未知键忽略。
          ignored.push(key);
      }
    }
    const normalized = normalizeSettings(next);
    await this.storage.set({ [SETTINGS_KEY]: normalized });
    return { settings: normalized, applied, ignored };
  }

  /**
   * 人工设置写入（扩展设置页专用）：与 `write` 同一份存储，但允许 HUMAN_ONLY_KEYS。
   * daemon/CLI 侧仍然走 `settings.set` → `humanOnlyKeysIn()` 拒绝，安全边界不变。
   */
  async writeHuman(patch: Record<string, unknown>): Promise<{ settings: BridgeSettings; applied: string[]; ignored: string[] }> {
    return this.write(patch);
  }
}

/** 检查 patch 是否包含人工开关；返回命中的键（空数组表示通过）。 */
export function humanOnlyKeysIn(patch: unknown): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  return HUMAN_ONLY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
}
