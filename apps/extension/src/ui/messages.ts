// src/ui/messages.ts —— 扩展子页面 ↔ background 的类型化消息面（`bb.ui`）。
//
// 为什么需要它：MV3 里扩展页面**收不到内容脚本**，而 `bb.rpc` 只能转发 daemon 的六个
// 只读方法（WS 白名单）。子页面要做的动作（整页截图、长截图恢复、调试采集、规则面板）
// 都是扩展自身的命令，因此需要一条独立、可校验、可审计的消息面：
//
// - 单一入口 `{type:'bb.ui', op, params}`；op 白名单硬校验（未知 op → E_BAD_ARG）；
// - 每个 op 都在 background 侧映射到**已有的**服务（ScreenshotService/DebugService/RuleService/
//   RpcRegistry），页面侧不重复实现业务逻辑，也不直接碰 chrome.* 敏感 API；
// - 返回统一信封 `{ok:true,result}` / `{ok:false,code,message,data}`，页面据此渲染错误；
// - 人工设置写入（settings.write）单独放行 HUMAN_ONLY_KEYS：安全边界是"daemon/CLI 不可改"，
//   扩展设置页就是用户本人，这是它与 `settings.set` 的关键差别。

export const UI_MESSAGE_TYPE = 'bb.ui';

export interface UiRequest {
  type: 'bb.ui';
  op: string;
  params: Record<string, unknown>;
}

export type UiReply =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; data?: unknown };

/** 页面可调用的 op（白名单；新增 op 必须同时在这里登记）。 */
export const UI_OPS: readonly string[] = Object.freeze([
  'state',
  'settings.read',
  'settings.write',
  'diagnostics',
  'tabs',
  'capture',
  'longshot.recover',
  'longshot.list',
  'debug.start',
  'debug.stop',
  'debug.current',
  'debug.performance',
  'debug.rule.add',
  'debug.rule.list',
  'debug.rule.clear',
  'audit.list',
  'preview.store',
  'preview.load',
  // M-C 第八批：视频录制页（record.html selftest / 手动操作）
  'video.start',
  'video.stop',
  'video.status',
  'video.discard',
  // M-C 第八批：调试页重放面板（debug.html selftest=replay）
  'network.replay',
]);

const UI_OP_SET: ReadonlySet<string> = new Set(UI_OPS);

/** 人工设置可写键（与 src/runtime/settings 的写入口径一致）。 */
export const UI_WRITABLE_SETTINGS: readonly string[] = Object.freeze([
  'controlHint',
  'recordOverlay',
  'borrowRequireConfirm',
  'allowHelp',
  'language',
  'daemonPort',
  'instanceLabel',
  'pageGuard',
  'longShotMode',
  'daemonUrl',
  'daemonToken',
  'daemonCode',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 解析页面消息：非 `bb.ui` 返回 null（交给其它消息处理器），非法形状返回结构化失败。 */
export function parseUiMessage(raw: unknown): UiRequest | null | { ok: false; code: string; message: string; data?: unknown } {
  if (!isRecord(raw) || raw.type !== UI_MESSAGE_TYPE) return null;
  const op = typeof raw.op === 'string' ? raw.op.trim() : '';
  if (!op) return { ok: false, code: 'E_BAD_ARG', message: 'bb.ui 消息缺少 op' };
  if (op.length > 64) return { ok: false, code: 'E_BAD_ARG', message: 'bb.ui op 过长' };
  if (!UI_OP_SET.has(op)) {
    return { ok: false, code: 'E_BAD_ARG', message: '未知的 bb.ui op：' + op, data: { op, allowlist: [...UI_OPS] } };
  }
  if (raw.params !== undefined && raw.params !== null && !isRecord(raw.params)) {
    return { ok: false, code: 'E_BAD_ARG', message: 'bb.ui params 必须是对象' };
  }
  return { type: UI_MESSAGE_TYPE, op, params: isRecord(raw.params) ? raw.params : {} };
}

export interface TargetTabInfo {
  tabId: number;
  url: string;
  title: string;
  windowId: number | null;
  active: boolean;
}

/** background 侧依赖（全部注入，单测可完全离线驱动消息面）。 */
export interface UiHandlerDeps {
  status(): Promise<Record<string, unknown>>;
  readSettings(): Promise<Record<string, unknown>>;
  writeSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  diagnostics(): Promise<Record<string, unknown>>;
  targetTabs(): Promise<TargetTabInfo[]>;
  capture(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  longshotRecover(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  longshotList(): Promise<Record<string, unknown>>;
  debugStart(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugStop(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugCurrent(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugPerformance(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugRuleAdd(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugRuleList(): Promise<Record<string, unknown>>;
  debugRuleClear(): Promise<Record<string, unknown>>;
  // 视频录制页（M-C 第八批）：页面只经 background 服务，不直接碰 chrome.tabCapture/离屏文档。
  videoStart(params: Record<string, unknown>): Promise<unknown>;
  videoStop(params: Record<string, unknown>): Promise<unknown>;
  videoStatus(params: Record<string, unknown>): Promise<unknown>;
  videoDiscard(params: Record<string, unknown>): Promise<unknown>;
  networkReplay(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  auditList(params: Record<string, unknown>): Promise<unknown>;
}

const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;

function errorOf(error: unknown): UiReply {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    const data = (error as { data?: unknown }).data;
    if (typeof code === 'string' && code) {
      return data === undefined
        ? { ok: false, code, message: typeof message === 'string' && message ? message : code }
        : { ok: false, code, message: typeof message === 'string' && message ? message : code, data };
    }
    if (error instanceof Error && error.message) return { ok: false, code: 'E_UI_FAILED', message: error.message };
  }
  return { ok: false, code: 'E_UI_FAILED', message: String(error) };
}

function requireTabId(value: unknown): number {
  const tabId = Number(value);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw Object.assign(new Error('该操作需要正整数 tabId'), { code: 'E_BAD_ARG', data: { tabId: value ?? null } });
  }
  return tabId;
}

/**
 * 页面消息处理器：`handle()` 返回 null 表示"不是 bb.ui 消息"，
 * 其余情况一定返回结构化信封（永不抛异常）。
 */
export class UiMessageHandler {
  private readonly deps: UiHandlerDeps;
  private readonly previews = new Map<string, { dataUrl: string; width: number | null; height: number | null; at: number }>();
  private readonly now: () => number;

  constructor(deps: UiHandlerDeps, options: { now?: () => number } = {}) {
    this.deps = deps;
    this.now = options.now ?? Date.now;
  }

  /** 最近预览（诊断/测试用）。 */
  previewCount(): number {
    return this.previews.size;
  }

  async handle(raw: unknown): Promise<UiReply | null> {
    const parsed = parseUiMessage(raw);
    if (parsed === null) return null;
    if ('ok' in parsed && parsed.ok === false) return parsed as UiReply;
    const request = parsed as UiRequest;
    try {
      const result = await this.dispatch(request.op, request.params);
      return { ok: true, result };
    } catch (error) {
      return errorOf(error);
    }
  }

  private async dispatch(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'state':
        return this.state();
      case 'settings.read':
        return { ok: true, settings: await this.deps.readSettings() };
      case 'settings.write':
        return this.writeSettings(params);
      case 'diagnostics':
        return this.deps.diagnostics();
      case 'tabs':
        return { ok: true, tabs: await this.deps.targetTabs() };
      case 'capture': {
        const tabId = requireTabId(params.tabId);
        const shot = await this.deps.capture({ ...params, tabId });
        return { ok: true, ...shot };
      }
      case 'longshot.recover':
        return this.deps.longshotRecover(params);
      case 'longshot.list':
        return this.deps.longshotList();
      case 'debug.start':
        return this.deps.debugStart({ tabId: requireTabId(params.tabId) });
      case 'debug.stop':
        return this.deps.debugStop({ tabId: requireTabId(params.tabId) });
      case 'debug.current':
        return this.deps.debugCurrent({ tabId: requireTabId(params.tabId) });
      case 'debug.performance':
        return this.deps.debugPerformance({ tabId: requireTabId(params.tabId) });
      case 'debug.rule.add':
        return this.deps.debugRuleAdd({ tabId: requireTabId(params.tabId), rule: isRecord(params.rule) ? params.rule : null });
      case 'debug.rule.list':
        return this.deps.debugRuleList();
      case 'debug.rule.clear':
        return this.deps.debugRuleClear();
      case 'video.start':
        return this.deps.videoStart(params);
      case 'video.stop':
        return this.deps.videoStop(params);
      case 'video.status':
        return this.deps.videoStatus(params);
      case 'video.discard':
        return this.deps.videoDiscard(params);
      case 'network.replay': {
        const tabId = requireTabId(params.tabId);
        return this.deps.networkReplay({ ...params, tabId });
      }
      case 'audit.list':
        return { ok: true, ...(await this.deps.auditList({ limit: clampLimit(params.limit, 200) })) as Record<string, unknown> };
      case 'preview.store':
        return this.storePreview(params);
      case 'preview.load':
        return this.loadPreview(params);
      default:
        throw Object.assign(new Error('未知的 bb.ui op：' + op), { code: 'E_BAD_ARG' });
    }
  }

  private async state(): Promise<Record<string, unknown>> {
    const [status, settings, diagnostics] = await Promise.all([
      this.deps.status(),
      this.deps.readSettings(),
      this.deps.diagnostics(),
    ]);
    return { ok: true, status, settings, diagnostics, at: this.now() };
  }

  private async writeSettings(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const patch = isRecord(params.patch) ? params.patch : params;
    const accepted: Record<string, unknown> = {};
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'patch') continue;
      if (!UI_WRITABLE_SETTINGS.includes(key)) {
        rejected.push(key);
        continue;
      }
      accepted[key] = value;
    }
    if (!Object.keys(accepted).length) {
      throw Object.assign(new Error('settings.write 至少给一个可写键：' + UI_WRITABLE_SETTINGS.join(',')), {
        code: 'E_BAD_ARG',
        data: { rejected },
      });
    }
    const result = await this.deps.writeSettings(accepted);
    return { ok: true, ...result, rejected };
  }

  private storePreview(params: Record<string, unknown>): Record<string, unknown> {
    const dataUrl = typeof params.dataUrl === 'string' ? params.dataUrl : '';
    if (!dataUrl.startsWith('data:image/')) {
      throw Object.assign(new Error('preview.store 需要 data:image/ 开头的 dataUrl'), { code: 'E_BAD_ARG' });
    }
    if (dataUrl.length > MAX_PREVIEW_BYTES) {
      throw Object.assign(new Error('预览图过大（上限 24MB base64）'), { code: 'E_BAD_ARG', data: { bytes: dataUrl.length } });
    }
    const id = 'pv_' + this.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    this.previews.set(id, {
      dataUrl,
      width: Number.isInteger(Number(params.width)) ? Number(params.width) : null,
      height: Number.isInteger(Number(params.height)) ? Number(params.height) : null,
      at: this.now(),
    });
    // 只保留最近 4 张：预览是瞬时数据，不做长期缓存。
    if (this.previews.size > 4) {
      const oldest = [...this.previews.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.previews.delete(oldest[0]);
    }
    return { ok: true, previewId: id, width: params.width ?? null, height: params.height ?? null };
  }

  private loadPreview(params: Record<string, unknown>): Record<string, unknown> {
    const id = typeof params.previewId === 'string' ? params.previewId : '';
    const found = this.previews.get(id);
    if (!found) throw Object.assign(new Error('预览图不存在或已过期：' + id), { code: 'E_NOT_FOUND', data: { previewId: id } });
    return { ok: true, previewId: id, dataUrl: found.dataUrl, width: found.width, height: found.height };
  }
}

function clampLimit(value: unknown, fallback: number): number {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}
