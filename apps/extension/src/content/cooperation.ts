// src/content/cooperation.ts —— 页面侧人工协作代理（human-watch + 人工协助卡片 + 完成条件）。
//
// 为什么这里全是“可注入的自包含函数”：
// - human-watch 需要**常驻**监听（document_start 起就要能看见人工点击），由
//   entrypoints/content.ts 的 main() 调 installHumanWatch()（与 0.3.0 的
//   content/human-watch.js 同义：隔离世界常驻 + runtime 消息回传）；
// - 人工协助卡片/完成条件只在 request-help 期间存在，由 background 用
//   `chrome.scripting.executeScript({ func })` 注入 —— executeScript 会序列化函数体，
//   **闭包变量不会跟过去**，所以每个可注入函数必须自包含（只用参数与 document/window/
//   chrome/performance 全局，不引用模块级常量/辅助函数；常量在本文件里各自内联一份）。
// - 页面事件只认真实输入（isTrusted === true），并跳过 Agent 自己派发的**可信**输入窗口
//   （data-bb-agent-input 标记，见 markAgentInput）；这样 CDP Input 派发的 click/type
//   不会被误判成人工接管（23k/23h3 这类用例依赖这一点）。
//
// 明确边界（与 0.3.0 近似语义一致，不谎报能力）：
// - 没有 UIA/OS 输入队列级监听：只看到页面 DOM 收到的可信事件。窗口被遮挡、输入法候选框
//   里的按键、浏览器 chrome UI 上的操作都不会计数；
// - “人工是否仍在操作”用**静默窗口**近似（HUMAN_ACTIVE_WINDOW_MS），不是精确实时状态；
// - 不读表单值：human-watch 只回传事件类型/目标标签（敏感字段只标 sensitive，不取值）。

/**
 * 人工输入的静默窗口：超过这个时间没有新的可信输入就视为人已停手。
 * 口径与 0.3.0 兼容目标的 `human-activity.active`（page-lib：Date.now() - lastHumanInputAt < 2000）
 * 保持一致：UIA 点击 → CLI 启动 → cooperate wait 之间通常有 0.5~1.5s 延迟，窗口太小会把
 * “正在人工操作”误判成 ready。
 */
export const HUMAN_ACTIVE_WINDOW_MS = 2000;
/** 活动回传节流（同一窗口内的连续输入合并成一条 runtime 消息）。 */
export const HUMAN_FLUSH_INTERVAL_MS = 400;
/** Agent 可信输入窗口标记的有效期（与 0.3.0 human-watch 的 10s 一致）。 */
export const HUMAN_AGENT_MARKER_TTL_MS = 10_000;
/** 协助卡片宿主的 id（E2E / 页面诊断都按它查）。 */
export const HELP_HOST_ID = '__bb_help_host';
/** 协助卡片目标高亮层的 id。 */
export const HELP_HIGHLIGHT_ID = '__bb_help_highlight';
/** 协助卡片“用户决定”在页面侧的状态键（background 轮询读它，作为 runtime 消息之外的兜底）。 */
export const HELP_STATE_KEY = '__bbTsHelpState';
/** human-watch 在页面侧的状态键。 */
export const HUMAN_WATCH_KEY = '__bbTsHumanWatch';

/**
 * `chrome` 由内容脚本隔离世界 / executeScript(ISOLATED) 提供（本文件里的可注入函数会
 * 被序列化到页面执行，闭包不跟随，所以只能用全局）。Node 单测把同名对象挂在 globalThis 上，
 * 因此运行时用 globalThis.chrome 作为回退。
 */
declare const chrome: { runtime?: { sendMessage?(message: unknown): unknown } } | undefined;

/** 人工活动回传（background → runtime 消息面）。 */
export interface HumanActivityEvent {
  type: 'bb.human.activity';
  at: number;
  kind: string;
  label: string;
  sensitive: boolean;
  editable: boolean;
  inputClock: number;
  active: boolean;
}

/** 页面侧 human-watch 的只读状态（background 兜底轮询用）。 */
export interface HumanActivityState {
  installed: boolean;
  active: boolean;
  lastInputAt: number;
  lastKind: string;
  lastLabel: string;
  sensitive: boolean;
  editable: boolean;
  inputClock: number;
  at: number;
}

export type HelpCriterionKind = 'selector_exists' | 'selector_visible' | 'text_exists' | 'url_contains';

export interface HelpCriterion {
  kind: HelpCriterionKind | string;
  selector?: string;
  text?: string;
}

export interface HelpCriterionCheck {
  kind: string;
  ok: boolean;
  selector: string | null;
  text: string | null;
  reason: string | null;
}

export interface HelpCriteriaResult {
  ok: boolean;
  checks: HelpCriterionCheck[];
  at: number;
}

export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: { width: number; height: number };
}

export interface HelpOverlayOptions {
  requestId: string;
  reason: string;
  title?: string;
  targetRect?: TargetRect | null;
  lang?: 'zh' | 'en';
}

export interface HelpOverlayResult {
  ok: boolean;
  requestId: string;
  hostId: string;
  highlight: boolean;
  at: number;
}

export interface HelpPageState {
  requestId: string;
  action: 'done' | 'skip';
  note: string;
  at: number;
  attached: boolean;
}

/**
 * 安装页面级 human-watch（幂等）。必须整函数自包含：既由 content script 常驻调用，
 * 也可被 executeScript 注入到还没安装过的页面。
 */
export function installHumanWatch(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof document === 'undefined' || document === null) return false;
  const existing = g['__bbTsHumanWatch'] as Record<string, unknown> | null | undefined;
  if (existing && existing['installed'] === true) return false;
  const state: Record<string, unknown> = {
    installed: true,
    lastInputAt: 0,
    lastKind: '',
    lastLabel: '',
    sensitive: false,
    editable: false,
    inputClock: 0,
    samples: 0,
    lastFlush: 0,
    timer: null,
  };
  g['__bbTsHumanWatch'] = state;
  const chromeBag = (typeof chrome !== 'undefined' && chrome ? chrome : null)
    ?? (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome
    ?? null;
  const runtimeBag = chromeBag && chromeBag.runtime ? chromeBag.runtime : null;
  const runtime = runtimeBag && typeof (runtimeBag as { sendMessage?: unknown }).sendMessage === 'function'
    ? (runtimeBag as { sendMessage(message: unknown): unknown })
    : null;
  const send = (message: unknown): void => {
    try {
      if (!runtime) return;
      const pending = runtime.sendMessage(message);
      const maybe = pending as { catch?: unknown } | null;
      if (maybe && typeof maybe.catch === 'function') (maybe as { catch(fn: () => void): void }).catch(() => undefined);
    } catch {
      // 扩展上下文失效（重载/升级）时忽略：页面上的 watcher 不应把页面拖挂。
    }
  };
  const attrOf = (element: unknown, name: string): string => {
    const el = element as { getAttribute?: (key: string) => string | null } | null;
    try {
      if (el && typeof el.getAttribute === 'function') {
        const value = el.getAttribute(name);
        return value === null || value === undefined ? '' : String(value);
      }
    } catch {
      // 忽略
    }
    return '';
  };
  const tagOf = (element: unknown): string => {
    const el = element as { tagName?: unknown; id?: unknown } | null;
    if (!el) return '';
    const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
    const id = typeof el.id === 'string' && el.id ? '#' + el.id : '';
    return (tag + id).slice(0, 120);
  };
  const labelOf = (element: unknown): string => {
    const aria = attrOf(element, 'aria-label');
    const name = attrOf(element, 'name');
    const placeholder = attrOf(element, 'placeholder');
    const id = attrOf(element, 'id');
    const composed = aria || name || placeholder || id || tagOf(element);
    return composed.trim().slice(0, 120);
  };
  const isSensitive = (element: unknown): boolean => {
    const type = attrOf(element, 'type').toLowerCase();
    const autocomplete = attrOf(element, 'autocomplete').toLowerCase();
    return type === 'password'
      || type === 'file'
      || autocomplete.includes('password')
      || autocomplete.includes('one-time-code');
  };
  const isEditable = (element: unknown): boolean => {
    const el = element as { tagName?: unknown; matches?: unknown } | null;
    if (!el) return false;
    try {
      if (typeof el.matches === 'function') {
        return (el.matches as (selector: string) => boolean)('input,textarea,select,[contenteditable="true"]');
      }
    } catch {
      // 忽略
    }
    const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  };
  const flush = (): void => {
    state['timer'] = null;
    state['lastFlush'] = Date.now();
    send({
      type: 'bb.human.activity',
      at: Number(state['lastInputAt']) || Date.now(),
      kind: String(state['lastKind'] || ''),
      label: String(state['lastLabel'] || ''),
      sensitive: state['sensitive'] === true,
      editable: state['editable'] === true,
      inputClock: Number(state['inputClock']) || 0,
      active: true,
    });
  };
  const schedule = (): void => {
    const now = Date.now();
    const lastFlush = Number(state['lastFlush']) || 0;
    if (now - lastFlush > 400) {
      flush();
      return;
    }
    if (state['timer'] === null || state['timer'] === undefined) {
      state['timer'] = setTimeout(flush, Math.max(0, 400 - (now - lastFlush)));
    }
  };
  const agentMarker = (): { recent: boolean } => {
    const root = document.documentElement;
    const marker = Number(root ? attrOf(root, 'data-bb-agent-input') : 0);
    if (!Number.isFinite(marker) || marker <= 0) return { recent: false };
    const mono = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    // 兼容两种标记：epoch 毫秒（旧）与 performance.now 单调毫秒（新）。
    const recent = marker > 1e11
      ? Date.now() - marker < 10000
      : (mono >= marker && mono - marker < 10000);
    return { recent };
  };
  const onTrustedInput = (event: unknown): void => {
    const bag = event as { isTrusted?: unknown; type?: unknown; target?: unknown } | null;
    if (!bag || bag.isTrusted !== true) return;
    if (agentMarker().recent) return;
    const target = bag.target ?? null;
    state['lastInputAt'] = Date.now();
    state['lastKind'] = String(bag.type ?? '');
    state['lastLabel'] = labelOf(target);
    state['sensitive'] = isSensitive(target);
    state['editable'] = isEditable(target);
    state['inputClock'] = (Number(state['inputClock']) || 0) + 1;
    state['samples'] = (Number(state['samples']) || 0) + 1;
    schedule();
  };
  for (const type of ['pointerdown', 'keydown', 'input', 'change', 'focusin', 'click']) {
    try {
      document.addEventListener(type, onTrustedInput, true);
    } catch {
      // 老环境/受限文档：忽略单个事件类型
    }
  }
  const onBlur = (): void => {
    state['lastInputAt'] = 0;
    send({ type: 'bb.human.blur', at: Date.now() });
  };
  try {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('blur', onBlur, true);
    }
  } catch {
    // 忽略
  }
  return true;
}

/**
 * 读取页面侧 human-watch 状态（background 兜底轮询；human-watch 未安装时如实回 installed:false）。
 * 只读，不触发任何副作用。
 */
export function readHumanActivity(): HumanActivityState {
  const g = globalThis as unknown as Record<string, unknown>;
  const state = g['__bbTsHumanWatch'] as Record<string, unknown> | null | undefined;
  const at = Date.now();
  if (!state || state['installed'] !== true) {
    return {
      installed: false,
      active: false,
      lastInputAt: 0,
      lastKind: '',
      lastLabel: '',
      sensitive: false,
      editable: false,
      inputClock: 0,
      at,
    };
  }
  const lastInputAt = Number(state['lastInputAt']) || 0;
  return {
    installed: true,
    active: lastInputAt > 0 && at - lastInputAt < 2000,
    lastInputAt,
    lastKind: String(state['lastKind'] || ''),
    lastLabel: String(state['lastLabel'] || ''),
    sensitive: state['sensitive'] === true,
    editable: state['editable'] === true,
    inputClock: Number(state['inputClock']) || 0,
    at,
  };
}

/**
 * 标记“接下来是 Agent 的可信输入”窗口：human-watch 在有效期内忽略可信事件，
 * 避免 CDP 原生输入（click-backend / shadow.click / --trusted 路径）被误判成人工接管。
 * 返回写入的单调时钟标记（0 表示当前文档不可标记）。
 */
export function markAgentInput(): number {
  if (typeof document === 'undefined' || document === null) return 0;
  const root = document.documentElement;
  if (!root || typeof root.setAttribute !== 'function') return 0;
  const mono = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  try {
    root.setAttribute('data-bb-agent-input', String(mono));
  } catch {
    return 0;
  }
  return mono;
}

/**
 * 在页面里显示人工协助卡片（closed shadow DOM 宿主，id = __bb_help_host）。
 * 用户点“完成并交还控制权”→ 页面状态 action='done'；点“取消请求”→ action='skip'；
 * 同时用 chrome.runtime.sendMessage 回传 bb.help.resolved（background 优先走消息，轮询兜底）。
 * 点击后卡片自行移除；background 仍会再调 hideHelpOverlay() 兜底清理。
 */
export function showHelpOverlay(options: HelpOverlayOptions): HelpOverlayResult {
  const g = globalThis as unknown as Record<string, unknown>;
  const requestId = String((options && options.requestId) || '');
  const lang = options && options.lang === 'en' ? 'en' : 'zh';
  const texts = lang === 'en'
    ? {
      title: 'Agent needs your help',
      reason: 'Finish the page action, then hand control back to the agent.',
      placeholder: 'Message for the agent (optional)',
      cancel: 'Cancel request',
      done: 'Done, hand back control',
    }
    : {
      title: 'Agent 需要你的帮助',
      reason: '完成页面上的操作后，把控制权交回 Agent。',
      placeholder: '给 Agent 留言（可选）',
      cancel: '取消请求',
      done: '完成并交还控制权',
    };
  const result: HelpOverlayResult = {
    ok: false,
    requestId,
    hostId: '__bb_help_host',
    highlight: false,
    at: Date.now(),
  };
  if (typeof document === 'undefined' || document === null) return result;
  const root = document.documentElement;
  if (!root) return result;
  const chromeBag = (typeof chrome !== 'undefined' && chrome ? chrome : null)
    ?? (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome
    ?? null;
  const runtimeBag = chromeBag && chromeBag.runtime ? chromeBag.runtime : null;
  const runtime = runtimeBag && typeof (runtimeBag as { sendMessage?: unknown }).sendMessage === 'function'
    ? (runtimeBag as { sendMessage(message: unknown): unknown })
    : null;
  const send = (message: unknown): void => {
    try {
      if (!runtime) return;
      const pending = runtime.sendMessage(message);
      const maybe = pending as { catch?: unknown } | null;
      if (maybe && typeof maybe.catch === 'function') (maybe as { catch(fn: () => void): void }).catch(() => undefined);
    } catch {
      // 忽略
    }
  };
  const removeById = (id: string): void => {
    try {
      const old = document.getElementById(id);
      if (old && typeof (old as unknown as { remove?: unknown }).remove === 'function') {
        (old as unknown as { remove(): void }).remove();
      }
    } catch {
      // 忽略
    }
  };
  removeById('__bb_help_host');
  removeById('__bb_help_highlight');
  // 目标高亮层（定位用，不参与像素结果；目标不存在时不显示）。
  const targetRect = options && options.targetRect ? options.targetRect : null;
  if (targetRect) {
    const highlight = document.createElement('div');
    highlight.id = '__bb_help_highlight';
    highlight.setAttribute('data-bb-overlay', 'help-target');
    highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;'
      + 'border:2px solid #2f6fed;border-radius:8px;box-shadow:0 0 0 6px rgba(47,111,237,.18),0 0 22px rgba(28,34,48,.28)';
    highlight.style.left = Math.round(targetRect.x - 3) + 'px';
    highlight.style.top = Math.round(targetRect.y - 3) + 'px';
    highlight.style.width = Math.round(targetRect.width + 6) + 'px';
    highlight.style.height = Math.round(targetRect.height + 6) + 'px';
    try {
      root.appendChild(highlight);
      result.highlight = true;
    } catch {
      // 忽略
    }
  }
  const host = document.createElement('div');
  host.id = '__bb_help_host';
  host.setAttribute('data-bb-ui', 'help');
  host.setAttribute('data-bb-overlay', 'help');
  host.setAttribute('dir', 'ltr');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  let shadow: ShadowRoot | null = null;
  try {
    shadow = host.attachShadow({ mode: 'closed' });
  } catch {
    shadow = null;
  }
  if (!shadow) {
    // 极端环境（已经 attach 过/被页面改写）不硬塞：清掉刚加的高亮并如实回 ok:false。
    removeById('__bb_help_highlight');
    return result;
  }
  const style = document.createElement('style');
  style.textContent = [
    ':host{--bb-font:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}',
    '.card{position:fixed;top:16px;right:16px;box-sizing:border-box;width:380px;max-width:calc(100vw - 24px);'
      + 'background:#f7f9fc;color:#1c2230;border:1px solid #dbe4f5;border-radius:14px;'
      + 'box-shadow:0 16px 40px rgba(28,34,48,.18),0 3px 8px rgba(28,34,48,.18);'
      + 'font:12.5px/1.5 var(--bb-font);pointer-events:auto;padding:14px}',
    '.title{margin:0 0 6px;font-size:13px;font-weight:650}',
    '.msg{margin:0 0 10px;font-size:12.5px;line-height:1.55}',
    '.note{width:100%;box-sizing:border-box;min-height:38px;max-height:90px;resize:vertical;border:1px solid #dbe4f5;'
      + 'border-radius:9px;background:#fff;color:#1c2230;font:12px/1.5 var(--bb-font);padding:8px 10px}',
    '.note::placeholder{color:#667085}',
    '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    '.btn{height:32px;padding:0 14px;border-radius:9px;border:1px solid #dbe4f5;background:#fff;color:#1c2230;'
      + 'font-size:12px;font-weight:550;cursor:pointer}',
    '.btn.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    'button:focus-visible{outline:2px solid #2f6fed;outline-offset:2px}',
  ].join('');
  const card = document.createElement('div');
  card.setAttribute('class', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const titleNode = document.createElement('p');
  titleNode.setAttribute('class', 'title');
  titleNode.textContent = String((options && options.title) || texts.title);
  const msgNode = document.createElement('p');
  msgNode.setAttribute('class', 'msg');
  msgNode.textContent = String((options && options.reason) || texts.reason);
  const noteNode = document.createElement('textarea');
  noteNode.setAttribute('class', 'note');
  noteNode.setAttribute('aria-label', texts.placeholder);
  noteNode.setAttribute('placeholder', texts.placeholder);
  const actions = document.createElement('div');
  actions.setAttribute('class', 'actions');
  const cancelBtn = document.createElement('button');
  cancelBtn.setAttribute('type', 'button');
  cancelBtn.setAttribute('class', 'btn');
  cancelBtn.setAttribute('data-act', 'cancel');
  cancelBtn.textContent = texts.cancel;
  const doneBtn = document.createElement('button');
  doneBtn.setAttribute('type', 'button');
  doneBtn.setAttribute('class', 'btn primary');
  doneBtn.setAttribute('data-act', 'done');
  doneBtn.textContent = texts.done;
  actions.appendChild(cancelBtn);
  actions.appendChild(doneBtn);
  card.appendChild(titleNode);
  card.appendChild(msgNode);
  card.appendChild(noteNode);
  card.appendChild(actions);
  shadow.appendChild(style);
  shadow.appendChild(card);
  const roots = (g['__bbTsHelpRoots'] as WeakMap<object, ShadowRoot> | undefined)
    || (g['__bbTsHelpRoots'] = new WeakMap<object, ShadowRoot>());
  try {
    roots.set(host, shadow);
  } catch {
    // 忽略
  }
  const decision = (action: 'done' | 'skip'): void => {
    let note = '';
    try {
      note = typeof noteNode.value === 'string' ? noteNode.value : '';
    } catch {
      note = '';
    }
    const at = Date.now();
    g['__bbTsHelpState'] = { requestId, action, note, at };
    // 先移除卡片再回传：调用方（CLI/E2E）看到 action 时卡片已经不在页面上。
    try {
      host.remove();
    } catch {
      // 忽略
    }
    removeById('__bb_help_highlight');
    send({ type: 'bb.help.resolved', requestId, action, note });
  };
  const onCancel = (): void => decision('skip');
  const onDone = (): void => decision('done');
  try {
    cancelBtn.addEventListener('click', onCancel);
    doneBtn.addEventListener('click', onDone);
  } catch {
    // 忽略：没有事件系统时仍然能通过 readHelpState 轮询到状态
  }
  try {
    root.appendChild(host);
  } catch {
    removeById('__bb_help_highlight');
    return result;
  }
  result.ok = true;
  result.at = Date.now();
  return result;
}

/** 移除协助卡片与目标高亮（可重复调用；requestId 匹配时顺手清掉页面侧决定）。 */
export function hideHelpOverlay(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof document === 'undefined' || document === null) return false;
  let removed = false;
  for (const id of ['__bb_help_host', '__bb_help_highlight']) {
    try {
      const node = document.getElementById(id);
      if (node && typeof (node as unknown as { remove?: unknown }).remove === 'function') {
        (node as unknown as { remove(): void }).remove();
        removed = true;
      }
    } catch {
      // 忽略
    }
  }
  // 决定已被调用方读取：清掉页面侧状态，避免下一次 request-help 误读旧 requestId。
  if (g['__bbTsHelpState']) delete g['__bbTsHelpState'];
  return removed;
}

/** 读取协助卡片的页面侧决定（background 轮询兜底；没有决定时回 null）。 */
export function readHelpState(): HelpPageState | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const state = g['__bbTsHelpState'] as Record<string, unknown> | null | undefined;
  if (!state) return null;
  const action = state['action'] === 'done' ? 'done' : (state['action'] === 'skip' ? 'skip' : null);
  if (!action) return null;
  let attached = false;
  try {
    attached = typeof document !== 'undefined' && document !== null && Boolean(document.getElementById('__bb_help_host'));
  } catch {
    attached = false;
  }
  return {
    requestId: String(state['requestId'] || ''),
    action,
    note: typeof state['note'] === 'string' ? state['note'] : '',
    at: Number(state['at']) || 0,
    attached,
  };
}

/** 检查 request-help 的完成条件（selector_exists / selector_visible / text_exists / url_contains）。 */
export function checkHelpCriteria(criteria: HelpCriterion[] | unknown): HelpCriteriaResult {
  const list = Array.isArray(criteria) ? criteria : [];
  const checks: HelpCriterionCheck[] = [];
  const doc = typeof document !== 'undefined' ? document : null;
  const href = typeof location !== 'undefined' && location ? String(location.href || '') : '';
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { kind?: unknown; selector?: unknown; text?: unknown };
    const kind = String(item.kind || '');
    const selector = typeof item.selector === 'string' ? item.selector : null;
    const text = typeof item.text === 'string' ? item.text : null;
    if (kind === 'url_contains') {
      checks.push({ kind, ok: Boolean(text) && href.includes(String(text)), selector: null, text, reason: null });
      continue;
    }
    if (kind === 'selector_exists' || kind === 'selector_visible') {
      let element: Element | null = null;
      try {
        element = doc && selector ? doc.querySelector(selector) : null;
      } catch (error) {
        checks.push({ kind, ok: false, selector, text: null, reason: 'bad-selector:' + String((error as Error)?.message || error) });
        continue;
      }
      if (!element) {
        checks.push({ kind, ok: false, selector, text: null, reason: 'not-found' });
        continue;
      }
      if (kind === 'selector_exists') {
        checks.push({ kind, ok: true, selector, text: null, reason: null });
        continue;
      }
      let visible = true;
      try {
        const style = (typeof getComputedStyle === 'function' ? getComputedStyle(element) : null) as
          { display?: string; visibility?: string; opacity?: string } | null;
        if (style) {
          if (style.display === 'none') visible = false;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') visible = false;
          if (style.opacity === '0') visible = false;
        }
        const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
        if (rect && rect.width <= 0 && rect.height <= 0) visible = false;
      } catch {
        visible = true;
      }
      checks.push({ kind, ok: visible, selector, text: null, reason: visible ? null : 'not-visible' });
      continue;
    }
    if (kind === 'text_exists') {
      let haystack = '';
      try {
        const body = doc ? doc.body : null;
        haystack = body ? String((body as HTMLElement).innerText || body.textContent || '') : '';
      } catch {
        haystack = '';
      }
      checks.push({ kind, ok: Boolean(text) && haystack.includes(String(text)), selector: null, text, reason: null });
      continue;
    }
    checks.push({ kind, ok: false, selector, text, reason: 'unsupported-kind' });
  }
  return { ok: checks.length > 0 && checks.every((check) => check.ok), checks, at: Date.now() };
}

/** 量目标元素的视口坐标（协助卡片定位/高亮用；ref 由调用方先解析成 selector）。 */
export function measureTarget(selector: string): TargetRect | null {
  if (typeof document === 'undefined' || document === null) return null;
  const text = String(selector || '');
  if (!text) return null;
  let element: Element | null = null;
  try {
    element = document.querySelector(text);
  } catch {
    return null;
  }
  if (!element || typeof element.getBoundingClientRect !== 'function') return null;
  const rect = element.getBoundingClientRect();
  const winWidth = typeof window !== 'undefined' && window ? Number(window.innerWidth) || 0 : 0;
  const winHeight = typeof window !== 'undefined' && window ? Number(window.innerHeight) || 0 : 0;
  return {
    x: Number(rect.left) || 0,
    y: Number(rect.top) || 0,
    width: Math.max(0, Number(rect.width) || 0),
    height: Math.max(0, Number(rect.height) || 0),
    viewport: { width: winWidth, height: winHeight },
  };
}
