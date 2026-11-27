// src/content/takeover-overlay.ts —— Agent 接管浮层（内容脚本侧，M-C 第八批 24d）。
//
// 与 0.3.0 的 `extension/src/takeover.js` + `overlay-ui.js`（installTakeover）对齐的**最小**
// 实现：这里只做「浮层真实存在 + 可见性可切换 + 截图期间可临时隐藏」，不做暂停按钮 /
// 控制器状态机 / 主题切换（那些属于 JS 树的完整接管 UI，本批不迁）。
//
// 语义边界：
// - host 用 closed shadow DOM 挂在 `<html>` 上：id = `__bb_takeover_host`、
//   `data-bb-ui="takeover"`、`data-bb-overlay=""`。closed 意味着页面脚本拿不到卡片内部
//   结构，只能看到 host（与 0.3.0 一致，E2E 24d 的判据也只看 host 的 computed visibility）；
// - 三态：attached（host 是否在 DOM）/ wantedVisible（业务是否要求显示）/ suppressed
//   （截图期临时隐藏）。截图 hook（`src/capture/screenshot.ts`）通过内容脚本 op
//   `overlay-suppress` 调 {@link handleTakeoverOverlayOp}：截图前 `{hidden:true}`、
//   截图后 `{hidden:false}`，隐藏只改 host 的 `visibility`，不卸载 host —— 这样截图后
//   的恢复是幂等的，也不会丢掉业务想要的可见状态；
// - 浮层整体 `pointer-events:none`（连卡片也不可点）：不改变页面命中测试，避免影响
//   observe/click/visual 这些既有只读面；等 lead 接控制器状态机后再按需放开按钮交互；
// - 本文件**自包含**：不 import 任何模块、没有模块级 DOM 访问（状态放 `WeakMap<Document>`），
//   因此内容脚本入口、background 侧注入函数、Node 单测都可以直接调用。
//
// 集成（lead 负责，见报告 E）：
// 1) `entrypoints/content.ts` 在 `installContentBridge()` 之后按业务状态调用
//    `installTakeoverOverlay()` / `setTakeoverVisible()`（建议只在顶层 frame）；
// 2) op `overlay-suppress` 需要登记到内容脚本 op 白名单并分发到
//    `handleTakeoverOverlayOp(params)`（`src/content/protocol.ts` + `src/content/session.ts`，
//    或在 `src/content/entry.ts` 的 listener 里先拦截），供截图 hook 使用。

/** host 的固定 id（E2E 用 `document.getElementById('__bb_takeover_host')` 兜底定位）。 */
export const TAKEOVER_OVERLAY_HOST_ID = '__bb_takeover_host';

/** host 上的 UI 标记（E2E 用 `[data-bb-ui="takeover"]` 定位）。 */
export const TAKEOVER_OVERLAY_UI = 'takeover';

/** 截图抑制 op 名：`{op:'overlay-suppress', params:{hidden:true|false}}`。 */
export const TAKEOVER_SUPPRESS_OP = 'overlay-suppress';

/** host 上记录“抑制前 visibility”的属性（与 0.3.0 overlay-suppress.js 同一语义）。 */
const SUPPRESSED_ATTR = 'data-bb-suppressed';

/** 浮层卡片的可见文本（zh/en 最小表；语言由调用方传，缺省 zh）。 */
const TEXTS = {
  zh: {
    title: 'BridgeDeck 接管中',
    status: 'Agent 正在操作此页面',
    aria: 'BridgeDeck 接管提示',
  },
  en: {
    title: 'BridgeDeck in control',
    status: 'The agent is operating this page',
    aria: 'BridgeDeck takeover hint',
  },
} as const;

export type TakeoverOverlayLanguage = keyof typeof TEXTS;

export interface TakeoverOverlayOptions {
  /** 文档（缺省用全局 document；单测注入假 DOM）。 */
  doc?: Document;
  /** 窗口（computed style 读取用；缺省用全局 window）。 */
  win?: Window;
  /** 语言（缺省 zh；只影响卡片文案与 dir）。 */
  lang?: TakeoverOverlayLanguage;
}

export interface TakeoverOverlayState {
  /** 本次调用是否被接受（没有文档/attachShadow 失败时 false，但不抛异常）。 */
  ok: boolean;
  /** 固定 host id（即使未安装也返回，便于调用方定位）。 */
  hostId: string;
  /** `data-bb-ui` 的值（恒为 takeover）。 */
  dataBbUi: string;
  /** host 是否在 DOM 里。 */
  attached: boolean;
  /** 业务可见性：attached 且未被抑制。 */
  visible: boolean;
  /** 截图抑制窗口内为 true。 */
  suppressed: boolean;
  /** host 的 computed visibility（没有 host 时为空串）。 */
  visibility: string;
  /** host 的 computed display（没有 host 时为空串）。 */
  display: string;
  /** closed shadow 里是否真的渲染了卡片（closed shadow 无法从外部查询，故用记账值）。 */
  cardRendered: boolean;
  /** 本次状态快照时间。 */
  at: number;
}

interface OverlayRecord {
  host: HTMLElement | null;
  shadow: ShadowRoot | null;
  wantedVisible: boolean;
  suppressed: boolean;
  cardRendered: boolean;
  lang: TakeoverOverlayLanguage;
  at: number;
}

const records = new WeakMap<Document, OverlayRecord>();

function resolveDoc(options: TakeoverOverlayOptions): Document | null {
  if (options.doc) return options.doc;
  try {
    return typeof document === 'undefined' ? null : document;
  } catch {
    return null;
  }
}

function resolveWin(options: TakeoverOverlayOptions): Window | null {
  if (options.win) return options.win;
  try {
    return typeof window === 'undefined' ? null : window;
  } catch {
    return null;
  }
}

function styleTexts(lang: TakeoverOverlayLanguage): string {
  const texts = TEXTS[lang] ?? TEXTS.zh;
  return [
    ':host{all:initial}',
    '.wrap{position:fixed;top:14px;right:14px;box-sizing:border-box;max-width:min(360px,calc(100vw - 28px));'
      + 'padding:9px 13px;border-radius:12px;background:#0f172a;color:#f8fafc;'
      + 'border:1px solid rgba(148,163,184,.45);box-shadow:0 10px 28px rgba(15,23,42,.35);'
      + 'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif;'
      + 'pointer-events:none;text-align:start}',
    '.title{margin:0;font-size:12.5px;font-weight:650;letter-spacing:.2px}',
    '.status{margin:2px 0 0;font-size:11.5px;color:#cbd5e1}',
    '.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#38bdf8;margin-inline-end:6px;vertical-align:1px}',
    `@media (prefers-color-scheme: light) {.wrap{background:#1c2230;border-color:rgba(28,34,48,.18)}}`,
    `/* ${texts.aria} */`,
  ].join('');
}

/** 记录快照（供 handle 返回、单测断言）。 */
function snapshot(record: OverlayRecord | null, win: Window | null, ok: boolean): TakeoverOverlayState {
  const host = record?.host ?? null;
  let visibility = '';
  let display = '';
  if (host && win && typeof win.getComputedStyle === 'function') {
    try {
      const computed = win.getComputedStyle(host);
      visibility = typeof computed?.visibility === 'string' ? computed.visibility : '';
      display = typeof computed?.display === 'string' ? computed.display : '';
    } catch {
      visibility = '';
      display = '';
    }
  }
  const attached = Boolean(host && host.isConnected !== false && record !== null);
  return {
    ok,
    hostId: TAKEOVER_OVERLAY_HOST_ID,
    dataBbUi: TAKEOVER_OVERLAY_UI,
    attached,
    visible: attached && (record?.wantedVisible ?? false) && !(record?.suppressed ?? false),
    suppressed: attached && (record?.suppressed ?? false),
    visibility,
    display,
    cardRendered: attached && (record?.cardRendered ?? false),
    at: record?.at ?? Date.now(),
  };
}

function emptySnapshot(ok: boolean): TakeoverOverlayState {
  return snapshot(null, null, ok);
}

/** 找到页面里已存在的 host（id 优先，`[data-bb-ui="takeover"]` 兜底）。 */
function findHost(doc: Document): HTMLElement | null {
  try {
    const byId = doc.getElementById(TAKEOVER_OVERLAY_HOST_ID);
    if (byId) return byId;
  } catch {
    // 忽略：极端页面环境
  }
  try {
    const bySelector = doc.querySelector('[data-bb-ui="' + TAKEOVER_OVERLAY_UI + '"]');
    if (bySelector) return bySelector as HTMLElement;
  } catch {
    // 忽略
  }
  return null;
}

/**
 * 安装（或复用）接管浮层。
 *
 * ```ts
 * installTakeoverOverlay({ visible: true });   // session 活跃时
 * installTakeoverOverlay({ visible: false });  // 只登记不要显示
 * ```
 */
export function installTakeoverOverlay(options: TakeoverOverlayOptions & { visible?: boolean } = {}): TakeoverOverlayState {
  const doc = resolveDoc(options);
  const win = resolveWin(options);
  if (!doc || !doc.documentElement) return emptySnapshot(false);
  const lang: TakeoverOverlayLanguage = options.lang === 'en' ? 'en' : 'zh';
  const wantedVisible = options.visible !== false;

  let record = records.get(doc) ?? null;
  let host = record?.host ?? findHost(doc);
  if (!host) {
    try {
      host = doc.createElement('div');
      host.id = TAKEOVER_OVERLAY_HOST_ID;
      host.setAttribute('data-bb-ui', TAKEOVER_OVERLAY_UI);
      host.setAttribute('data-bb-overlay', '');
      host.setAttribute('dir', 'ltr');
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('aria-label', TEXTS[lang].aria);
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = doc.createElement('style');
      style.textContent = styleTexts(lang);
      shadow.appendChild(style);
      const card = doc.createElement('div');
      card.setAttribute('class', 'wrap');
      card.setAttribute('data-bb-part', 'takeover-card');
      const title = doc.createElement('p');
      title.setAttribute('class', 'title');
      const dot = doc.createElement('span');
      dot.setAttribute('class', 'dot');
      dot.setAttribute('aria-hidden', 'true');
      title.appendChild(dot);
      title.appendChild(doc.createTextNode(TEXTS[lang].title));
      const line = doc.createElement('p');
      line.setAttribute('class', 'status');
      line.textContent = TEXTS[lang].status;
      card.appendChild(title);
      card.appendChild(line);
      shadow.appendChild(card);
      record = {
        host,
        shadow,
        wantedVisible,
        suppressed: false,
        cardRendered: true,
        lang,
        at: Date.now(),
      };
      records.set(doc, record);
      doc.documentElement.appendChild(host);
    } catch {
      return emptySnapshot(false);
    }
  } else {
    const existing: OverlayRecord = record ?? {
      host,
      shadow: null,
      wantedVisible,
      suppressed: false,
      cardRendered: Boolean(host),
      lang,
      at: Date.now(),
    };
    existing.host = host;
    existing.wantedVisible = wantedVisible;
    existing.lang = lang;
    existing.at = Date.now();
    record = existing;
    records.set(doc, existing);
  }
  // attached 但业务不要显示：用 display:'none' 藏起来（保留 host，避免重复注入）；
  // “截图抑制”走独立通道（visibility），两者互不覆盖。
  try {
    if (!wantedVisible) host.style.display = 'none';
    else if (host.style.display === 'none') host.style.removeProperty('display');
  } catch {
    // 忽略
  }
  record.at = Date.now();
  return snapshot(record, win, true);
}

/**
 * 切换业务可见性。`true` 时会先安装（幂等）；`false` 会把 host 从 DOM 移除
 * （截图抑制的“隐藏→恢复”不用这个接口，用 {@link suppressTakeoverOverlay}）。
 */
export function setTakeoverVisible(visible: boolean, options: TakeoverOverlayOptions = {}): TakeoverOverlayState {
  const doc = resolveDoc(options);
  const win = resolveWin(options);
  if (!doc || !doc.documentElement) return emptySnapshot(false);
  if (visible) return installTakeoverOverlay({ ...options, visible: true });
  const record = records.get(doc) ?? null;
  const host = record?.host ?? findHost(doc);
  if (record) record.wantedVisible = false;
  if (host) {
    try {
      host.remove();
    } catch {
      // 忽略：remove 不可用时退化成 display:none
      try {
        host.style.display = 'none';
      } catch {
        // 忽略
      }
    }
    if (record) {
      record.host = null;
      record.shadow = null;
      record.cardRendered = false;
      record.suppressed = false;
      record.at = Date.now();
    }
    records.delete(doc);
  }
  return snapshot(null, win, true);
}

/**
 * 截图抑制：`hidden=true` 把 host 的 visibility 设成 hidden（并记下原值），
 * `hidden=false` 恢复。host 不存在时是幂等 no-op（best-effort：截图不能被浮层拖慢）。
 */
export function suppressTakeoverOverlay(hidden: boolean, options: TakeoverOverlayOptions = {}): TakeoverOverlayState {
  const doc = resolveDoc(options);
  const win = resolveWin(options);
  if (!doc) return emptySnapshot(false);
  const record = records.get(doc) ?? null;
  const host = record?.host ?? findHost(doc);
  if (!host) {
    // 没有浮层：抑制/恢复都当成功 no-op（截图路径不关心）。
    return { ...emptySnapshot(true), suppressed: false };
  }
  try {
    if (hidden) {
      if (!host.hasAttribute(SUPPRESSED_ATTR)) {
        host.setAttribute(SUPPRESSED_ATTR, host.style.visibility || '');
      }
      host.style.setProperty('visibility', 'hidden', 'important');
    } else if (host.hasAttribute(SUPPRESSED_ATTR)) {
      const previous = host.getAttribute(SUPPRESSED_ATTR) ?? '';
      host.removeAttribute(SUPPRESSED_ATTR);
      if (previous) host.style.visibility = previous;
      else host.style.removeProperty('visibility');
    }
  } catch {
    return emptySnapshot(false);
  }
  const next: OverlayRecord = record ?? {
    host,
    shadow: null,
    wantedVisible: true,
    suppressed: hidden,
    cardRendered: true,
    lang: 'zh',
    at: Date.now(),
  };
  next.host = host;
  next.suppressed = hidden;
  next.at = Date.now();
  records.set(doc, next);
  return snapshot(next, win, true);
}

/** 卸载浮层并清掉页面侧记账（tab 关闭/会话结束时的收尾；幂等）。 */
export function removeTakeoverOverlay(options: TakeoverOverlayOptions = {}): TakeoverOverlayState {
  const doc = resolveDoc(options);
  const win = resolveWin(options);
  if (!doc) return emptySnapshot(false);
  const record = records.get(doc) ?? null;
  const host = record?.host ?? findHost(doc);
  if (host) {
    try {
      host.remove();
    } catch {
      // 忽略
    }
  }
  records.delete(doc);
  return snapshot(null, win, true);
}

/** 当前状态（不产生副作用）；没有浮层时 attached=false。 */
export function takeoverOverlayState(options: TakeoverOverlayOptions = {}): TakeoverOverlayState {
  const doc = resolveDoc(options);
  const win = resolveWin(options);
  if (!doc) return emptySnapshot(false);
  const record = records.get(doc) ?? null;
  const host = record?.host ?? findHost(doc);
  if (!host) return { ...emptySnapshot(true), at: record?.at ?? Date.now() };
  const merged: OverlayRecord = record ?? {
    host,
    shadow: null,
    wantedVisible: true,
    suppressed: false,
    cardRendered: true,
    lang: 'zh',
    at: Date.now(),
  };
  merged.host = host;
  records.set(doc, merged);
  return snapshot(merged, win, true);
}

/**
 * 内容脚本 op handler：`overlay-suppress`。
 *
 * ```ts
 * // background/截图 hook
 * content.request(tabId, { op: 'overlay-suppress', params: { hidden: true } });
 * // session 活跃 → 显示
 * content.request(tabId, { op: 'overlay-suppress', params: { visible: true } });
 * ```
 *
 * 参数优先级：`visible`（安装/卸载）> `hidden`（截图抑制）> 空（只读状态）。
 * 永不抛异常：内容脚本回包必须是结构化信封。
 */
export function handleTakeoverOverlayOp(
  params: Record<string, unknown> = {},
  options: TakeoverOverlayOptions = {},
): TakeoverOverlayState {
  try {
    const bag = params && typeof params === 'object' ? params : {};
    if (typeof bag.visible === 'boolean') return setTakeoverVisible(bag.visible, options);
    if (typeof bag.hidden === 'boolean') return suppressTakeoverOverlay(bag.hidden, options);
    return takeoverOverlayState(options);
  } catch {
    return emptySnapshot(false);
  }
}
