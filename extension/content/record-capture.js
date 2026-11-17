// content/record-capture.js —— 常驻记录采集器（document_start，all_frames）。
// 由 worker 的 bb.record.activate 激活；页面导航后浏览器会自动重注入，
// 新文档会查询 bb.record.status 自动恢复录制。

(() => {
  if (window.__bb_record_capture && window.__bb_record_capture.active) return;
  if (window.__bb_ops && window.__bb_ops.active) return;

  let state = null;
  let listeners = [];
  let flushTimer = null;
  let pending = [];
  let sending = false;
  let lastNavUrl = '';

  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const flush = () => {
    if (sending || !pending.length) return;
    sending = true;
    const item = pending[0];
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sending = false;
      if (ok) pending.shift();
      else pending.splice(0, 1);
      if (pending.length) setTimeout(flush, 300);
    };
    try {
      const reply = chrome.runtime.sendMessage(item, () => {
        if (chrome.runtime.lastError) done(false);
        else done(true);
      });
      if (reply && typeof reply.then === 'function') reply.then(() => done(true), () => done(false));
    } catch {
      done(false);
    }
  };

  const send = (payload) => {
    if (!pending.length) pending.push(Object.assign({ type: 'bb.ops.event' }, payload));
    else pending.push(Object.assign({ type: 'bb.ops.event' }, payload));
    if (pending.length > 200) pending.shift();
    flush();
  };

  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.getAttribute && node.getAttribute('name')) part += '[name="' + node.getAttribute('name') + '"]';
      else if (node.getAttribute && node.getAttribute('aria-label')) part += '[aria-label="' + node.getAttribute('aria-label') + '"]';
      else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
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

  const textOf = (el) => String((el && (el.innerText || el.value || el.getAttribute('aria-label') || '')) || '').trim().slice(0, 80);
  const roleOf = (el) => {
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
  const nameOf = (el) => String((el && (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '')) || '').trim().slice(0, 80);

  const sensitiveFields = new WeakSet();
  const isSensitiveField = (el) => {
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

  const overlayEvent = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    return path.some((node) => node && node.id === '__bb_record_host');
  };

  const inOwnOverlay = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && el.id.startsWith('__bb_')) return true;
    return !!el.closest('[id^="__bb_"], [data-bb-overlay]');
  };

  const scheduleState = (seq) => {
    if (!state || !state.active) return;
    state.pendingStateSeq = seq;
    if (state.stateTimer) clearTimeout(state.stateTimer);
    state.stateTimer = setTimeout(async () => {
      state.stateTimer = null;
      if (!state.active) return;
      const api = globalThis.__BB_PAGE__;
      if (!api || typeof api.handle !== 'function') return;
      try {
        const reply = await api.handle('observe', { probeHover: false });
        if (!reply || reply.ok !== true || !reply.result) return;
        send({
          kind: 'state',
          seq: state.pendingStateSeq,
          ts: Date.now(),
          url: location.href,
          observation: String(reply.result.observation || '').slice(0, 20000),
          refs: Number(reply.result.refs) || 0,
          title: String(reply.result.title || ''),
        });
      } catch {
        // 页面不可观察时忽略该步状态
      }
    }, 300);
  };

  const isTopFrame = window.top === window;
  let iframeHover = null;
  const inPopupSurface = (el) => {
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const marker = String(node.className || '') + ' ' + String(node.id || '');
      if (['menu', 'listbox', 'dialog', 'tooltip', 'option', 'menuitem', 'alertdialog'].includes(role)
        || node.getAttribute('aria-modal') === 'true'
        || /(dropdown-menu|popover|popper|flyout|submenu|context-menu|menu-list|account-menu|user-menu)/i.test(marker)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };
  const iframeHoverToken = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'ifh-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  };
  let lastHoverSelector = '';
  let lastHoverAt = 0;
  let lastHoverEl = null;
  let dwellTimer = null;
  let dwellSelector = '';
  let dwellEl = null;

  const isDwellTarget = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toLowerCase();
    const role = roleOf(el);
    return tag === 'a' || tag === 'button' || ['menuitem', 'option', 'tab', 'treeitem'].includes(role);
  };
  const cancelDwell = () => {
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = null;
    dwellSelector = '';
    dwellEl = null;
  };

  const record = (kind, payload) => {
    if (!state || !state.active) return;
    state.seq += 1;
    const seq = state.seq;
    const agentAt = Number(globalThis.__bbAgentInputAt || 0) || Number(document.documentElement.getAttribute('data-bb-agent-input') || 0);
    // 标记可能是 performance.now（新）或 Date.now（旧），两种都认。
    const agentRecent = agentAt > 0 && (agentAt > 1e11 ? Date.now() - agentAt < 10000 : (performance.now() >= agentAt && performance.now() - agentAt < 10000));
    const actor = agentRecent ? 'agent' : 'human';
    send(Object.assign({ kind, seq, ts: Date.now(), actor, url: location.href }, payload));
    if (kind !== 'state') scheduleState(seq);
  };

  const popupTriggerOf = (el) => {
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      const expanded = String(node.getAttribute('aria-expanded') || '').toLowerCase();
      const className = typeof node.className === 'string' ? node.className : '';
      if (node.hasAttribute('aria-haspopup')
        || expanded === 'false'
        || /(menu|popup|dropdown|flyout|popover|submenu|combobox|autocomplete)/i.test(className + ' ' + String(node.id || ''))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
  };

  const findPopupSurface = () => {
    const direct = document.querySelectorAll([
      '[role="menu"]',
      '[role="listbox"]',
      '[role="dialog"]',
      '[role="tooltip"]',
      '[aria-modal="true"]',
      '[data-popper-placement]',
      '[data-radix-popper-content-wrapper]',
    ].join(','));
    for (const el of direct) {
      if (isVisible(el)) return el;
    }
    for (const el of document.querySelectorAll('[class],[id]')) {
      const marker = String(el.className || '') + ' ' + String(el.id || '');
      if (!/(dropdown-menu|popover|popper|flyout|submenu|context-menu|menu-list|account-menu|user-menu)/i.test(marker)) continue;
      if (isVisible(el)) return el;
    }
    return null;
  };

  let lastPopupSurface = null;
  let popupSurfaceAt = 0;
  const rememberPopupSurface = () => {
    setTimeout(() => {
      lastPopupSurface = findPopupSurface();
      popupSurfaceAt = Date.now();
    }, 120);
  };

  const parentOfClick = (el) => {
    if (!lastHoverEl || !lastHoverSelector || Date.now() - lastHoverAt > 5000) return '';
    if (lastHoverEl.contains(el)) return lastHoverSelector;
    if (lastPopupSurface && Date.now() - popupSurfaceAt <= 5000 && lastPopupSurface.contains(el)) return lastHoverSelector;
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      if (node === lastHoverEl) return lastHoverSelector;
      node = node.parentElement;
    }
    return '';
  };

  const start = (options = {}) => {
    if (state && state.active) return { ok: true, existing: true };
    if (window.__bb_ops && window.__bb_ops.active) return { ok: true, existing: 'injected' };
    state = {
      active: true,
      seq: 0,
      pendingStateSeq: 0,
      stateTimer: null,
      startedAt: Number(options.startedAt) || Date.now(),
      includeAgent: options.includeAgent === true,
    };
    pending = [];
    sending = false;
    flushTimer = setInterval(flush, 500);
    lastNavUrl = location.href;
    lastHoverSelector = '';
    lastHoverAt = 0;
    lastHoverEl = null;
    iframeHover = null;

    const onClick = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      cancelDwell();
      isSensitiveField(el);
      const parent = parentOfClick(el);
      let iframeParent = null;
      if (isTopFrame && iframeHover && Date.now() - iframeHover.at < 5000 && inPopupSurface(el)) {
        iframeParent = iframeHover;
        iframeHover = null;
      }
      record('click', {
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: nameOf(el),
        text: textOf(el),
        ...(parent ? { parent } : {}),
        ...(iframeParent ? { parentToken: iframeParent.token, parentSelector: iframeParent.selector } : {}),
      });
    };
    const onInput = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      const type = String(el.getAttribute('type') || '').toLowerCase();
      let value = '********';
      if (!isSensitiveField(el)) {
        const raw = el.value != null ? el.value : (el.isContentEditable ? el.textContent : '');
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
    const onChange = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      if (String(el.tagName).toLowerCase() === 'select') {
        record('select', {
          selector: selectorOf(el),
          role: roleOf(el),
          name: nameOf(el),
          value: String(el.value || ''),
        });
        return;
      }
      if (String(el.tagName).toLowerCase() === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'file') {
        const files = Array.from(el.files || []).map((file) => String(file.name || '').slice(0, 120));
        record('file', { selector: selectorOf(el), role: roleOf(el), name: nameOf(el), files });
      }
    };
    const onPointerOver = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      const trigger = popupTriggerOf(el);
      if (!trigger) {
        if (!isDwellTarget(el)) return;
        const selector = selectorOf(el);
        if (dwellSelector === selector) return;
        cancelDwell();
        dwellSelector = selector;
        dwellEl = el;
        dwellTimer = setTimeout(() => {
          if (!state || !state.active || !dwellEl) return;
          record('hover', {
            selector: dwellSelector,
            tag: String(dwellEl.tagName || '').toLowerCase(),
            role: roleOf(dwellEl),
            name: nameOf(dwellEl),
            dwellMs: 800,
          });
          dwellTimer = null;
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
      lastPopupSurface = null;
      rememberPopupSurface();
      const token = !isTopFrame ? iframeHoverToken() : '';
      record('hover', {
        selector,
        tag: String(trigger.tagName || '').toLowerCase(),
        role: roleOf(trigger),
        name: nameOf(trigger),
        expectsPopup: true,
        ...(token ? { token } : {}),
      });
      if (token && window.top) {
        try {
          window.top.postMessage({ type: 'bb.record.iframe-hover', token, selector }, '*');
        } catch {
          // 跨源被拒绝时忽略
        }
      }
    };
    const onPointerOut = (event) => {
      if (!dwellEl) return;
      if (event.target === dwellEl || (dwellEl.contains && dwellEl.contains(event.target))) cancelDwell();
    };
    let dragSource = null;
    const onDragStart = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      dragSource = { selector: selectorOf(el), text: textOf(el) };
      record('dragstart', dragSource);
    };
    const onDrop = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || overlayEvent(event)) return;
      const to = { selector: selectorOf(el), text: textOf(el) };
      record('drop', { ...to, ...(dragSource ? { from: dragSource.selector } : {}) });
      dragSource = null;
    };

    // 媒体进度：不产生单独步骤，挂到最后一条事件上。
    const mediaState = new WeakMap();
    let lastMediaAt = 0;
    const onMedia = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || state.seq <= 0) return;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag !== 'video' && tag !== 'audio') return;
      const now = Date.now();
      if (event.type === 'timeupdate' && now - lastMediaAt < 1000) return;
      lastMediaAt = now;
      const current = Number(el.currentTime) || 0;
      const duration = Number(el.duration) || 0;
      const prev = mediaState.get(el);
      mediaState.set(el, current);
      if (prev !== undefined && Math.abs(prev - current) < 0.2 && event.type !== 'ended') return;
      send({
        kind: 'media',
        seq: state.seq,
        ts: now,
        url: location.href,
        media: {
          selector: selectorOf(el),
          tag,
          currentTime: Math.round(current * 100) / 100,
          duration: Math.round(duration * 100) / 100,
          paused: el.paused === true,
          event: event.type,
        },
      });
    };
    on(document, 'timeupdate', onMedia, true);
    on(document, 'play', onMedia, true);
    on(document, 'pause', onMedia, true);
    on(document, 'ended', onMedia, true);
    const textBaseline = new WeakMap();
    const collectTextChanges = (mutations) => {
      const changes = [];
      const seen = new Set();
      for (const mutation of mutations) {
        let node = mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
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
          label: `${tag}${node.id ? '#' + node.id : ''}`.slice(0, 160),
          previous_value: previous,
          value: current,
        });
        if (changes.length >= 20) break;
      }
      if (!changes.length || !state || !state.active || state.seq <= 0) return;
      send({
        kind: 'text',
        seq: state.seq,
        ts: Date.now(),
        url: location.href,
        changes,
      });
    };
    let textTimer = null;
    const textObserver = new MutationObserver((mutations) => {      if (!state || !state.active) return;
      if (textTimer) clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        textTimer = null;
        collectTextChanges(mutations);
      }, 400);
    });
    textObserver.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    const onNavigate = (source) => {
      if (!state || !state.active || location.href === lastNavUrl) return;
      lastNavUrl = location.href;
      record('navigate', { url: lastNavUrl, source });
    };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function patchedPushState(...args) {
      const result = originalPush.apply(this, args);
      queueMicrotask(() => onNavigate('pushState'));
      return result;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplace.apply(this, args);
      queueMicrotask(() => onNavigate('replaceState'));
      return result;
    };
    on(document, 'pointerover', onPointerOver, true);
    on(document, 'pointerout', onPointerOut, true);
    on(document, 'click', onClick, true);
    if (isTopFrame) {
      on(window, 'message', (event) => {
        const data = event && event.data;
        if (!data || data.type !== 'bb.record.iframe-hover' || !data.token) return;
        if (!state || !state.active) return;
        iframeHover = { token: String(data.token), selector: String(data.selector || ''), at: Date.now() };
      });
    }
    on(document, 'input', onInput, true);
    on(document, 'change', onChange, true);
    on(document, 'dragstart', onDragStart, true);
    on(document, 'drop', onDrop, true);
    on(window, 'popstate', () => onNavigate('popstate'));
    on(window, 'hashchange', () => onNavigate('hashchange'));
    on(window, 'pagehide', () => flush());
    state.restore = () => {
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      textObserver.disconnect();
      if (textTimer) clearTimeout(textTimer);
    };
    return { ok: true, existing: false };
  };

  const stop = () => {
    if (!state || !state.active) return { ok: true, events: 0 };
    state.active = false;
    cancelDwell();
    iframeHover = null;
    if (state.stateTimer) clearTimeout(state.stateTimer);
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    for (const remove of listeners) remove();
    listeners = [];
    if (state.restore) state.restore();
    flush();
    const events = state.seq;
    state = null;
    window.__bb_record_capture = { active: false };
    return { ok: true, events };
  };

  window.__bb_record_capture = {
    get active() { return !!(state && state.active); },
    start,
    stop,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'bb.record.activate') {
      sendResponse(start(message));
      return false;
    }
    if (message.type === 'bb.record.deactivate') {
      sendResponse(stop());
      return false;
    }
    return false;
  });

  // 导航/新 iframe 注入时，如果该 tab 仍在录制则自动恢复。
  try {
    chrome.runtime.sendMessage({ type: 'bb.record.status' }, (reply) => {
      if (chrome.runtime.lastError) return;
      if (reply && reply.active === true) start({ startedAt: reply.startedAt });
    });
  } catch {
    // worker 暂不可达时忽略
  }
})();
