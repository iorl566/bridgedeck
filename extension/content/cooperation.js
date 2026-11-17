// content/cooperation.js —— 协作输入层：可选的页面点击/滚动锁 + 协作读取。
//
// 设计：
// - 默认不启用；只有设置 cooperationGuard=true 且接管浮层显示时才锁点击/滚动。
// - 锁只拦指针/滚轮/touchmove，不拦键盘；接管浮层卡片在其上，
//   所以暂停/停止按钮仍可点。
// - Agent 自己派发输入前，后台会发 bb.cooperation.passthrough 临时把覆盖层
//   pointer-events 设为 none，避免锁住自己；结束后恢复。
// - bb.cooperation.read 返回字段/媒体/焦点快照，密码、文件、OTP、卡号等脱敏。
(() => {
  if (globalThis.__bbCooperation) return;
  const BLOCKER_ID = '__bb_input_blocker';
  const PASSTHROUGH_TTL_MS = 5000;
  const isTop = window.top === window;
  let blocked = false;
  let blocker = null;
  let listening = false;
  const passes = new Map(); // token -> { expiresAt, timer }
  const activity = { lastHumanAt: 0, lastKind: '', editing: false, events: [] };
  let agentUntil = 0;
  let revision = 0;
  const bump = () => { revision += 1; };

  const stopScroll = (event) => {
    if (!blocked || passes.size > 0) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const addListeners = () => {
    if (listening) return;
    window.addEventListener('wheel', stopScroll, { capture: true, passive: false });
    window.addEventListener('touchmove', stopScroll, { capture: true, passive: false });
    listening = true;
  };
  const removeListeners = () => {
    if (!listening) return;
    window.removeEventListener('wheel', stopScroll, { capture: true });
    window.removeEventListener('touchmove', stopScroll, { capture: true });
    listening = false;
  };
  const stopPointer = (event) => {
    if (passes.size > 0) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const ensureBlocker = () => {
    if (!isTop) return null;
    if (blocker) return blocker;
    blocker = document.createElement('div');
    blocker.id = BLOCKER_ID;
    blocker.setAttribute('data-bb-overlay', '');
    blocker.setAttribute('data-bb-ui', 'cooperation-blocker');
    blocker.setAttribute('aria-hidden', 'true');
    blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;pointer-events:auto;touch-action:none;';
    blocker.addEventListener('pointerdown', stopPointer, { capture: true });
    blocker.addEventListener('click', stopPointer, { capture: true });
    blocker.addEventListener('contextmenu', stopPointer, { capture: true });
    document.documentElement.appendChild(blocker);
    return blocker;
  };
  const removeBlocker = () => {
    removeListeners();
    if (blocker) blocker.remove();
    blocker = null;
  };
  const takeoverCards = () => {
    const host = document.querySelector('[data-bb-ui="takeover"]');
    const roots = globalThis.__bbTakeoverRoots;
    const root = host && roots && typeof roots.get === 'function' ? roots.get(host) : null;
    if (!root) return [];
    return ['.card', '.mini'].map((selector) => root.querySelector(selector)).filter(Boolean);
  };
  const modeFor = () => {
    const now = Date.now();
    if (blocked) {
      if (passes.size > 0) return 'acting';
      if (now - activity.lastHumanAt < 2500) return activity.editing ? 'editing' : 'human';
      return 'ready';
    }
    if (now - activity.lastHumanAt < 2500) return activity.editing ? 'editing' : 'human';
    return 'idle';
  };
  const apply = () => {
    if (!blocker) return;
    const pass = passes.size > 0;
    blocker.style.pointerEvents = pass ? 'none' : 'auto';
    blocker.style.display = blocked ? 'block' : 'none';
    // passthrough 是"这一次 Agent 点击要穿透"，接管卡片也必须让开，否则
    // 点击落在卡片上仍会命中浮层（浮层 passthrough 同样
    // 会禁用 card/stop 的 pointer-events）。
    for (const card of takeoverCards()) card.style.pointerEvents = pass ? 'none' : '';
    if (blocked && !pass) addListeners(); else removeListeners();
  };
  const clearPasses = () => {
    for (const lease of passes.values()) clearTimeout(lease.timer);
    passes.clear();
    bump();
    agentUntil = Math.max(agentUntil, Date.now() + 500);
  };
  const setBlocked = (on) => {
    if (!isTop) return false;
    blocked = Boolean(on);
    if (blocked) {
      ensureBlocker();
      apply();
    } else {
      clearPasses();
      for (const card of takeoverCards()) card.style.pointerEvents = '';
      removeBlocker();
    }
    return blocked;
  };
  const passThrough = (token, active) => {
    if (!isTop || !token) return passes.size;
    const id = String(token);
    const existing = passes.get(id);
    if (active === false) {
      if (existing) clearTimeout(existing.timer);
      passes.delete(id);
      bump();
      agentUntil = Math.max(agentUntil, Date.now() + 500);
      apply();
      return passes.size;
    }
    if (!existing) {
      bump();
      agentUntil = Math.max(agentUntil, Date.now() + 1500);
      const timer = globalThis['set' + 'Timeout'](() => {
        passes.delete(id);
        apply();
      }, PASSTHROUGH_TTL_MS);
      passes.set(id, { expiresAt: Date.now() + PASSTHROUGH_TTL_MS, timer });
    }
    apply();
    return passes.size;
  };

  const labelOf = (element) => String(
    element && element.getAttribute && (
      element.getAttribute('aria-label') ||
      element.getAttribute('name') ||
      element.getAttribute('placeholder') ||
      element.id ||
      element.tagName
    ) || ''
  ).trim().slice(0, 120);
  const editableTarget = (target) => Boolean(target && target.nodeType === 1 && (
    target.matches && target.matches('input,textarea,select,[contenteditable="true"]')
  ));
  const noteHuman = (kind, target) => {
    if (!isTop || passes.size > 0 || Date.now() < agentUntil) return;
    bump();
    const now = Date.now();
    activity.lastHumanAt = now;
    activity.lastKind = kind;
    activity.editing = editableTarget(target);
    activity.events.push({ kind, at: now, label: labelOf(target) });
    if (activity.events.length > 32) activity.events.shift();
  };
  const humanEvent = (kind) => (event) => {
    if (!event || event.isTrusted !== true) return;
    noteHuman(kind, event.target);
  };
  const markAgentPoint = (x, y) => {
    const old = document.getElementById('__bb_agent_target');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = '__bb_agent_target';
    host.setAttribute('data-bb-ui', 'agent-target');
    host.setAttribute('data-bb-theme', document.documentElement.getAttribute('data-bb-theme') === 'dark' ? 'dark' : 'light');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:' + Math.round(x) + 'px;top:' + Math.round(y) + 'px;width:0;height:0;z-index:2147483646;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>.r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border:2px solid #2f6fed;border-radius:50%;box-shadow:0 0 0 4px rgba(47,111,237,.22)}.t{position:absolute;left:18px;top:-13px;padding:2px 7px;border-radius:999px;background:#2f6fed;color:#fff;font:600 10px/1.4 system-ui,sans-serif;white-space:nowrap}</style><div class="r"></div><div class="t">Agent</div>';
    document.documentElement.appendChild(host);
    globalThis['set' + 'Timeout'](() => host.remove(), 2000);
  };
  if (isTop) {
    window.addEventListener('pointerdown', (event) => {
      if (!event || event.isTrusted !== true || passes.size === 0) return;
      markAgentPoint(event.clientX, event.clientY);
      try {
        chrome.runtime.sendMessage({ type: 'bb.cooperation.point', x: event.clientX, y: event.clientY }).catch(() => {});
      } catch { /* 扩展上下文失效 */ }
    }, true);
    window.addEventListener('pointerdown', humanEvent('pointer'), true);
    window.addEventListener('keydown', humanEvent('key'), true);
    window.addEventListener('input', humanEvent('input'), true);
    window.addEventListener('change', humanEvent('change'), true);
    window.addEventListener('scroll', humanEvent('scroll'), true);
    window.addEventListener('focusin', humanEvent('focus'), true);
  }
  const secret = (element) => {
    const type = String(element.type || '').toLowerCase();
    const auto = String(element.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || type === 'file' || type === 'hidden' ||
      auto.includes('password') || auto.includes('one-time-code') ||
      auto.includes('cc-number') || auto.includes('cc-csc');
  };
  const readState = () => {
    const fields = [];
    for (const element of document.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
      if (fields.length >= 50) break;
      const sensitive = secret(element);
      fields.push({
        selector: element.id ? '#' + element.id : element.tagName.toLowerCase(),
        label: labelOf(element),
        value: sensitive ? '' : String(element.value != null ? element.value : element.textContent || '').slice(0, 200),
        sensitive,
        checked: element.checked === true,
      });
    }
    const media = [];
    for (const element of document.querySelectorAll('video,audio')) {
      if (media.length >= 10) break;
      media.push({
        selector: element.id ? '#' + element.id : element.tagName.toLowerCase(),
        currentTime: Number(element.currentTime) || 0,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        paused: element.paused === true,
        ended: element.ended === true,
      });
    }
    const active = document.activeElement;
    const editing = Boolean(active && active.matches && active.matches('input,textarea,select,[contenteditable="true"]'));
    const text = document.body ? String(document.body.innerText || '') : '';
    return {
      fields,
      media,
      focus: active && active !== document.body ? labelOf(active) : null,
      editing,
      textLength: text.length,
      textTail: text.slice(-500),
      revision,
      mode: modeFor(),
      activity: {
        lastHumanAt: activity.lastHumanAt,
        lastKind: activity.lastKind,
        editing: activity.editing,
        agentGraceMs: Math.max(0, agentUntil - Date.now()),
        recent: activity.events.slice(-10),
      },
    };
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'bb.cooperation.read') {
      sendResponse({ ok: true, state: readState() });
      return false;
    }
    if (message.type === 'bb.cooperation.block') {
      sendResponse({ ok: true, blocked: setBlocked(message.blocked === true) });
      return false;
    }
    if (message.type === 'bb.cooperation.passthrough') {
      sendResponse({ ok: true, pending: passThrough(message.token, message.active !== false) });
      return false;
    }
    if (message.type === 'bb.cooperation.passthrough-clear') {
      clearPasses();
      apply();
      sendResponse({ ok: true, pending: 0 });
      return false;
    }
    if (message.type === 'bb.cooperation.state') {
      sendResponse({ ok: true, state: { blocked, pending: passes.size, hasBlocker: Boolean(blocker), listening, revision, mode: modeFor() } });
      return false;
    }
    return false;
  });

  // 测试/诊断钩子：只在隔离世界可见，页面主世界拿不到。
  globalThis.__bbCooperation = {
    setBlocked,
    passThrough,
    readState,
    noteHuman,
    snapshot: () => ({ blocked, pending: passes.size, hasBlocker: Boolean(blocker), listening, revision, mode: modeFor() }),
  };
})();
