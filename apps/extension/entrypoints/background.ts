import { browser } from 'wxt/browser';
import { buildStatus, parseMessage, type BridgeRpcMessage, type ExtensionReply } from '@/shared/messages';
import { PROTOCOL_VERSION } from '@/shared/constants';
import { normalizeSettings } from '@/shared/settings';
import { errorPayloadOf } from '@/src/daemon/errors';
import { DaemonSocket } from '@/src/daemon/ws';
import { DaemonConnector } from '@/src/daemon/connector';
import { explicitSettingsPort, loadPortsAsset, PORTS_ASSET_PATH, resolvePortCandidates } from '@/src/daemon/discovery';
import type { DaemonCommandFrame } from '@/src/daemon/ws';
import { RpcRegistry } from '@/src/rpc/registry';
import { RpcMethodError } from '@/src/rpc/registry';
import { RefRegistry } from '@/src/refs/registry';
import { ActionRegistry } from '@/src/actions/registry';
import { ExtendedActionRegistry } from '@/src/actions/extended';
import { createContentTransport } from '@/src/content/transport';
import { CommandRouter } from '@/src/runtime/router';
import { createRuntimeCommands, type BrowserApiLike } from '@/src/runtime/commands';
import { COOPERATION_METHODS, CooperationRuntime, createCooperationCommands } from '@/src/runtime/cooperation';
import { createChromeRecordService, type ChromeRecordApi } from '@/src/record/chrome-deps';
import { RecordMessageHandler } from '@/src/record/messages';
import { sharedTrustedInputClock } from '@/src/actions/trusted-input';
import { VideoService, type TabCaptureApi, type VideoCdp } from '@/src/video/service';
import type { VideoStartParams, VideoTabInfo } from '@/src/video/types';
import { TAKEOVER_SUPPRESS_OP } from '@/src/content/takeover-overlay';
import type { ContentOp } from '@/src/content/protocol';
import { createOffscreenPort, createStorageAdapter, probeBrowserStorage, type OffscreenApiLike, type StorageAreaLike } from '@/src/video/runtime';
import { createVideoStore, resolveIndexedDb } from '@/src/video/store';
import { createTabCommands } from '@/src/runtime/tab-commands';
import { SettingsStore } from '@/src/runtime/settings';
import { daemonSettingsView } from '@/src/runtime/settings';
import { TabActivityRegistry, TabAliasStore, TabPolicyStore } from '@/src/runtime/tab-state';
import { createBrowserCanvasCodec } from '@/src/capture/codec';
import { ScreenshotService } from '@/src/capture/screenshot';
import type { CaptureTabsApi } from '@/src/capture/screenshot';
import { NetworkService } from '@/src/network/service';
import type { ScriptingApi } from '@/src/scripting/evaluate';
import { ReceiptStore } from '@/src/actions/receipts';
import { FrameObservationService } from '@/src/frames/service';
import type { WebNavigationApi } from '@/src/frames/service';
import { DownloadService, UploadService } from '@/src/native/service';
import type { DownloadsApi } from '@/src/native/service';
import { DialogService } from '@/src/dialog/service';
import { DebugService, OperationTimeline } from '@/src/debug/service';
import { RuleService } from '@/src/debug/rules';
import type { DnrRulesApi } from '@/src/debug/service';
import { createCdpClient, createFrameCdpService } from '@/src/cdp';
import { FetchController } from '@/src/network/fetch';
import { TraceService } from '@/src/debug/trace';
import { EmulateService } from '@/src/debug/emulate';
import { PdfService } from '@/src/capture/pdf';
import { InputService } from '@/src/scripting/input';
import { PierceService } from '@/src/scripting/pierce';
import { createFileInputService } from '@/src/actions/file-input';
import { createBackendNodeLocator } from '@/src/actions/backend-locator';
import { WebMcpService } from '@/src/webmcp/service';
import { UiPageService } from '@/src/ui/open';
import type { UiTabsApi } from '@/src/ui/open';
import { uiDiagnostics } from '@/src/ui/catalog';
import { UiMessageHandler } from '@/src/ui/messages';
import { portFromDaemonUrl } from '@/shared/settings';

const startedAt = Date.now();
const LAST_PORT_KEY = 'bb.lastPort';

/** 浏览器名（hello 里的 browser 字段）：只需与 daemon 的展示/选择逻辑对齐。 */
function detectBrowser(): string {
  const ua = (globalThis.navigator && typeof navigator.userAgent === 'string') ? navigator.userAgent : '';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\//i.test(ua)) return 'chrome';
  return 'chromium';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 后台 service worker（架构路线 M-C 第三批：截图/网络只读面 + 扩展动作面）。
 *
 * 组成：
 * - 连接：DaemonConnector 按端口候选（设置 → 上次端口 → 产物里的端口锚点 → 默认表）
 *   顺序建 WS；DaemonSocket 负责 hello/心跳/重连；
 * - 只读转发：`bb.rpc` 仍走 RpcRegistry 的只读白名单 + feature gate；
 * - 动作面：daemon 的 `cmd` 帧交给 CommandRouter：
 *   - 第二批方法（observe/click/fill/read/select/get-html/evaluate）→ ActionRegistry；
 *   - 第三批方法（scroll-to/hover/focus/press/wheel/blur/drag/click-point/snapshot/
 *     extract 家族 / wait-* / cancel / request-help / cooperate.*）→ ExtendedActionRegistry；
 *   - screenshot（可见区域/整页拼接/元素/区域/差分/流式/标注）→ ScreenshotService；
 *   - network.start/stop/list/detail → NetworkService（PerformanceResourceTiming 只读面）；
 *   - window/tab/navigate/settings + tab.alias/tab.policy/tab.cleanup → runtime commands；
 * - 策略：per-tab readOnly / allowedOrigins 在动作派发前强制（页面收不到命令）；
 * - 事件：daemon 单向事件进 RpcEventDispatcher，供 debug 页/弹窗订阅与回看。
 *
 * 硬约束：不使用 chrome.debugger；输入是合成事件（证据 trusted:false），
 * evaluate 走 chrome.scripting 的页面主世界（不是隔离世界，也不是 CDP）。
 */
export default defineBackground(() => {
  const version = browser.runtime.getManifest().version;

  // feature gate 的对端是扩展自身协议投影：1.8 的旧运行时会被明确拒绝 1.9 特性。
  const registry = new RpcRegistry({ peer: { protocol: PROTOCOL_VERSION } });
  const refs = new RefRegistry();
  const content = createContentTransport(browser as unknown as Parameters<typeof createContentTransport>[0]);
  const now = (): number => Date.now();
  const settings = new SettingsStore(browser.storage.local);
  const policyStorage = browser.storage.local as unknown as { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  const policies = new TabPolicyStore(policyStorage, now);
  const aliases = new TabAliasStore(policyStorage);
  const activity = new TabActivityRegistry(now);

  // 协作 hold（人工接管）闸门：held 期间所有变更动作在派发前被拒绝（E_SESSION_PAUSED）。
  const holds = new Set<number>();

  /** 动作授权：per-tab 策略 + 协作 hold 闸门（任一拒绝都不派发页面命令）。 */
  function authorizeAction(tabId: number, method: string): { ok: true } | { ok: false; code: string; message: string; data?: unknown } {
    const policy = policies.authorize(tabId, method);
    if (!policy.ok) return policy;
    if (holds.has(Number(tabId))) {
      return {
        ok: false,
        code: 'E_SESSION_PAUSED',
        message: '人工接管中（cooperate hold）：Agent 动作被拒绝，先 cooperate hold --release 或等待 handback',
        data: { held: true, reason: 'cooperate-hold', method },
      };
    }
    return { ok: true };
  }

  const extensionScripting = (globalThis as unknown as { chrome?: { scripting?: unknown } }).chrome?.scripting
    ?? (browser as unknown as { scripting?: unknown }).scripting
    ?? null;
  const receipts = new ReceiptStore({ now });
  // 共享一个 CDP 客户端：frames 的 owner 投影与 debug/Fetch/PDF/trace/emulate/input 共用同一 attach，
  // 避免同 tab 二次 attach 触发 E_CDP_BUSY 把 OOPIF（23p3/7/8/9）降级回 frame-projected。
  const cdpClient = createCdpClient({ idleDetachMs: 10_000 });
  // CDP 输入/节点定位/closed-shadow pierce：动作面（trusted/stableRef/大文件）与 observe 共用。
  const inputService = new InputService({ client: cdpClient });
  const pierceService = new PierceService({ client: cdpClient, input: inputService });
  const backendLocator = createBackendNodeLocator({ client: cdpClient });
  const fileInputs = createFileInputService({ client: cdpClient });
  const frames = new FrameObservationService({
    content,
    navigation: (((globalThis as unknown as { chrome?: { webNavigation?: unknown } }).chrome?.webNavigation)
      ?? (browser as unknown as { webNavigation?: unknown }).webNavigation) as WebNavigationApi,
    cdp: createFrameCdpService({ client: cdpClient }),
    now,
  });
  const timeline = new OperationTimeline();
  const network = new NetworkService({
    content,
    // 资源计时条目 → commandId 的时间窗近似归因（不是 CDP 的精确关联，字段里写明）。
    commandResolver: (startedAt: number) => timeline.commandFor(startedAt),
    // network.replay 在页面 MAIN world 重放请求（与 evaluate 共用 scripting 包装）。
    scripting: extensionScripting ? ({ scripting: extensionScripting } as unknown as ScriptingApi) : null,
  });
  const actions = new ActionRegistry({
    content,
    refs,
    receipts,
    frames,
    // scripting 权限在 manifest 里；evaluateInMainWorld 需要 { scripting: <namespace> } 包装。
    scripting: extensionScripting ? ({ scripting: extensionScripting } as unknown as ScriptingApi) : null,
    authorize: (tabId, method) => authorizeAction(tabId, method),
    // trusted/stableRef/大文件/closed-shadow：CDP 原生路由（不可用/定位失败回退内容脚本）。
    input: inputService,
    backend: backendLocator,
    pierce: {
      clickRefNode: (tabId, backendNodeId) => pierceService.clickRefNode(tabId, backendNodeId),
      readRefNode: (tabId, backendNodeId) => pierceService.readRefNode(tabId, backendNodeId),
    },
  });

  const codec = createBrowserCanvasCodec();
  const screenshots = new ScreenshotService({
    api: browser as unknown as CaptureTabsApi,
    windows: (browser as unknown as { windows?: { update(windowId: number, props: Record<string, unknown>): Promise<unknown> } }).windows,
    content,
    codec,
  });

  const extended = new ExtendedActionRegistry({
    content,
    refs,
    receipts,
    captures: {
      consume: (id) => screenshots.consumeCapture(id),
    },
    readSettings: () => settings.read(),
    authorize: (tabId, method) => authorizeAction(tabId, method),
    input: inputService,
    backend: backendLocator,
    control: {
      isHeld: (tabId: number) => holds.has(Number(tabId)),
      setHeld: (tabId: number, held: boolean) => {
        if (held) holds.add(Number(tabId));
        else holds.delete(Number(tabId));
      },
    },
  });

  // 人工协作运行时（23u/23x/24b/24b2）：human-watch 状态机 + handback + 人工协助卡片。
  const scriptingApi = extensionScripting as
    | { executeScript(injection: Record<string, unknown>): Promise<Array<{ result?: unknown }>> }
    | null;
  const cooperation = new CooperationRuntime({
    inject: async (tabId, func, args) => {
      if (!scriptingApi || typeof scriptingApi.executeScript !== 'function') return null;
      const results = await scriptingApi.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args: args ?? [] });
      const first = Array.isArray(results) ? results[0] : null;
      return first && 'result' in first ? first.result : null;
    },
    dispatchExtended: (method, params, options) => extended.dispatch(method, params, options),
    readSettings: () => settings.read(),
    control: {
      isHeld: (tabId) => holds.has(Number(tabId)),
      setHeld: (tabId, held) => {
        if (held) holds.add(Number(tabId));
        else holds.delete(Number(tabId));
      },
    },
    activateTab: async (tabId) => {
      const tab = await browser.tabs.get(tabId);
      if (tab && Number.isInteger(tab.windowId)) await browser.windows.update(Number(tab.windowId), { focused: true });
      await browser.tabs.update(tabId, { active: true });
    },
  });

  // 接管浮层显隐（M-C 第八批 C）：扩展侧没有 daemon 的 session 状态，最小语义=该 tab 收到过
  // 会话命令即视为“接管中”；controlHint=false 时不显示（与 JS 0.3.0 语义一致）。
  const takeoverShownTabs = new Set<number>();
  const setTakeoverOverlay = async (tabId: number, visible: boolean): Promise<void> => {
    try {
      const reply = await content.request(tabId, {
        type: 'bb.content',
        requestId: 'takeover-' + (visible ? 'show-' : 'hide-') + String(tabId),
        op: TAKEOVER_SUPPRESS_OP as unknown as ContentOp,
        params: { visible },
      }, { timeoutMs: 1_500 });
      if (reply.ok === true) {
        if (visible) takeoverShownTabs.add(tabId);
        else takeoverShownTabs.delete(tabId);
      }
    } catch {
      // 页面没有内容脚本/已关闭：忽略（不影响命令本身）。
    }
  };
  const ensureTakeoverOverlay = async (tabId: number): Promise<void> => {
    if (takeoverShownTabs.has(tabId)) return;
    try {
      const current = await settings.read();
      if ((current as { controlHint?: unknown }).controlHint === false) return;
    } catch {
      return;
    }
    await setTakeoverOverlay(tabId, true);
  };
  /** 强制重装（幂等）：跨导航后跟踪集合可能过期，evaluate 断言前用这个。 */
  const showTakeoverOverlay = async (tabId: number): Promise<void> => {
    try {
      const current = await settings.read();
      if ((current as { controlHint?: unknown }).controlHint === false) return;
    } catch {
      return;
    }
    await setTakeoverOverlay(tabId, true);
  };

  // 操作录制（M-C 第八批）：事件模型/持久化/Trace v3 导出；页面录制器由 chrome-deps 自注入。
  const recordService = createChromeRecordService(browser as unknown as ChromeRecordApi, {
    now,
    // 20d10 关键：Agent 可信输入时钟 → 页面事件 actor 归因（默认过滤 Agent 动作）。
    agentInputAt: (tabId) => sharedTrustedInputClock.peek(tabId).last?.at ?? 0,
    // stop 时补一次最终观察（失败允许返回 null，不影响落库）。
    observe: async (tabId) => {
      try {
        const snap = await actions.dispatch('observe', { tabId, probeHover: false }) as Record<string, unknown>;
        return {
          text: String(snap.observation ?? ''),
          url: String(snap.url ?? ''),
          title: String(snap.title ?? ''),
          refs: Number(snap.refs) || 0,
          at: Date.now(),
        };
      } catch {
        return null;
      }
    },
  });
  const recordMessages = new RecordMessageHandler(recordService, {
    extensionId: browser.runtime.id,
    extensionOrigin: (browser.runtime as unknown as { getURL(path: string): string }).getURL(''),
  });
  // 20d3/20d5：tab/window 焦点切换记为 boundary 步骤；20d4：导航后重新注入录制器。
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void recordService.recordTabSwitch(tabId);
  });
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (tab?.id != null) void recordService.recordTabSwitch(tab.id);
    })();
  });
  browser.webNavigation.onCommitted.addListener((details) => {
    void recordService.reattach(details.tabId, { overlay: details.frameId === 0 });
    // 24d：导航后接管浮层会随旧文档消失；主文档提交后重装（多次重试覆盖内容脚本就绪时序）。
    if (details.frameId === 0) {
      takeoverShownTabs.delete(details.tabId); // 旧文档的“已显示”跟踪已失效
      for (const delay of [200, 800, 1600]) {
        setTimeout(() => { void ensureTakeoverOverlay(details.tabId).catch(() => undefined); }, delay);
      }
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    takeoverShownTabs.delete(tabId);
  });

  // 视频录制（M-C 第八批 B）：tabCapture → offscreen 编码 MP4（CDP 截帧兜底）+ IndexedDB 分片。
  const videoService = new VideoService({
    tabs: {
      get: async (tabId): Promise<VideoTabInfo> => {
        const tab = await browser.tabs.get(tabId);
        return {
          id: tab.id ?? tabId,
          url: tab.url ?? '',
          title: tab.title ?? '',
          ...(Number.isInteger(tab.windowId) ? { windowId: Number(tab.windowId) } : {}),
        };
      },
    },
    port: createOffscreenPort({
      runtime: browser.runtime as unknown as Parameters<typeof createOffscreenPort>[0]['runtime'],
      offscreen: (browser as unknown as { offscreen: OffscreenApiLike }).offscreen,
      log: (message) => console.info('[video]', message),
    }),
    store: createVideoStore({ indexedDb: resolveIndexedDb() }),
    storage: createStorageAdapter(browser.storage.local as unknown as StorageAreaLike),
    tabCapture: (browser as unknown as { tabCapture?: TabCaptureApi }).tabCapture,
    cdp: cdpClient as unknown as VideoCdp,
    probeStorage: (backend) => probeBrowserStorage(backend),
    log: (message) => console.info('[video]', message),
  });
  videoService.attach();

  const uploads = new UploadService({ content, now, files: fileInputs });
  const downloads = new DownloadService({
    content,
    downloads: (((globalThis as unknown as { chrome?: { downloads?: unknown } }).chrome?.downloads)
      ?? (browser as unknown as { downloads?: unknown }).downloads) as DownloadsApi,
    tabs: browser.tabs as unknown as { update(tabId: number, props: Record<string, unknown>): Promise<unknown> },
    now,
  });
  const dialogs = new DialogService({
    content,
    scripting: extensionScripting ? ({ scripting: extensionScripting } as unknown as ScriptingApi) : null,
    now,
  });
  const debug = new DebugService({
    content,
    network,
    timeline,
    scripting: extensionScripting ? ({ scripting: extensionScripting } as unknown as ScriptingApi) : null,
    rules: (((globalThis as unknown as { chrome?: { declarativeNetRequest?: unknown } }).chrome?.declarativeNetRequest)
      ?? (browser as unknown as { declarativeNetRequest?: unknown }).declarativeNetRequest) as DnrRulesApi,
    cdp: { client: cdpClient },
    now,
  });
  const ruleService = new RuleService({
    rules: (((globalThis as unknown as { chrome?: { declarativeNetRequest?: unknown } }).chrome?.declarativeNetRequest)
      ?? (browser as unknown as { declarativeNetRequest?: unknown }).declarativeNetRequest) as never,
    now,
  });
  // CDP Fetch 通道：fulfill/modify 由 Fetch 真正拦截（block 仍走 DNR）；规则增删启停即同步 Fetch。
  const fetchController = new FetchController({
    client: cdpClient,
    resolveRules: () => ruleService.rulesForFetch(),
    onHit: (_tabId, id) => ruleService.recordHit(id),
  });
  ruleService.attachFetch(fetchController);
  const traceService = new TraceService({ client: cdpClient });
  const emulateService = new EmulateService({ client: cdpClient });
  const pdfService = new PdfService({ client: cdpClient });
  const webmcp = new WebMcpService({
    scripting: extensionScripting ? ({ scripting: extensionScripting } as unknown as ScriptingApi) : null,
    now,
  });

  // 子页面服务（ui.open）：页面清单单源 + chrome.tabs.create。
  const getRuntimeUrl = (browser.runtime as unknown as { getURL(path: string): string }).getURL;
  const resolveRuntimeUrl = (path: string): string => getRuntimeUrl.call(browser.runtime, path);
  const uiPages = new UiPageService({
    api: browser as unknown as UiTabsApi,
    resolveUrl: resolveRuntimeUrl,
    now,
  });

  /** 只读转发到 daemon（bb.ui 的 audit.list 用；复用 bb.rpc 的白名单/feature gate）。 */
  async function forwardReadonly(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = await ensureConnection();
    const reply = await registry.forward(socket, { method, params });
    if (!reply.ok) {
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
    }
    return reply.result;
  }

  // 子页面消息面（bb.ui）：页面 → background 服务；未知 op 由处理器结构化拒绝。
  const uiMessages = new UiMessageHandler({
    status: async () => {
      const tabs = await browser.tabs.query({});
      return { ...buildStatus(tabs.length, startedAt, version) };
    },
    readSettings: async () => (await settings.read()) as unknown as Record<string, unknown>,
    writeSettings: async (patch) => {
      const result = await settings.writeHuman(patch);
      return {
        settings: daemonSettingsView(result.settings).settings,
        applied: result.applied,
        ignored: result.ignored,
      };
    },
    diagnostics: async () => diagnosticsPayload(),
    targetTabs: () => uiPages.targetTabs(),
    capture: async (params) => {
      const shot = await screenshots.takeScreenshot(params, { timeoutMs: 180_000, requestId: 'ui-capture' });
      // 页面只需要预览与统计字段：不把内部 diff/manifest 结构塞进页面消息。
      return {
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        tiled: shot.tiled,
        dpr: shot.dpr,
        fixedTop: shot.fixedTop,
        fixedFooter: shot.fixedFooter,
        fixedBands: shot.fixedBands,
        stale: shot.stale,
        stale_attempts: shot.stale_attempts,
        segmented: shot.segmented === true,
        segment_count: shot.segment_count ?? null,
        longshot_id: shot.longshot_id ?? null,
        tiles_persisted: shot.tiles_persisted ?? 0,
        via: shot.via ?? 'capture-visible-tab',
        truncated: shot.truncated === true,
      };
    },
    longshotRecover: (params) => screenshots.longshotRecover(params),
    longshotList: () => screenshots.longshotManifests(),
    debugStart: (params) => debug.start(params),
    debugStop: (params) => debug.stop(params),
    debugCurrent: (params) => debug.current(params),
    debugPerformance: (params) => debug.performance(params),
    debugRuleAdd: (params) => ruleService.add(params.rule),
    debugRuleList: () => ruleService.list(),
    debugRuleClear: () => ruleService.clear(),
    // 视频录制页（record.html）的真实 selftest 链路（M-C 第八批 B）。
    videoStart: (params) => videoService.start(params as VideoStartParams),
    videoStop: (params) => videoService.stop(params),
    videoStatus: (params) => videoService.status(params),
    videoDiscard: (params) => videoService.discard(params),
    // 33d：调试页重放面板（debug.html?selftest=replay）经页面消息调 network.replay。
    networkReplay: (params) => network.replay(params),
    auditList: (params) => forwardReadonly('audit.list', params),
  }, { now });

  /** doctor `extension-ui` 用的诊断载荷（页面清单单源）。 */
  function diagnosticsPayload(): Record<string, unknown> {
    return {
      ...uiDiagnostics(resolveRuntimeUrl, version),
      icons: ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'],
      action: 'popup.html',
    };
  }

  const router = new CommandRouter();

  // 实例/标签页/导航/设置命令（session.start → navigate → status 链路依赖它们）。
  router.registerAll(createRuntimeCommands({
    api: browser as unknown as BrowserApiLike,
    policies,
    activity,
  }));
  // tab 控制面（alias / policy / cleanup）。
  router.registerAll(createTabCommands({
    api: browser as unknown as BrowserApiLike,
    policies,
    aliases,
    activity,
  }));

  // 页面动作面（第二批）：observe/click/fill/read/select/get-html/evaluate。
  // observe 单独注册（需要 background 侧 CDP pierce 补充 closed shadow / AX 未映射元素）。
  for (const spec of actions.specsList()) {
    if (spec.method === 'click') continue; // click 走对话框近似包装（见下）
    if (spec.method === 'observe') continue; // 见下方自定义 observe
    router.register(
      spec.method,
      (context) => actions.dispatch(spec.method, context.params, {
        timeoutMs: context.timeoutMs,
        requestId: context.requestId,
      }),
      { description: spec.description },
    );
  }

  /** closed shadow 候选的近似角色（AX 未映射元素用；不参与 ref 身份）。 */
  const closedShadowRoleOf = (tag: string): string => (
    tag === 'a' ? 'link'
      : tag === 'select' ? 'combobox'
        : tag === 'textarea' ? 'textbox'
          : tag === 'button' ? 'button'
            : 'generic'
  );

  // observe：动作面观察 + 可选 closed shadow / AX 未映射补充（CDP pierce 在 background）。
  router.register('observe', async (context) => {
    const params: Record<string, unknown> = { ...context.params };
    const tabId = Number(params.tabId);
    if ((params.closedShadow === true || params.ax === true) && Number.isInteger(tabId) && tabId > 0) {
      try {
        const entries = await pierceService.entries(tabId, 20);
        const enriched: Array<Record<string, unknown>> = [];
        for (const entry of entries) {
          let bounds: Record<string, number> | null = null;
          try {
            const model = await cdpClient.send<Record<string, unknown>>(tabId, 'DOM.getBoxModel', { backendNodeId: entry.backendNodeId });
            const quad = (model['model'] as { content?: number[] } | undefined)?.content;
            if (Array.isArray(quad) && quad.length >= 8) {
              const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
              const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
              const x = Math.min(...xs);
              const y = Math.min(...ys);
              bounds = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
            }
          } catch {
            bounds = null;
          }
          enriched.push({ text: entry.text, tag: entry.tag, backendNodeId: entry.backendNodeId, bounds });
        }
        if (params.closedShadow === true) params.closedShadowNodes = enriched;
        if (params.ax === true) {
          params.unmappedAx = enriched.map((entry) => ({
            role: closedShadowRoleOf(String(entry.tag)),
            name: entry.text,
            backendNodeId: entry.backendNodeId,
            bounds: entry.bounds,
            source: 'closed-shadow',
          }));
        }
      } catch {
        // CDP 不可用/页面不可读时保持主观察可用（补充字段缺省）。
      }
    }
    return actions.dispatch('observe', params, { timeoutMs: context.timeoutMs, requestId: context.requestId });
  }, { serialized: false, timeoutMs: 120_000, description: '观察（含 closed shadow / AX 未映射补充；CDP pierce）' });

  // stableRef 协商：跨 revision 把稳定身份换回当前 @eN（E2E 5b / stableRef 动作链路）。
  router.register('refs.negotiate', (context) => {
    const tabId = Number(context.params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new RpcMethodError('E_BAD_ARG', 'refs.negotiate 需要正整数 tabId');
    const stableRefs = (Array.isArray(context.params.stableRefs) ? context.params.stableRefs : [])
      .map((item) => String(item ?? ''))
      .filter(Boolean);
    if (!stableRefs.length) throw new RpcMethodError('E_BAD_ARG', 'refs.negotiate 需要 stableRefs');
    const current: Record<string, unknown> = { generation: refs.generationOf(tabId) };
    const documentId = typeof context.params.documentId === 'string' && context.params.documentId
      ? context.params.documentId
      : refs.documentOf(tabId);
    if (documentId) current.documentId = documentId;
    if (Number.isInteger(context.params.revision)) current.revision = Number(context.params.revision);
    return refs.negotiate(tabId, stableRefs, current);
  }, { serialized: false, description: 'stableRef 协商（跨 revision）' });

  // 扩展动作面（第三批）：薄动作 / 提取 / 等待 / 取消 / 协助与协作最小面。
  for (const spec of extended.specsList()) {
    if (COOPERATION_METHODS.includes(spec.method)) continue; // 由 CooperationRuntime 接管（避免重复注册）
    router.register(
      spec.method,
      (context) => extended.dispatch(spec.method, context.params, {
        timeoutMs: context.timeoutMs,
        requestId: context.requestId,
      }),
      { description: spec.description },
    );
  }
  // 协作/协助命令（cooperate.wait/handback/sync、request-help）：human-watch + 卡片 + 交还。
  router.registerAll(createCooperationCommands(cooperation));

  // 截图只读面（不接 debugger）。
  router.register('screenshot', (context) => screenshots.takeScreenshot(context.params, {
    timeoutMs: context.timeoutMs,
    requestId: context.requestId,
  }), { serialized: false, timeoutMs: 120_000, description: '截图：可见区域 / 整页拼接 / 元素 / 区域 / 差分 / 流式 / 标注（captureVisibleTab，无 CDP）' });
  router.register('screenshot.read', (context) => screenshots.readChunk(context.params), {
    serialized: false,
    description: '按 offset 分块读取流式暂存的大截图',
  });
  router.register('screenshot.release', (context) => screenshots.releaseStream(context.params), {
    serialized: false,
    description: '释放流式暂存的大截图',
  });
  router.register('screenshot.manual.frame', (context) => screenshots.manualFrame(context.params, {
    timeoutMs: context.timeoutMs,
  }), { serialized: true, timeoutMs: 60_000, description: '手动画布：拍一帧并暂存' });
  router.register('screenshot.manual.save', (context) => screenshots.manualSave(context.params), {
    serialized: true,
    timeoutMs: 60_000,
    description: '手动画布：把暂存帧纵向拼成一张 PNG',
  });

  // 网络只读面（PerformanceResourceTiming；没有请求头/正文，字段缺省为 null）。
  router.register('network.start', (context) => network.start(context.params), {
    serialized: false,
    description: '开始网络只读采集（资源计时时间线；无 CDP）',
  });
  router.register('network.stop', (context) => network.stop(context.params), {
    serialized: false,
    description: '停止网络只读采集',
  });
  router.register('network.list', (context) => network.list(context.params), {
    serialized: false,
    description: '列出采集到的资源计时条目（method/commandId 为 null：无 debugger）',
  });
  router.register('network.detail', (context) => network.detail(context.params), {
    serialized: false,
    description: '单条资源计时详情（无请求/响应头与正文）',
  });
  // click：对话框近似（页面主世界钩子）包装；没有对话框时语义与 ActionRegistry 完全一致。
  router.register('click', async (context) => {
    const tabId = Number(context.params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new RpcMethodError('E_BAD_ARG', 'click 需要正整数 tabId');
    return dialogs.dispatchClick(tabId, context.params, (targetTabId, params) => actions.dispatch('click', {
      ...params,
      tabId: targetTabId,
    }, { timeoutMs: context.timeoutMs, requestId: context.requestId }));
  }, { serialized: true, timeoutMs: 60_000, description: '点击（dialog 近似：main-world 钩子 + operation）' });

  // 文件事务：upload（DataTransfer，daemon 内联字节/transfer staging）与 download（chrome.downloads）。
  router.register('upload', (context) => uploads.upload(context.params), {
    serialized: true,
    timeoutMs: 120_000,
    description: '上传文件：分块字节 → 内容脚本 DataTransfer 写 input.files/drop（无 CDP）',
  });
  router.register('download', (context) => downloads.download(context.params), {
    serialized: true,
    timeoutMs: 120_000,
    description: '下载：点击/导航后用 chrome.downloads 观测完成（无 CDP）',
  });

  // observe --frames：主文档 + 子帧语义树摘要与全局 ref 别名（跨 frame 动作 via=frame-projected；
  // 跨源/跨进程/变换帧自动走 CDP frame-owner 投影，vom:true 时每帧附带 VOM 子图）。
  router.register('observe-frames', async (context) => {
    const tabId = Number(context.params.tabId);
    const result = await frames.observeFrames({
      tabId,
      ...(context.params.force === true ? { force: true } : {}),
      ...(context.params.vom === true ? { vom: true } : {}),
      timeoutMs: context.timeoutMs,
    });
    // 主文档结果登记进 ref 表（与单文档 observe 同一生命周期）：跨帧观察后主文档 @eN 仍可动作。
    const main = result.frames.find((frame) => frame.frameId === 0);
    if (main) {
      const registered = actions.registerFrameObservation(tabId, {
        url: result.url,
        title: result.title,
        observation: main.observation,
        revision: main.revision,
        documentId: main.documentId,
        fingerprint: result.fingerprint,
        nodes: main.nodes as never,
      });
      result.observationId = registered.observationId;
      result.refsRegistered = registered.registered;
    }
    return result;
  }, { serialized: false, timeoutMs: 120_000, description: '逐帧观察：frames/aliases/隐藏帧/帧清单对账（跨源帧走 CDP frame-owner 投影，vom:true 附 VOM 子图）' });

  // 对话框近似：status / accept / dismiss / list / arm / disarm / handle。
  router.register('dialog.status', () => dialogs.status(), { serialized: false, description: '获取当前对话框状态与挂起记录（main-world 钩子）' });
  router.register('dialog.list', () => dialogs.status(), { serialized: false, description: '列出对话框记录（近似实现）' });
  router.register('dialog.accept', (context) => dialogs.accept(context.params, (tabId, params) => actions.dispatch('click', {
    ...params,
    tabId,
  }, { timeoutMs: context.timeoutMs })), { serialized: false, timeoutMs: 60_000, description: '接受对话框（重放原点击，让页面拿到 accept 值）' });
  router.register('dialog.dismiss', (context) => dialogs.dismiss(context.params, (tabId, params) => actions.dispatch('click', {
    ...params,
    tabId,
  }, { timeoutMs: context.timeoutMs })), { serialized: false, timeoutMs: 60_000, description: '关闭对话框（重放原点击，让页面拿到 dismiss 值）' });
  router.register('dialog.arm', () => ({ ok: true, armed: true, mode: 'main-world-hook', note: 'TS 运行时在每次 click 派发窗口内自动 arm，无需显式 arm' }), { serialized: false, description: '挂载对话框拦截（no-op：click 派发窗口自动 arm）' });
  router.register('dialog.disarm', () => ({ ok: true, armed: false, mode: 'main-world-hook' }), { serialized: false, description: '卸载对话框拦截（no-op）' });
  router.register('dialog.handle', (context) => (context.params.accept === true ? dialogs.accept(context.params, (tabId, params) => actions.dispatch('click', {
    ...params,
    tabId,
  }, { timeoutMs: context.timeoutMs })) : dialogs.dismiss(context.params, (tabId, params) => actions.dispatch('click', {
    ...params,
    tabId,
  }, { timeoutMs: context.timeoutMs }))), { serialized: false, timeoutMs: 60_000, description: '按 accept 标志处理对话框' });
  router.register('operation.await', (context) => dialogs.awaitOperation(context.params), { serialized: false, timeoutMs: 130_000, description: '等待 operation 完成（对话框结算/动作）' });

  // debug 只读域：console 采集 / 请求快照 / capabilities/pin / rules 只读列表。
  router.register('debug.start', (context) => debug.start(context.params), { serialized: false, timeoutMs: 30_000, description: '开始调试采集（页面 console 钩子 + 资源计时；无 debugger）' });
  router.register('debug.stop', (context) => debug.stop(context.params), { serialized: false, timeoutMs: 30_000, description: '停止调试采集' });
  router.register('debug.current', (context) => debug.current(context.params), { serialized: false, timeoutMs: 30_000, description: '当前采集快照（requests/console/context）' });
  router.register('debug.history', () => debug.historyList(), { serialized: false, description: '调试采集历史' });
  router.register('debug.capabilities', () => debug.capabilities(), { serialized: false, description: 'debug 只读域能力清单（含明确缺口）' });
  router.register('debug.pin', (context) => debug.pin(context.params), { serialized: false, description: '钉住/取消钉住一条 id' });
  router.register('debug.pinned', () => debug.pinnedList(), { serialized: false, description: '列出钉住项' });
  router.register('console', (context) => debug.console(context.params), { serialized: false, timeoutMs: 30_000, description: '按 limit/cursor 分页读取页面 console（MAIN world 钩子）' });
  router.register('debug.requests', (context) => debug.requests(context.params), { serialized: false, timeoutMs: 30_000, description: '当前采集请求列表' });
  router.register('debug.request', (context) => debug.request(context.params), { serialized: false, timeoutMs: 30_000, description: '单条请求元数据（headers/body unavailable）' });
  router.register('debug.performance', (context) => debug.performance(context.params), { serialized: false, timeoutMs: 30_000, description: '性能指标（资源计时只读面）' });
  router.register('debug.rule_list', () => ruleService.list(), { serialized: false, description: '规则列表（block 走 DNR；fulfill/modify 只登记）' });
  router.register('debug.rule_add', (context) => ruleService.add(context.params.rule, context.params.tabId), { serialized: true, description: '添加规则（block → DNR；fulfill/modify → CDP Fetch）' });
  router.register('debug.rule_enable', (context) => ruleService.setEnabled(context.params.id, true, context.params.tabId), { serialized: true, description: '启用规则' });
  router.register('debug.rule_disable', (context) => ruleService.setEnabled(context.params.id, false, context.params.tabId), { serialized: true, description: '停用规则' });
  router.register('debug.rule_remove', (context) => ruleService.remove(context.params.id, context.params.tabId), { serialized: true, description: '删除规则' });
  router.register('debug.rule_clear', (context) => ruleService.clear(context.params.tabId), { serialized: true, description: '清空本运行时下发的规则并关闭 Fetch 拦截' });
  router.register('debug.rule_export', () => ruleService.exportRules(), { serialized: false, description: '导出规则快照' });
  router.register('debug.rule_import', (context) => ruleService.importRules(context.params.rules, context.params.tabId), { serialized: true, description: '导入规则快照' });
  // CDP 域（M-C 第六批 wave 2）：Fetch 诊断、网络瀑布/重放、PDF、emulate、trace、closed shadow、可信点击。
  router.register('debug.fetch_probe', (context) => ruleService.probe(context.params), { serialized: false, timeoutMs: 30_000, description: 'CDP Fetch requestPaused 诊断（paused/urls）' });
  router.register('network.waterfall', (context) => network.waterfall(context.params), { serialized: false, timeoutMs: 30_000, description: '网络瀑布（相对时间轴/慢请求/分类/错误统计）' });
  router.register('network.replay', (context) => network.replay(context.params), { serialized: true, timeoutMs: 120_000, description: '页面上下文重放请求（id 或 request 对象）' });
  router.register('pdf', (context) => pdfService.printPdf(context.params), { serialized: false, timeoutMs: 60_000, description: 'Page.printToPDF 导出（base64 回包）' });
  router.register('emulate', (context) => emulateService.emulate(context.params), { serialized: false, timeoutMs: 30_000, description: '视口/DPR/UA/时区/定位仿真（CDP Emulation）' });
  router.register('trace.start', (context) => traceService.start(Number(context.params.tabId), { categories: typeof context.params.categories === 'string' ? context.params.categories : undefined }), { serialized: false, timeoutMs: 30_000, description: 'CDP Tracing 开始' });
  router.register('trace.stop', (context) => traceService.stop(Number(context.params.tabId)), { serialized: false, timeoutMs: 40_000, description: 'CDP Tracing 停止并返回 Trace JSON' });
  router.register('trace.status', (context) => traceService.status(Number(context.params.tabId)), { serialized: false, description: 'CDP Tracing 状态' });
  router.register('shadow.click', async (context) => {
    await cooperation.markAgentInput(Number(context.params.tabId));
    return pierceService.shadowClick(context.params);
  }, { serialized: false, timeoutMs: 60_000, description: 'closed shadow 按文本点击（DOM pierce + Input）' });
  router.register('shadow.read', (context) => pierceService.shadowRead(context.params), { serialized: false, timeoutMs: 60_000, description: 'closed shadow 按文本读取' });
  router.register('click-backend', async (context) => {
    await cooperation.markAgentInput(Number(context.params.tabId));
    const clicked = await inputService.clickBackendNode(Number(context.params.tabId), Number(context.params.backendId));
    return { ...clicked, effectState: 'committed', inputMode: 'cdp-input' };
  }, { serialized: true, timeoutMs: 60_000, description: '按 backendNodeId 可信点击（CDP Input）' });

  // 操作录制命令面（CLI record.start/stop/list/export/status）。
  router.register('record.start', (context) => recordService.start(context.params), { serialized: false, timeoutMs: 30_000, description: '开始操作录制（事件模型/浮层/过滤 Agent 动作）' });
  router.register('record.stop', (context) => recordService.stop(context.params), { serialized: false, timeoutMs: 30_000, description: '停止操作录制并落库' });
  router.register('record.list', (context) => recordService.list(context.params), { serialized: false, description: '历史录制（含事件）' });
  router.register('record.export', (context) => recordService.export(context.params), { serialized: false, timeoutMs: 60_000, description: '导出 Trace v3（states/steps/截图引用）' });
  router.register('record.status', () => recordService.status(), { serialized: false, description: '活跃录制状态' });

  // 视频录制命令面（CLI video.start/stop/status/list/save(fetch)/verify/prune/discard/recover）。
  router.register('video.start', (context) => videoService.start(context.params as VideoStartParams), { serialized: false, timeoutMs: 60_000, description: '开始录制标签页视频（tabCapture→离屏编码 MP4；CDP 截帧兜底）' });
  router.register('video.stop', (context) => videoService.stop(context.params), { serialized: false, timeoutMs: 60_000, description: '停止视频录制并落库（分片 sha256）' });
  router.register('video.status', (context) => videoService.status(context.params), { serialized: false, timeoutMs: 30_000, description: '视频录制状态/分片日记/完整性' });
  router.register('video.list', () => videoService.list(), { serialized: false, timeoutMs: 30_000, description: '历史视频录制' });
  router.register('video.fetch', (context) => videoService.fetch(context.params), { serialized: false, timeoutMs: 120_000, description: 'CLI video save 取字节（base64）' });
  router.register('video.verify', (context) => videoService.verify(context.params), { serialized: false, timeoutMs: 60_000, description: '逐片 SHA-256/容器/分片日记校验' });
  router.register('video.prune', (context) => videoService.prune(context.params), { serialized: false, timeoutMs: 30_000, description: '清理过期录制' });
  router.register('video.discard', (context) => videoService.discard(context.params), { serialized: false, timeoutMs: 30_000, description: '丢弃录制（删分片）' });
  router.register('video.recover', (context) => videoService.recover(context.params), { serialized: false, timeoutMs: 120_000, description: '从分片扫描重建可播放文件' });
  router.register('diagnostics.ui', () => diagnosticsPayload(), { serialized: false, description: '扩展 UI 自检（doctor extension-ui）：子页面清单 + 图标 + 能力缺口' });

  // 子页面：`ui.open` 打开扩展页面（popup/options/quick/longshot/debug/audit/ops/record/preview）。
  router.register('ui.open', (context) => uiPages.open(context.params), {
    serialized: false,
    timeoutMs: 30_000,
    description: '打开扩展子页面（chrome.tabs.create；页面清单见 src/ui/catalog）',
  });

  // 长截图恢复：按分片 manifest 把整页拼回来（CLI `bridge longshot recover` / MCP 共用）。
  router.register('longshot.recover', (context) => screenshots.longshotRecover(context.params), {
    serialized: false,
    timeoutMs: 180_000,
    description: '长截图恢复：按本地分片（IndexedDB）重新拼接整页 PNG',
  });
  router.register('longshot.list', () => screenshots.longshotManifests(), {
    serialized: false,
    description: '列出本地可恢复的长截图分片',
  });
  router.register('debug.coverage', (context) => debug.coverage(context.params), { serialized: false, timeoutMs: 30_000, description: '调试覆盖统计与明确缺口' });

  // WebMCP：页面 modelContext 工具 list/call。
  router.register('webmcp.list', (context) => webmcp.list(context.params), { serialized: false, timeoutMs: 30_000, description: '列出页面 WebMCP 工具（document.modelContext）' });
  router.register('webmcp.call', (context) => webmcp.call(context.params), { serialized: false, timeoutMs: 60_000, description: '调用页面 WebMCP 工具' });

  // step：CLI 的 `bridge step <method>` 把一个具体动作包成单步执行。
  // 这里不复制动作逻辑，而是把内部方法交回同一个路由器（参数/ref/错误映射完全一致）。
  router.register('step', async (context) => {
    const action = isRecord(context.params.action) ? context.params.action : null;
    const innerMethod = action && typeof action.method === 'string' ? action.method : '';
    if (!innerMethod) throw new RpcMethodError('E_BAD_ARG', 'step 需要 action.method（由 CLI 生成）');
    const innerParams: Record<string, unknown> = isRecord(action?.params) ? { ...action.params } : {};
    for (const key of ['tabId', 'session', 'sessionId', 'context', 'observation', 'expect']) {
      if (innerParams[key] === undefined && context.params[key] !== undefined) innerParams[key] = context.params[key];
    }
    const outcome = await router.handle({
      type: 'cmd',
      id: (context.requestId || 'step') + '-inner',
      method: innerMethod,
      params: innerParams,
      timeoutMs: context.timeoutMs,
    });
    if (!outcome.ok) throw new RpcMethodError(outcome.error.code, outcome.error.message, outcome.error.data);
    return { ok: true, action: { ok: true, method: innerMethod, result: outcome.result } };
  }, { serialized: false, timeoutMs: 120_000, description: '单步执行一个动作方法（内部复用动作注册表）' });

  // -------------------------------------------------------------------------
  // 端口候选与连接
  // -------------------------------------------------------------------------

  let portsAssetPromise: Promise<number[] | null> | null = null;
  /** 读取产物里的端口锚点（只读一次；失败回退默认表）。 */
  function loadPortsOnce(): Promise<number[] | null> {
    if (!portsAssetPromise) {
      // WXT 给 runtime.getURL 的路径参数做了字面量类型收窄；锚点是部署期才存在的
      // 静态资源，不在生成的文件清单里，这里按普通字符串调用。
      const getUrl = (browser.runtime as unknown as { getURL(path: string): string }).getURL;
      portsAssetPromise = loadPortsAsset(getUrl.call(browser.runtime, PORTS_ASSET_PATH));
    }
    return portsAssetPromise;
  }

  async function candidatePorts(): Promise<number[]> {
    let settingsPort: number | null = null;
    let pairedPort: number | null = null;
    try {
      const stored = await browser.storage.local.get('bridgeSettings');
      // 只有用户显式配置过 daemonPort 才占用最高优先级；缺省值 52900 不能盖过
      // 部署/E2E 改写过的端口锚点（见 discovery.ts 的说明）。
      settingsPort = explicitSettingsPort(stored.bridgeSettings);
      const bag = (stored.bridgeSettings && typeof stored.bridgeSettings === 'object')
        ? stored.bridgeSettings as Record<string, unknown>
        : {};
      pairedPort = portFromDaemonUrl(bag.daemonUrl);
      // 配对地址里的端口与显式 daemonPort 同级优先（显式 daemonPort 更强）。
      settingsPort = explicitSettingsPort(stored.bridgeSettings) ?? pairedPort;
    } catch {
      settingsPort = null;
    }
    let lastPort: number | null = null;
    try {
      const sessionArea = (browser.storage as unknown as { session?: { get(key: string): Promise<Record<string, unknown>> } }).session;
      if (sessionArea) {
        const stored = await sessionArea.get(LAST_PORT_KEY);
        const candidate = Number(stored?.[LAST_PORT_KEY]);
        if (Number.isInteger(candidate) && candidate > 0) lastPort = candidate;
      }
    } catch {
      lastPort = null;
    }
    const assetPorts = await loadPortsOnce();
    return resolvePortCandidates({ settingsPort, lastPort, assetPorts });
  }

  let socketRef: DaemonSocket | null = null;

  const connector = new DaemonConnector({
    socketFactory: (port) => {
      const socket = new DaemonSocket({
        port,
        extVersion: version,
        browser: detectBrowser(),
        userAgent: (globalThis.navigator && typeof navigator.userAgent === 'string') ? navigator.userAgent : '',
      });
      socket.setCommandHandler((frame: DaemonCommandFrame) => {
        // 24d：收到带 tabId 的会话命令时确保接管浮层可见（最小语义，controlHint=false 不显示）。
        const takeoverTabId = Number(((frame.params ?? {}) as Record<string, unknown>).tabId);
        // 命令结果/错误直接回给 daemon；处理器异常已在 router 内结构化。
        // 同时记录命令窗口：资源计时条目的 commandId 用时间窗近似归因（debug/network 共用）。
        const respond = (): void => {
          const startedAt = Date.now();
          void router.respond(frame, socket).finally(() => {
            try {
              timeline.record({
                id: String(frame.id ?? ''),
                method: String(frame.method ?? ''),
                startedAt,
                finishedAt: Date.now(),
                ok: true,
              });
            } catch {
              // 记录失败不影响回包
            }
          });
        };
        if (Number.isInteger(takeoverTabId) && takeoverTabId > 0) {
          if (frame.method === 'evaluate') {
            // 24d 的“截图前浮层可见”断言紧跟导航后的 evaluate：先确保浮层装好再执行表达式
            // （安装完成于内容脚本回包前，避免与异步重装的竞态）。强制重装：跟踪集合可能因导航过期。
            void showTakeoverOverlay(takeoverTabId)
              .catch(() => undefined)
              .finally(respond);
            return;
          }
          void ensureTakeoverOverlay(takeoverTabId).catch(() => undefined);
        }
        respond();
      });
      socket.onAnyDaemonEvent((frame) => {
        registry.events.dispatch(frame);
      });
      socket.onStateChange((snapshot) => {
        if (snapshot.state === 'connected' && snapshot.url) {
          const connectedPort = Number(new URL(snapshot.url).port);
          if (Number.isInteger(connectedPort) && connectedPort > 0) {
            const sessionArea = (browser.storage as unknown as { session?: { set(items: Record<string, unknown>): Promise<void> } }).session;
            if (sessionArea) void sessionArea.set({ [LAST_PORT_KEY]: connectedPort }).catch(() => undefined);
          }
        } else {
          // 断连/重连：接管浮层全部收起，避免页面残留“接管中”。
          for (const tabId of [...takeoverShownTabs]) void setTakeoverOverlay(tabId, false);
        }
      });
      socketRef = socket;
      return socket;
    },
    candidatePorts,
    onAttempt: () => {
      // 失败端口不刷屏：只在最终 ensure() 失败时由调用方记录结构化错误。
    },
  });

  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 确保连接；失败时排一次 5s 重试（SW 被回收后由 alarms 兜底）。 */
  function ensureConnection(): Promise<DaemonSocket> {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    return connector.ensure().then(
      (socket) => socket as DaemonSocket,
      (error: unknown) => {
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void ensureConnection().catch(() => undefined);
          }, 5_000);
        }
        throw error;
      },
    );
  }

  // 启动即连：否则空 profile 下 SW 只有收到消息才醒，daemon 永远看不到浏览器。
  void ensureConnection().catch(() => undefined);

  // MW3 SW 会被回收：用 alarms 定期检查连接（权限里已有 alarms）。
  try {
    browser.alarms.create('bb.reconnect', { periodInMinutes: 0.5 });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== 'bb.reconnect') return;
      if (connector.isConnected()) return;
      void ensureConnection().catch(() => undefined);
    });
  } catch {
    // 该浏览器不支持 alarms 时只靠重试定时器
  }

  // -------------------------------------------------------------------------
  // runtime 消息面（popup/诊断页）
  // -------------------------------------------------------------------------

  /** bb.rpc：daemon 只读转发 + 结构化错误。 */
  async function handleBridgeRpc(message: BridgeRpcMessage): Promise<ExtensionReply> {
    type BridgeRpcReply =
      | Extract<ExtensionReply, { ok: true; type: 'rpc' }>
      | Extract<ExtensionReply, { ok: false }>;
    const withId = (reply: BridgeRpcReply): ExtensionReply => (
      message.id ? { ...reply, id: message.id } : reply
    );
    try {
      let target: DaemonSocket;
      try {
        target = await ensureConnection();
      } catch (error) {
        const payload = errorPayloadOf(error);
        return withId(
          payload.data === undefined
            ? { ok: false, code: payload.code, message: payload.message }
            : { ok: false, code: payload.code, message: payload.message, data: payload.data },
        );
      }
      const reply = await registry.forward(target, message);
      if (reply.ok) {
        return withId({ ok: true, type: 'rpc', result: reply.result });
      }
      const error = reply.error;
      return withId(
        error.data === undefined
          ? { ok: false, code: error.code, message: error.message }
          : { ok: false, code: error.code, message: error.message, data: error.data },
      );
    } catch (error) {
      const payload = errorPayloadOf(error);
      return withId(
        payload.data === undefined
          ? { ok: false, code: payload.code, message: payload.message }
          : { ok: false, code: payload.code, message: payload.message, data: payload.data },
      );
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // 子页面消息面（bb.ui）：只接受本扩展自己的页面/上下文（sender.id 必须一致）。
    if (isRecord(raw) && raw.type === 'bb.ui') {
      if (!sender || sender.id !== browser.runtime.id) {
        sendResponse({ ok: false, code: 'E_FORBIDDEN', message: 'bb.ui 只接受本扩展上下文的消息' } satisfies ExtensionReply);
        return false;
      }
      void uiMessages.handle(raw).then(
        (reply) => sendResponse(reply ?? { ok: false, code: 'E_BAD_MESSAGE', message: 'bb.ui 消息无法识别' }),
        () => sendResponse({ ok: false, code: 'E_UI_FAILED', message: 'bb.ui 处理失败' }),
      );
      return true;
    }
    // 操作录制：页面 record.* 命令 + 内容录制器事件（bb.record.event）——必须先于 parseMessage。
    // 注意：handle() 是 async（对任何消息都返回 Promise），必须先用类型前缀闸门，否则会吞掉所有消息。
    if (isRecord(raw) && typeof raw.type === 'string' && raw.type.startsWith('bb.record.')) {
      const recordHandled = recordMessages.handle(raw, sender as never);
      void recordHandled.then(sendResponse, () => sendResponse({ ok: false, code: 'E_RECORD_FAILED', message: 'record 处理失败' }));
      return true;
    }
    // 人工输入 / 协助卡片回传（内容脚本 → background 的协作运行时）。
    if (isRecord(raw) && typeof raw.type === 'string'
      && (raw.type === 'bb.human.activity' || raw.type === 'bb.human.blur' || raw.type === 'bb.help.resolved')) {
      cooperation.handleRuntimeMessage(raw, (sender as { tab?: { id?: number } } | undefined)?.tab?.id);
      sendResponse({ ok: true });
      return false;
    }
    const message = parseMessage(raw);
    if (!message) {
      sendResponse({ ok: false, code: 'E_BAD_MESSAGE', message: '未知消息类型' } satisfies ExtensionReply);
      return false;
    }
    if (message.type === 'bb.rpc') {
      void handleBridgeRpc(message).then(sendResponse);
      return true;
    }
    void (async () => {
      if (message.type === 'bb.status') {
        const tabs = await browser.tabs.query({});
        sendResponse({ ok: true, type: 'status', status: buildStatus(tabs.length, startedAt, version) } satisfies ExtensionReply);
        return;
      }
      if (message.type === 'bb.ping') {
        sendResponse({ ok: true, type: 'pong', nonce: message.nonce, at: Date.now() } satisfies ExtensionReply);
        return;
      }
      const stored = await browser.storage.local.get('bridgeSettings');
      sendResponse({ ok: true, type: 'settings', settings: normalizeSettings(stored.bridgeSettings) } satisfies ExtensionReply);
    })();
    return true; // 异步 sendResponse
  });

  // 诊断：SW 里暴露只读状态（不参与业务路径；debug 页/支持时可现场查看）。
  (globalThis as unknown as { __bbTsRuntime?: unknown }).__bbTsRuntime = {
    version,
    protocol: PROTOCOL_VERSION,
    actions: actions.methods(),
    extended: extended.methods(),
    pendingOperations: () => extended.pendingOperationIds(),
    scripting: () => actions.scriptingAvailable(),
    commands: router.methods(),
    refs: () => refs.total(),
    connector: () => connector.snapshot(),
    socket: () => socketRef?.snapshot() ?? null,
    screenshots: () => screenshots.captures.size,
    streams: () => screenshots.streams.size,
    longshots: () => screenshots.longshots.backendKind(),
    uiPages: () => uiDiagnostics(resolveRuntimeUrl, version).availablePages,
    uiPreview: () => uiMessages.previewCount(),
    networkCaptures: () => network.activeCaptures().length,
    policies: () => policies.list(),
    aliases: () => aliases.list(),
    activity: () => activity.list(),
  };
});
