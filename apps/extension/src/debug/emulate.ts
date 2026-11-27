// src/debug/emulate.ts —— CDP Emulation 域：视口/DPR/UA/时区/语言/地理仿真（21、31f2）。
//
// 用途：E2E 视口覆盖（innerWidth=800）、长截图分数 DPR（deviceScaleFactor=1.5，
// 页面 devicePixelRatio 变化后截图按 1.5 倍放大）、移动端/时区/定位等设备仿真。
//
// 实现要点（与 JS 参考 extension/src/emulate.js 同口径）：
// - attach 走 `CdpChannel.acquire`，仿真期间持有 'emulate' 租约，避免空闲软分离；
// - 首次仿真前记录真实视口（Runtime.evaluate window.innerWidth/innerHeight/devicePixelRatio）；
// - reset 依次 clearDeviceMetricsOverride / 零尺寸覆盖 / 清时区定位 UA，再实测 innerWidth；
//   Edge 偶发「clear 成功但渲染进程仍卡在仿真尺寸」，此时用记录的原始视口再覆盖一次。

import type { CdpChannel } from './cdp-channel.ts';
import { finiteNumber } from './cdp-channel.ts';

export interface EmulateServiceOptions {
  client: CdpChannel;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ViewportSnapshot {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
}

const METRICS_EXPRESSION = '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio })';

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function badArg(message: string): Error {
  return Object.assign(new Error(message), { code: 'E_BAD_ARG' });
}

/**
 * 设备/视口仿真服务。
 *
 * ```ts
 * const emulate = new EmulateService({ client });
 * await emulate.emulate({ tabId, viewport: { width: 1241, height: 800, deviceScaleFactor: 1.5 } });
 * await emulate.emulate({ tabId, reset: true });
 * ```
 */
export class EmulateService {
  private readonly client: CdpChannel;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly snapshots = new Map<number, ViewportSnapshot>();

  constructor(options: EmulateServiceOptions) {
    if (!options || !options.client) throw new TypeError('EmulateService 需要 CdpChannel');
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      (timer as unknown as { unref?: () => void }).unref?.();
    }));
  }

  private requireTabId(params: Record<string, unknown>): number {
    const tabId = Number(params['tabId']);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw badArg('emulate 需要正整数 tabId（由 daemon 按会话注入）');
    }
    return tabId;
  }

  /** 读页面实测视口（失败返回 null，不抛错）。 */
  async metrics(tabId: number): Promise<ViewportSnapshot | null> {
    try {
      const evaluated = await this.client.send<Record<string, unknown>>(tabId, 'Runtime.evaluate', {
        expression: METRICS_EXPRESSION,
        returnByValue: true,
      });
      const value = asRecord(asRecord(asRecord(evaluated)['result'])['value']);
      const innerWidth = Number(value['innerWidth']);
      const innerHeight = Number(value['innerHeight']);
      const dpr = Number(value['dpr']);
      if (!Number.isFinite(innerWidth) || innerWidth <= 0) return null;
      return {
        innerWidth: Math.round(innerWidth),
        innerHeight: Math.max(1, Math.round(Number.isFinite(innerHeight) ? innerHeight : innerWidth)),
        dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
      };
    } catch {
      return null;
    }
  }

  /** emulate：应用仿真参数（reset=true 等价于 21 的 `--reset`）。 */
  async emulate(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = asRecord(rawParams);
    const tabId = this.requireTabId(params);
    if (params['reset'] === true) return this.reset(tabId);

    const hasViewport = params['viewport'] && typeof params['viewport'] === 'object';
    const wants =
      hasViewport
      || (typeof params['userAgent'] === 'string' && params['userAgent'] !== '')
      || (typeof params['acceptLanguage'] === 'string' && params['acceptLanguage'] !== '')
      || params['touch'] !== undefined
      || (typeof params['timezone'] === 'string' && params['timezone'] !== '')
      || (typeof params['locale'] === 'string' && params['locale'] !== '')
      || params['geolocation'] !== undefined;
    if (!wants) throw badArg('emulate 至少给一个参数（--width/--height/--dpr/--timezone/--geolocation/--reset 等）');

    await this.client.acquire(tabId, 'emulate');
    const applied: Record<string, unknown> = {};
    const errors: string[] = [];
    let released = false;
    try {
      if (!this.snapshots.has(tabId)) {
        const snapshot = await this.metrics(tabId);
        if (snapshot) this.snapshots.set(tabId, snapshot);
      }
      if (hasViewport) {
        const viewport = asRecord(params['viewport']);
        const width = Math.round(Number(viewport['width']));
        const height = Math.round(Number(viewport['height']));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw badArg('viewport 需要正的 width/height');
        }
        const scale = Number(viewport['deviceScaleFactor']);
        const deviceScaleFactor = Number.isFinite(scale) && scale > 0 ? scale : 1;
        // Emulation 只能给 deviceScaleFactor，页面 devicePixelRatio 会跟着变（截图 DPR 依赖它）。
        await this.client.send(tabId, 'Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor,
          mobile: viewport['mobile'] === true,
        });
        applied['viewport'] = { width, height, deviceScaleFactor };
      }

      const userAgent = typeof params['userAgent'] === 'string' ? String(params['userAgent']) : '';
      const acceptLanguage = typeof params['acceptLanguage'] === 'string' ? String(params['acceptLanguage']) : '';
      if (userAgent || acceptLanguage) {
        const command: Record<string, unknown> = {};
        if (userAgent) command['userAgent'] = userAgent;
        else command['userAgent'] = '';
        if (acceptLanguage) command['acceptLanguage'] = acceptLanguage;
        if (typeof params['platform'] === 'string' && params['platform']) command['platform'] = String(params['platform']);
        await this.trySend(tabId, 'Network.setUserAgentOverride', command, errors);
        applied['userAgent'] = userAgent || null;
        if (acceptLanguage) applied['acceptLanguage'] = acceptLanguage;
      }

      if (params['touch'] === true) {
        await this.trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, errors);
        applied['touch'] = true;
      } else if (params['touch'] === false) {
        await this.trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }, errors);
        applied['touch'] = false;
      }

      if (typeof params['timezone'] === 'string' && params['timezone']) {
        await this.trySend(tabId, 'Emulation.setTimezoneOverride', { timezoneId: String(params['timezone']) }, errors);
        applied['timezone'] = String(params['timezone']);
      }
      if (typeof params['locale'] === 'string' && params['locale']) {
        await this.trySend(tabId, 'Emulation.setLocaleOverride', { locale: String(params['locale']) }, errors);
        applied['locale'] = String(params['locale']);
      }
      if (params['geolocation'] === null) {
        await this.trySend(tabId, 'Emulation.clearGeolocationOverride', {}, errors);
        applied['geolocation'] = null;
      } else if (params['geolocation'] && typeof params['geolocation'] === 'object') {
        const geolocation = asRecord(params['geolocation']);
        const latitude = Number(geolocation['latitude']);
        const longitude = Number(geolocation['longitude']);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw badArg('geolocation 需要 latitude/longitude');
        const accuracy = finiteNumber(geolocation['accuracy'], 1);
        await this.trySend(tabId, 'Emulation.setGeolocationOverride', {
          latitude,
          longitude,
          accuracy: accuracy > 0 ? accuracy : 1,
        }, errors);
        applied['geolocation'] = { latitude, longitude };
      }
    } finally {
      if (!released) {
        this.client.release(tabId, 'emulate');
        released = true;
      }
    }
    return {
      ok: errors.length === 0,
      applied,
      errors,
      tabId,
      mode: 'cdp-emulation',
      at: this.now(),
    };
  }

  /**
   * reset：清掉设备指标/地理/时区/语言/UA，并实测恢复后的视口三要素。
   *
   * 与旧实现的差别（task-12 回归修复）：
   * - 不再在正常路径发 `setDeviceMetricsOverride({width:0,height:0,...})`：CDP 约定 0 表示取消覆盖，
   *   但部分 Edge 版本会把它当成一次新的（0 尺寸）覆盖，留下窗口视口 4px 级偏差；
   *   只在 clear 后实测仍卡在旧视口时，才用「快照真实视口」覆盖一次兜底（方向相反：恢复而不是清零）。
   * - 恢复判定同时比较 innerWidth/innerHeight/dpr（旧实现只看 width，dpr/height 残留不会被发现）。
   * - 返回 before/after 实测三要素 + restored 布尔，供 E2E/诊断核对（不谎报）。
   */
  async reset(tabId: number): Promise<Record<string, unknown>> {
    await this.client.acquire(tabId, 'emulate');
    const errors: string[] = [];
    const MAX_ATTEMPTS = 4;
    try {
      const before = await this.metrics(tabId);
      const snapshot = this.snapshots.get(tabId) ?? before;
      // DPR 是覆盖的主要标记；窗口 chrome/合成器重排可能让真实视口出现几像素漂移，不作为残留判据。
      const VIEWPORT_DRIFT_TOLERANCE_PX = 8;
      const driftOf = (probe: ViewportSnapshot | null): { width: number; height: number } | null => {
        if (!probe || !snapshot) return null;
        return {
          width: probe.innerWidth - snapshot.innerWidth,
          height: probe.innerHeight - snapshot.innerHeight,
        };
      };
      const restoredTarget = (probe: ViewportSnapshot | null): boolean => {
        if (!probe) return false;
        if (!snapshot) return true;
        const drift = driftOf(probe);
        return Math.abs(probe.dpr - snapshot.dpr) <= 0.01
          && Math.abs(drift?.width ?? 0) <= VIEWPORT_DRIFT_TOLERANCE_PX
          && Math.abs(drift?.height ?? 0) <= VIEWPORT_DRIFT_TOLERANCE_PX;
      };
      let after: ViewportSnapshot | null = null;
      let cleared = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        // 只清覆盖，不追加零尺寸覆盖（见方法注释）。
        await this.trySend(tabId, 'Emulation.clearDeviceMetricsOverride', {}, errors);
        await this.trySend(tabId, 'Emulation.clearGeolocationOverride', {}, errors);
        await this.trySend(tabId, 'Network.setUserAgentOverride', { userAgent: '' }, errors);
        await this.trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }, errors);
        await this.trySend(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' }, errors);
        await this.trySend(tabId, 'Emulation.setLocaleOverride', { locale: '' }, errors);
        await this.sleep(120);
        after = await this.metrics(tabId);
        // 判定「覆盖已消失」：恢复到快照附近，或至少视口/DPR 与本轮 reset 前不同。
        cleared = restoredTarget(after)
          || (after !== null && before !== null && (after.innerWidth !== before.innerWidth || Math.abs(after.dpr - before.dpr) > 0.01));
        if (cleared) break;
      }
      // 兜底：clear 成功但渲染进程仍卡在仿真尺寸 → 用仿真前的真实视口覆盖一次（恢复语义）。
      if (!cleared && snapshot && before && after && after.innerWidth === before.innerWidth) {
        await this.trySend(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: snapshot.innerWidth,
          height: snapshot.innerHeight,
          deviceScaleFactor: snapshot.dpr || 1,
          mobile: false,
        }, errors);
        await this.sleep(150);
        after = await this.metrics(tabId);
      }
      const restored = restoredTarget(after);
      this.snapshots.delete(tabId);
      return {
        ok: true,
        reset: true,
        tabId,
        restored,
        viewportDrift: driftOf(after),
        innerWidthBefore: before ? before.innerWidth : null,
        innerWidthAfter: after ? after.innerWidth : null,
        innerHeightBefore: before ? before.innerHeight : null,
        innerHeightAfter: after ? after.innerHeight : null,
        dprBefore: before ? before.dpr : null,
        dprAfter: after ? after.dpr : null,
        restoredTo: snapshot ? snapshot.innerWidth : null,
        errors,
        mode: 'cdp-emulation',
      };
    } finally {
      this.client.release(tabId, 'emulate');
    }
  }

  /** tab 关闭/会话回收：丢弃快照并尽力撤销覆盖。 */
  async forgetTab(tabId: number): Promise<void> {
    const id = Number(tabId);
    this.snapshots.delete(id);
    await this.client.send(id, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined);
  }

  private async trySend(tabId: number, method: string, params: Record<string, unknown>, errors: string[]): Promise<void> {
    try {
      await this.client.send(tabId, method, params);
    } catch (error) {
      errors.push(method + ': ' + errorText(error));
    }
  }
}

/** 便捷工厂。 */
export function createEmulateService(options: EmulateServiceOptions): EmulateService {
  return new EmulateService(options);
}
