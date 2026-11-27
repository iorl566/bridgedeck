// src/record/capture.ts —— 页面录制器（自包含注入函数；页面事件上报来源）。
//
// 由 background 的 record.start/reattach 通过 `chrome.scripting.executeScript` 注入到
// 目标 tab 的每个 frame（ISOLATED world），监听 DOM 事件并 `chrome.runtime.sendMessage`
// 上报 `{type:'bb.record.event', event}`；background 的 record 服务做归一化/过滤/落库。
//
// 为什么写成“自包含函数”：executeScript({func}) 会把函数**源码**序列化后在页面执行，
// 它看不到模块作用域（import 进来的常量/辅助函数会 ReferenceError）。因此这个函数内部
// 不引用任何模块级变量，所有 helper 都嵌套在函数体里，类型只通过 `import type` 引入。
//
// 采集面（与 0.3.0 JS 运行时 content/record-capture.js 对齐的最小集）：
//   click / input / change(select,file) / hover(停留 800ms + popup trigger) /
//   dragstart / drop / text(文本 diff) / media(进度) / navigate(pushState 等)；
//   iframe 内 hover 通过 postMessage 把 token 交给顶层 frame，顶层菜单点击据此
//   归属到“iframe 内的触发元素”（E2E 20d7）。
//
// 非目标：不做 state 观察（observe 走 background 的页面动作层，录制器不重复实现 VOM）。

import type { RecordCaptureInstallResult } from './types.ts';

export interface RecordCaptureOptions {
  startedAt?: number;
  includeAgent?: boolean;
  documentId?: string | null;
}

/**
 * 在页面安装录制监听器（幂等：同一文档重复注入返回 existing=true）。
 *
 * 注意：函数体必须保持自包含（不要引用模块作用域符号），见文件头说明。
 */
export function installRecordCapture(options: RecordCaptureOptions = {}): RecordCaptureInstallResult {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc || !doc.documentElement) return { ok: false, reason: 'no-dom' };
  const win = window as unknown as Window & {
    __bb_record_capture?: { active: boolean; start?: (value?: RecordCaptureOptions) => RecordCaptureInstallResult; stop?: () => { ok: boolean; events: number } };
    __bb_ops?: { active?: boolean };
    __bbAgentInputAt?: number;
  };
  const chromeApi = (globalThis as unknown as {
    chrome?: {
      runtime?: {
        sendMessage?: (message: unknown, callback?: () => void) => unknown;
        lastError?: { message?: string } | null;
        onMessage?: { addListener?: (listener: (message: unknown) => void) => void };
      };
    };
  }).chrome;
  if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.sendMessage !== 'function') {
    return { ok: false, reason: 'no-runtime' };
  }
  if (win.__bb_record_capture && win.__bb_record_capture.active) return { ok: true, existing: true };
  if (win.__bb_ops && win.__bb_ops.active) return { ok: true, existing: 'injected' };

  interface CaptureState {
    active: boolean;
    seq: number;
    startedAt: number;
    includeAgent: boolean;
    documentId: string | null;
  }

  let state: CaptureState | null = {
    active: true,
    seq: 0,
    startedAt: Number(options.startedAt) || Date.now(),
    includeAgent: options.includeAgent === true,
    documentId: typeof options.documentId === 'string' && options.documentId ? options.documentId : null,
  };
  const pending: unknown[] = [];
  let sending = false;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let lastNavUrl = '';
  const removers: Array<() => void> = [];

  const on = (target: EventTarget | null, type: string, handler: (event: Event) => void, capture = true): void => {
    if (!target || typeof (target as EventTarget).addEventListener !== 'function') return;
    (target as EventTarget).addEventListener(type, handler, capture);
    removers.push(() => (target as EventTarget).removeEventListener(type, handler, capture));
  };

  const flush = (): void => {
    if (sending || !pending.length) return;
    const runtime = chromeApi.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    sending = true;
    const item = pending[0];
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sending = false;
      if (ok) pending.shift();
      else pending.splice(0, 1);
      if (pending.length) setTimeout(flush, 300);
    };
    try {
      const reply = runtime.sendMessage(item, () => {
        if (runtime.lastError) done(false);
        else done(true);
      });
      if (reply && typeof (reply as { then?: unknown }).then === 'function') {
        (reply as Promise<unknown>).then(() => done(true), () => done(false));
      }
    } catch {
      done(false);
    }
  };

  const send = (payload: Record<string, unknown>): void => {
    const withMeta: Record<string, unknown> = {
      documentId: state && state.documentId ? state.documentId : null,
      frameUrl: location.href,
      ...payload,
    };
    pending.push({ type: 'bb.record.event', event: withMeta });
    if (pending.length > 200) pending.shift();
    flush();
  };

  const selectorOf = (el: Element | null): string => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      const name = node.getAttribute('name');
      const aria = node.getAttribute('aria-label');
      if (name) part += '[name="' + name + '"]';
      else if (aria) part += '[aria-label="' + aria + '"]';
      else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const textOf = (el: Element | null): string => String(
    el && ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || ''),
  ).trim().slice(0, 80);

  const roleOf = (el: Element | null): string => {
    if (!el || el.nodeType !== 1) return '';
    const explicit = String(el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio', 'range', 'file'].includes(type)) return type;
      return 'textbox';
    }
    return '';
  };

  const nameOf = (el: Element | null): string => String(
    el && (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).innerText || (el as HTMLInputElement).value || ''),
  ).trim().slice(0, 80);

  const sensitiveFields = new WeakSet<Element>();
  const isSensitiveField = (el: Element | null): boolean => {
    if (!el || el.nodeType !== 1) return false;
    if (sensitiveFields.has(el)) return true;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'file') {
      sensitiveFields.add(el);
      return true;
    }
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/.test(autocomplete)) {
      sensitiveFields.add(el);
      return true;
    }
    return false;
  };

  const overlayEvent = (event: Event): boolean => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some((node) => node && (node as Element).id === '__bb_record_host');
  };

  const inOwnOverlay = (el: Element | null): boolean => {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && el.id.startsWith('__bb_')) return true;
    return Boolean(el.closest && el.closest('[id^="__bb_"], [data-bb-overlay]'));
  };

  const agentRecent = (): boolean => {
    const agentAt = Number(win.__bbAgentInputAt || 0) || Number(doc.documentElement.getAttribute('data-bb-agent-input') || 0);
    if (!agentAt) return false;
    if (agentAt > 1e11) return Date.now() - agentAt < 10_000;
    return typeof performance !== 'undefined' && performance.now() >= agentAt && performance.now() - agentAt < 10_000;
  };

  const record = (kind: string, payload: Record<string, unknown>): void => {
    if (!state || !state.active) return;
    state.seq += 1;
    const agent = payload.actor === 'agent' || agentRecent();
    send({
      kind,
      seq: state.seq,
      ts: Date.now(),
      actor: agent ? 'agent' : 'human',
      url: location.href,
      ...payload,
    });
  };

  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  const popupTriggerOf = (el: Element): Element | null => {
    let node: Element | null = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      const expanded = String(node.getAttribute('aria-expanded') || '').toLowerCase();
      const className = typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className : '';
      if (node.hasAttribute('aria-haspopup')
        || expanded === 'false'
        || /(menu|popup|dropdown|flyout|popover|submenu|combobox|autocomplete)/i.test(className + ' ' + String(node.id || ''))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  };

  const inPopupSurface = (el: Element | null): boolean => {
    let node: Element | null = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const marker = String((node as HTMLElement).className || '') + ' ' + String(node.id || '');
      if (['menu', 'listbox', 'dialog', 'tooltip', 'option', 'menuitem', 'alertdialog'].includes(role)
        || node.getAttribute('aria-modal') === 'true'
        || /(dropdown-menu|popover|popper|flyout|submenu|context-menu|menu-list|account-menu|user-menu)/i.test(marker)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const hoverToken = (): string => {
    const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoLike && typeof cryptoLike.randomUUID === 'function') return cryptoLike.randomUUID();
    return 'ifh-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  };

  let lastHoverSelector = '';
  let lastHoverAt = 0;
  let lastHoverEl: Element | null = null;
  let iframeHover: { token: string; selector: string; at: number } | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellSelector = '';
  let dwellEl: Element | null = null;

  const isDwellTarget = (el: Element): boolean => {
    const tag = String(el.tagName || '').toLowerCase();
    const role = roleOf(el);
    return tag === 'a' || tag === 'button' || ['menuitem', 'option', 'tab', 'treeitem'].includes(role);
  };
  const cancelDwell = (): void => {
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = null;
    dwellSelector = '';
    dwellEl = null;
  };

  const parentOfClick = (el: Element): string => {
    if (!lastHoverEl || !lastHoverSelector || Date.now() - lastHoverAt > 5000) return '';
    if (lastHoverEl.contains(el)) return lastHoverSelector;
    let node: Element | null = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      if (node === lastHoverEl) return lastHoverSelector;
      node = node.parentElement;
    }
    return '';
  };

  // -- 事件处理 ------------------------------------------------------------

  const onClick = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    cancelDwell();
    isSensitiveField(el);
    const parent = parentOfClick(el);
    let parentToken = '';
    let parentSelector = '';
    if (isTopFrame && iframeHover && Date.now() - iframeHover.at < 5000 && inPopupSurface(el)) {
      parentToken = iframeHover.token;
      parentSelector = iframeHover.selector;
      iframeHover = null;
    }
    record('click', {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      text: textOf(el),
      ...(parent ? { parent } : {}),
      ...(parentToken ? { parentToken, parentSelector } : {}),
    });
  };

  const onInput = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    let value = '********';
    if (!isSensitiveField(el)) {
      const target = el as HTMLInputElement & { isContentEditable?: boolean; textContent?: string | null };
      const raw = target.value != null ? target.value : (target.isContentEditable ? target.textContent : '');
      value = String(raw == null ? '' : raw).slice(0, 200);
    }
    record('input', {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      type: type || el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      value,
    });
  };

  const onChange = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    const tag = String(el.tagName).toLowerCase();
    if (tag === 'select') {
      record('select', {
        selector: selectorOf(el),
        role: roleOf(el),
        name: nameOf(el),
        value: String((el as HTMLSelectElement).value || ''),
      });
      return;
    }
    if (tag === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'file') {
      const files = Array.from((el as HTMLInputElement).files || []).map((file) => String(file.name || '').slice(0, 120));
      record('file', { selector: selectorOf(el), role: roleOf(el), name: nameOf(el), files });
    }
  };

  const onPointerOver = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    const trigger = popupTriggerOf(el);
    if (!trigger) {
      if (!isDwellTarget(el)) return;
      const selector = selectorOf(el);
      if (dwellSelector === selector) return;
      cancelDwell();
      dwellSelector = selector;
      dwellEl = el;
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        if (!state || !state.active || !dwellEl) return;
        record('hover', {
          selector: dwellSelector,
          tag: String(dwellEl.tagName || '').toLowerCase(),
          role: roleOf(dwellEl),
          name: nameOf(dwellEl),
          dwellMs: 800,
        });
      }, 800);
      return;
    }
    cancelDwell();
    const selector = selectorOf(trigger);
    const now = Date.now();
    if (selector === lastHoverSelector && now - lastHoverAt < 2000) return;
    lastHoverSelector = selector;
    lastHoverAt = now;
    lastHoverEl = trigger;
    const token = !isTopFrame ? hoverToken() : '';
    record('hover', {
      selector,
      tag: String(trigger.tagName || '').toLowerCase(),
      role: roleOf(trigger),
      name: nameOf(trigger),
      expectsPopup: true,
      ...(token ? { token } : {}),
    });
    if (token) {
      try {
        window.top?.postMessage({ type: 'bb.record.iframe-hover', token, selector }, '*');
      } catch {
        // 跨源被拒绝时忽略
      }
    }
  };

  const onPointerOut = (event: Event): void => {
    if (!dwellEl) return;
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;
    if (el === dwellEl || (dwellEl.contains && dwellEl.contains(el))) cancelDwell();
  };

  let dragSource: { selector: string; text: string } | null = null;
  const onDragStart = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    dragSource = { selector: selectorOf(el), text: textOf(el) };
    record('dragstart', dragSource);
  };
  const onDrop = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || overlayEvent(event)) return;
    const to = { selector: selectorOf(el), text: textOf(el) };
    record('drop', { ...to, ...(dragSource ? { from: dragSource.selector } : {}) });
    dragSource = null;
  };

  // -- 媒体进度：不单独成步，归并到最后一条动作事件 -----------------------
  const mediaState = new WeakMap<Element, number>();
  let lastMediaAt = 0;
  const onMedia = (event: Event): void => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || el.nodeType !== 1 || !state || state.seq <= 0) return;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'video' && tag !== 'audio') return;
    const media = el as HTMLMediaElement;
    const now = Date.now();
    if (event.type === 'timeupdate' && now - lastMediaAt < 1000) return;
    lastMediaAt = now;
    const current = Number(media.currentTime) || 0;
    const duration = Number(media.duration) || 0;
    const prev = mediaState.get(el);
    mediaState.set(el, current);
    if (prev !== undefined && Math.abs(prev - current) < 0.2 && event.type !== 'ended') return;
    send({
      kind: 'media',
      seq: state.seq,
      ts: now,
      url: location.href,
      media: [{
        selector: selectorOf(el),
        tag,
        currentTime: Math.round(current * 100) / 100,
        duration: Math.round(duration * 100) / 100,
        paused: media.paused === true,
        event: event.type,
      }],
    });
  };

  // -- 文本变化：MutationObserver → 延迟归并（E2E 20d8） --------------------
  const textBaseline = new WeakMap<Element, string>();
  const collectTextChanges = (mutations: MutationRecord[]): void => {
    const changes: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const mutation of mutations) {
      let node: Element | null = mutation.type === 'characterData' ? (mutation.target.parentElement || null) : (mutation.target as Element);
      if (!node || node.nodeType !== 1 || inOwnOverlay(node)) continue;
      const tag = String(node.tagName || '').toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'math'].includes(tag)) continue;
      if (node.closest && node.closest('script,style,noscript,template')) continue;
      if (node.closest && node.closest('input[type="password"],input[type="file"]')) continue;
      const current = String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!current) continue;
      const key = selectorOf(node);
      if (seen.has(key)) continue;
      seen.add(key);
      let previous = textBaseline.get(node);
      if (mutation.type === 'characterData' && typeof mutation.oldValue === 'string') {
        previous = mutation.oldValue.replace(/\s+/g, ' ').trim().slice(0, 300);
      } else if (mutation.removedNodes && mutation.removedNodes.length) {
        const removed = Array.from(mutation.removedNodes)
          .map((item) => String(item.textContent || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        if (removed) previous = removed;
      }
      textBaseline.set(node, current);
      if (previous === undefined || previous === current) continue;
      changes.push({
        selector: key,
        label: (tag + (node.id ? '#' + node.id : '')).slice(0, 160),
        previous_value: previous,
        value: current,
      });
      if (changes.length >= 20) break;
    }
    if (!changes.length || !state || !state.active || state.seq <= 0) return;
    send({ kind: 'text', seq: state.seq, ts: Date.now(), url: location.href, changes });
  };
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  const textObserver = typeof MutationObserver === 'function'
    ? new MutationObserver((mutations) => {
      if (!state || !state.active) return;
      if (textTimer) clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        textTimer = null;
        collectTextChanges(mutations);
      }, 400);
    })
    : null;
  if (textObserver) {
    textObserver.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
  }

  // -- 同页导航 -----------------------------------------------------------
  const historyLike = window.history as History & { pushState: History['pushState']; replaceState: History['replaceState'] };
  const originalPush = historyLike.pushState;
  const originalReplace = historyLike.replaceState;
  const onNavigate = (source: string): void => {
    if (!state || !state.active || location.href === lastNavUrl) return;
    lastNavUrl = location.href;
    record('navigate', { url: lastNavUrl, source });
  };
  const patchedPush = function patchedPushState(this: History, ...args: Parameters<History['pushState']>): void {
    originalPush.apply(this, args);
    queueMicrotask(() => onNavigate('pushState'));
  };
  const patchedReplace = function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>): void {
    originalReplace.apply(this, args);
    queueMicrotask(() => onNavigate('replaceState'));
  };
  try {
    historyLike.pushState = patchedPush as History['pushState'];
    historyLike.replaceState = patchedReplace as History['replaceState'];
  } catch {
    // 只读 history 的极端环境忽略
  }

  lastNavUrl = location.href;
  on(doc, 'pointerover', onPointerOver);
  on(doc, 'pointerout', onPointerOut);
  on(doc, 'click', onClick);
  on(doc, 'input', onInput);
  on(doc, 'change', onChange);
  on(doc, 'dragstart', onDragStart);
  on(doc, 'drop', onDrop);
  on(doc, 'timeupdate', onMedia);
  on(doc, 'play', onMedia);
  on(doc, 'pause', onMedia);
  on(doc, 'ended', onMedia);
  on(window, 'popstate', () => onNavigate('popstate'));
  on(window, 'hashchange', () => onNavigate('hashchange'));
  on(window, 'pagehide', () => flush());
  if (isTopFrame) {
    on(window, 'message', (event: Event) => {
      const data = (event as MessageEvent).data as { type?: unknown; token?: unknown; selector?: unknown } | null;
      if (!data || data.type !== 'bb.record.iframe-hover' || !data.token) return;
      if (!state || !state.active) return;
      iframeHover = { token: String(data.token), selector: String(data.selector || ''), at: Date.now() };
    });
  }
  flushTimer = setInterval(flush, 500);

  const stop = (): { ok: boolean; events: number } => {
    if (!state || !state.active) return { ok: true, events: 0 };
    state.active = false;
    cancelDwell();
    iframeHover = null;
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    if (textObserver) textObserver.disconnect();
    for (const remove of removers) {
      try {
        remove();
      } catch {
        // 页面元素可能已移除
      }
    }
    removers.length = 0;
    try {
      historyLike.pushState = originalPush;
      historyLike.replaceState = originalReplace;
    } catch {
      // 同上
    }
    flush();
    const events = state.seq;
    state = null;
    win.__bb_record_capture = { active: false };
    return { ok: true, events };
  };

  win.__bb_record_capture = {
    get active(): boolean {
      return Boolean(state && state.active);
    },
    stop,
  };

  // `chrome.runtime.onMessage` 只装一次（同一文档多帧各自一份；全局标记防重复）。
  // 注意：监听器内部只能通过 window.__bb_record_capture 取当前 stop，不能闭包引用
  // 本次 install 的局部函数（否则重复注入时 deactivate 会停到旧会话）。
  const onMessage = chromeApi.runtime.onMessage;
  if (onMessage && typeof onMessage.addListener === 'function') {
    const listenerWin = win as unknown as { __bb_record_listener?: boolean };
    if (!listenerWin.__bb_record_listener) {
      listenerWin.__bb_record_listener = true;
      onMessage.addListener((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        if ((message as { type?: unknown }).type !== 'bb.record.deactivate') return;
        const current = (window as unknown as {
          __bb_record_capture?: { active?: boolean; stop?: () => { ok: boolean; events: number } };
        }).__bb_record_capture;
        if (current && current.active && typeof current.stop === 'function') current.stop();
      });
    }
  }

  return { ok: true, existing: false };
}

/** 停止当前文档的录制器（background 也可直接用 executeScript 调用）。 */
export function stopRecordCapture(): { ok: boolean; events: number } {
  const win = typeof window === 'undefined'
    ? null
    : (window as unknown as { __bb_record_capture?: { stop?: () => { ok: boolean; events: number } } });
  if (!win || !win.__bb_record_capture || typeof win.__bb_record_capture.stop !== 'function') return { ok: true, events: 0 };
  return win.__bb_record_capture.stop();
}
