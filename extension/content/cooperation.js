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
  // 时间戳级归因：Agent 派发输入前登记 expectation，事件 timeStamp（performance 时基）
  // 落在 ±1.5ms 内即视为 Agent，优先于坐标/按键匹配（输入期望时钟）。
  const ATTRIBUTION_TIME_TOLERANCE_MS = 1.5;
  const isTop = window.top === window;
  let blocked = false;
  let blocker = null;
  let listening = false;
  const passes = new Map(); // token -> { expiresAt, timer }
  const activity = { lastHumanAt: 0, lastAgentAt: 0, lastKind: '', editing: false, events: [] };
  let agentUntil = 0;
  let expectation = null;
  let lastAttribution = null;
  let revision = 0;
  let authorityGeneration = 0;
  let inputClock = 0;
  let lastScrollAt = 0;
  const textLog = [];
  let textFloor = 0;
  const acceptGeneration = (generation) => {
    if (!Number.isInteger(Number(generation))) return true;
    if (Number(generation) < authorityGeneration) return false;
    authorityGeneration = Number(generation);
    return true;
  };
  const bump = () => { revision += 1; };
  const frameState = { mutations: 0, structure: 0, textual: 0, childList: 0, attributes: 0, text: 0, scroll: 0, pointer: 0, keyboard: 0, human: 0, startedAt: Date.now() };
  const bumpFrame = (kind, by = 1) => {
    if (!kind) return;
    frameState[kind] = (frameState[kind] || 0) + by;
    bump();
  };
  const focusSensitiveStyles = () => {
    try {
      for (const sheet of Array.from(document.styleSheets || [])) {
        let rules = null;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of Array.from(rules || [])) {
          if (!rule || !rule.selectorText || !rule.style) continue;
          if (!/:focus(?:-visible|-within)?\b/.test(rule.selectorText)) continue;
          if (/(display|visibility|opacity|height|width)/i.test(rule.style.cssText || '')) return true;
        }
      }
    } catch { /* 样式表不可读时按中性处理 */ }
    return false;
  };
  const mediaState = () => {
    try {
      return Array.from(document.querySelectorAll('video,audio')).slice(0, 5).map((el) => ({
        tag: el.tagName.toLowerCase(),
        playing: el.paused === false,
        currentTime: Number.isFinite(el.currentTime) ? Math.round(el.currentTime * 10) / 10 : null,
        duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null,
        muted: el.muted === true,
      }));
    } catch { return []; }
  };
  const observeFrameState = () => {
    if (!document || typeof MutationObserver !== 'function') return;
    try {
      new MutationObserver((records) => {
        let structural = false;
        let textual = false;
        for (const record of records) {
          frameState.mutations += 1;
          if (record.type === 'childList') { frameState.childList += 1; structural = true; }
          else if (record.type === 'attributes') { frameState.attributes += 1; structural = true; }
          else if (record.type === 'characterData') {
            frameState.text += 1;
            textual = true;
            textLog.push({ at: Date.now(), before: String(record.oldValue || '').slice(0, 120), after: String(record.target && record.target.data || '').slice(0, 120) });
            while (textLog.length > 20) { textLog.shift(); textFloor += 1; }
          }
        }
        if (structural) frameState.structure += 1;
        if (textual) frameState.textual += 1;
        if (records.length) bump();
      }).observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch { /* 受限文档不阻塞协作 */ }
    addEventListener('scroll', () => { lastScrollAt = Date.now(); bumpFrame('scroll'); }, { passive: true, capture: true });
  };
  observeFrameState();

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
  const passThrough = (token, active, expect) => {
    if (!isTop || !token) return passes.size;
    const id = String(token);
    const existing = passes.get(id);
    if (active === false) {
      if (existing) clearTimeout(existing.timer);
      passes.delete(id);
      expectation = null;
      bump();
      agentUntil = Math.max(agentUntil, Date.now() + 1500);
      apply();
      return passes.size;
    }
    if (!existing) {
      bump();
      agentUntil = Math.max(agentUntil, Date.now() + 1500);
      if (Array.isArray(expect) && expect.length) {
        expectation = { kinds: expect.map(String), at: Date.now(), perfAt: performance.now() };
      }
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
    if (!isTop) return;
    bump();
    const now = Date.now();
    lastAttribution = { owner: 'human', reason: 'input', kind, at: now };
    activity.lastHumanAt = now;
    activity.lastKind = kind;
    activity.editing = editableTarget(target);
    activity.events.push({ kind, at: now, label: labelOf(target) });
    frameState.human += 1;
    frameState.humanAttributed = (frameState.humanAttributed || 0) + 1;
    inputClock += 1;
    bumpFrame(kind === 'keydown' ? 'keyboard' : 'pointer');
    if (activity.events.length > 32) activity.events.shift();
  };
  const humanEvent = (kind) => (event) => {
    if (!event || event.isTrusted !== true) return;
    const now = Date.now();
    if (expectation && now - expectation.at <= 5000 && Array.isArray(expectation.kinds)) {
      const eventPerf = Number(event.timeStamp);
      const skewMs = Number.isFinite(eventPerf) && Number.isFinite(expectation.perfAt)
        ? eventPerf - expectation.perfAt
        : NaN;
      // 时间戳优先：同一输入派发窗口内 ±1.5ms 的事件直接归 Agent（不要求坐标/按键完全一致）。
      const timeOk = Number.isFinite(skewMs) && Math.abs(skewMs) <= ATTRIBUTION_TIME_TOLERANCE_MS;
      const pointOk = kind !== 'pointer'
        || !Number.isFinite(expectation.x)
        || !Number.isFinite(expectation.y)
        || (Math.abs(Number(event.clientX) - expectation.x) <= 2 && Math.abs(Number(event.clientY) - expectation.y) <= 2);
      const keyOk = kind !== 'key'
        || !expectation.key
        || String(event.key || '') === String(expectation.key);
      if (expectation.kinds.includes(kind) && (timeOk || (pointOk && keyOk))) {
        const reason = timeOk ? 'timestamp' : 'coordinate';
        lastAttribution = {
          owner: 'agent',
          reason,
          kind,
          skewMs: Number.isFinite(skewMs) ? Math.round(skewMs * 100) / 100 : null,
          at: now,
        };
        activity.lastAgentAt = now;
        if (timeOk) frameState.agentAttributedByTimestamp = (frameState.agentAttributedByTimestamp || 0) + 1;
        else frameState.agentAttributedByCoordinate = (frameState.agentAttributedByCoordinate || 0) + 1;
        expectation = null;
        frameState.agentAttributed = (frameState.agentAttributed || 0) + 1;
        inputClock += 1;
        return;
      }
      // 期待窗口内出现了不匹配的输入（类型、时间戳或坐标）：deny-by-default，按人工处理。
      noteHuman(kind, event.target);
      return;
    }
    if (passes.size > 0 || now < agentUntil) {
      activity.lastAgentAt = now;
      lastAttribution = { owner: 'agent', reason: 'grace', kind, skewMs: null, at: now };
      frameState.agentAttributed = (frameState.agentAttributed || 0) + 1;
      inputClock += 1;
      return;
    }
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
    // 滚动可能由 Agent 的 scroll-into-view 触发：只有紧跟人工输入时才计为人工。
    window.addEventListener('scroll', () => {
      if (Date.now() - activity.lastHumanAt <= 1000) noteHuman('scroll', document.documentElement);
    }, true);
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
    const fieldNodes = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]'));
    const fieldsTruncated = fieldNodes.length > 50;
    for (const element of fieldNodes) {
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
      authority: { revision, generation: authorityGeneration },
      mode: modeFor(),
      control: {
        inputLocked: blocked,
        agentActive: passes.size > 0 || Date.now() < agentUntil,
        shared: passes.size > 0,
        humanActive: activity.lastHumanAt > 0 && Date.now() - activity.lastHumanAt < 2500,
        agentGraceMs: Math.max(0, agentUntil - Date.now()),
      },
      frameState: {
        mutations: frameState.mutations,
        structure: frameState.structure || 0,
        textual: frameState.textual || 0,
        childList: frameState.childList,
        attributes: frameState.attributes,
        text: frameState.text,
        scroll: frameState.scroll,
        pointer: frameState.pointer,
        keyboard: frameState.keyboard,
        human: frameState.human,
        agentAttributed: frameState.agentAttributed || 0,
        agentAttributedByTimestamp: frameState.agentAttributedByTimestamp || 0,
        agentAttributedByCoordinate: frameState.agentAttributedByCoordinate || 0,
        timeToleranceMs: ATTRIBUTION_TIME_TOLERANCE_MS,
        attribution: lastAttribution,
        humanAttributed: frameState.humanAttributed || 0,
        inputClock,
        expectationPending: Boolean(expectation),
        lastHumanKind: activity.lastKind,
        focusIsDocument: !active || active === document.body || active === document.documentElement,
        fieldsComplete: !fieldsTruncated,
        scrolling: lastScrollAt > 0 && Date.now() - lastScrollAt < 500,
        texts: textLog.slice(-20),
        textsComplete: textLog.length <= 20,
        document: typeof location !== 'undefined' ? String(location.href || '') : '',
        focusNeutral: !focusSensitiveStyles(),
        media: mediaState(),
        mediaComplete: (() => { try { return document.querySelectorAll('video,audio').length <= 5; } catch { return true; } })(),
        selection: (() => { try { return String((window.getSelection && window.getSelection()) ? window.getSelection().toString() : '').slice(0, 200); } catch { return ''; } })(),
        events: activity.events.slice(-20),
        eventsComplete: activity.events.length <= 20,
        textFloor,
        lastHumanAt: activity.lastHumanAt,
        lastAgentAt: activity.lastAgentAt,
        lastInput: Math.max(activity.lastHumanAt, activity.lastAgentAt),
        busy: passes.size > 0 || Date.now() < agentUntil,
        editing: activity.editing,
        revision,
        startedAt: frameState.startedAt,
      },
      activity: {
        lastHumanAt: activity.lastHumanAt,
        lastAgentAt: activity.lastAgentAt,
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
      if (!acceptGeneration(message.generation)) { sendResponse({ ok: false, stale: true, generation: authorityGeneration }); return false; }
      sendResponse({ ok: true, blocked: setBlocked(message.blocked === true), generation: authorityGeneration });
      return false;
    }
    if (message.type === 'bb.cooperation.expect') {
      const expect = message.expectation || {};
      if (Array.isArray(expect.kinds) && expect.kinds.length) {
        expectation = {
          kinds: expect.kinds.map(String),
          x: Number.isFinite(Number(expect.x)) ? Number(expect.x) : null,
          y: Number.isFinite(Number(expect.y)) ? Number(expect.y) : null,
          key: expect.key != null ? String(expect.key) : '',
          at: Date.now(),
          perfAt: performance.now(),
        };
      }
      sendResponse({ ok: true, expectation: Boolean(expectation) });
      return false;
    }
    if (message.type === 'bb.cooperation.passthrough') {
      if (!acceptGeneration(message.generation)) { sendResponse({ ok: false, stale: true, generation: authorityGeneration }); return false; }
      sendResponse({ ok: true, pending: passThrough(message.token, message.active !== false, message.expectation), generation: authorityGeneration });
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
