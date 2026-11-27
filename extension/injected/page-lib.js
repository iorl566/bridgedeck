// injected/page-lib.js
// 页面侧（ISOLATED world）能力库：observe / snapshot / 动作命令 / 等待探测。
// 通过 chrome.scripting.executeScript(files) 按需补注入，也作为 content script 在 document_start 注入。
// 所有状态挂在 globalThis.__BB_PAGE__（同一 frame 的隔离世界在多次注入间共享），导航后随文档重建。
// 结构索引（同一 IIFE 内顺序）：\
//   §A 状态与 DOM 代数（revision / mutation tracker）      → currentRevision、ensureMutationTracker
//   §B 基础工具（文本 / 可见性 / 角色 / 无障碍名）           → roleOf、accessibleName、statusFlags
//   §C 观察与页面图（VOM / 视觉扫描 / 命中 / 对比度 / graph） → buildObservation、walk、visualScan、hitAt、formatNode
//   §D 目标解析（阻塞层 / 增量观察 / ref→element）           → observe、snapshot、resolveElement
//   §E 动作（click / fill / press / focus / expect / help）  → actionClick、actionFill、actionPress、actionability
//   §F 视觉与等待（坐标点击 / 滚动空闲 / 性能 / human）       → visualRefs、clickPoint、perfMetrics、humanActivity
//   §G 签名与读取（nodeSignature / fieldInfo / actionRead）  → nodeSignatureOf、actionReadFields、actionRead
//   §H 提取（table / list / grid / discover / 预算 / 覆盖度） → tableExtract、listExtract、gridExtract、actionExtract
//   §I 指针 / 拖拽 / 滚轮 / 上传 / fetch                    → actionDrag、actionWheel、actionUpload、actionFetchRun
//   §J 消息分派（handle）与 installHumanWatchers
//
(() => {
  'use strict';

  const KEY = '__BB_PAGE__';
  const LIB_VERSION = 53;
  if (globalThis[KEY] && globalThis[KEY].version >= LIB_VERSION) return;

  const NAME_MAX = 80;
  const TEXT_MAX = 120;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'HEAD', 'SVG', 'MATH',
  ]);
  // 可交互角色：分配 @eN ref
  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton',
    'tab', 'treeitem',
  ]);
  // 需要输出的语义角色（含上面的可交互角色）
  const SEMANTIC_ROLES = new Set([
    ...INTERACTIVE_ROLES,
    'heading', 'paragraph', 'listitem', 'img', 'navigation', 'main', 'form', 'table', 'list',
    'banner', 'contentinfo', 'complementary', 'dialog', 'iframe', 'progressbar', 'separator',
    'group', 'region', 'toolbar', 'document',
    'tree', 'menu', 'menubar', 'tablist', 'row', 'rowheader', 'columnheader', 'gridcell', 'article', 'figure', 'status', 'alert', 'note', 'tooltip',
  ]);
  const TAG_ROLES = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
    NAV: 'navigation',
    MAIN: 'main',
    FORM: 'form',
    IMG: 'img',
    TABLE: 'table',
    LI: 'listitem',
    P: 'paragraph',
    UL: 'list',
    OL: 'list',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    ASIDE: 'complementary',
    DIALOG: 'dialog',
    IFRAME: 'iframe',
    SUMMARY: 'button',
    PROGRESS: 'progressbar',
    HR: 'separator',
    FIELDSET: 'group',
    DETAILS: 'group',
    OPTGROUP: 'group',
    OPTION: 'option',
  };
  const INPUT_ROLES = {
    text: 'textbox',
    search: 'searchbox',
    email: 'textbox',
    url: 'textbox',
    tel: 'textbox',
    password: 'textbox',
    number: 'spinbutton',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    file: 'button',
    color: 'button',
    date: 'textbox',
    'datetime-local': 'textbox',
    month: 'textbox',
    week: 'textbox',
    time: 'textbox',
  };

  const state = {
    version: LIB_VERSION,
    refs: new Map(),
    elRefs: new WeakMap(),
    seq: 0,
    lastObservation: null,
    rowAnchors: new Map(),
    // mutation log：上一次 observe 之后的 DOM/属性/布局变化，用于 unchanged 快路径与增量补丁。
    mutation: { raw: [], layoutDirty: false, interactionDirty: false, started: false, docs: new WeakSet(), loadBound: false },
  };

  // 视觉候选表：index -> element。随文档重建而清空，命中校验按 index 判断"是不是它"。
  const visualState = { candidates: new Map() };

  // ===========================================================================
  // §A 状态与 DOM 代数：revision、变更摘要、MutationObserver
  // ===========================================================================
  function getVisualState() {
    return visualState;
  }

  // 观测代数：DOM 每次变更递增。observe 返回当时的代数，动作可带 expectRevision 要求"同一代数内"。
  const revisionState = { value: 0 };
  function bumpRevision() {
    revisionState.value += 1;
  }
  try {
    new MutationObserver(bumpRevision).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  } catch {
    // 观察器不可用时代数恒为 0，expectRevision 只接受 0
  }
  function currentRevision() {
    return revisionState.value;
  }

  // <mutation-summary>
  function summarizeMutations(records, flags = {}) {
    const counts = { text: 0, added: 0, removed: 0, attributes: 0 };
    for (const record of Array.isArray(records) ? records : []) {
      if (!record) continue;
      if (record.type === 'characterData') counts.text += 1;
      else if (record.type === 'childList') {
        counts.added += Number(record.added) || 0;
        counts.removed += Number(record.removed) || 0;
      } else if (record.type === 'attribute') counts.attributes += 1;
    }
    const total = counts.text + counts.added + counts.removed + counts.attributes;
    return {
      ...counts,
      total,
      structural: counts.added > 0 || counts.removed > 0,
      layout: flags.layout === true,
      interaction: flags.interaction === true,
    };
  }

  function shouldFastUnchanged(snapshot) {
    return !!snapshot && snapshot.total === 0 && snapshot.layout !== true && snapshot.interaction !== true;
  }

  function canIncremental(snapshot, records) {
    return !!snapshot && snapshot.total > 0 && snapshot.structural === false && snapshot.attributes === 0
      && Array.isArray(records) && records.length > 0 && records.every((record) => record && record.type === 'characterData');
  }
  // </mutation-summary>

  function handleMutationRecords(records) {
    const mutation = state.mutation;
    for (const record of records) {
      // 忽略桥自己注入的浮层（documentElement 下），否则每次浮层出现都会被当成结构变化。
      if (record.target && record.target.nodeType === 1 && record.target.closest && record.target.closest('[data-bb-ui="takeover"], #__bb_takeover_host')) continue;
      if (record.type === 'childList') {
        const addedNodes = record.addedNodes ? Array.from(record.addedNodes) : [];
        const removedNodes = record.removedNodes ? Array.from(record.removedNodes) : [];
        const touchesOverlay = addedNodes.concat(removedNodes).some((node) => node && node.nodeType === 1 && ((node.getAttribute && node.getAttribute('data-bb-ui') === 'takeover') || node.id === '__bb_takeover_host' || (node.closest && node.closest('[data-bb-ui="takeover"], #__bb_takeover_host'))));
        if (touchesOverlay) continue;
        if (mutation.raw.length < 200) mutation.raw.push({ type: 'childList', target: record.target, added: addedNodes.length, removed: removedNodes.length });
      } else if (record.type === 'characterData') {
        if (mutation.raw.length < 200) mutation.raw.push({ type: 'characterData', target: record.target });
      } else if (record.type === 'attributes') {
        const name = String(record.attributeName || '');
        // VOM 自己的标记属性不算页面变化。
        if (name.startsWith('data-bb-')) continue;
        if (mutation.raw.length < 200) mutation.raw.push({ type: 'attribute', target: record.target, name });
      }
    }
  }

  function attachMutationObservers() {
    const mutation = state.mutation;
    const attachDoc = (doc, depth) => {
      if (!doc || depth > 4 || mutation.docs.has(doc)) return;
      mutation.docs.add(doc);
      try {
        new MutationObserver(handleMutationRecords).observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
      } catch {
        // 观察器不可用时退回逐次重建
      }
      for (const type of ['input', 'change', 'focusin', 'paste', 'drop']) {
        try {
          doc.addEventListener(type, () => { mutation.interactionDirty = true; }, true);
        } catch {
          // 某些文档不允许监听
        }
      }
      // 滚动/缩放会改变元素的可见性和位置；window 与 document 都挂。
      const win = doc.defaultView;
      for (const target of [win, doc]) {
        if (!target) continue;
        for (const type of ['scroll', 'resize']) {
          try {
            target.addEventListener(type, () => { mutation.layoutDirty = true; }, { capture: true, passive: true });
          } catch {
            // 忽略
          }
        }
      }
      // 同源 iframe 的文档也要观察，否则 iframe 内部变化不会进入 mutation log。
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch { frames = []; }
      for (const frame of frames) {
        try {
          if (frame.contentDocument) attachDoc(frame.contentDocument, depth + 1);
        } catch {
          // 跨源 iframe 不可访问
        }
      }
    };
    attachDoc(document, 0);
    if (!mutation.loadBound) {
      mutation.loadBound = true;
      try {
        document.addEventListener('load', (event) => {
          if (event.target && event.target.tagName === 'IFRAME') attachMutationObservers();
        }, true);
      } catch {
        // 忽略
      }
    }
  }

  function ensureMutationTracker() {
    const mutation = state.mutation;
    if (mutation.started) {
      attachMutationObservers();
      return;
    }
    mutation.started = true;
    attachMutationObservers();
  }

  function takeMutations() {
    const mutation = state.mutation;
    const records = mutation.raw.slice();
    const snapshot = summarizeMutations(records, { layout: mutation.layoutDirty, interaction: mutation.interactionDirty });
    snapshot.records = records;
    mutation.raw = [];
    mutation.layoutDirty = false;
    mutation.interactionDirty = false;
    return snapshot;
  }

  const formerPasswordFields = new WeakSet();
  const sensitiveTokens = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z0-9-]+)(\s|$)/i;
  const sensitiveField = (el) => {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') {
      formerPasswordFields.add(el);
      return true;
    }
    return formerPasswordFields.has(el) || sensitiveTokens.test(String(el.getAttribute('autocomplete') || ''));
  };
  try {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue && record.oldValue.toLowerCase() === 'password' && record.target instanceof Element) {
          formerPasswordFields.add(record.target);
        }
      }
    }).observe(document, { attributes: true, attributeFilter: ['type'], attributeOldValue: true, subtree: true });
  } catch {
    // 观察器不可用时仍按当前 type/autocomplete 判断
  }

  // 稳定 ref：同一个元素在多次 observe 之间复用同一个编号

  // ===========================================================================
  // §B 基础工具：文本/可见性/角色/无障碍名/状态旗标
  // ===========================================================================
  function rowAnchorFor(el) {
    const row = el && el.closest ? el.closest('tr,[role="row"]') : null;
    if (!row) return null;
    const text = normalizeText(row.textContent || '').slice(0, 200);
    return text ? { text, tag: row.tagName } : null;
  }

  // ---------- 虚拟列表行事实（VOM row facts） ----------
  // 契约（与 lib/vom-rows.js / W2 fill/click 的 rowAnchor 一致）：
  //   anchor = { ariaRowIndex, dataIndex, transform, rowKey, rowText, containerScrollTop, recycled }
  // 另有 role/tag 供 classifyVirtualRow 判 kind。仅对“有虚拟化线索”的行产出，静态表格不产出，
  // 避免普通大表把 payload 撑大。
  const ROW_SELECTOR = 'tr,[role="row"],[aria-rowindex],[data-index],[data-row-key],[data-key]';
  const VIRTUAL_ROW_SELECTOR = '[role="grid"],[role="treegrid"],[role="listbox"],[aria-rowcount],[aria-rowindex],[data-index],[data-row-key],[data-key]';
  const ROW_SCROLL_ANCESTOR_LIMIT = 16;
  const ROW_FACT_TEXT_MAX = 200;
  let rowFactsCache = new WeakMap();

  function resetRowFactsCache() {
    rowFactsCache = new WeakMap();
  }

  function rowElementOf(el) {
    if (!el || el.nodeType !== 1 || typeof el.closest !== 'function') return null;
    try {
      return el.closest(ROW_SELECTOR);
    } catch {
      return null;
    }
  }

  function rowIntAttr(el, names) {
    if (!el || el.nodeType !== 1) return null;
    for (const name of names) {
      const raw = normalizeText(el.getAttribute(name) || '');
      if (/^-?\d+$/.test(raw)) return Number(raw);
    }
    return null;
  }

  function rowAriaIndex(row) {
    let node = row;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      const value = rowIntAttr(node, ['aria-rowindex']);
      if (value != null) return value;
      node = node.parentElement;
    }
    return null;
  }

  function rowDataIndex(row) {
    let node = row;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      const value = rowIntAttr(node, ['data-index', 'data-row-index']);
      if (value != null) return value;
      node = node.parentElement;
    }
    return null;
  }

  function rowKeyOf(row) {
    for (const name of ['data-row-key', 'data-key', 'data-id']) {
      const value = normalizeText(row.getAttribute(name) || '');
      if (value) return value.slice(0, 120);
    }
    const id = normalizeText(row.id || '');
    return id ? id.slice(0, 120) : null;
  }

  function rowTransformOf(row) {
    try {
      const transform = getComputedStyle(row).transform;
      return transform ? String(transform).slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  function rowScrollContainerOf(row) {
    let node = row ? row.parentElement : null;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < ROW_SCROLL_ANCESTOR_LIMIT) {
      let style = null;
      try {
        style = getComputedStyle(node);
      } catch {
        style = null;
      }
      if (style && /(auto|scroll)/.test(String(style.overflowX || '') + ' ' + String(style.overflowY || ''))
        && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) {
        return node;
      }
      node = node.parentElement;
      guard += 1;
    }
    return null;
  }

  function rowHasVirtualHints(row) {
    if (!row || row.nodeType !== 1) return false;
    if (row.hasAttribute('aria-rowindex') || row.hasAttribute('data-index') || row.hasAttribute('data-row-index')
      || row.hasAttribute('data-row-key') || row.hasAttribute('data-key') || row.hasAttribute('data-id')) return true;
    const transform = rowTransformOf(row);
    if (transform && transform !== 'none') return true;
    try {
      return Boolean(row.closest(VIRTUAL_ROW_SELECTOR));
    } catch {
      return false;
    }
  }

  function computeRowFacts(row) {
    const rowText = normalizeText(row.textContent || '').slice(0, ROW_FACT_TEXT_MAX);
    const container = rowScrollContainerOf(row);
    const roleAttr = normalizeText(row.getAttribute('role') || '').toLowerCase();
    return {
      ariaRowIndex: rowAriaIndex(row),
      dataIndex: rowDataIndex(row),
      transform: rowTransformOf(row),
      rowKey: rowKeyOf(row),
      rowText: rowText || null,
      // text 是 rowText 的兼容别名：51-key-fill 的旧行守卫按 anchor.text 比对。
      text: rowText || null,
      containerScrollTop: container ? Math.round(container.scrollTop * 10) / 10 : null,
      recycled: false,
      role: roleAttr || (row.tagName === 'TR' ? 'row' : null),
      tag: String(row.tagName || '').toLowerCase(),
    };
  }

  function rowFactsChanged(previous, current) {
    if (!previous || !current) return false;
    const beforeText = previous.rowText != null ? previous.rowText : previous.text;
    if (beforeText !== current.rowText) return true;
    if (previous.rowKey != null && current.rowKey != null && previous.rowKey !== current.rowKey) return true;
    if (previous.ariaRowIndex != null && current.ariaRowIndex != null && previous.ariaRowIndex !== current.ariaRowIndex) return true;
    if (previous.dataIndex != null && current.dataIndex != null && previous.dataIndex !== current.dataIndex) return true;
    if (previous.transform !== current.transform) return true;
    return false;
  }

  /** 当前行事实（每次都重新读）：row-anchor 只读命令用它，避免返回上一次观察的缓存。 */
  function currentRowAnchorOf(el) {
    const row = rowElementOf(el);
    if (!row || !rowHasVirtualHints(row)) return null;
    const facts = computeRowFacts(row);
    const refSeq = state.elRefs.get(el);
    const previous = Number.isInteger(refSeq) ? state.rowAnchors.get(refSeq) : null;
    facts.recycled = rowFactsChanged(previous, facts);
    return facts;
  }

  /** 页面侧行事实生产者：同一观察内缓存；跨观察用 state.rowAnchors 判定 recycled。 */
  function rowFactsOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const cached = rowFactsCache.get(el);
    if (cached !== undefined) return cached;
    const facts = currentRowAnchorOf(el);
    if (facts) {
      const refSeq = state.elRefs.get(el);
      if (Number.isInteger(refSeq)) state.rowAnchors.set(refSeq, facts);
    }
    rowFactsCache.set(el, facts);
    return facts;
  }

  /** 只读命令 row-anchor：动作前取“当前行事实”；无行/非虚拟行返回 anchor:null（fail-closed）。 */
  function rowAnchorProbe(args) {
    const el = resolveElement(args);
    return { anchor: currentRowAnchorOf(el), revision: currentRevision() };
  }

  // ---------- 页面侧 paint/可见性事实（统一 gate 的输入） ----------
  // display/visibility/opacity + 原生 checkVisibility + 祖先 overflow 裁剪，只在这一处归约；
  // 扩展侧 lib/vom-visibility.js 读取这些事实做唯一判定。
  function paintVisibilityOf(el, style) {
    let computed = style || null;
    if (!computed) {
      try {
        computed = getComputedStyle(el);
      } catch {
        computed = null;
      }
    }
    if (!computed) return { paintVisible: null, hiddenReason: null };
    if (computed.display === 'none') return { paintVisible: false, hiddenReason: 'display-none' };
    if (computed.visibility === 'hidden' || computed.visibility === 'collapse') {
      return { paintVisible: false, hiddenReason: 'visibility-hidden' };
    }
    if (Number.parseFloat(computed.opacity) === 0) return { paintVisible: false, hiddenReason: 'opacity-zero' };
    let paintVisible = true;
    try {
      if (typeof el.checkVisibility === 'function') {
        paintVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true;
      }
    } catch {
      paintVisible = true;
    }
    return paintVisible === false
      ? { paintVisible: false, hiddenReason: 'content-hidden' }
      : { paintVisible: true, hiddenReason: null };
  }

  function clipFactsOf(el, rect) {
    if (!el || !rect || !(rect.width > 0) || !(rect.height > 0)) return { clipped: false, clippedBy: null };
    let node = el.parentElement;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < ROW_SCROLL_ANCESTOR_LIMIT) {
      let style = null;
      try {
        style = getComputedStyle(node);
      } catch {
        style = null;
      }
      if (style) {
        const overflow = String(style.overflowX || '') + ' ' + String(style.overflowY || '');
        if (/(hidden|clip|auto|scroll)/.test(overflow)) {
          const box = node.getBoundingClientRect();
          const ix = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left));
          const iy = Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
          if (ix * iy <= 0) {
            return { clipped: true, clippedBy: normalizeText(node.id || '') || String(node.tagName || '').toLowerCase() };
          }
        }
      }
      node = node.parentElement;
      guard += 1;
    }
    return { clipped: false, clippedBy: null };
  }

  function refFor(el) {
    const existing = state.elRefs.get(el);
    if (existing && state.refs.get(existing) === el) return existing;
    state.seq += 1;
    state.refs.set(state.seq, el);
    state.elRefs.set(el, state.seq);
    // 虚拟滚动列表会复用行节点：记录行事实（含 rowText 别名），动作前比对。
    const anchor = rowFactsOf(el);
    if (anchor) {
      state.rowAnchors.set(state.seq, anchor);
    } else {
      const plain = rowAnchorFor(el);
      if (plain) state.rowAnchors.set(state.seq, plain);
    }
    return state.seq;
  }

  // ---------- 基础工具 ----------

  function sleepMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function truncate(value, max) {
    const text = String(value == null ? '' : value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function quoteName(value) {
    return `"${String(value).replace(/"/g, "'")}"`;
  }

  function pageError(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data && typeof data === 'object') error.data = data;
    throw error;
  }

  /** Agent 输入标记：用单调时钟（performance.now）而不是墙钟，睡眠/改系统时间不会误判人工接管。 */
  function markAgentInput() {
    // 只写隔离世界全局：record-capture 与 page-lib 同处扩展 isolated world，页面脚本不可见/不可伪造。
    globalThis.__bbAgentInputAt = performance.now();
  }

  function agentInputRecent() {
    // 用单调时钟判断“刚才是不是 Agent 自己派发的输入”；窗口取 3s（覆盖动作+settle），
    // 避免 trusted 点击/按键产生的 isTrusted 事件被当成人工接管而自动暂停会话。
    const at = Number(globalThis.__bbAgentInputAt || 0);
    return at > 0 && performance.now() - at < 3000;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const ownerWindow = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = ownerWindow.getComputedStyle(node);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number.parseFloat(style.opacity) === 0) return false;
      node = node.parentElement;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = normalizeText(el.getAttribute('role') || '').toLowerCase().split(/\s+/)[0];
    if (explicit === 'none' || explicit === 'presentation') return null;
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = normalizeText(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      return INPUT_ROLES[type] || 'textbox';
    }
    if (tag === 'A' && !el.hasAttribute('href')) return null;
    if (tag === 'SELECT') {
      return el.multiple || Number(el.getAttribute('size') || 0) > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'IMG') {
      return normalizeText(el.getAttribute('alt') || '') ? 'img' : null;
    }
    if (tag === 'SECTION' || tag === 'ARTICLE') {
      return normalizeText(el.getAttribute('aria-label') || '') || el.hasAttribute('aria-labelledby')
        ? 'region'
        : null;
    }
    if (tag === 'DIV' || tag === 'SPAN' || tag === 'LI' || tag === 'I' || tag === 'LABEL') {
      const cls = typeof el.className === 'string' ? el.className : '';
      const clickable = el.hasAttribute('aria-pressed')
        || el.hasAttribute('aria-haspopup')
        || /(^|[\s-])(btn|button)([\s-]|$)/i.test(cls)
        || (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0);
      if (clickable) {
        const text = normalizeText(el.textContent || '').slice(0, 40);
        if (text || el.getAttribute('aria-label')) return 'button';
      }
    }
    return TAG_ROLES[tag] || null;
  }

  // 容器角色：名称只取 aria-label/labelledby/title，不能拿子节点文本（否则噪声很大）
  const CONTAINER_ROLES = new Set([
    'navigation', 'main', 'form', 'table', 'list', 'banner', 'contentinfo', 'complementary',
    'dialog', 'group', 'region', 'toolbar',
  ]);
  // 表单控件：名称不走 textContent（select 的 option 文本不是它的名字），优先 label
  const FORM_CONTROL_ROLES = new Set([
    'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch',
  ]);

  // ---------- aria 关系事实（关系图 v3 的页面侧证据） ----------

  const LABELLED_BY_CHAIN_DEPTH = 3;

  /**
   * aria-labelledby 链：直接目标 + 目标自身 aria-labelledby 的继续展开（最多 3 跳）。
   * 返回 [{id, depth, from, text}]；关系图用 depth≥2 的跳生成 aria-labelledby-chain 关系。
   */
  function labelledByChainOf(el) {
    const raw = normalizeText(el.getAttribute('aria-labelledby') || '');
    if (!raw) return null;
    const out = [];
    const seen = new Set();
    if (el.id) seen.add(String(el.id));
    const queue = [];
    for (const id of raw.split(/\s+/).filter(Boolean)) queue.push({ id, depth: 1, from: null });
    while (queue.length) {
      const item = queue.shift();
      if (!item || !item.id || item.depth > LABELLED_BY_CHAIN_DEPTH) continue;
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      let target = null;
      try {
        target = document.getElementById(item.id);
      } catch {
        target = null;
      }
      if (!target) continue;
      out.push({
        id: String(item.id),
        depth: item.depth,
        from: item.from,
        text: truncate(normalizeText(target.textContent || ''), 80) || null,
      });
      const nested = normalizeText(target.getAttribute('aria-labelledby') || '');
      if (!nested) continue;
      for (const nestedId of nested.split(/\s+/).filter(Boolean)) {
        queue.push({ id: nestedId, depth: item.depth + 1, from: String(item.id) });
      }
    }
    return out.length ? out : null;
  }

  /**
   * 表格结构事实（表头单元格/数据行数/题注）：原生 <th> 不会作为节点被遍历到，
   * 但表格节点自身可以一次读出，供 lib/vom-context.js 的表格分组使用。
   */
  function tableFactsOf(el) {
    if (!el || el.nodeType !== 1 || String(el.tagName || '').toUpperCase() !== 'TABLE') return null;
    const role = normalizeText(el.getAttribute('role') || '').toLowerCase();
    if (role && !['table', 'grid', 'treegrid'].includes(role)) return null;
    const headers = [];
    let cells = 0;
    try {
      cells = el.querySelectorAll('th,[role="columnheader"],[role="rowheader"]').length;
    } catch {
      cells = 0;
    }
    if (cells) {
      let index = 0;
      for (const cell of el.querySelectorAll('th,[role="columnheader"],[role="rowheader"]')) {
        if (index >= 12) break;
        index += 1;
        const name = truncate(normalizeText(cell.textContent || ''), 80);
        if (!name) continue;
        const cellRole = normalizeText(cell.getAttribute('role') || '').toLowerCase()
          || (String(cell.tagName || '').toUpperCase() === 'TH' ? 'columnheader' : 'cell');
        headers.push({ role: cellRole, name, id: cell.id || null });
      }
    }
    let dataRows = 0;
    try {
      const bodies = el.tBodies ? Array.from(el.tBodies) : [];
      dataRows = bodies.reduce((sum, body) => sum + (body.rows ? body.rows.length : 0), 0);
      if (!bodies.length && el.rows) dataRows = Math.max(0, el.rows.length - (el.tHead ? 1 : 0));
    } catch {
      dataRows = 0;
    }
    let caption = null;
    try {
      const captionEl = el.querySelector('caption');
      if (captionEl) caption = truncate(normalizeText(captionEl.textContent || ''), 120) || null;
    } catch {
      caption = null;
    }
    return {
      headers,
      headerCount: headers.length,
      dataRows,
      caption,
      hasHeaderRow: headers.length > 0,
    };
  }

  function accessibleName(el, role) {
    const ariaLabel = normalizeText(el.getAttribute('aria-label') || '');
    if (ariaLabel) return ariaLabel;
    const labelledBy = normalizeText(el.getAttribute('aria-labelledby') || '');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? target.textContent : '';
      });
      const joined = normalizeText(parts.join(' '));
      if (joined) return joined;
    }
    const title = normalizeText(el.getAttribute('title') || '');
    if (CONTAINER_ROLES.has(role)) return title;
    if (FORM_CONTROL_ROLES.has(role)) {
      // 表单控件常见：<label for> / 包裹 label
      if (typeof el.labels !== 'undefined' && el.labels && el.labels.length) {
        const labelText = normalizeText(el.labels[0].textContent || '');
        if (labelText) return labelText;
      }
      const placeholder = normalizeText(el.getAttribute('placeholder') || '');
      if (placeholder) return placeholder;
      if (title) return title;
      const name = normalizeText(el.getAttribute('name') || '');
      if (name) return name;
      return '';
    }
    const text = normalizeText(el.textContent || '');
    if (text) return text;
    if (role === 'img') {
      const alt = normalizeText(el.getAttribute('alt') || '');
      if (alt) return alt;
    }
    if (typeof el.labels !== 'undefined' && el.labels && el.labels.length) {
      const labelText = normalizeText(el.labels[0].textContent || '');
      if (labelText) return labelText;
    }
    const placeholder = normalizeText(el.getAttribute('placeholder') || '');
    if (placeholder) return placeholder;
    if (title) return title;
    const name = normalizeText(el.getAttribute('name') || '');
    if (name) return name;
    return '';
  }

  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

  /** 裸输入控件的前置静态标题（"[field: 邮箱]"）：只在没有无障碍名/placeholder 时兜底。 */
  function boundFieldLabel(el, role, ctx) {
    if (el.tagName === 'SELECT' || el.tagName === 'BUTTON' || el.tagName === 'A') return '';
    if (!FIELD_ROLES.has(role) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return '';
    // 自绘控件自带文字（如 role=combobox 的 div）时不要再去绑前置标题。
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && normalizeText(el.textContent || '')) return '';
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('aria-describedby')) return '';
    if (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name')) return '';
    if (typeof el.labels !== 'undefined' && el.labels && el.labels.length) return '';
    const captionOf = (node) => {
      if (!node || node.nodeType !== 1) return '';
      if (ctx.consumedCaptions.has(node)) return '';
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON|A|IMG|VIDEO|CANVAS|IFRAME)$/i.test(node.tagName)) return '';
      // 整行表单一类的容器（内含控件）不是标题，别把 options 文本绑进来。
      if (node.querySelector && node.querySelector('input,select,textarea,button,[role="button"],[role="combobox"]')) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const text = normalizeText(node.textContent || '');
      if (!text || text.length > 40) return '';
      return text;
    };
    let previous = el.previousElementSibling;
    let guard = 0;
    while (previous && guard < 3) {
      const text = captionOf(previous);
      if (text) {
        ctx.consumedCaptions.add(previous);
        return text;
      }
      previous = previous.previousElementSibling;
      guard += 1;
    }
    // 有的表单把标题放在父级的前一个兄弟里。
    const parent = el.parentElement;
    if (parent && parent.previousElementSibling) {
      const text = captionOf(parent.previousElementSibling);
      if (text) {
        ctx.consumedCaptions.add(parent.previousElementSibling);
        return text;
      }
    }
    return '';
  }

  function statusFlags(el, role, ctx, name) {
    const flags = [];
    if (role === 'heading') {
      const tagLevel = /^H([1-6])$/.exec(el.tagName);
      const ariaLevel = Number.parseInt(el.getAttribute('aria-level') || '', 10);
      const level = Number.isInteger(ariaLevel) ? ariaLevel : tagLevel ? Number(tagLevel[1]) : null;
      if (level) flags.push(`[level=${level}]`);
    }
    const ariaDisabled = normalizeText(el.getAttribute('aria-disabled') || '').toLowerCase();
    if (el.disabled === true || ariaDisabled === 'true') flags.push('[disabled]');
    const checked = typeof el.checked === 'boolean' ? el.checked : null;
    const ariaChecked = normalizeText(el.getAttribute('aria-checked') || '').toLowerCase();
    if (checked === true || ariaChecked === 'true') flags.push('[checked]');
    else if (ariaChecked === 'mixed') flags.push('[checked=mixed]');
    const expanded = normalizeText(el.getAttribute('aria-expanded') || '').toLowerCase();
    if (expanded === 'true') flags.push('[expanded]');
    const haspopup = normalizeText(el.getAttribute('aria-haspopup') || '').toLowerCase();
    if (haspopup && haspopup !== 'false') flags.push('[has-submenu]');
    const draggable = el.draggable === true || normalizeText(el.getAttribute('draggable') || '').toLowerCase() === 'true';
    if (draggable) flags.push('[draggable]');
    const dragHandle =
      el.hasAttribute('data-drag-handle') ||
      normalizeText(el.getAttribute('data-drag-handle') || '').toLowerCase() === 'true' ||
      (el.className && /(^|\s)(drag-handle|draghandle|dragHandle)(\s|$)/.test(String(el.className)));
    if (dragHandle) flags.push('[drag-handle]');
    const dropTarget =
      el.hasAttribute('data-drop-target') ||
      normalizeText(el.getAttribute('data-drop-target') || '').toLowerCase() === 'true' ||
      (el.className && /(^|\s)(drop-target|dropzone)(\s|$)/.test(String(el.className)));
    if (dropTarget) flags.push('[drop-target]');
    const roleName = normalizeText(el.getAttribute('role') || '').toLowerCase();
    // 原生 <select> 内联可见选项（最多 10 个），* 标记当前选中项，方便按 label 直接选择。
    if (el.tagName === 'SELECT' && el.multiple !== true) {
      const choices = Array.from(el.options).slice(0, 10).map((option) => {
        const label = truncate(normalizeText(option.textContent || ''), 40).replace(/"/g, "'");
        const value = truncate(String(option.value || ''), 40).replace(/"/g, "'");
        const marked = option.selected ? '*' : '';
        return value && value !== label ? `${value}="${label}"${marked}` : `"${label}"${marked}`;
      });
      if (choices.length) flags.push(`[options: ${choices.join(' | ')}]`);
    }
    // 自绘下拉不是 <select>：select 命令选不了，明确告诉调用方要点开。
    if (role === 'combobox' && el.tagName !== 'SELECT') {
      const open = normalizeText(el.getAttribute('aria-expanded') || '').toLowerCase() === 'true';
      flags.push(open ? '[custom-dropdown: expanded]' : '[custom-dropdown: click to open]');
    }
    // 裸输入框没有名字时，把前置静态标题绑上（"[field: 邮箱]"）。
    if (!name && ctx) {
      const fieldLabel = boundFieldLabel(el, role, ctx);
      if (fieldLabel) flags.push('[field: "' + fieldLabel.replace(/"/g, "'") + '"]');
    }
    if ((roleName === 'option' || roleName === 'tab' || roleName === 'listitem' || roleName === 'treeitem') && el.className) {
      if (/(^|\s)(selected|is-selected|active)(\s|$)/.test(String(el.className))) flags.push('[selected:class]');
    }
    const dataSelected = normalizeText(el.getAttribute('data-selected') || '').toLowerCase();
    if (dataSelected === 'true') flags.push('[selected:data]');
    const selected =
      el.selected === true || normalizeText(el.getAttribute('aria-selected') || '').toLowerCase() === 'true';
    if (selected) flags.push('[selected]');
    const required =
      el.required === true || normalizeText(el.getAttribute('aria-required') || '').toLowerCase() === 'true';
    if (required) flags.push('[required]');
    return flags;
  }

  // ---------- affordance / layer 页面侧事实（26/27/30 共用） ----------

  /** 真实 Chromium top-layer 探测：modal dialog / popover / fullscreen。 */
  function topLayerKindOf(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (document.fullscreenElement === el) return 'fullscreen';
    } catch {
      // 忽略
    }
    try {
      if (el.matches(':popover-open')) return 'popover';
    } catch {
      // 旧内核不支持 :popover-open
    }
    if (el.tagName === 'DIALOG') {
      const open = el.open === true || el.hasAttribute('open');
      if (!open) return null;
      let modal = false;
      try {
        modal = el.matches(':modal');
      } catch {
        modal = false;
      }
      return modal ? 'modal-dialog' : 'dialog';
    }
    const role = normalizeText(el.getAttribute('role') || '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return 'role-dialog';
    return null;
  }

  /** 单个元素的计算样式层事实：position/z-index/top-layer/指针与 DIP 矩形。 */
  function layerFactsOf(el) {
    if (!el || el.nodeType !== 1) return null;
    let style = null;
    try {
      style = getComputedStyle(el);
    } catch {
      return null;
    }
    if (!style) return null;
    const zIndexRaw = normalizeText(style.zIndex || '');
    const rect = el.getBoundingClientRect();
    return {
      position: style.position || null,
      zIndex: /^-?\d+$/.test(zIndexRaw) ? Number(zIndexRaw) : null,
      topLayer: topLayerKindOf(el),
      pointerEvents: style.pointerEvents || null,
      display: style.display || null,
      visibility: style.visibility || null,
      opacity: style.opacity || null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  // ===========================================================================
  // §C 观察与页面图：VOM markers、walk/nodeBrief、视觉扫描、命中、对比度、graph
  // ===========================================================================
  function probeHoverEntries(el) {
    const selector =
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="menu"] a';
    const roots = [];
    const controls = normalizeText(el.getAttribute('aria-controls') || '');
    for (const id of controls.split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(id);
      if (target) roots.push(target);
    }
    // 常见实现：菜单紧跟触发器作为兄弟节点；没有 aria-controls 时退化为看兄弟/自身
    if (!roots.length && el.nextElementSibling) roots.push(el.nextElementSibling);
    if (!roots.length) roots.push(el);
    const names = [];
    for (const root of roots) {
      const candidates = root.matches && root.matches(selector) ? [root] : root.querySelectorAll(selector);
      for (const candidate of candidates) {
        const text = normalizeText(candidate.textContent || '');
        if (!text) continue;
        const name = truncate(text, 40);
        if (!names.includes(name)) names.push(name);
        if (names.length >= 5) break;
      }
      if (names.length >= 5) break;
    }
    return names;
  }

  // ---------- observe / snapshot ----------

  /** 清理 observe 临时标记（含 open shadow / 同源 iframe）。 */
  function clearVomMarkers() {
    let removed = 0;
    function walk(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      for (const el of root.querySelectorAll('[data-bb-vom]')) {
        el.removeAttribute('data-bb-vom');
        removed += 1;
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            if (el.contentDocument) walk(el.contentDocument);
          } catch {
            // 跨源 iframe 不可访问
          }
        }
      }
    }
    walk(document);
    return { removed };
  }

  function buildObservation(options) {
    const withRefs = !!options.withRefs;
    const probeHover = !!options.probeHover;
    const walkStartedAt = performance.now();
    if (options.markVom) clearVomMarkers();
    if (withRefs) {
      // 清掉已脱离文档的旧 ref，保留仍可用的编号，保证多次 observe 稳定
      for (const [refId, el] of state.refs) {
        if (!el.isConnected) {
          state.refs.delete(refId);
          state.elRefs.delete(el);
        }
      }
    }
    const lines = [];
    const lineMap = [];
    const mark = (node, depth) => { lineMap.push({ node, depth, index: lines.length - 1 }); };
    const title = normalizeText(document.title || '');
    if (!options.only) {
      lines.push(title ? `- document ${quoteName(truncate(title, NAME_MAX))}` : '- document');
    }
    const maxDepth = Number(options.maxDepth);
    const ctx = {
      lines, withRefs, probeHover, refs: 0, nodes: options.collectNodes ? [] : null, paintSeq: 0,
      markVom: !!options.markVom, vomSeq: 0,
      graph: options.collectGraph ? createGraph() : null,
      maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 0, truncated: false,
      surfaces: { iframes: 0, shadows: 0 }, consumedCaptions: new Set(),
      funnel: { visited: 0, hidden: 0, stealth: 0, skippedTag: 0, emitted: 0, refs: 0, truncated: false, ms: { visibility: 0, stealth: 0 }, walkMs: 0 },
    };

    // 提示注入剥离：隐藏不可交互的"视觉不可见"子树（opacity/字号/尺寸/离屏），保留可交互控件。
  const STEALTH_INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);
  function stealthInteractive(el) {
    if (STEALTH_INTERACTIVE.has(el.tagName)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'textbox', 'combobox'].includes(role)) return true;
    if (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0) return true;
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable === true) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    if (el.getAttribute('aria-labelledby') || el.getAttribute('aria-describedby')) return true;
    return false;
  }
  // sr-only / visually-hidden 是给读屏和 aria 用的，不能当注入剥掉。
  function isSrOnly(el) {
    const cls = String(el.className || '');
    return /(^|\s)(sr-only|visually-hidden|screen-reader-text|a11y-hidden|sr_only)(\s|$)/i.test(cls);
  }
  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true;
    }
    return false;
  }
  function gradientClipText(style) {
    const clip = String(style.webkitBackgroundClip || style.backgroundClip || '').toLowerCase();
    return clip === 'text' && /gradient|url\(/i.test(String(style.backgroundImage || ''));
  }
  function hasInnerScroll(node) {
    let el = node;
    let depth = 0;
    while (el && el.nodeType === 1 && depth < 8) {
      const style = getComputedStyle(el);
      const overflow = style.overflowX + style.overflowY;
      if (/(auto|scroll)/.test(overflow)
        && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return true;
      el = el.parentElement;
      depth += 1;
    }
    return false;
  }
  function stealthHidden(el) {
    const style = getComputedStyle(el);
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return true;
    const fontSize = Number.parseFloat(style.fontSize || '0');
    if (Number.isFinite(fontSize) && fontSize > 0 && fontSize <= 1.5) return true;
    const rect = el.getBoundingClientRect();
    // sr-only 常见做法是 1px 裁切；这类节点保留，否则会丢掉 accessible name 的文本来源。
    if (rect.width < 2 && rect.height < 2 && !isSrOnly(el)) return true;
    const margin = 5000;
    if (rect.right < -margin || rect.bottom < -margin) return true;
    if (rect.left > (window.innerWidth || 0) + margin || rect.top > (window.innerHeight || 0) + margin) return true;
    // text-indent 把字挪出可视区：有内层滚动容器的真实长行不算。
    const textIndent = Number.parseFloat(String(style.textIndent || '0'));
    if (Number.isFinite(textIndent) && textIndent <= -1000 && !hasInnerScroll(el.parentElement)) return true;
    // 零对比度 / 完全透明文字：只对直接含文本、非 sr-only、非渐变裁剪标题的节点做，
    // 避免把每个容器都拉去做取色。取色复用 AX 探针的 canvas 归一化，天然覆盖 oklch/color-mix。
    if (hasDirectText(el) && !isSrOnly(el) && !gradientClipText(style)) {
      let foreground = null;
      try { foreground = parseCssColor(style.color); } catch { foreground = null; }
      if (foreground && foreground.a < 0.05) return true;
      if (foreground) {
        try {
          const background = effectiveBackgroundColor(el);
          const solid = compositeColor(foreground, background);
          if (contrastRatio(solid, background) <= 1.05) return true;
        } catch { /* 取色失败时保留，宁可多留 */ }
      }
    }
    return false;
  }
  function walk(el, depth) {
      if (!el || el.nodeType !== 1) return;
      ctx.funnel.visited += 1;
      if (ctx.maxDepth && depth > ctx.maxDepth) { ctx.truncated = true; ctx.funnel.truncated = true; return; }
      if (el.tagName === 'IFRAME') ctx.surfaces.iframes += 1;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) { ctx.funnel.skippedTag += 1; return; }
      const visibleAt = performance.now();
      const visible = isVisible(el);
      ctx.funnel.ms.visibility += performance.now() - visibleAt;
      if (!visible) { ctx.funnel.hidden += 1; return; }
      const stealthAt = performance.now();
      const stealth = !stealthInteractive(el) && stealthHidden(el);
      ctx.funnel.ms.stealth += performance.now() - stealthAt;
      if (stealth) { ctx.funnel.stealth += 1; return; }
      if (isGridNode(el)) {
        const cols = gridHeaderCells(el).map(function (cell) { return normalizeText(cell.textContent || ''); }).filter(Boolean);
        const gridLine = '  '.repeat(depth) + '- grid' + (cols.length ? ' ' + quoteName(truncate(cols.join(' | '), NAME_MAX)) : '');
        lines.push(gridLine);
        mark(el, depth);
        const entries = gridRowEntries(el).slice(0, 200);
        const small = entries.length <= 8 && cols.length <= 8;
        if (small) {
          for (const entry of entries) {
            for (const cell of entry.cells) {
              const text = normalizeText(cell.textContent || '');
              if (!text) continue;
              let line = '  '.repeat(depth + 1) + '- cell ' + quoteName(truncate(text, NAME_MAX));
              if (ctx.withRefs) {
                const refId = refFor(cell);
                ctx.refs += 1;
                line += ' [@e' + refId + ']';
              }
              lines.push(line);
              mark(cell, depth + 1);
            }
          }
        }
        // 只读大表折叠：超过 40 行且行内没有可交互元素时，只保留前 40 行并标注剩余数量。
        const readOnlyRows = entries.length > 40 && !entries.some((entry) => entry.row.querySelector && entry.row.querySelector('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]'));
        const rowInteractive = (row) => !!(row && row.querySelector && row.querySelector('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex],[contenteditable="true"]'));
        const rowText = (entry) => entry.cells.map(function (cell) { return normalizeText(cell.textContent || ''); }).filter(Boolean).join(' | ');
        let emittedRows = 0;
        if (entries.length > 12) {
          // 连续 ≥3 条纯只读行压成一行管道分隔文本；可交互行保持逐行 + ref。
          let index = 0;
          while (index < entries.length) {
            const text = rowText(entries[index]);
            if (!text) { index += 1; continue; }
            if (rowInteractive(entries[index].row)) {
              let line = '  '.repeat(depth + 1) + '- row ' + quoteName(truncate(text, NAME_MAX));
              if (ctx.withRefs) {
                const refId = refFor(entries[index].row);
                ctx.refs += 1;
                line += ' [@e' + refId + ']';
              }
              lines.push(line);
              mark(entries[index].row, depth + 1);
              emittedRows += 1;
              index += 1;
              continue;
            }
            let end = index;
            while (end < entries.length && rowText(entries[end]) && !rowInteractive(entries[end].row)) end += 1;
            const run = end - index;
            if (run >= 3) {
              const compact = entries.slice(index, end).map(rowText).filter(Boolean).join(' | ');
              lines.push('  '.repeat(depth + 1) + '- rows ' + (index + 1) + '–' + end + '（只读）: ' + quoteName(truncate(compact, NAME_MAX * 2)));
              mark(el, depth + 1);
              emittedRows += run;
              index = end;
              continue;
            }
            // 短 run 仍逐行输出，保留行 ref。
            for (let cursor = index; cursor < end; cursor += 1) {
              const singleText = rowText(entries[cursor]);
              if (!singleText) continue;
              let line = '  '.repeat(depth + 1) + '- row ' + quoteName(truncate(singleText, NAME_MAX));
              if (ctx.withRefs) {
                const refId = refFor(entries[cursor].row);
                ctx.refs += 1;
                line += ' [@e' + refId + ']';
              }
              lines.push(line);
              mark(entries[cursor].row, depth + 1);
              emittedRows += 1;
            }
            index = end;
          }
        } else {
          for (const entry of entries) {
            const text = rowText(entry);
            if (!text) continue;
            if (readOnlyRows && emittedRows >= 40) break;
            emittedRows += 1;
            let line = '  '.repeat(depth + 1) + '- row ' + quoteName(truncate(text, NAME_MAX));
            if (ctx.withRefs) {
              const refId = refFor(entry.row);
              ctx.refs += 1;
              line += ' [@e' + refId + ']';
            }
            lines.push(line);
            mark(entry.row, depth + 1);
          }
        }
        if (readOnlyRows && emittedRows < entries.length) {
          lines.push('  '.repeat(depth + 1) + '- …（只读表格，其余 ' + (entries.length - emittedRows) + ' 行已折叠）');
        }
        return;
      }
      if (tag === 'TD' || tag === 'TH') {
        const table = el.closest ? el.closest('table') : null;
        const tableClass = table && typeof table.className === 'string' ? table.className : '';
        const tableLabel = table ? normalizeText(table.getAttribute('aria-label') || '') : '';
        if (/calendar/i.test(tableClass) || /calendar|日历/i.test(tableLabel)) {
          const cellText = normalizeText(el.textContent || '');
          if (cellText) {
            let line = '  '.repeat(depth) + '- cell ' + quoteName(truncate(cellText, NAME_MAX));
            if (ctx.withRefs) {
              const refId = refFor(el);
              ctx.refs += 1;
              line += ' [@e' + refId + ']';
            }
            lines.push(line);
            mark(el, depth);
          }
          return;
        }
      }
      const role = roleOf(el);
      let emitted = false;
      if (role && SEMANTIC_ROLES.has(role)) {
        lines.push(formatNode(el, role, depth, ctx));
        mark(el, depth);
        emitted = true;
        if (tag === 'IFRAME') {
        // 同源 iframe：继续遍历内部文档；跨源时只能保留占位。
        let frameDoc = null;
        try {
          frameDoc = el.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (frameDoc && frameDoc.body) {
          for (const child of frameDoc.body.children) walk(child, depth + 1);
        }
        return;
      }
      }
      if (role === 'table' && tag === 'TABLE' && ctx.withRefs) {
        // table row refs：数据表按行暴露 ref，配合单元格内的链接 ref 一起使用
        const bodyRows = el.tBodies && el.tBodies.length
          ? Array.from(el.tBodies).flatMap(function (body) { return Array.from(body.rows); })
          : Array.from(el.rows || []).slice(1);
        for (const row of bodyRows.slice(0, 60)) {
          const text = normalizeText(row.textContent || '');
          if (!text) continue;
          let line = '  '.repeat(depth + 1) + '- row ' + quoteName(truncate(text, NAME_MAX));
          const refId = refFor(row);
          ctx.refs += 1;
          line += ' [@e' + refId + ']';
          lines.push(line);
          mark(row, depth + 1);
        }
      }
      const childDepth = emitted ? depth + 1 : depth;
      const children = el.children;
      for (let i = 0; i < children.length; i += 1) walk(children[i], childDepth);
      // shadow DOM：open 模式的影子树也要出现在观察与 ref 表里
      if (el.shadowRoot) {
        ctx.surfaces.shadows += 1;
        const shadowChildren = el.shadowRoot.children;
        for (let i = 0; i < shadowChildren.length; i += 1) walk(shadowChildren[i], childDepth);
      }
    }

    if (options.only) {
      walk(options.only.node, options.only.depth);
      ctx.funnel.walkMs = performance.now() - walkStartedAt;
      return { lines, refs: ctx.refs, nodes: ctx.nodes || [], lineMap, graph: snapshotGraph(ctx.graph), stats: finishFunnel(ctx, lines) };
    }
    if (document.body) {
      for (const child of document.body.children) walk(child, 1);
    }
    if (ctx.truncated) lines.push('- …（已按 --max-depth ' + ctx.maxDepth + ' 截断更深层）');
    if (options.debugSurfaces) lines.push('- surfaces iframes=' + ctx.surfaces.iframes + ' open-shadow=' + ctx.surfaces.shadows);
    ctx.funnel.walkMs = performance.now() - walkStartedAt;
    return { lines, refs: ctx.refs, nodes: ctx.nodes || [], lineMap, graph: snapshotGraph(ctx.graph), stats: finishFunnel(ctx, lines) };
  }

  function estimateLineTokens(text) {
    const value = String(text == null ? '' : text);
    let tokens = 0;
    let latinRun = 0;
    const flushLatin = () => {
      if (latinRun > 0) { tokens += latinRun <= 3 ? 1 : Math.ceil(latinRun / 3.6); latinRun = 0; }
    };
    for (const ch of value) {
      if (/[A-Za-z0-9_]/.test(ch)) { latinRun += 1; continue; }
      flushLatin();
      if (/\s/.test(ch)) tokens += 0.25;
      else if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) tokens += 0.76;
      else if (/[\u3040-\u30ff\uac00-\ud7af]/.test(ch)) tokens += 0.6;
      else tokens += 0.5;
    }
    flushLatin();
    return Math.max(1, Math.round(tokens));
  }

  function finishFunnel(ctx, lines) {
    const funnel = ctx.funnel || {};
    let tokens = 0;
    let maxLineTokens = 0;
    for (const line of lines) {
      const cost = estimateLineTokens(line);
      tokens += cost;
      if (cost > maxLineTokens) maxLineTokens = cost;
    }
    const walkMs = Number(funnel.walkMs) || 0;
    const visibilityMs = Number(funnel.ms && funnel.ms.visibility) || 0;
    const stealthMs = Number(funnel.ms && funnel.ms.stealth) || 0;
    return {
      visited: Number(funnel.visited) || 0,
      hidden: Number(funnel.hidden) || 0,
      stealth: Number(funnel.stealth) || 0,
      skippedTag: Number(funnel.skippedTag) || 0,
      emitted: lines.length,
      refs: Number(ctx.refs) || 0,
      truncated: funnel.truncated === true || ctx.truncated === true,
      iframes: Number(ctx.surfaces && ctx.surfaces.iframes) || 0,
      tokens: tokens,
      lineTokens: tokens,
      maxLineTokens,
      ms: {
        walk: Math.round(walkMs * 10) / 10,
        visibility: Math.round(visibilityMs * 10) / 10,
        stealth: Math.round(stealthMs * 10) / 10,
        semantics: Math.max(0, Math.round((walkMs - visibilityMs - stealthMs) * 10) / 10),
      },
    };
  }

  /** VOM：被遮挡时可读的遮挡者摘要（只用于诊断，不参与动作）。 */
  function nodeBrief(el) {
    if (!el || el.nodeType !== 1) return null;
    const role = roleOf(el) || '';
    return {
      tag: String(el.tagName || '').toLowerCase(),
      role: role || null,
      id: el.id || null,
      name: truncate(accessibleName(el, role), 60) || null,
    };
  }

  /**
   * VOM 命中测试：取元素可见区域中心点做 elementFromPoint。
   * 返回 self/descendant/ancestor 表示可命中；blocked 表示被其他元素挡住；
   * pointer-events-none/offscreen/empty/none/unknown 表示不可命中原因。
   */
  function hitTestNode(el, rect, style) {
    if (style.pointerEvents === 'none') return { state: 'pointer-events-none', by: null };
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    if (!vw || !vh) return { state: 'unknown', by: null };
    if (!(rect.width > 0 && rect.height > 0)) return { state: 'empty', by: null };
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return { state: 'offscreen', by: null };
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, vw);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, vh);
    if (right <= left || bottom <= top) return { state: 'offscreen', by: null };
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    let root = doc;
    try {
      if (el.getRootNode) {
        const candidate = el.getRootNode();
        if (candidate && typeof candidate.elementFromPoint === 'function') root = candidate;
      }
    } catch {
      // shadow/iframe 边界异常时退回文档级命中
    }
    let hit = null;
    try {
      hit = root.elementFromPoint(x, y);
    } catch {
      hit = null;
    }
    if (!hit) return { state: 'none', by: null };
    if (hit === el) return { state: 'self', by: null };
    if (el.contains && el.contains(hit)) return { state: 'descendant', by: null };
    // shadow DOM 会在文档级 elementFromPoint 上 retarget 到 host；host 是祖先不算遮挡
    if (hit.contains && hit.contains(el)) return { state: 'ancestor', by: null };
    if (hit.shadowRoot && hit.shadowRoot.contains && hit.shadowRoot.contains(el)) return { state: 'ancestor', by: null };
    return { state: 'blocked', by: nodeBrief(hit), byOwnOverlay: isOwnOverlayNode(hit), byLayer: layerFactsOf(hit) };
  }

  /**
   * 视觉候选扫描：把 canvas / 图片 / 自绘区域列成可引用的目标。
   * 先有"区域"这个对象，再谈坐标；坐标永远相对某个候选，
   * 命中校验也才有"是不是它"可判。只报告几何与类型，不判断内容是什么。
   */
  const LAYER_SCAN_LIMIT = 16;
  const LAYER_SCAN_BODY_CHILDREN = 120;

  /**
   * 页面侧有序层事实（交给 lib/vom-layers.js 归一化）：
   * 只扫 top-layer（dialog/popover/fullscreen）、role=dialog 与 body 直系子节点，
   * 按 position/z-index 粗过滤，避免对整页做 computed style 扫描。
   */
  function layerStackFacts() {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || el.nodeType !== 1 || out.length >= LAYER_SCAN_LIMIT || seen.has(el)) return;
      if (el === document.documentElement || el === document.body) return;
      if (isOwnOverlayNode(el)) return;
      const facts = layerFactsOf(el);
      if (!facts || facts.display === 'none' || facts.visibility === 'hidden' || facts.opacity === '0') return;
      const rect = facts.rect;
      if (rect.width <= 0 && rect.height <= 0) return;
      if (rect.x < -10000 || rect.y < -10000) return;
      const interesting = facts.topLayer
        || facts.position === 'fixed'
        || facts.position === 'sticky'
        || (facts.zIndex != null && facts.zIndex !== 0);
      if (!interesting) return;
      seen.add(el);
      const role = roleOf(el) || '';
      out.push({
        position: facts.position,
        zIndex: facts.zIndex,
        topLayer: facts.topLayer,
        pointerEvents: facts.pointerEvents,
        rect,
        tag: String(el.tagName || '').toLowerCase(),
        id: el.id || null,
        role: role || null,
        name: truncate(accessibleName(el, role), 60) || null,
        coverage: vw > 0 && vh > 0 && rect.width > 0 && rect.height > 0
          ? Math.round((rect.width * rect.height) / (vw * vh) * 1000) / 1000
          : null,
      });
    };
    const scan = (selector, limit) => {
      let count = 0;
      try {
        for (const el of document.querySelectorAll(selector)) {
          count += 1;
          if (count > limit) break;
          push(el);
        }
      } catch {
        // 选择器异常忽略
      }
    };
    scan('dialog,[popover],[role="dialog"],[role="alertdialog"]', 32);
    scan('body > *', LAYER_SCAN_BODY_CHILDREN);
    return {
      viewport: { width: vw, height: vh, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
      layers: out,
    };
  }

  function visualScan() {
    const out = [];
    const seen = new Set();
    const state = getVisualState();
    state.candidates.clear();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const push = (el, kind) => {
      if (!el || seen.has(el) || out.length >= 40) return;
      if (el === document.documentElement || el === document.body) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) return;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) return;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return;
      if (Number(style.opacity) === 0) return;
      // 只保留"真的能被点到"的候选：同一份 DOM 里常有多份模板/隐藏副本，
      // 它们矩形看着正常，但该点上最上层的元素不是它，按它算坐标会打到空气。
      const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
      let top = null;
      try {
        top = document.elementFromPoint(cx, cy);
      } catch {
        top = null;
      }
      if (!top) return;
      const hitSelf = top === el
        || (el.contains && el.contains(top))
        || (top.contains && top.contains(el));
      if (!hitSelf) return;
      seen.add(el);
      const index = out.length + 1;
      state.candidates.set(index, el);
      out.push({
        index,
        kind,
        tag: el.tagName.toLowerCase(),
        id: String(el.id || ''),
        cls: String(el.getAttribute('class') || '').slice(0, 60),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };
    for (const el of document.querySelectorAll('canvas')) push(el, 'canvas');
    for (const el of document.querySelectorAll('img, [role=img]')) push(el, 'image');
    for (const el of document.querySelectorAll('svg')) push(el, 'vector');
    // 自绘区域：有背景图、自身几乎没有文本、面积够大（canvas 类控件的常见形态）
    for (const el of document.querySelectorAll('div,section,li')) {
      if (out.length >= 40) break;
      if (seen.has(el)) continue;
      const style = getComputedStyle(el);
      if (!style.backgroundImage || style.backgroundImage === 'none') continue;
      if ((el.textContent || '').trim().length > 24) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 80) continue;
      push(el, 'region');
    }
    const layerStack = layerStackFacts();
    return {
      candidates: out,
      viewport: { width: vw, height: vh, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
      layers: layerStack.layers,
      layerViewport: layerStack.viewport,
    };
  }

  /**
   * 视觉坐标命中校验：这个页面坐标下面到底是什么？
   * 用于"看图派发动作"之前——坐标是模型给的，必须先确认落点不是浮层/遮罩/空白。
   * 给了 index 时额外判断"落点是不是那个视觉候选"（自身/后代/祖先都算命中）。
   */
  function hitAt(args) {
    const x = Number(args && args.x);
    const y = Number(args && args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return pageError('E_BAD_ARG', 'hitAt 需要 x/y');
    const el = document.elementFromPoint(x, y);
    if (!el) return { hit: false, reason: 'none' };
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    let inert = false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.inert) { inert = true; break; }
    }
    const expectedIndex = Number(args && args.index);
    let matches = null;
    if (Number.isFinite(expectedIndex)) {
      const target = getVisualState().candidates.get(expectedIndex);
      matches = Boolean(target)
        && (target === el || (target.contains && target.contains(el)) || (el.contains && el.contains(target)));
    }
    return {
      hit: true,
      x,
      y,
      tag: el.tagName.toLowerCase(),
      id: String(el.id || ''),
      cls: String(el.className || '').slice(0, 80),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      pointerEvents: style.pointerEvents,
      inert,
      ownOverlay: isOwnOverlayNode(el),
      // 页面侧层/affordance 事实：agent 在按坐标动作前可以判断落点会激活/输入/滚动什么。
      layer: layerFactsOf(el),
      affordance: affordanceFactsOf(el),
      coversViewport: vw > 0 && vh > 0 && rect.width * rect.height > vw * vh * 0.8,
      anchored: el === document.documentElement || el === document.body,
      matches,
    };
  }

  /** 扩展自己的浮层（__bb_*）不算页面遮挡：动作前会临时隐藏，脚本动作也应能穿透。 */
  const OWN_OVERLAY_IDS = new Set([
    '__bb_takeover_host', '__bb_help_host', '__bb_help_highlight', '__bb_record_host',
    '__bb_manual_host', '__bb_borrow_modal', '__bb_control_hint', '__bb_human_banner',
  ]);
  function isOwnOverlayNode(node) {
    let current = node;
    for (let depth = 0; current && current.nodeType === 1 && depth < 12; depth += 1) {
      if (OWN_OVERLAY_IDS.has(String(current.id || ''))) return true;
      if (current.getAttribute && current.getAttribute('data-bb-ui') === 'takeover') return true;
      current = current.parentElement;
    }
    return false;
  }

  function disabledNode(el) {
    if (el.disabled === true) return true;
    try {
      if (el.matches && el.matches(':disabled')) return true;
    } catch {
      // 非表单元素不支持 :disabled
    }
    if (normalizeText(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
    try {
      return Boolean(el.closest && el.closest('[inert]'));
    } catch {
      return false;
    }
  }

  function readOnlyNode(el) {
    if (el.readOnly === true) return true;
    return normalizeText(el.getAttribute('aria-readonly') || '').toLowerCase() === 'true';
  }

  const ACTION_WAIT_DEFAULT_MS = 5000;
  const ACTION_FORCE_SKIP_REASONS = new Set(['occluded', 'pointer-events-none', 'outside_viewport']);

  function sameActionRect(a, b) {
    return Boolean(a && b) && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  /** 等两帧让动画推进；后台标签页 rAF 可能被节流，用 60ms 超时兜底。 */
  function nextActionFrame() {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function () {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { requestAnimationFrame(done); });
      }
      setTimeout(done, 60);
    });
  }

  /**
   * 动作前统一可操作性判定：可见、可用、可编辑、能接收指针事件。
   * --force 只绕过遮挡类检查，不放宽"存在/可见/可用"这些硬条件。
   */
  function actionFacts(el, args, kind) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const facts = {
      kind,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    if (!el.isConnected) return { ...facts, ok: false, reason: 'detached' };
    if (!isVisible(el)) return { ...facts, ok: false, reason: 'not_visible' };
    if (kind !== 'hover' && kind !== 'scroll-to' && disabledNode(el)) return { ...facts, ok: false, reason: 'disabled' };
    if (kind === 'fill' && readOnlyNode(el)) return { ...facts, ok: false, reason: 'readonly' };
    if (rect.width < 1 || rect.height < 1) return { ...facts, ok: false, reason: 'no_area' };
    const hit = hitTestNode(el, rect, style);
    if (hit.state === 'pointer-events-none') return { ...facts, ok: false, reason: 'pointer-events-none' };
    if (hit.state === 'offscreen') return { ...facts, ok: false, reason: 'outside_viewport' };
    if (hit.state === 'blocked' && hit.byOwnOverlay !== true) {
      return { ...facts, ok: false, reason: 'occluded', occludedBy: hit.by };
    }
    return { ...facts, ok: true, reason: 'ok' };
  }

  function describeActionFailure(facts) {
    if (facts.reason === 'occluded') {
      const by = facts.occludedBy || {};
      const label = (by.tag || '元素') + (by.id ? '#' + by.id : '') + (by.role ? ' (' + by.role + ')' : '');
      return `目标被遮挡（${label}）`;
    }
    const labels = {
      detached: '目标已脱离文档',
      not_visible: '目标不可见',
      disabled: '目标已禁用',
      readonly: '目标为只读，无法填写',
      no_area: '目标尺寸为 0',
      'pointer-events-none': '目标 pointer-events:none，收不到事件',
      outside_viewport: '目标不在视口内',
    };
    return labels[facts.reason] || '目标当前不可操作';
  }

  /**
   * 不满足时按 waitTimeoutMs 等待（默认 5s），并连续两次采样 rect 一致（stable）后才动作。
   * waitTimeoutMs: 0 关闭等待与稳定采样，退回单次判定。
   */
  async function ensureActionable(el, args, kind) {
    assertRowAnchor(el, args);
    const rawWait = args.waitTimeoutMs;
    const waitMs = rawWait === 0
      ? 0
      : (Number.isFinite(Number(rawWait)) && Number(rawWait) >= 0 ? Number(rawWait) : ACTION_WAIT_DEFAULT_MS);
    const deadline = Date.now() + waitMs;
    let previous = null;
    let last = null;
    for (;;) {
      const facts = actionFacts(el, args, kind);
      last = facts;
      // selector 目标被替换：立即交给 retryDetachedTarget 重新解析，不必等满超时。
      if (facts.reason === 'detached' && typeof args.selector === 'string' && args.selector) {
        let replacement = null;
        try {
          replacement = document.querySelector(args.selector);
        } catch {
          replacement = null;
        }
        if (replacement && replacement.isConnected) break;
      }
      if (args.force === true && (facts.ok || ACTION_FORCE_SKIP_REASONS.has(facts.reason))) return { ...facts, waitedMs: 0 };
      if (facts.ok) {
        if (waitMs === 0) return { ...facts, waitedMs: 0 };
        if (previous && previous.ok && sameActionRect(previous.rect, facts.rect)) {
          return { ...facts, waitedMs: Math.max(0, waitMs - Math.max(0, deadline - Date.now())) };
        }
      }
      if (Date.now() >= deadline) break;
      previous = facts;
      await nextActionFrame();
    }
    const who = args.ref ? args.ref : ('selector ' + String(args.selector || ''));
    const hint = args.force === true ? '' : '；确认页面状态后重试，或用 --force 跳过遮挡检查';
    const waited = waitMs > 0 ? `（已等待 ${waitMs}ms）` : '';
    pageError('E_NOT_ACTIONABLE', `${who} 不可操作：${describeActionFailure(last)}${waited}${hint}`);
  }

  /**
   * 动作等待期间目标被 SPA 替换（旧节点 detached）时，selector 目标重试一次。
   * 只有 selector 仍能解析到新节点才重试，避免永久消失的目标等两倍超时。
   */
  async function retryDetachedTarget(args, run) {
    try {
      return await run();
    } catch (error) {
      if (!args || typeof args.selector !== 'string' || !args.selector) throw error;
      if (!error || error.code !== 'E_NOT_ACTIONABLE') throw error;
      if (!/脱离文档|detached/i.test(String(error.message || ''))) throw error;
      let replacement = null;
      try {
        replacement = document.querySelector(args.selector);
      } catch {
        replacement = null;
      }
      if (!replacement || !replacement.isConnected) throw error;
      return run();
    }
  }

  /** 动作前命中测试：给 --trusted 用，避免原生点击落到遮挡层。 */
  function actionHitTest(args) {
    const el = resolveElement(args);
    if (!isVisible(el)) return { state: 'hidden', occludedBy: null, rect: null };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hit = hitTestNode(el, rect, style);
    return {
      state: hit.state,
      occludedBy: hit.by,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  }

  // ---------- 颜色对比度（oklch/lab/color-mix 交给浏览器 canvas 归一化） ----------

  const colorParseCache = new Map();
  let colorCanvas = null;
  let colorContext = null;

  function parseCssColor(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (colorParseCache.has(text)) return colorParseCache.get(text);
    let parsed = null;
    try {
      if (!colorContext) {
        colorCanvas = document.createElement('canvas');
        colorCanvas.width = 1;
        colorCanvas.height = 1;
        colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (colorContext) {
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = text;
        colorContext.fillRect(0, 0, 1, 1);
        const data = colorContext.getImageData(0, 0, 1, 1).data;
        parsed = { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
      }
    } catch {
      parsed = null;
    }
    colorParseCache.set(text, parsed);
    return parsed;
  }

  function compositeColor(top, bottom) {
    const alpha = Math.min(1, Math.max(0, Number(top && top.a) || 0));
    const base = bottom || { r: 255, g: 255, b: 255, a: 1 };
    return {
      r: (top.r * alpha) + (base.r * (1 - alpha)),
      g: (top.g * alpha) + (base.g * (1 - alpha)),
      b: (top.b * alpha) + (base.b * (1 - alpha)),
      a: 1,
    };
  }

  function effectiveBackgroundColor(el) {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let color = null;
      try {
        color = parseCssColor(getComputedStyle(node).backgroundColor);
      } catch {
        color = null;
      }
      if (color && color.a > 0) layers.push(color);
      if (color && color.a >= 1) break;
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) base = compositeColor(layers[index], base);
    return base;
  }

  function linearChannel(channel) {
    const value = Math.min(255, Math.max(0, Number(channel) || 0)) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(color) {
    return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b);
  }

  function contrastRatio(foreground, background) {
    const a = relativeLuminance(foreground);
    const b = relativeLuminance(background);
    const light = Math.max(a, b);
    const dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
  }

  /** 元素文字色对有效背景的 WCAG 对比度；解析失败返回 null。 */
  function nodeContrast(el) {
    try {
      const style = getComputedStyle(el);
      const foreground = parseCssColor(style.color);
      if (!foreground) return null;
      const background = effectiveBackgroundColor(el);
      const text = foreground.a < 1 ? compositeColor(foreground, background) : foreground;
      const ratio = contrastRatio(text, background);
      return Number.isFinite(ratio) ? ratio : null;
    } catch {
      return null;
    }
  }

  /** VOM：表单控件的输入状态（比单纯的 filled/empty 更贴近 AX）。 */
  function nodeInputState(el) {
    if (el.tagName === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (type === 'file') return el.files && el.files.length ? 'filled' : 'empty';
      return String(el.value || '') ? 'filled' : 'empty';
    }
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return String(el.value || '') ? 'filled' : 'empty';
    if (el.isContentEditable) return normalizeText(el.textContent || '') ? 'filled' : 'empty';
    return null;
  }

  /** VOM：拖拽提示（draggable / drag-handle / drop-target）。 */
  function nodeDragHint(el) {
    if (el.draggable === true || normalizeText(el.getAttribute('draggable') || '').toLowerCase() === 'true') return 'draggable';
    const cls = typeof el.className === 'string' ? el.className : '';
    if (el.hasAttribute('data-drag-handle') || /(^|[\s-])(drag-handle|draghandle|drag_handle)([\s-]|$)/i.test(cls)) return 'drag-handle';
    if (el.hasAttribute('data-drop-target') || /(^|[\s-])(drop-target|dropzone|drop-zone)([\s-]|$)/i.test(cls)) return 'drop-target';
    return null;
  }

  /**
   * VOM affordance 页面侧事实：一次把所有规则需要的 DOM/样式事实收齐。
   * 纯读取；hit-at 会把它随命中结果返回，lib/vom-affordance.js 再用同一份事实归约。
   */
  function affordanceFactsOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const role = roleOf(el) || '';
    const tag = String(el.tagName || '').toLowerCase();
    const inputType = tag === 'input' ? String(el.type || 'text').toLowerCase() : null;
    let style = null;
    try {
      style = getComputedStyle(el);
    } catch {
      style = null;
    }
    let scrollable = false;
    try {
      const overflow = String(style ? style.overflowX : '') + ' ' + String(style ? style.overflowY : '');
      scrollable = /(auto|scroll)/.test(overflow)
        && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    } catch {
      scrollable = false;
    }
    const readBool = (value) => (value == null ? null : normalizeText(value).toLowerCase() === 'true');
    const tabIndexAttr = el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : null;
    const name = truncate(normalizeText(accessibleName(el, role)), NAME_MAX);
    return {
      role: role || null,
      tag,
      name: name || null,
      inputType,
      href: typeof el.href === 'string' && el.href ? String(el.href).slice(0, 200) : null,
      contentEditable: el.isContentEditable === true,
      tabIndex: Number.isFinite(tabIndexAttr) ? tabIndexAttr : null,
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      expanded: readBool(el.getAttribute('aria-expanded')),
      selected: readBool(el.getAttribute('aria-selected')),
      pressed: readBool(el.getAttribute('aria-pressed')),
      hasPopup: el.getAttribute('aria-haspopup') || null,
      disabled: disabledNode(el),
      readOnly: readOnlyNode(el),
      multiple: el.multiple === true,
      scrollable,
      draggable: el.draggable === true || normalizeText(el.getAttribute('draggable') || '').toLowerCase() === 'true',
      dragHint: nodeDragHint(el),
      pointerEvents: style ? style.pointerEvents : null,
      cursor: style ? style.cursor : null,
      position: style ? style.position : null,
      zIndex: style && /^-?\d+$/.test(normalizeText(style.zIndex || '')) ? Number(style.zIndex) : null,
      topLayer: topLayerKindOf(el),
    };
  }

  /** VOM：邻近文本（用于消歧；只看兄弟/叔伯节点，避免把整页文本带进来）。 */
  function nodeNearbyText(el) {
    const own = normalizeText(el.textContent || '');
    const parent = el.parentElement;
    const candidates = [el.previousElementSibling, el.nextElementSibling,
      parent ? parent.previousElementSibling : null, parent ? parent.nextElementSibling : null];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const text = normalizeText(candidate.textContent || '');
      if (text && (!own || !text.includes(own))) return truncate(text, 80);
    }
    return null;
  }

  // ---------- VOM 完整关系图（containment / ownership / label / form） ----------
  //
  // 旧版只有每个节点自己的 ancestors（best-effort，最多 4 层，父节点用 tag#id 猜）。
  // 这里在页面侧一次性收集一张可解析的图：
  // - 每个被观察到的元素 + 其祖先链都分配一个观测内唯一的 key；
  // - `child` 边从祖先指向元素（完整到 documentElement，受上限保护）；
  // - `aria-controls/labelledby/describedby/owns`、`<label for>`、`form` 边尽量解析到目标元素；
  // - 只输出结构（tag/id/role/ref/parentKey），不带文本内容，避免放大观测体积。

  const GRAPH_NODE_LIMIT = 800;
  const GRAPH_EDGE_LIMIT = 2000;
  const GRAPH_ANCESTOR_LIMIT = 16;
  const GRAPH_OWNER_TARGET_LIMIT = 8;

  function createGraph() {
    return { keyOf: new WeakMap(), nodes: new Map(), edges: [], edgeSeen: new Set(), domKeys: new Map(), seq: 0, truncated: false };
  }

  /** 页面图必须能跨 executeScript 序列化：只输出纯数组/对象。 */
  function snapshotGraph(graph) {
    if (!graph) return null;
    return {
      nodes: Array.from(graph.nodes.values()).map((node) => ({
        key: node.key,
        ref: node.ref,
        tag: node.tag,
        domId: node.domId,
        role: node.role,
        parentKey: node.parentKey,
        frameIndex: Number.isInteger(node.frameIndex) ? node.frameIndex : null,
        srcUrl: node.srcUrl || null,
      })),
      edges: graph.edges.map((edge) => ({ type: edge.type, from: edge.from, to: edge.to })),
      truncated: graph.truncated === true,
      nodeLimit: GRAPH_NODE_LIMIT,
      edgeLimit: GRAPH_EDGE_LIMIT,
    };
  }

  function frameIndexOf(el) {
    try {
      const all = document.querySelectorAll('iframe');
      const index = Array.prototype.indexOf.call(all, el);
      return index >= 0 ? index : null;
    } catch {
      return null;
    }
  }

  function graphKeyOf(el, graph) {
    if (!graph || !el || el.nodeType !== 1) return null;
    const existing = graph.keyOf.get(el);
    if (existing) return existing;
    if (graph.nodes.size >= GRAPH_NODE_LIMIT) {
      graph.truncated = true;
      return null;
    }
    const key = 'n' + (++graph.seq);
    graph.keyOf.set(el, key);
    const refSeq = state.elRefs.get(el);
    graph.nodes.set(key, {
      key: key,
      ref: Number.isInteger(refSeq) ? '@e' + refSeq : null,
      tag: String(el.tagName || '').toLowerCase(),
      domId: el.id || null,
      role: el.getAttribute('role') || null,
      parentKey: null,
      frameIndex: el.tagName === 'IFRAME' ? frameIndexOf(el) : null,
      srcUrl: el.tagName === 'IFRAME' ? String(el.src || '').slice(0, 300) : null,
    });
    if (el.id) graph.domKeys.set(String(el.id), key);
    return key;
  }

  /** DOM id → 图节点 key（已存在则复用，不存在则建节点）；关系链展开用。 */
  function graphKeyOfDomId(graph, domId) {
    if (!graph || !domId) return null;
    const existing = graph.domKeys.get(String(domId));
    if (existing) return existing;
    let target = null;
    try {
      target = document.getElementById(String(domId));
    } catch {
      target = null;
    }
    return target ? graphKeyOf(target, graph) : null;
  }

  function graphEdgeOf(graph, type, from, to) {
    if (!graph || !from || !to || from === to) return;
    const id = type + '\u0000' + from + '\u0000' + to;
    if (graph.edgeSeen.has(id)) return;
    if (graph.edges.length >= GRAPH_EDGE_LIMIT) {
      graph.truncated = true;
      return;
    }
    graph.edgeSeen.add(id);
    graph.edges.push({ type: type, from: from, to: to });
  }

  /** 记录元素 + 祖先链（child 边）与它自己的语义关系边，返回元素 key。 */
  function recordElementGraph(el, graph) {
    if (!graph) return null;
    const key = graphKeyOf(el, graph);
    if (!key) return null;
    let childKey = key;
    let childEl = el;
    let depth = 0;
    while (childEl && childEl.parentElement && depth < GRAPH_ANCESTOR_LIMIT) {
      const parentEl = childEl.parentElement;
      const parentKey = graphKeyOf(parentEl, graph);
      if (!parentKey) break;
      graphEdgeOf(graph, 'child', parentKey, childKey);
      graph.nodes.get(childKey).parentKey = parentKey;
      childKey = parentKey;
      childEl = parentEl;
      depth += 1;
    }
    if (el.labels && el.labels.length) {
      for (const label of Array.from(el.labels).slice(0, 4)) {
        const labelKey = graphKeyOf(label, graph);
        if (!labelKey) continue;
        // 显式 <label for>（htmlFor 指向本元素）与隐式包裹 label 分开记：关系来源/置信度不同。
        const explicit = label.htmlFor && el.id && String(label.htmlFor) === String(el.id);
        graphEdgeOf(graph, explicit ? 'html-for' : 'label', labelKey, key);
      }
    }
    if (el.form) {
      const formKey = graphKeyOf(el.form, graph);
      // form 边的方向统一为“表单 → 控件”（关系方向，见 lib/vom-relations.js 的 form → owns）。
      if (formKey) graphEdgeOf(graph, 'form', formKey, key);
    }
    const roleAttr = normalizeText(el.getAttribute('role') || '').toLowerCase();
    // 关系边按“关系方向”记录（与 lib/vom-relations.js 的映射一一对应，避免同一网页事实两种方向）：
    //   label/html-for: 标签 → 控件；labelledby/describedby/errormessage: 目标 → 元素；controls: 元素 → 目标。
    const emitRelationEdges = (attr, type, reverse) => {
      const ids = String(el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
      for (const targetId of ids.slice(0, GRAPH_OWNER_TARGET_LIMIT)) {
        let target = null;
        try { target = document.getElementById(targetId); } catch { target = null; }
        if (!target) continue;
        const targetKey = graphKeyOf(target, graph);
        if (!targetKey) continue;
        if (reverse) graphEdgeOf(graph, type, targetKey, key);
        else graphEdgeOf(graph, type, key, targetKey);
      }
    };
    emitRelationEdges('aria-controls', roleAttr === 'tab' ? 'tab-controls' : 'controls', false);
    emitRelationEdges('aria-owns', 'owns', false);
    emitRelationEdges('aria-labelledby', 'labelledby', true);
    emitRelationEdges('aria-describedby', 'describedby', true);
    emitRelationEdges('aria-errormessage', 'errormessage', true);
    // labelledby 链：把链上每一跳的节点与 labelledby 边补进图，关系层才能解析出 aria-labelledby-chain。
    const chainFacts = labelledByChainOf(el);
    if (chainFacts) {
      const ordered = chainFacts
        .filter((hop) => hop && hop.id)
        .slice()
        .sort((left, right) => (Number(left.depth) || 0) - (Number(right.depth) || 0));
      for (const hop of ordered) {
        const targetKey = graphKeyOfDomId(graph, hop.id);
        if (!targetKey) continue;
        const sourceKey = hop.from ? graphKeyOfDomId(graph, hop.from) : key;
        if (sourceKey) graphEdgeOf(graph, 'labelledby', targetKey, sourceKey);
      }
    }
    return key;
  }

  function formatNode(el, role, depth, ctx) {
    const indent = '  '.repeat(depth);
    const interactive = INTERACTIVE_ROLES.has(role);
    let prefix = `- ${role}`;
    let textPart = '';
    const name = truncate(accessibleName(el, role), NAME_MAX);

    if (role === 'paragraph' || role === 'listitem') {
      const ariaLabel = normalizeText(el.getAttribute('aria-label') || '');
      const body = ariaLabel || normalizeText(el.textContent || '');
      if (body) textPart = `: ${truncate(body, TEXT_MAX)}`;
    } else if (name) {
      prefix += ` ${quoteName(name)}`;
    }

    let line = indent + prefix + textPart;
    let refId = null;
    if (interactive && ctx.withRefs) {
      refId = refFor(el);
      ctx.refs += 1;
      line += ` [@e${refId}]`;
    }
    if (ctx.nodes && ctx.nodes.length < 500) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const rawValue = 'value' in el ? String(el.value == null ? '' : el.value) : '';
      const sensitive = /password/i.test(String(el.type || '')) || /(password|token|secret|one-time-code)/i.test(String(el.getAttribute('autocomplete') || ''));
      const hit = hitTestNode(el, rect, style);
      const clickableBase = interactive || el.onclick != null || (el.getAttribute('onclick') || '').length > 0 || style.cursor === 'pointer';
      const clickable = clickableBase && hit.state !== 'blocked' && hit.state !== 'pointer-events-none';
      const contrast = nodeContrast(el);
      const textBearing = Boolean(name) || ['paragraph', 'heading', 'listitem', 'cell', 'link', 'button', 'textbox'].includes(role);
      const vomId = ctx.markVom ? 'v' + (++ctx.vomSeq) : null;
      if (vomId) el.setAttribute('data-bb-vom', vomId);
      const graphKey = ctx.graph ? recordElementGraph(el, ctx.graph) : null;
      // 行事实（虚拟列表契约）与页面侧 paint/裁剪事实：扩展侧 lib/vom-visibility.js 统一归约。
      const anchor = rowFactsOf(el);
      const paint = paintVisibilityOf(el, style);
      const clip = interactive || clickableBase ? clipFactsOf(el, rect) : null;
      ctx.nodes.push({
        ref: refId != null ? '@e' + refId : null,
        vomId,
        graphKey,
        tag: String(el.tagName || '').toLowerCase(),
        id: el.id || null,
        role: role || null,
        name: name || null,
        value: sensitive ? (rawValue ? '********' : '') : truncate(rawValue, TEXT_MAX),
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        focused: document.activeElement === el,
        disabled: el.disabled === true || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true',
        expanded: el.getAttribute('aria-expanded') == null ? null : String(el.getAttribute('aria-expanded')).toLowerCase() === 'true',
        selected: el.getAttribute('aria-selected') == null ? null : String(el.getAttribute('aria-selected')).toLowerCase() === 'true',
        required: el.required === true || String(el.getAttribute('aria-required') || '').toLowerCase() === 'true',
        invalid: String(el.getAttribute('aria-invalid') || '').toLowerCase() === 'true' || (typeof el.matches === 'function' && el.matches(':invalid')),
        busy: String(el.getAttribute('aria-busy') || '').toLowerCase() === 'true',
        readonly: el.readOnly === true,
        placeholder: el.getAttribute('placeholder') || null,
        ariaControls: el.getAttribute('aria-controls') || null,
        ariaLive: el.getAttribute('aria-live') || null,
        ariaPressed: el.getAttribute('aria-pressed') == null ? null : String(el.getAttribute('aria-pressed')).toLowerCase() === 'true',
        ariaCurrent: el.getAttribute('aria-current') || null,
        ariaHasPopup: el.getAttribute('aria-haspopup') || null,
        ariaValueNow: el.getAttribute('aria-valuenow') == null ? null : Number(el.getAttribute('aria-valuenow')),
        ariaValueMin: el.getAttribute('aria-valuemin') == null ? null : Number(el.getAttribute('aria-valuemin')),
        ariaValueMax: el.getAttribute('aria-valuemax') == null ? null : Number(el.getAttribute('aria-valuemax')),
        ariaHidden: String(el.getAttribute('aria-hidden') || '').toLowerCase() === 'true',
        ariaLabelledBy: el.getAttribute('aria-labelledby') || null,
        ariaDescribedBy: el.getAttribute('aria-describedby') || null,
        ariaOwns: el.getAttribute('aria-owns') || null,
        ariaErrorMessage: el.getAttribute('aria-errormessage') || null,
        ariaInvalid: el.getAttribute('aria-invalid') || null,
        labels: el.labels ? Array.from(el.labels).map((label) => normalizeText(label.textContent || '').slice(0, 80)).filter(Boolean) : [],
        labelIds: el.labels ? Array.from(el.labels).map((label) => label.id).filter(Boolean).slice(0, 8) : [],
        labelledByChain: labelledByChainOf(el),
        title: normalizeText(el.getAttribute('title') || '') || null,
        alt: el.tagName === 'IMG' ? (normalizeText(el.getAttribute('alt') || '') || null) : null,
        ...(el.tagName === 'TABLE' ? (() => {
          const tableFacts = tableFactsOf(el);
          return tableFacts ? { tableFacts } : {};
        })() : {}),
        formId: el.form && el.form.id ? String(el.form.id) : null,
        ancestors: (() => {
          const out = [];
          let parent = el.parentElement;
          while (parent && out.length < 4) {
            const refSeq = state.elRefs.get(parent);
            out.push({
              tag: String(parent.tagName || '').toLowerCase(),
              role: parent.getAttribute('role') || null,
              id: parent.id || null,
              ref: Number.isInteger(refSeq) ? '@e' + refSeq : null,
              // 上下文分组（lib/vom-context.js）用祖先的可访问名做 landmark/form/table 标签。
              name: normalizeText(parent.getAttribute('aria-label') || parent.getAttribute('title') || '') || null,
            });
            parent = parent.parentElement;
          }
          return out;
        })(),
        href: role === 'link' && el.href && /^https?:/i.test(el.href) ? el.href : null,
        inputType: String(el.type || '').toLowerCase() || null,
        inputState: nodeInputState(el),
        inForm: el.form != null,
        clickable: clickable === true,
        hitTest: hit.state,
        occludedBy: hit.by,
        draggable: el.draggable === true,
        dragHint: nodeDragHint(el),
        nearbyText: nodeNearbyText(el),
        paintOrder: ctx.paintSeq++,
        pointerEvents: style.pointerEvents,
        cursor: style.cursor,
        ...(anchor ? { anchor } : {}),
        paintVisible: paint.paintVisible,
        hiddenReason: paint.hiddenReason || null,
        ...(clip && clip.clipped ? { clipped: true, clippedBy: clip.clippedBy || null } : {}),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
        contrast: contrast == null ? null : Number(contrast.toFixed(2)),
        lowContrast: contrast != null && textBearing && contrast < 4.5,
      });
    }
    if (role === 'link' && el.href && /^https?:/i.test(el.href)) {
      line += ' → ' + truncate(el.href.replace(/^https?:\/\//i, ''), 90);
    }
    line += statusFlags(el, role, ctx, name)
      .map((flag) => ` ${flag}`)
      .join('');
    if (ctx.probeHover && interactive) {
      const hoverable =
        testAttr(el, 'aria-haspopup') || testAttr(el, 'aria-expanded') === 'false';
      if (hoverable) {
        const entries = probeHoverEntries(el);
        if (entries.length) line += ` [hover first: ${entries.join(' | ')}]`;
      }
    }
    return line;
  }


  // ===========================================================================
  // §D 目标解析：探测阻塞层、增量观察、observe/snapshot、ref→element
  // ===========================================================================
  function testAttr(el, name) {
    return normalizeText(el.getAttribute(name) || '');
  }

  function detectBlockingLayer() {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh) return null;
    const hit = document.elementFromPoint(vw / 2, vh / 2);
    if (!hit || hit === document.body || hit === document.documentElement) return null;
    let node = hit;
    while (node && node.nodeType === 1 && node !== document.body) {
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const tag = node.tagName.toLowerCase();
      const ariaModal = node.getAttribute('aria-modal') === 'true';
      const cls = String(node.className || '').toLowerCase();
      const label = normalizeText(node.getAttribute('aria-label') || '');
      if (role === 'dialog' || role === 'alertdialog' || ariaModal || tag === 'dialog') {
        return { tag: tag, role: role || tag, label: truncate(label || node.textContent || '', NAME_MAX) };
      }
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const covers = rect.width >= vw * 0.6 && rect.height >= vh * 0.6;
      const looksModal = /modal|overlay|backdrop|mask|dialog/.test(cls);
      if (covers && looksModal && style.pointerEvents !== 'none') {
        return { tag: tag, role: role || 'overlay', label: truncate(label || node.textContent || '', NAME_MAX) };
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 用 mutation log 只重渲染被改文本的最近祖先子树；失败返回 null（调用方回退整页重建）。 */
  function incrementalObservation(previous, records) {
    if (!previous || !previous.text || !Array.isArray(previous.lineMap) || !previous.lineMap.length) return null;
    const lines = previous.text.split('\n');
    const entryByNode = new Map();
    for (const entry of previous.lineMap) {
      if (entry && entry.node && !entryByNode.has(entry.node)) entryByNode.set(entry.node, entry);
    }
    const jobs = new Map();
    for (const record of records) {
      if (!record || record.type !== 'characterData') return null;
      let node = record.target && record.target.nodeType === 3 ? record.target.parentElement : record.target;
      let hit = null;
      while (node) {
        if (entryByNode.has(node)) { hit = node; break; }
        node = node.parentElement;
      }
      if (!hit) return null;
      jobs.set(hit, entryByNode.get(hit));
    }
    if (!jobs.size) return null;
    const entries = [...jobs.entries()].map(([node, entry]) => ({ node, ...entry }));
    // 同一子树里的多个改动只重渲染最外层祖先。
    const top = entries.filter((job) => !entries.some((other) => other !== job && other.node.contains(job.node)));
    const sortedMap = previous.lineMap.slice().sort((a, b) => a.index - b.index);
    for (const job of top.sort((a, b) => b.index - a.index)) {
      let end = lines.length;
      for (const entry of sortedMap) {
        if (entry.index > job.index && entry.depth <= job.depth) { end = entry.index; break; }
      }
      if (end <= job.index) return null;
      const sub = buildObservation({ withRefs: true, only: { node: job.node, depth: job.depth } });
      if (!sub.lines.length) return null;
      lines.splice(job.index, end - job.index, ...sub.lines);
    }
    return lines.join('\n');
  }

  function collectDeepElements(root, out) {
    if (!root || !root.children) return;
    for (const el of root.children) {
      out.push(el);
      if (el.shadowRoot) collectDeepElements(el.shadowRoot, out);
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.documentElement) collectDeepElements(doc.documentElement, out);
        } catch { /* 跨源文档跳过 */ }
      }
      collectDeepElements(el, out);
    }
  }

  function estimateDeepTokens(text) {
    const value = String(text == null ? '' : text);
    let tokens = 0;
    let run = 0;
    const flush = () => { if (run) { tokens += run <= 3 ? 1 : Math.ceil(run / 3.6); run = 0; } };
    for (const ch of value) {
      if (/[A-Za-z0-9_]/.test(ch)) { run += 1; continue; }
      flush();
      if (/\s/.test(ch)) tokens += 0.25;
      else if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) tokens += 0.76;
      else if (/[\u3040-\u30ff\uac00-\ud7af]/.test(ch)) tokens += 0.6;
      else tokens += 0.5;
    }
    flush();
    return Math.max(1, Math.round(tokens));
  }

  function deepInteractive(el) {
    const tag = el.tagName;
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL'].includes(tag)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'textbox', 'combobox'].includes(role)) return true;
    if (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0) return true;
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable === true) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    return Boolean(el.getAttribute('aria-labelledby') || el.getAttribute('aria-describedby'));
  }

  function deepHidden(el) {
    const style = getComputedStyle(el);
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return true;
    const fontSize = Number.parseFloat(style.fontSize || '0');
    if (Number.isFinite(fontSize) && fontSize > 0 && fontSize <= 1.5) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) return true;
    const margin = 5000;
    if (rect.right < -margin || rect.bottom < -margin) return true;
    if (rect.left > (window.innerWidth || 0) + margin || rect.top > (window.innerHeight || 0) + margin) return true;
    return false;
  }

  /** 六阶段深观察：收集 → 可见 → 注入过滤 → 语义 → 去重/绘制序 → token 预算与 ref。 */
  function buildDeepVom(args) {
    const started = performance.now();
    resetRowFactsCache();
    const all = [];
    collectDeepElements(document.documentElement, all);
    const stages = {
      collected: all.length, skippedTag: 0, hidden: 0, stealth: 0, empty: 0, deduped: 0,
      emitted: 0, tokens: 0, truncated: false,
    };
    const candidates = [];
    const seen = new Map();
    let order = 0;
    for (const el of all) {
      order += 1;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) { stages.skippedTag += 1; continue; }
      if (!isVisible(el)) { stages.hidden += 1; continue; }
      if (!deepInteractive(el) && deepHidden(el)) { stages.stealth += 1; continue; }
      const role = roleOf(el) || '';
      const name = normalizeText(accessibleName(el, role) || '');
      const text = normalizeText(el.textContent || '');
      const interactive = deepInteractive(el) || role === 'button' || role === 'link';
      if (!interactive && !name && !text) { stages.empty += 1; continue; }
      const rect = el.getBoundingClientRect();
      const key = [role, name, tag, el.id || '', Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join('|');
      if (seen.has(key)) { stages.deduped += 1; continue; }
      seen.set(key, true);
      candidates.push({
        el, tag, role: role || null, name: name || null, interactive,
        rect: {
          x: Math.round((rect.left + (window.scrollX || 0)) * 10) / 10,
          y: Math.round((rect.top + (window.scrollY || 0)) * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
        order,
      });
    }
    // 绘制序：先按视口外坐标（含滚动）从上到下、从左到右；同位置按 DOM 顺序。
    candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.order - b.order);
    const budget = Number(args && args.deepMaxTokens) > 0
      ? Math.min(Math.round(Number(args.deepMaxTokens)), 20000)
      : 12000;
    const nodes = [];
    const lines = [];
    let tokens = 0;
    for (const item of candidates) {
      const line = '- ' + (item.role || item.tag.toLowerCase())
        + (item.name ? ' ' + quoteName(truncate(item.name, NAME_MAX)) : '')
        + (item.interactive ? ' [interactive]' : '')
        + (item.rect.width && item.rect.height ? ' @' + Math.round(item.rect.x) + ',' + Math.round(item.rect.y) : '');
      const cost = estimateDeepTokens(line);
      if (tokens + cost > budget && nodes.length) { stages.truncated = true; break; }
      tokens += cost;
      lines.push(line);
      // 与树观察同一个 rowFactsOf：深观察节点也带虚拟列表行事实，供 W2 动作守卫消费。
      const anchor = rowFactsOf(item.el);
      nodes.push({
        id: 'vom-deep:' + nodes.length,
        ref: '@e' + refFor(item.el),
        tag: item.tag,
        role: item.role,
        name: item.name,
        interactive: item.interactive,
        rect: item.rect,
        ...(anchor ? { anchor } : {}),
      });
    }
    stages.emitted = nodes.length;
    stages.tokens = tokens;
    return {
      nodes,
      lines,
      stages: { ...stages, elapsedMs: Math.round(performance.now() - started), sorted: 'paint-order' },
      revision: currentRevision(),
    };
  }

  function observe(args) {
    ensureMutationTracker();
    resetRowFactsCache();
    const mutations = takeMutations();
    const url = location.href;
    const previous = state.lastObservation;
    const wantsFull = args.force === true || args.delta === true || args.baseline !== undefined || args.vomDeep === true;
    const plain = !args.probeHover && args.maxDepth == null && !args.debugSurfaces && !args.vom && !args.markVom && !args.facts && !args.vomDeep;
    // 无 mutation、无输入交互且参数与上次一致：直接返回 unchanged，不重建 VOM。
    if (!wantsFull && plain && previous && previous.plain === true && previous.url === url
      && shouldFastUnchanged(mutations)) {
      return {
        url,
        title: document.title || '',
        unchanged: true,
        refs: previous.refs || 0,
        nodes: [],
        blocking: detectBlockingLayer(),
        revision: currentRevision(),
        mutations,
      };
    }
    // mutation-log 快补丁：只有文本节点变化时，只重渲染最近祖先子树。
    if (args.delta === true && args.force !== true && plain && previous && previous.plain === true
      && previous.url === url && canIncremental(mutations, mutations.records)) {
      const patched = incrementalObservation(previous, mutations.records);
      if (patched != null) {
        const refs = (patched.match(/\[@e\d+\]/g) || []).length;
        const revision = currentRevision();
        state.lastObservation = { url, text: patched, refs, revision, plain: true, lineMap: null };
        return {
          url,
          title: document.title || '',
          observation: patched,
          refs,
          nodes: [],
          blocking: detectBlockingLayer(),
          revision,
          mutations,
          incremental: true,
        };
      }
    }
    const started = performance.now();
    const built = buildObservation({ withRefs: true, probeHover: !!args.probeHover, maxDepth: args.maxDepth, debugSurfaces: !!args.debugSurfaces, collectNodes: !!args.collectNodes || !!args.vom, collectGraph: !!args.vom, markVom: !!args.markVom });
    const deep = args.vomDeep === true ? buildDeepVom(args) : null;
    const text = built.lines.join('\n');
    const unchanged = !wantsFull && previous && previous.url === url && previous.text === text;
    state.lastObservation = { url, text, refs: built.refs, revision: currentRevision(), plain, lineMap: built.lineMap };
    return {
      url,
      title: document.title || '',
      ...(unchanged ? { unchanged: true } : { observation: text }),
      refs: built.refs,
      nodes: built.nodes || [],
      ...(built.graph ? { graph: built.graph } : {}),
      ...(built.stats ? { stages: { ...built.stats, elapsedMs: Math.round(performance.now() - started), serializeMs: Math.max(0, Math.round((performance.now() - started) - (Number(built.stats.ms && built.stats.ms.walk) || 0))) } } : {}),
      ...(deep ? { deepVom: deep } : {}),
      blocking: detectBlockingLayer(),
      revision: currentRevision(),
      mutations,
    };
  }

  function snapshot() {
    const built = buildObservation({ withRefs: true, probeHover: false });
    return { text: built.lines.join('\n'), refs: built.refs };
  }

  function resetRefs() {
    state.refs.clear();
    state.elRefs = new WeakMap();
    state.rowAnchors.clear();
    resetRowFactsCache();
    state.seq = 0;
    return { ok: true };
  }

  // ---------- 元素解析 ----------

  function findByText(text) {
    const wanted = String(text == null ? '' : text).trim();
    if (!wanted) pageError('E_BAD_ARG', 'text 不能为空');
    const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="menuitem"],[data-key],.desktop-item')];
    const textOf = (el) => String(el.innerText || el.textContent || '').trim();
    let matches = candidates.filter((el) => textOf(el) === wanted);
    if (!matches.length) matches = candidates.filter((el) => textOf(el).includes(wanted));
    if (!matches.length) {
      const all = [...document.querySelectorAll('*')].filter((el) => textOf(el) === wanted && (el.offsetWidth || el.offsetHeight));
      matches = all.length ? all : [...document.querySelectorAll('*')].filter((el) => textOf(el) === wanted);
    }
    if (!matches.length) pageError('E_NOT_FOUND', '找不到文本匹配的元素: ' + wanted);
    // 优先取最内层匹配，避免点到只包一层的 wrapper；应用卡片本身仍有 data-key。
    const leaves = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    return (leaves.length ? leaves : matches)[0];
  }

  function resolveElement(args) {
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasText = typeof args.text === 'string' && args.text.length > 0;
    const count = [hasRef, hasSelector, hasText].filter(Boolean).length;
    if (count !== 1) {
      pageError('E_BAD_ARG', 'ref、selector、text 必须恰好给一个');
    }
    if (hasText) return findByText(args.text);
    if (hasSelector) {
      let el = null;
      try {
        el = document.querySelector(args.selector);
      } catch {
        pageError('E_BAD_ARG', `无效的 CSS 选择器: ${args.selector}`);
      }
      if (!el) pageError('E_NOT_FOUND', `找不到匹配选择器的元素: ${args.selector}`);
      if (!el.isConnected) pageError('E_NOT_FOUND', `元素已脱离文档: ${args.selector}`);
      return el;
    }
    const match = /^@e(\d+)$/.exec(args.ref);
    if (!match) pageError('E_BAD_ARG', `ref 格式应为 @eN，收到: ${args.ref}`);
    const refId = Number(match[1]);
    const el = state.refs.get(refId);
    if (!el) pageError('E_STALE_REF', `ref ${args.ref} 不在当前 ref 表里，请重新 observe`);
    if (!el.isConnected) pageError('E_STALE_REF', `ref ${args.ref} 指向的元素已不在文档里，请重新 observe`);
    return el;
  }

  function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        // 忽略：元素可能不可滚动
      }
    }
  }

  // ===========================================================================
  // §E 动作：click/hover/scroll/fill/press/focus/get-html/actionable/expect/help
  // ===========================================================================
  async function actionClick(args) {
    let el = resolveElement(args);
    scrollIntoView(el);
    await ensureActionable(el, args, 'click');
    markAgentInput();
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch {
      // 忽略 focus 失败
    }
    await sleepMs(20);
    if (args.selector && !args.ref) {
      let current = null;
      try { current = document.querySelector(args.selector); } catch { current = null; }
      if (current && current !== el) pageError('E_NOT_ACTIONABLE', '目标在聚焦时被替换（selector 指向新节点），未重放点击');
    }
    if (!el.isConnected) {
      // 安全契约：动作前目标被替换就 fail closed，不把旧动作重放到新节点。
      pageError('E_NOT_ACTIONABLE', '目标在聚焦时被替换（detached），未重放点击');
    }
    // 有些站点把真正的按钮嵌在外层 custom button 里（例如 SSO 登录按钮），
    // 直接 el.click() 只触发外层，页面不会提交。优先点击视口中心命中的子元素。
    let target = el;
    try {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit && hit !== el && el.contains(hit) && typeof hit.click === 'function' && !(hit.closest && hit.closest('[id^="__bb_"]'))) {
        target = hit;
      }
    } catch {
      // 命中测试失败时退回目标本身
    }
    if (typeof target.click === 'function') {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    return { ok: true };
  }

  async function actionHover(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    await ensureActionable(el, args, 'hover');
    markAgentInput();
    const common = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('pointerover', common));
    el.dispatchEvent(new MouseEvent('mouseover', common));
    el.dispatchEvent(new MouseEvent('pointerenter', { ...common, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...common, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', common));
    return { ok: true };
  }

  async function actionAutoScroll() {
    const stepMs = 120;
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < 60; i += 1) {
      window.scrollBy(0, Math.max(200, Math.round(window.innerHeight * 0.85)));
      await sleepMs(stepMs);
      const height = document.documentElement ? document.documentElement.scrollHeight : document.body.scrollHeight;
      const atBottom = window.innerHeight + window.scrollY >= height - 4;
      if (height === lastHeight) stable += 1; else stable = 0;
      lastHeight = height;
      if (atBottom && stable >= 2) break;
    }
    window.scrollTo(0, 0);
    await sleepMs(180);
    return { height: lastHeight };
  }

  function actionRect(args) {
    const el = resolveElement(args);
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  /** 把子 frame 的本地坐标逐层投影到当前文档；只做几何，不做动作。 */
  function frameProjectPoint(args) {
    if (typeof args.url !== 'string' || !args.url) return null;
    const normalize = (value, base) => {
      try { return new URL(String(value || ''), base).href; } catch { return String(value || ''); }
    };
    const target = normalize(args.url, location.href);
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const chain = [];
    const find = (doc, base) => {
      if (!doc || !doc.querySelectorAll) return false;
      for (const owner of doc.querySelectorAll('iframe,frame')) {
        const src = normalize(owner.getAttribute('src'), base);
        if (src === target) {
          chain.push({ owner, doc });
          return true;
        }
        // 同源嵌套：继续在子文档里找；跨源拿不到 contentDocument，保持单层回退。
        try {
          if (owner.contentDocument && find(owner.contentDocument, src)) {
            chain.push({ owner, doc });
            return true;
          }
        } catch {
          // 跨源 frame 不可读；由直接 src 匹配处理。
        }
      }
      return false;
    };
    if (!find(document, location.href)) return null;
    let px = x;
    let py = y;
    const owners = [];
    // chain 是「目标在内、外层在后」，从内往外加 owner 的 viewport 四边形。
    for (const entry of chain) {
      const win = entry.doc.defaultView;
      // Chromium 没有 getBoxQuads：只要 owner 或祖先带 transform/rotate/scale，
      // 就放弃页面内 rect 投影，交给 CDP owner 链做完整仿射投影。
      for (let node = entry.owner; node && node.nodeType === 1; node = node.parentElement) {
        const cs = win.getComputedStyle(node);
        if ((cs.transform && cs.transform !== 'none') ||
            (cs.rotate && cs.rotate !== 'none') ||
            (cs.scale && cs.scale !== 'none')) return null;
      }
      const rect = entry.owner.getBoundingClientRect();
      const style = win.getComputedStyle(entry.owner);
      const left = Number.parseFloat(style.borderLeftWidth) || 0;
      const top = Number.parseFloat(style.borderTopWidth) || 0;
      const width = Number(entry.owner.offsetWidth) || Number(entry.owner.clientWidth) || rect.width;
      const height = Number(entry.owner.offsetHeight) || Number(entry.owner.clientHeight) || rect.height;
      // 无变换时四边形退化为 axis-aligned rect；仍走同一仿射公式。
      const p1 = { x: rect.left, y: rect.top };
      const p2 = { x: rect.right, y: rect.top };
      const p4 = { x: rect.left, y: rect.bottom };
      const ux = { x: (p2.x - p1.x) / width, y: (p2.y - p1.y) / width };
      const uy = { x: (p4.x - p1.x) / height, y: (p4.y - p1.y) / height };
      const localX = left + px;
      const localY = top + py;
      px = p1.x + ux.x * localX + uy.x * localY;
      py = p1.y + ux.y * localX + uy.y * localY;
      owners.push({
        url: normalize(entry.owner.getAttribute('src'), entry.doc.location ? entry.doc.location.href : location.href),
        rect: { x: p1.x, y: p1.y, width, height },
        scale: { x: Math.hypot(ux.x, ux.y), y: Math.hypot(uy.x, uy.y) },
      });
    }
    return { x: px, y: py, frameUrl: target, owners };
  }

  function refSelector(args) {
    const el = resolveElement(args);
    if (!el || !el.tagName) return null;
    if (el.id) return { selector: '#' + CSS.escape(el.id), frameUrl: location.href };
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node === document.body || node === document.documentElement) break;
      node = parent;
    }
    return { selector: parts.join(' > '), frameUrl: location.href };
  }

  function actionPoint(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  }

  const DATE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

  async function actionFill(args) {
    const el = resolveElement(args);
    if (typeof args.value !== 'string') pageError('E_BAD_ARG', 'fill 需要字符串 value');
    const noClear = args.noClear === true;
    scrollIntoView(el);
    await ensureActionable(el, args, 'fill');
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch {
      // 忽略
    }
    if (!el.isConnected) pageError('E_NOT_ACTIONABLE', '目标在聚焦时被替换（detached）');
    const inputType = el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '';
    const dateLike = DATE_TYPES.has(inputType);
    if (dateLike && noClear) {
      pageError('E_BAD_ARG', '日期/时间输入不支持 --no-clear（浏览器会整体替换）');
    }
    if (dateLike) {
      const normalizer = el.ownerDocument.createElement('input');
      normalizer.type = inputType;
      if (el.min) normalizer.min = el.min;
      if (el.max) normalizer.max = el.max;
      normalizer.value = String(args.value);
      if (normalizer.value === '') {
        pageError('E_BAD_ARG', '日期/时间值格式不合法：' + args.value);
      }
      if (normalizer.validity.rangeUnderflow || normalizer.validity.rangeOverflow) {
        const bounds = [el.min && 'min ' + el.min, el.max && 'max ' + el.max].filter(Boolean).join(', ');
        pageError('E_BAD_ARG', '日期/时间值 ' + normalizer.value + ' 超出允许范围（' + bounds + '）');
      }
    }
    if (el.isContentEditable) {
      const nextText = noClear ? String(el.textContent || '') + args.value : args.value;
      el.textContent = nextText;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    if (!('value' in el)) {
      pageError('E_BAD_ARG', '目标元素不支持 fill（既不是输入控件也不是 contenteditable）');
    }
    // 用原生 setter 绕过 React/Vue 的 value 劫持
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const nextValue = noClear ? String(el.value == null ? '' : el.value) + args.value : args.value;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    if (DATE_TYPES.has(String(el.type || '').toLowerCase()) && nextValue && !el.value) {
      pageError('E_BAD_ARG', '日期/时间值不合法：' + nextValue);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  function parseKey(rawKey) {
    const parts = String(rawKey || '').split('+').map((part) => part.trim()).filter(Boolean);
    const main = parts.pop() || '';
    const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') modifiers.ctrlKey = true;
      else if (lower === 'alt' || lower === 'option') modifiers.altKey = true;
      else if (lower === 'shift') modifiers.shiftKey = true;
      else if (lower === 'meta' || lower === 'win' || lower === 'cmd' || lower === 'super') modifiers.metaKey = true;
    }
    const aliases = {
      space: ' ',
      spacebar: ' ',
      esc: 'Escape',
      escape: 'Escape',
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      backspace: 'Backspace',
      del: 'Delete',
      delete: 'Delete',
      insert: 'Insert',
      up: 'ArrowUp',
      down: 'ArrowDown',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
    };
    const lower = main.toLowerCase();
    const key = aliases[lower] || main;
    // US 布局标点的物理 code：快捷键常检查 event.code，不能把 '/' 直接当 code。
    const punctuation = {
      '`': 'Backquote', '~': 'Backquote',
      '-': 'Minus', '_': 'Minus',
      '=': 'Equal', '+': 'Equal',
      '[': 'BracketLeft', '{': 'BracketLeft',
      ']': 'BracketRight', '}': 'BracketRight',
      '\\': 'Backslash', '|': 'Backslash',
      ';': 'Semicolon', ':': 'Semicolon',
      "'": 'Quote', '"': 'Quote',
      ',': 'Comma', '<': 'Comma',
      '.': 'Period', '>': 'Period',
      '/': 'Slash', '?': 'Slash',
    };
    const shiftedPunctuation = '~_+{}|:"<>?';
    let code = '';
    if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
    else if (/^\d$/.test(key)) code = `Digit${key}`;
    else if (key === ' ') code = 'Space';
    else if (/^F([1-9]|1[0-2])$/i.test(key)) code = key.toUpperCase();
    else if (punctuation[key]) {
      code = punctuation[key];
      if (shiftedPunctuation.includes(key)) modifiers.shiftKey = true;
    } else code = key;
    return { key, code, modifiers };
  }

  async function actionPress(args) {
    if (typeof args.key !== 'string' || !args.key) pageError('E_BAD_ARG', 'press 需要 key');
    const hasTarget = Boolean(args.ref || args.selector);
    const target = hasTarget ? resolveElement(args) : document.activeElement || document.body;
    if (hasTarget) {
      scrollIntoView(target);
      await ensureActionable(target, args, 'press');
      try {
        if (typeof target.focus === 'function') target.focus({ preventScroll: true });
      } catch {
        // 忽略
      }
      if (!target.isConnected) pageError('E_NOT_ACTIONABLE', '目标在聚焦时被替换（detached）');
    }
    if (!target) pageError('E_NOT_FOUND', '页面没有可聚焦元素');
    const { key, code, modifiers } = parseKey(args.key);
    const init = { key, code, bubbles: true, cancelable: true, composed: true, ...modifiers };
    const down = new KeyboardEvent('keydown', init);
    const keypressable = key.length === 1 || key === 'Enter';
    const pressAllowed = keypressable && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey;
    const press = pressAllowed ? new KeyboardEvent('keypress', init) : null;
    const up = new KeyboardEvent('keyup', init);
    target.dispatchEvent(down);
    if (press) target.dispatchEvent(press);
    target.dispatchEvent(up);
    return { ok: true };
  }

  /** 与 src/tools/focus-state.js 同语义：document.activeElement 只看 shadow host，必须逐层查 shadow root。 */
  function isElementFocused(node) {
    let current = node;
    while (current) {
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      if (root && root.activeElement === current) return true;
      current = root && root.host ? root.host : null;
    }
    return false;
  }

  function fillFastTarget(args) {
    const el = resolveElement(args);
    if (!el) pageError('E_NOT_FOUND', '页面没有可填写元素');
    const tag = el.tagName.toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const isCe = el.isContentEditable === true;
    if (tag !== 'input' && tag !== 'textarea' && !isCe) pageError('E_TARGET_NOT_FILLABLE', '目标不可填写');
    if (el.disabled === true || el.readOnly === true) pageError('E_TARGET_NOT_FILLABLE', '目标已禁用或只读');
    const textLike = isCe || tag === 'textarea' || (tag === 'input' && ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type));
    if (!textLike) return { ok: true, textLike: false, reason: 'programmatic-only', inputType: type };
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const ownOverlay = !!(hit && hit.closest && hit.closest('[id^="__bb_"]'));
    const related = !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    let occluding = false;
    if (!related && !ownOverlay && hit && hit !== document.body && hit !== document.documentElement) {
      const hb = hit.getBoundingClientRect();
      const ix = Math.max(0, Math.min(box.right, hb.right) - Math.max(box.left, hb.left));
      const iy = Math.max(0, Math.min(box.bottom, hb.bottom) - Math.max(box.top, hb.top));
      occluding = (ix * iy) / Math.max(1, box.width * box.height) > 0.9;
    }
    if (occluding) {
      try { el.focus({ preventScroll: false }); } catch { /* 忽略 */ }
      try { if (args.noClear !== true && typeof el.select === 'function') el.select(); } catch { /* 忽略 */ }
      return { ok: true, textLike: true, occluded: true, reason: 'occluded', focused: isElementFocused(el) };
    }
    markAgentInput();
    try { el.focus({ preventScroll: false }); } catch { /* 忽略 */ }
    try { if (args.noClear !== true && typeof el.select === 'function') el.select(); } catch { /* 忽略 */ }
    return { ok: true, textLike: true, tag: tag, type: type, focused: isElementFocused(el), hadValue: String(el.value == null ? '' : el.value).length > 0 };
  }

  function normalizeFillExpected(el, expected) {
    let value = String(expected);
    if (el && el.tagName === 'TEXTAREA') value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (el && el.type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) value = String(Number(value));
    return value;
  }

  function fillVerify(args) {
    const el = resolveElement(args);
    const expected = normalizeFillExpected(el, typeof args.expected === 'string' ? args.expected : '');
    const sensitive = el ? sensitiveField(el) : false;
    const actual = el ? String(el.value != null ? el.value : normalizeText(el.textContent || '')) : '';
    return { ok: true, sensitive: sensitive, value: sensitive ? null : actual, expected_value: sensitive ? null : expected, formatted: actual !== expected, matches: actual === expected };
  }

  function assertRowAnchor(el, args) {
    if (!args || typeof args.ref !== 'string') return;
    const match = /^@?e(\d+)$/.exec(args.ref);
    if (!match) return;
    const anchor = state.rowAnchors.get(Number(match[1]));
    if (!anchor) return;
    const current = rowAnchorFor(el);
    if (!current || current.text !== anchor.text) {
      pageError('E_TARGET_MISMATCH', '目标所在行已被重新渲染（虚拟列表行回收），ref 不再指向原来那一行；请重新 observe', {
        reason: 'virtual_row_recycled',
        expected: anchor.text.slice(0, 120),
        actual: current ? current.text.slice(0, 120) : null,
      });
    }
  }

  function actionability(args) {
    const el = resolveElement(args);
    if (!el) pageError('E_NOT_FOUND', '页面没有可操作元素');
    assertRowAnchor(el, args);
    const facts = actionFacts(el, args, 'actionable');
    return {
      ok: facts.ok,
      reason: facts.reason,
      rect: facts.rect,
      ...(facts.occludedBy ? { occludedBy: facts.occludedBy } : {}),
    };
  }

  async function actionSelect(args) {
    const el = resolveElement(args);
    if (el.tagName !== 'SELECT') pageError('E_BAD_ARG', 'select 只支持 <select> 元素');
    if (typeof args.value !== 'string') pageError('E_BAD_ARG', 'select 需要字符串 value');
    if (el.disabled === true) {
      pageError('E_BAD_ARG', '控件已禁用，无法选择', { phase: 'precondition', dispatched: false, available: [] });
    }
    const wanted = args.value;
    const options = Array.from(el.options);
    const available = options.slice(0, 12).map((item) => normalizeText(item.textContent));
    // 先校验再滚动/聚焦：选不到目标时页面没被改动，调用方可以安全重试而不用 resolve 账本。
    let chosen = options.find((item) => item.value === wanted);
    if (!chosen) {
      let byLabel = options.filter((item) => normalizeText(item.textContent) === wanted);
      if (!byLabel.length) {
        const lower = wanted.toLowerCase();
        byLabel = options.filter((item) => normalizeText(item.textContent).toLowerCase() === lower);
      }
      if (!byLabel.length) {
        byLabel = options.filter((item) => normalizeText(item.getAttribute('label') || '') === wanted
          || normalizeText(item.getAttribute('label') || '').toLowerCase() === wanted.toLowerCase());
      }
      if (byLabel.length > 1) {
        pageError('E_OPTION_AMBIGUOUS', `“${wanted}” 匹配 ${byLabel.length} 个选项，请改用 value：` + byLabel.slice(0, 12).map((item) => item.value).join(' / '), {
          phase: 'precondition', dispatched: false, count: byLabel.length, available, values: byLabel.slice(0, 12).map((item) => item.value),
        });
      }
      if (byLabel.length === 0) {
        pageError('E_OPTION_NOT_FOUND', `找不到“${wanted}”；可选：` + available.join(' / '), { phase: 'precondition', dispatched: false, available });
      }
      chosen = byLabel[0];
    }
    scrollIntoView(el);
    await ensureActionable(el, args, 'select');
    el.value = chosen.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      value: chosen.value,
      label: normalizeText(chosen.textContent),
      selected: Array.from(el.selectedOptions || []).map((item) => ({ value: item.value, label: normalizeText(item.textContent) })),
    };
  }

  function actionFocus(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    if (typeof el.focus !== 'function') pageError('E_BAD_ARG', '目标元素不可聚焦');
    el.focus({ preventScroll: true });
    return { ok: true };
  }

  function actionScrollTo(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    };
  }

  function getHtml(args) {
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    let html;
    if (hasRef && hasSelector) pageError('E_BAD_ARG', 'ref 与 selector 必须恰好给一个');
    if (hasRef || hasSelector) {
      const el = resolveElement(args);
      html = el.outerHTML == null ? String(el) : el.outerHTML;
    } else {
      html = document.documentElement.outerHTML;
    }
    return { html, url: location.href };
  }

  function probeState(args) {
    const stateName = typeof args.state === 'string' ? args.state : 'visible';
    let el = null;
    if (typeof args.ref === 'string' && args.ref) {
      try {
        el = resolveElement({ ref: args.ref });
      } catch (error) {
        // ref 失效属于错误，交给上层
        throw error;
      }
    } else {
      const selector = typeof args.selector === 'string' ? args.selector : '';
      if (!selector) pageError('E_BAD_ARG', 'probe-state 需要 selector 或 ref');
      try {
        el = document.querySelector(selector);
      } catch {
        pageError('E_BAD_ARG', '无效的 CSS 选择器: ' + selector);
      }
    }
    return {
      present: Boolean(el),
      visible: el ? isVisible(el) : false,
      state: stateName,
    };
  }

  function elementRect(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
      dpr: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  function resolveConditionTarget(target) {
    if (!target || typeof target !== 'string') return null;
    try {
      return target.charAt(0) === '@' ? resolveElement({ ref: target }) : document.querySelector(target);
    } catch {
      return null;
    }
  }

  function fieldValue(el, condition) {
    const field = String(condition.field || 'text');
    if (field === 'exists') return Boolean(el);
    if (!el) return null;
    if (field === 'value') {
      if (sensitiveField(el)) return '********';
      return 'value' in el ? el.value : null;
    }
    if (field === 'checked') return el.checked === true;
    if (field === 'attribute') {
      const name = String(condition.attribute || '');
      return name ? el.getAttribute(name) : null;
    }
    return el.textContent;
  }

  function expectCheck(args) {
    const conditions = Array.isArray(args.conditions) ? args.conditions : [];
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object' || !condition.target) {
        return { ok: false, mismatch: { reason: 'missing_target', expected: null, actual: null } };
      }
      const el = resolveConditionTarget(String(condition.target));
      const field = String(condition.field || 'text');
      const sensitive = el ? sensitiveField(el) : false;
      // 敏感字段的 value 以及 value 属性都不外泄：expect 失败详情同样遮蔽。
      const masked = sensitive && (field === 'value'
        || (field === 'attribute' && String(condition.attribute || '').toLowerCase() === 'value'));
      const actual = masked ? '********' : fieldValue(el, condition);
      const expected = masked ? '********' : condition.equals;
      const same = masked ? String(el.value) === String(condition.equals) : actual === expected;
      if (!same) {
        return {
          ok: false,
          mismatch: {
            target: condition.target,
            field: String(condition.field || 'text'),
            attribute: condition.attribute ? String(condition.attribute) : undefined,
            expected: expected === undefined ? null : expected,
            actual: actual === undefined ? null : actual,
            reason: el ? 'mismatch' : 'not_found',
          },
        };
      }
    }
    return { ok: true, checked: conditions.length };
  }

  /** request-help 的完成条件：只读检查，不修改页面。 */
  function helpCriteriaCheck(args) {
    const criteria = Array.isArray(args && args.criteria) ? args.criteria : [];
    const results = [];
    for (const criterion of criteria) {
      if (!criterion || typeof criterion !== 'object') {
        return { ok: false, results, error: 'invalid_criterion' };
      }
      const kind = String(criterion.kind || criterion.type || '');
      if (kind === 'selector_exists' || kind === 'selector') {
        const selector = String(criterion.selector || '');
        let element = null;
        try { element = selector ? document.querySelector(selector) : null; } catch { element = null; }
        results.push({ kind, ok: Boolean(element) });
      } else if (kind === 'selector_visible') {
        const selector = String(criterion.selector || '');
        let element = null;
        try { element = selector ? document.querySelector(selector) : null; } catch { element = null; }
        let visible = false;
        if (element) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        results.push({ kind, ok: visible });
      } else if (kind === 'text_exists' || kind === 'text') {
        const text = String(criterion.text || '');
        const bodyText = document.body ? String(document.body.innerText || '') : '';
        results.push({ kind, ok: text.length > 0 && bodyText.includes(text) });
      } else {
        results.push({ kind, ok: false, error: 'unsupported' });
      }
    }
    return { ok: results.every((item) => item.ok === true), results };
  }


  // ===========================================================================
  // §F 视觉与等待：visualRefs、滚动空闲、坐标点击、性能指标、human activity、frame
  // ===========================================================================
  function visualRefs() {
    const out = [];
    for (const entry of state.refs) {
      const refId = entry[0];
      const el = entry[1];
      if (!el || !el.isConnected) continue;
      if (el.ownerDocument !== document) continue; // 跨 iframe 的坐标不在这里换算
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const role = roleOf(el) || '';
      out.push({
        ref: '@e' + refId,
        role: role,
        name: truncate(accessibleName(el, role), 40),
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      if (out.length >= 200) break;
    }
    return {
      refs: out,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
    };
  }

  // 坐标输入必须等滚动停稳：滚动中按原始坐标点会落到别的元素上。
  let lastScrollAt = 0;
  try {
    document.addEventListener('scroll', () => { lastScrollAt = Date.now(); }, { capture: true, passive: true });
  } catch {
    // 忽略
  }
  function waitForScrollIdle(maxMs = 800) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (Date.now() - lastScrollAt >= 120 || Date.now() - started >= maxMs) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  async function clickPoint(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) pageError('E_BAD_ARG', 'click-point 需要数字坐标');
    if (args.waitScroll !== false) await waitForScrollIdle();
    const el = document.elementFromPoint(x, y);
    if (!el) pageError('E_NOT_FOUND', '坐标 (' + x + ', ' + y + ') 处没有元素');
    fireMouseTarget(el, 'pointermove', x, y, { buttons: 0 });
    fireMouseTarget(el, 'pointerdown', x, y, { buttons: 1 });
    fireMouseTarget(el, 'pointerup', x, y, { buttons: 0 });
    fireMouseTarget(el, 'click', x, y, { buttons: 0 });
    return { ok: true, x: x, y: y, tag: el.tagName.toLowerCase() };
  }

  let clsValue = 0;
  let longTaskCount = 0;
  let longTaskMax = 0;
  try {
    if (typeof PerformanceObserver === 'function') {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry && entry.hadRecentInput !== true) clsValue += Number(entry.value) || 0;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskMax = Math.max(longTaskMax, Number(entry.duration) || 0);
        }
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch {
    // 浏览器不支持时忽略
  }

  function perfMetrics() {
    const navEntry = performance.getEntriesByType('navigation')[0] || null;
    const paints = performance.getEntriesByType('paint').map(function (entry) {
      return { name: entry.name, startTime: Math.round(entry.startTime) };
    });
    const resources = performance.getEntriesByType('resource');
    let transferBytes = 0;
    for (const entry of resources) transferBytes += Number(entry.transferSize) || 0;
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    return {
      url: location.href,
      ttfb: navEntry ? Math.round(navEntry.responseStart) : null,
      domContentLoaded: navEntry ? Math.round(navEntry.domContentLoadedEventEnd) : null,
      load: navEntry ? Math.round(navEntry.loadEventEnd) : null,
      paints: paints,
      lcp: lcpEntries.length ? Math.round(lcpEntries[lcpEntries.length - 1].startTime) : null,
      cls: Math.round(clsValue * 1000) / 1000,
      longTasks: { count: longTaskCount, maxMs: Math.round(longTaskMax) },
      resources: { count: resources.length, transferBytes: transferBytes },
    };
  }

  let lastHumanInputAt = 0;
  function markHumanActivity(event) {
    if (event && event.isTrusted === false) return; // 忽略 agent 自己派发的合成事件
    lastHumanInputAt = Date.now();
    try {
      window.__bbHumanActivity = lastHumanInputAt;
    } catch {
      // 忽略
    }
  }
  // Only completed actions yield control. Scrolling, modifier keys, focus and
  // ineffective keys must not restart the quiet window.
  for (const type of ['click', 'input', 'change']) {
    document.addEventListener(type, markHumanActivity, { capture: true, passive: true });
  }

  function humanActivity() {
    return { lastInputAt: lastHumanInputAt, active: lastHumanInputAt > 0 && Date.now() - lastHumanInputAt < 2000 };
  }

  function mediaProgress() {
    const items = Array.from(document.querySelectorAll('video, audio')).slice(0, 10).map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      paused: element.paused === true,
      ended: element.ended === true,
      currentTime: Number(element.currentTime) || 0,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
      readyState: Number(element.readyState) || 0,
    }));
    return {
      count: items.length,
      playing: items.filter((item) => item.paused === false && item.ended === false).length,
      items,
    };
  }

  function frameMeta() {
    const top = window.top === window;
    // 本地文档的 iframe 列表（嵌套 frame 也需要，供父帧把 iframe 元素连到子图根）。
    const children = Array.from(document.querySelectorAll('iframe')).slice(0, 50).map(function (el, index) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const hidden =
        rect.width < 1 ||
        rect.height < 1 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0 ||
        el.hidden === true;
      const offscreen = rect.bottom < 0 || rect.right < 0;
      return {
        index: index,
        url: el.src || '',
        id: el.id || null,
        hidden,
        offscreen,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        reason: hidden ? 'not-visible' : offscreen ? 'offscreen' : null,
      };
    });
    let frameElement = null;
    try { frameElement = window.frameElement; } catch { frameElement = null; }
    if (!frameElement) {
      return { top, crossOrigin: !top, hidden: top ? false : null, reason: top ? null : 'cross-origin', children };
    }
    const rect = frameElement.getBoundingClientRect();
    const style = window.getComputedStyle(frameElement);
    const hidden =
      rect.width < 1 ||
      rect.height < 1 ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0 ||
      frameElement.hidden === true;
    const offscreen = rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth;
    return {
      top: false,
      crossOrigin: false,
      hidden,
      offscreen,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      reason: hidden ? 'not-visible' : offscreen ? 'offscreen' : null,
    };
  }

  function pageMetrics() {
    const body = document.body;
    const viewportHeight = window.innerHeight;
    let fixedBottomHeight = 0;
    let fixedTopHeight = 0;
    const fixedBands = [];
    // 只扫一层常见固定元素；用于长截图 final/footer 重绘，不做完整层树。
    try {
      let count = 0;
      for (const element of document.querySelectorAll('body *')) {
        count += 1;
        if (count > 3000) break;
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.height > viewportHeight * 0.6) continue;
        if (rect.bottom >= viewportHeight - 2 && rect.top > viewportHeight * 0.5) {
          fixedBottomHeight = Math.max(fixedBottomHeight, Math.round(viewportHeight - rect.top));
          if (fixedBands.length < 8) fixedBands.push({ edge: 'bottom', height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
        }
        if (rect.top <= 2 && rect.bottom < viewportHeight * 0.5) {
          fixedTopHeight = Math.max(fixedTopHeight, Math.round(rect.bottom));
          if (fixedBands.length < 8) fixedBands.push({ edge: 'top', height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
        }
      }
    } catch { /* 受限文档忽略 */ }
    return {
      url: location.href,
      title: document.title || '',
      scrollHeight: Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        body ? body.scrollHeight : 0,
      ),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      scrollWidth: Math.max(document.documentElement ? document.documentElement.scrollWidth : 0, document.body ? document.body.scrollWidth : 0),
      dpr: window.devicePixelRatio || 1,
      revision: currentRevision(),
      fixedBottomHeight,
      fixedTopHeight,
      fixedBands,
    };
  }

  function scrollToY(args) {
    const y = Number(args.y);
    window.scrollTo(0, Number.isFinite(y) ? y : 0);
    return { scrollY: window.scrollY };
  }

  // ---------- 节点级签名（动态读取校验：target_detached / 节点级 observed_changes） ----------
  //
  // 页面级 revision 只能判断“整页变没变”。节点级校验需要能回答：
  // - 观测到的那个节点还在不在（detached）；
  // - 它自己的文本/值/属性/状态有没有变（而不是邻居变了）。
  // 签名刻意做小：内容用 FNV-1a 哈希，几何只做记录、不作为阻断条件（滚动/重排不算内容变化）。


  // ===========================================================================
  // §G 签名与读取：nodeSignature、ref 签名、fieldInfo、actionRead
  // ===========================================================================
  function fnv1a(value) {
    const text = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('0000000' + hash.toString(16)).slice(-8);
  }

  const SIGNATURE_ATTRS = [
    'id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title',
    'aria-label', 'aria-checked', 'aria-expanded', 'aria-selected', 'data-testid', 'placeholder',
  ];

  function nodeSignatureOf(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    for (const name of SIGNATURE_ATTRS) {
      const value = el.getAttribute(name);
      if (value != null) attrs.push(name + '=' + value);
    }
    const text = normalizeText(el.textContent || '');
    const sensitive = sensitiveField(el);
    const rawValue = 'value' in el ? String(el.value == null ? '' : el.value) : '';
    const rect = el.getBoundingClientRect();
    return {
      tag: tag,
      id: el.id || '',
      name: normalizeText(el.getAttribute('name') || ''),
      textLength: text.length,
      textHash: fnv1a(text),
      valueHash: fnv1a(sensitive ? '********' : rawValue),
      attrsHash: fnv1a(attrs.join('\u0001')),
      geometry: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      disabled: el.disabled === true,
      checked: 'checked' in el ? el.checked === true : null,
    };
  }

  /** 单节点签名：节点不存在/ref 失效时返回 present:false（不抛错，供调用方区分 detached 与 changed）。 */
  function actionNodeSignature(args) {
    try {
      const el = resolveElement(args);
      return { present: true, ...nodeSignatureOf(el), revision: currentRevision() };
    } catch (error) {
      return {
        present: false,
        code: (error && error.code) || 'E_NOT_FOUND',
        revision: currentRevision(),
      };
    }
  }

  /** 批量签名：给 cooperate sync 在观测时一次性记录当前 ref 表的节点状态。 */
  function actionRefSignatures(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500);
    const signatures = [];
    for (const [refId, el] of state.refs) {
      if (!el || el.isConnected !== true) continue;
      signatures.push({ ref: '@e' + refId, ...nodeSignatureOf(el) });
      if (signatures.length >= limit) break;
    }
    return { signatures: signatures, count: signatures.length, limit: limit, revision: currentRevision() };
  }

  // ---------- v0.2：读取与结构化导出 ----------

  function reverseRef(el) {
    for (const entry of state.refs) {
      if (entry[1] === el) return '@e' + entry[0];
    }
    return undefined;
  }

  function fieldInfo(el) {
    const tag = el.tagName.toLowerCase();
    const isCe = el.isContentEditable === true;
    const type = tag === 'input'
      ? normalizeText(el.getAttribute('type') || 'text').toLowerCase()
      : (tag === 'select' ? 'select' : (tag === 'textarea' ? 'textarea' : (isCe ? 'contenteditable' : tag)));
    const info = {
      tag: tag,
      type: type,
      name: normalizeText(el.getAttribute('name') || ''),
      disabled: el.disabled === true,
      readonly: el.readOnly === true || el.hasAttribute('readonly'),
      required: el.required === true || el.hasAttribute('required'),
      contentEditable: isCe,
    };
    const ref = reverseRef(el);
    if (ref) info.ref = ref;
    const placeholder = normalizeText(el.getAttribute('placeholder') || '');
    if (placeholder) info.placeholder = placeholder;
    if (tag === 'select') {
      info.value = el.value;
      info.selectedOptions = Array.from(el.selectedOptions || []).map(function (option) {
        return { value: option.value, label: normalizeText(option.textContent || '') };
      });
    } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      info.value = el.value;
      info.checked = el.checked === true;
    } else if (isCe) {
      info.value = normalizeText(el.innerText || '');
    } else if ('value' in el) {
      info.value = sensitiveField(el) ? '********' : String(el.value == null ? '' : el.value);
    } else {
      info.value = normalizeText(el.textContent || '');
    }
    if (tag === 'input' && el.files) {
      info.files = Array.from(el.files).map(function (file) { return file.name; });
    }
    return info;
  }

  function readFieldsFrom(el, fields) {
    const out = {};
    for (const field of fields) {
      if (!field || typeof field !== 'object') continue;
      const key = String(field.key || field.name || 'field');
      const read = String(field.read || 'text');
      if (read === 'value') {
        out[key] = sensitiveField(el) ? '********' : ('value' in el ? el.value : normalizeText(el.textContent || ''));
      } else if (read === 'attribute') {
        const name = String(field.attribute || '');
        out[key] = name
          ? (sensitiveField(el) && name.toLowerCase() === 'value' ? '********' : el.getAttribute(name))
          : null;
      } else if (read === 'checked') {
        out[key] = el.checked === true;
      } else {
        out[key] = normalizeText(el.textContent || '');
      }
    }
    return out;
  }

  function actionReadFields(args) {
    const el = resolveElement(args);
    return { fields: [readFieldsFrom(el, Array.isArray(args.fields) ? args.fields : [])] };
  }

  function actionRead(args) {
    if (Array.isArray(args.fields) && args.fields.length) return actionReadFields(args);
    if (args.all === true) {
      const nodes = document.querySelectorAll(
        'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable="true"]',
      );
      const fields = [];
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        fields.push(fieldInfo(el));
        if (fields.length >= 500) break;
      }
      return { fields: fields };
    }
    return { fields: [fieldInfo(resolveElement(args))] };
  }

  function cellText(cell) {
    return normalizeText(cell.textContent || '');
  }

  function rowIsHeader(row) {
    if (!row || !row.cells || !row.cells.length) return false;
    for (const cell of row.cells) {
      if (cell.tagName !== 'TH') return false;
    }
    return true;
  }


  // ===========================================================================
  // §H 提取：table/list/grid、discover、预算、覆盖度、revision、capExtractBytes
  // ===========================================================================
  function tableCellGrid(rows) {
    const grid = [];
    const covered = [];
    rows.forEach((row, rowIndex) => {
      if (!grid[rowIndex]) grid[rowIndex] = [];
      if (!covered[rowIndex]) covered[rowIndex] = [];
      let col = 0;
      const cells = Array.from(row.cells || []);
      for (const cell of cells) {
        while (grid[rowIndex][col] !== undefined) col += 1;
        const text = cellText(cell);
        // 某些表格（SMM）在 rowspan 区域里重复输出同一单元格：若该值已被上方 rowspan 覆盖，跳过。
        let duplicated = false;
        for (let k = 0; k < col; k += 1) {
          if (covered[rowIndex][k] && grid[rowIndex][k] === text) { duplicated = true; break; }
        }
        if (duplicated) continue;
        const colSpan = Math.max(1, cell.colSpan || 1);
        const rowSpan = Math.max(1, cell.rowSpan || 1);
        for (let dr = 0; dr < rowSpan; dr += 1) {
          if (!grid[rowIndex + dr]) grid[rowIndex + dr] = [];
          if (!covered[rowIndex + dr]) covered[rowIndex + dr] = [];
          for (let dc = 0; dc < colSpan; dc += 1) {
            grid[rowIndex + dr][col + dc] = text;
            if (dr > 0) covered[rowIndex + dr][col + dc] = true;
          }
        }
        col += colSpan;
      }
    });
    return grid;
  }

  function tableExtract(table, maxRows, budget, offset) {
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const headRows = table.tHead ? Array.from(table.tHead.rows) : [];
    const bodyRows = table.tBodies && table.tBodies.length
      ? Array.from(table.tBodies).flatMap(function (body) { return Array.from(body.rows); })
      : Array.from(table.rows || []).filter(function (row) { return headRows.indexOf(row) < 0; });
    let headerRows = headRows;
    if (!headerRows.length && bodyRows.length && rowIsHeader(bodyRows[0])) {
      headerRows = [bodyRows.shift()];
    }
    const headGrid = tableCellGrid(headerRows);
    const bodyGrid = tableCellGrid(bodyRows);
    let width = 0;
    for (const row of headGrid) width = Math.max(width, row.length);
    for (const row of bodyGrid) width = Math.max(width, row.length);
    const columns = [];
    for (let c = 0; c < width; c += 1) {
      const parts = [];
      for (const hrow of headGrid) {
        const value = normalizeText(hrow[c] || '');
        if (value && parts[parts.length - 1] !== value) parts.push(value);
      }
      columns.push({ key: 'c' + (c + 1), label: parts.join(' / ') || ('c' + (c + 1)) });
    }
    const cellCap = budget ? Math.max(0, Math.floor(budget.maxCells / Math.max(width, 1))) : maxRows;
    const effectiveMax = Math.min(maxRows, cellCap);
    const rows = [];
    let truncated = false;
    let stopReason = 'end';
    let seen = 0;
    for (const cells of bodyGrid) {
      if (rows.length >= effectiveMax) {
        truncated = true;
        stopReason = effectiveMax < maxRows ? 'max-cells' : 'max-rows';
        break;
      }
      if (seen < start) {
        seen += 1;
        continue;
      }
      const out = {};
      for (let c = 0; c < width; c += 1) out['c' + (c + 1)] = cells[c] === undefined ? '' : cells[c];
      rows.push(out);
      seen += 1;
    }
    const warnings = [];
    if (!headerRows.length) warnings.push('未找到表头，列名用 cN 代替');
    const declared = declaredRowCount(table, 'table');
    const hasMore = start + rows.length < bodyGrid.length;
    return withCoverage({
      kind: 'table',
      columns: columns,
      rows: rows,
      rowCount: rows.length,
      totalRows: bodyGrid.length,
      columnCount: width,
      cells: rows.length * width,
      stopReason: truncated ? stopReason : 'end',
      hasMore: hasMore,
      complete: !truncated && !hasMore && warnings.length === 0,
      truncated: truncated,
      warnings: warnings,
    }, declared == null ? null : Math.max(0, declared - headerRows.length), budget, start);
  }

  function listExtract(root, maxRows, budget, offset) {
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    let items = [];
    if (root.matches && root.matches('ul,ol,[role=list]')) {
      items = Array.from(root.children).filter(function (node) {
        if (node.nodeType !== 1) return false;
        return node.tagName === 'LI' || node.getAttribute('role') === 'listitem' || node.hasAttribute('role');
      });
    }
    if (!items.length) items = Array.from(root.querySelectorAll('li,[role=listitem]'));
    const cellCap = budget ? Math.max(0, Math.floor(budget.maxCells / 2)) : maxRows;
    const effectiveMax = Math.min(maxRows, cellCap);
    const rows = [];
    let truncated = false;
    let stopReason = 'end';
    let seen = 0;
    for (const item of items) {
      if (rows.length >= effectiveMax) {
        truncated = true;
        stopReason = effectiveMax < maxRows ? 'max-cells' : 'max-rows';
        break;
      }
      if (seen < start) {
        seen += 1;
        continue;
      }
      const link = item.querySelector ? item.querySelector('a[href]') : null;
      const row = { index: start + rows.length + 1, text: truncate(normalizeText(item.textContent || ''), 500) };
      if (link) row.href = link.href;
      rows.push(row);
      seen += 1;
    }
    const hasMore = start + rows.length < items.length;
    return withCoverage({
      kind: 'list',
      columns: [{ key: 'index', label: '#' }, { key: 'text', label: 'text' }],
      rows: rows,
      rowCount: rows.length,
      totalRows: items.length,
      cells: rows.length * 2,
      stopReason: truncated ? stopReason : 'end',
      hasMore: hasMore,
      complete: !truncated && !hasMore,
      truncated: truncated,
      warnings: [],
    }, declaredRowCount(root, 'list'), budget, start);
  }

  function listExtractFields(root, args, budget, offset) {
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const maxRows = budget ? budget.maxRows : boundedMaxRows(args);
    const selector = typeof args.itemSelector === 'string' && args.itemSelector.trim() ? args.itemSelector.trim() : '';
    let items = selector ? Array.from(root.querySelectorAll(selector)) : Array.from(root.children || []);
    if (!selector) items = items.filter(function (node) { return node.nodeType === 1; });
    if (!items.length) items = Array.from(root.querySelectorAll('li,[role=listitem],article'));
    const fields = Array.isArray(args.fields) && args.fields.length
      ? args.fields.map(function (field) {
        if (typeof field === 'string') return { name: field, selector: field };
        return {
          name: String(field && field.name || field && field.label || 'field'),
          selector: typeof (field && field.selector) === 'string' ? field.selector : '',
          attribute: typeof (field && field.attribute) === 'string' ? field.attribute : '',
        };
      })
      : [{ name: 'text', selector: '', attribute: '' }];
    const columns = fields.map(function (field, index) { return { key: field.name || ('field' + (index + 1)), label: field.name || ('field' + (index + 1)) }; });
    const cellCap = budget ? Math.max(0, Math.floor(budget.maxCells / Math.max(fields.length, 1))) : maxRows;
    const effectiveMax = Math.min(maxRows, cellCap);
    const rows = [];
    let truncated = false;
    let stopReason = 'end';
    let seen = 0;
    for (const item of items) {
      if (rows.length >= effectiveMax) {
        truncated = true;
        stopReason = effectiveMax < maxRows ? 'max-cells' : 'max-rows';
        break;
      }
      if (seen < start) {
        seen += 1;
        continue;
      }
      const row = { index: start + rows.length + 1 };
      for (const field of fields) {
        const target = field.selector ? item.querySelector(field.selector) : item;
        let value = '';
        if (target) value = field.attribute ? String(target.getAttribute(field.attribute) || '') : String(target.textContent || '');
        row[field.name || 'text'] = truncate(normalizeText(value), 500);
      }
      if (row.text === undefined) {
        const link = item.querySelector ? item.querySelector('a[href]') : null;
        if (link) row.href = link.href;
      }
      rows.push(row);
      seen += 1;
    }
    const hasMore = start + rows.length < items.length;
    return withCoverage({
      kind: 'list',
      columns: columns,
      rows: rows,
      rowCount: rows.length,
      totalRows: items.length,
      cells: rows.length * fields.length,
      stopReason: truncated ? stopReason : 'end',
      hasMore: hasMore,
      complete: !truncated && !hasMore,
      truncated: truncated,
      warnings: [],
    }, declaredRowCount(root, 'list'), budget, start);
  }

  function isGridNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (role === 'grid' || role === 'treegrid') return true;
    const cls = typeof node.className === 'string' ? node.className : '';
    return /(^|\s)ag-root(\s|$)/.test(cls) || /(^|\s)ag-root-wrapper(\s|$)/.test(cls);
  }

  function gridHeaderCells(node) {
    return Array.from(node.querySelectorAll('[role="columnheader"], .ag-header-cell')).filter(function (cell) {
      return isVisible(cell);
    });
  }

  function gridDataRows(node) {
    return Array.from(node.querySelectorAll('[role="row"], .ag-row')).filter(function (row) {
      return row.querySelector('[role="gridcell"], .ag-cell') !== null;
    });
  }

  function gridRowCells(row) {
    return Array.from(row.querySelectorAll('[role="gridcell"], .ag-cell'));
  }

  function gridRowEntries(node) {
    const byIndex = new Map();
    const rows = Array.from(node.querySelectorAll('[role="row"], .ag-row'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], .ag-cell'));
      if (!cells.length) continue;
      const key = row.getAttribute('row-index') || row.getAttribute('row-id') || String(byIndex.size);
      const prev = byIndex.get(key);
      if (!prev || cells.length > prev.cells.length) byIndex.set(key, { row: row, cells: cells, index: key });
    }
    return Array.from(byIndex.values()).sort(function (a, b) {
      const na = Number(a.index); const nb = Number(b.index);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a.index).localeCompare(String(b.index));
    });
  }

  function gridExtract(node, maxRows, budget, offset) {
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const headerCells = Array.from(node.querySelectorAll('[role="columnheader"][col-id], .ag-header-cell[col-id]')).filter(function (cell) {
      return isVisible(cell);
    });
    const colIds = headerCells.map(function (cell) { return cell.getAttribute('col-id'); });
    const labels = headerCells.map(function (cell) { return normalizeText(cell.textContent || ''); });
    const byRow = new Map();
    const rows = Array.from(node.querySelectorAll('[role="row"], .ag-row'));
    for (const row of rows) {
      const index = row.getAttribute('row-index') || row.getAttribute('row-id') || '';
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], .ag-cell'));
      if (!cells.length) continue;
      let bucket = byRow.get(index);
      if (!bucket) { bucket = {}; byRow.set(index, bucket); }
      for (const cell of cells) {
        const colId = cell.getAttribute('col-id') || ('idx' + cells.indexOf(cell));
        bucket[colId] = truncate(normalizeText(cell.textContent || ''), 500);
      }
    }
    const orderedCols = colIds.length ? colIds : Array.from(new Set(Array.from(byRow.values()).flatMap(function (row) { return Object.keys(row); })));
    const columns = orderedCols.map(function (colId, i) {
      const label = labels[i] || '';
      return { key: 'c' + (i + 1), label: label || ('c' + (i + 1)), colId: colId };
    });
    const indices = Array.from(byRow.keys());
    const sorted = indices.slice().sort(function (a, b) {
      const na = Number(a); const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const outRows = [];
    let truncated = false;
    let stopReason = 'end';
    const cellCap = budget ? Math.max(0, Math.floor(budget.maxCells / Math.max(orderedCols.length, 1))) : maxRows;
    const effectiveMax = Math.min(maxRows, cellCap);
    let seen = 0;
    for (const index of sorted) {
      if (outRows.length >= effectiveMax) {
        truncated = true;
        stopReason = effectiveMax < maxRows ? 'max-cells' : 'max-rows';
        break;
      }
      if (seen < start) {
        seen += 1;
        continue;
      }
      const bucket = byRow.get(index);
      const out = {};
      orderedCols.forEach(function (colId, i) { out['c' + (i + 1)] = bucket[colId] === undefined ? '' : bucket[colId]; });
      outRows.push(out);
      seen += 1;
    }
    const hasMore = start + outRows.length < sorted.length;
    return withCoverage({
      kind: 'table',
      columns: columns,
      rows: outRows,
      rowCount: outRows.length,
      totalRows: sorted.length,
      columnCount: orderedCols.length,
      cells: outRows.length * orderedCols.length,
      stopReason: truncated ? stopReason : 'end',
      hasMore: hasMore,
      complete: !truncated && !hasMore && headerCells.length > 0,
      truncated: truncated,
      warnings: headerCells.length ? [] : ['未找到列头，列名用 cN 代替'],
    }, declaredRowCount(node, 'grid'), budget, start);
  }

  const DISCOVER_MAX_TARGETS = 32;
  const DISCOVER_PREVIEW_COLUMNS = 8;
  const DISCOVER_MAX_DEPTH = 4;

  function discoverPreview(node, kind, columns, previewColumns) {
    const labels = [];
    const sample = [];
    if (kind === 'table') {
      if (isGridNode(node)) {
        for (const cell of gridHeaderCells(node).slice(0, previewColumns)) labels.push(truncate(normalizeText(cell.textContent || ''), 60));
        const firstRow = gridDataRows(node)[0];
        if (firstRow) {
          for (const cell of gridRowCells(firstRow).slice(0, previewColumns)) sample.push(truncate(normalizeText(cell.textContent || ''), 80));
        }
      } else {
        const headRows = node.tHead && node.tHead.rows.length ? Array.from(node.tHead.rows) : Array.from(node.rows || []).slice(0, 1);
        const grid = tableCellGrid(headRows);
        for (let c = 0; c < Math.min(columns, previewColumns); c += 1) {
          const parts = [];
          for (const row of grid) {
            const value = normalizeText(row[c] || '');
            if (value && parts[parts.length - 1] !== value) parts.push(value);
          }
          labels.push(truncate(parts.join(' / ') || ('c' + (c + 1)), 60));
        }
        const body = node.tBodies && node.tBodies.length ? node.tBodies[0].rows : (node.rows || []);
        const firstBody = Array.from(body)[0] || Array.from(node.rows || [])[1];
        if (firstBody) {
          const cells = tableCellGrid([firstBody])[0] || [];
          for (let c = 0; c < Math.min(cells.length, previewColumns); c += 1) sample.push(truncate(normalizeText(cells[c] || ''), 80));
        }
      }
    } else {
      const first = node.querySelector('li, [role="listitem"]');
      if (first) sample.push(truncate(normalizeText(first.textContent || ''), 80));
    }
    return { columns: labels, sample: sample };
  }

  function discoverTargets(args = {}) {
    state.extractTargets = new Map();
    state.extractTargetsAt = Date.now();
    const maxTargets = Math.min(Math.max(Number.isInteger(Number(args.maxTargets)) ? Number(args.maxTargets) : DISCOVER_MAX_TARGETS, 1), 200);
    const previewColumns = Math.min(Math.max(Number.isInteger(Number(args.previewColumns)) ? Number(args.previewColumns) : DISCOVER_PREVIEW_COLUMNS, 1), 32);
    const found = [];
    let seq = 0;
    let scanned = 0;
    let truncated = false;
    const selector = 'table, ul, ol, [role="table"], [role="list"], [role="grid"], [role="treegrid"], .ag-root';
    const nodes = [];
    const collect = (root, depth) => {
      if (!root || depth > DISCOVER_MAX_DEPTH) return;
      for (const node of root.querySelectorAll(selector)) nodes.push(node);
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot) collect(host.shadowRoot, depth + 1);
      }
    };
    collect(document, 0);
    for (const node of nodes) {
      if (found.length >= maxTargets) {
        truncated = true;
        break;
      }
      if (!isVisible(node)) continue;
      if (node.closest('table') && node.tagName !== 'TABLE' && node.tagName !== 'UL' && node.tagName !== 'OL') continue;
      scanned += 1;
      seq += 1;
      const kind = node.tagName === 'TABLE' || node.getAttribute('role') === 'table' || isGridNode(node) ? 'table' : 'list';
      let rows = 0;
      let columns = 0;
      if (kind === 'table') {
        if (isGridNode(node)) {
          rows = gridDataRows(node).length;
          columns = gridHeaderCells(node).length;
        } else {
          const bodyRows = node.tBodies && node.tBodies.length ? Array.from(node.tBodies[0].rows) : Array.from(node.rows || []);
          rows = bodyRows.length;
          const headRows = node.tHead && node.tHead.rows.length ? Array.from(node.tHead.rows) : Array.from(node.rows || []).slice(0, 1);
          const headGrid = tableCellGrid(headRows);
          columns = headGrid.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
        }
      } else {
        rows = node.querySelectorAll('li, [role="listitem"]').length;
        columns = 1;
      }
      const label = normalizeText(node.getAttribute('aria-label') || node.id || node.className || '') || (kind + ' #' + seq);
      state.extractTargets.set(seq, node);
      found.push({
        id: seq,
        kind: kind,
        label: truncate(label, 60),
        rows: rows,
        columns: columns,
        preview: discoverPreview(node, kind, columns, previewColumns),
      });
    }
    return {
      targets: found,
      url: location.href,
      scanned: scanned,
      truncated: truncated,
      limits: { maxTargets: maxTargets, previewColumns: previewColumns, maxDepth: DISCOVER_MAX_DEPTH },
    };
  }

  function extractTarget(id) {
    const node = state.extractTargets ? state.extractTargets.get(Number(id)) : null;
    if (!node || !node.isConnected) pageError('E_STALE_REF', 'target ' + id + ' 不在当前列表里，请重新 extract discover');
    if (state.extractTargetsAt && Date.now() - state.extractTargetsAt > 5 * 60 * 1000) {
      pageError('E_STALE_REF', 'extract target 句柄已超过 5 分钟，请重新 extract discover');
    }
    return node;
  }

  function boundedMaxRows(args) {
    const rawMax = Number(args.maxRows);
    return Math.min(Math.max(Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : 500, 1), 5000);
  }

  // 预算镜像：与 extension/src/lib/extract-limits.js 保持一致（页面侧不能 import 模块）。
  const EXTRACT_DEFAULT_MAX_BYTES = 256 * 1024;
  const EXTRACT_DEFAULT_MAX_CELLS = 20000;

  function boundedMaxBytes(args) {
    const raw = Number(args.maxBytes);
    return Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.round(raw) : EXTRACT_DEFAULT_MAX_BYTES, 1024), 4 * 1024 * 1024);
  }

  function boundedMaxCells(args) {
    const raw = Number(args.maxCells);
    return Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.round(raw) : EXTRACT_DEFAULT_MAX_CELLS, 1), 200000);
  }

  function extractBudgetOf(args) {
    return { maxRows: boundedMaxRows(args), maxBytes: boundedMaxBytes(args), maxCells: boundedMaxCells(args) };
  }

  function jsonBytes(value) {
    try {
      const text = JSON.stringify(value === undefined ? null : value);
      try { return new TextEncoder().encode(text).length; } catch { return text.length; }
    } catch { return 0; }
  }

  /** 读取页面自己声明的行数（ARIA），没有声明就返回 null——不猜。 */
  function declaredRowCount(root, kind) {
    if (!root || !root.getAttribute) return null;
    const read = (value) => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const direct = read(root.getAttribute('aria-rowcount'));
    if (direct != null) return direct;
    if (kind === 'list') {
      const item = root.querySelector ? root.querySelector('[aria-setsize]') : null;
      const size = item ? read(item.getAttribute('aria-setsize')) : null;
      if (size != null) return size;
    }
    const rowgroup = root.querySelector ? root.querySelector('[aria-rowcount]') : null;
    return rowgroup ? read(rowgroup.getAttribute('aria-rowcount')) : null;
  }

  /**
   * 给提取结果补一层覆盖度说明：本次只覆盖已加载的 DOM，
   * 声明行数取自页面 ARIA，停止原因区分"到末尾 / 行数上限 / 字节上限"。
   * datasetComplete 只有在"页面有声明且确实读满"时才给 complete，其余一律 unknown/incomplete。
   */
  function withCoverage(result, declared, budget, offset) {
    if (!result || typeof result !== 'object') return result;
    const returned = Array.isArray(result.rows) ? result.rows.length : 0;
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const declaredRows = Number.isFinite(declared) ? declared : null;
    const stopReason = result.stopReason || (result.truncated === true ? 'max-rows' : 'end');
    const hasMore = result.hasMore === true;
    let datasetComplete = 'unknown';
    if (result.truncated === true || hasMore) datasetComplete = 'incomplete';
    else if (declaredRows != null && start + returned >= declaredRows) datasetComplete = 'complete';
    result.offset = start;
    result.declaredRows = declaredRows;
    result.coverage = {
      scope: 'loaded-dom',
      offset: start,
      returned: returned,
      declared: declaredRows,
      omitted: declaredRows == null ? null : Math.max(0, declaredRows - (start + returned)),
      stopReason: stopReason,
      datasetComplete: datasetComplete,
    };
    if (budget) {
      result.cells = Number.isFinite(result.cells) ? result.cells : returned;
      result.budget = {
        maxRows: budget.maxRows,
        maxBytes: budget.maxBytes,
        maxCells: budget.maxCells,
        offset: start,
        rows: returned,
        cells: result.cells,
        bytes: jsonBytes(result),
        stopReason: stopReason,
      };
    }
    return result;
  }

  /** 给读取类结果标注当前 DOM 代数，调用方可据此在后续动作里要求同一代。 */
  function withRevision(result) {
    if (!result || typeof result !== 'object') return result;
    if (result.revision == null) result.revision = currentRevision();
    return result;
  }

  function capExtractBytes(result, maxBytes) {
    const budget = Number(maxBytes);
    if (!Number.isFinite(budget) || budget <= 0) return result;
    if (jsonBytes(result) <= budget) {
      if (result && typeof result === 'object' && result.budget) result.budget.bytes = jsonBytes(result);
      return result;
    }
    result.truncated = true;
    result.complete = false;
    result.stopReason = 'max-bytes';
    if (Array.isArray(result.rows)) {
      while (result.rows.length > 0 && jsonBytes(result) > budget) result.rows.pop();
    }
    if (result.coverage && typeof result.coverage === 'object') {
      result.coverage.stopReason = 'max-bytes';
      result.coverage.returned = Array.isArray(result.rows) ? result.rows.length : 0;
      result.coverage.datasetComplete = 'incomplete';
      if (result.coverage.declared != null) {
        result.coverage.omitted = Math.max(0, result.coverage.declared - result.coverage.returned);
      }
    }
    if (result.budget && typeof result.budget === 'object') {
      result.budget.maxBytes = budget;
      result.budget.bytes = jsonBytes(result);
      result.budget.stopReason = 'max-bytes';
      result.budget.rows = Array.isArray(result.rows) ? result.rows.length : 0;
    }
    return result;
  }

  function actionExtract(args) {
    const budget = extractBudgetOf(args);
    const maxRows = budget.maxRows;
    const offset = Math.max(0, Math.min(Math.floor(Number(args.offset) || 0), 1000000));
    if (args.discover === true) return discoverTargets(args);
    if (args.mode === 'list') {
      let root = null;
      if (args.ref || args.selector) root = resolveElement(args);
      else if (args.target != null && args.target !== '') {
        const node = extractTarget(args.target);
        root = node;
      } else {
        root = document.querySelector('ul,ol,[role=list],main') || document.body;
      }
      if (!root) pageError('E_NOT_FOUND', '页面没有可导出的列表');
      return listExtractFields(root, args, budget, offset);
    }
    if (args.target != null && args.target !== '') {
      const node = extractTarget(args.target);
      if (node.tagName === 'TABLE') return tableExtract(node, maxRows, budget, offset);
      if (isGridNode(node)) return gridExtract(node, maxRows, budget, offset);
      return listExtract(node, maxRows, budget, offset);
    }
    let root = null;
    if (args.ref || args.selector) root = resolveElement(args);
    else root = document.querySelector('table') || document.querySelector('[role="grid"], [role="treegrid"], .ag-root') || document.querySelector('ul,ol,[role=list]');
    if (!root) pageError('E_NOT_FOUND', '页面没有可导出的表格或列表');
    if (root.tagName === 'TABLE') return tableExtract(root, maxRows, budget, offset);
    if (isGridNode(root)) return gridExtract(root, maxRows, budget, offset);
    const table = root.querySelector ? root.querySelector('table') : null;
    if (table) return tableExtract(table, maxRows, budget, offset);
    return listExtract(root, maxRows, budget, offset);
  }

  // ===========================================================================
  // §I 指针/拖拽/滚轮/上传/fetch
  // ===========================================================================
  function rectCenter(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) pageError('E_NOT_FOUND', '目标元素没有可交互区域（尺寸为 0）');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function eventTargetAt(x, y, fallback) {
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    return el || fallback || document.body;
  }

  function fireMouseTarget(target, type, x, y, extra) {
    const init = Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 0,
    }, extra || {});
    try {
      target.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)));
    } catch (e) {
      // 极旧内核没有 PointerEvent：只发 MouseEvent
    }
    const mapped = type === 'pointerdown' ? 'mousedown' : (type === 'pointermove' ? 'mousemove' : (type === 'pointerup' ? 'mouseup' : null));
    if (mapped) target.dispatchEvent(new MouseEvent(mapped, init));
  }

  function targetArg(value, label) {
    if (typeof value === 'string' && value) {
      return value.charAt(0) === '@' ? { ref: value } : { selector: value };
    }
    if (value && typeof value === 'object' && (value.ref || value.selector)) return value;
    pageError('E_BAD_ARG', 'drag 需要 ' + label + '（ref 或 selector）');
    return null;
  }

  function nativeDragSequence(fromEl, toEl, a, b, mods) {
    let transfer = null;
    try { transfer = new DataTransfer(); } catch (e) { transfer = null; }
    const base = Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }, mods || {});
    try {
      fromEl.dispatchEvent(new DragEvent('dragstart', Object.assign({}, base, { clientX: a.x, clientY: a.y })));
      fromEl.dispatchEvent(new DragEvent('drag', Object.assign({}, base, { clientX: a.x, clientY: a.y })));
      toEl.dispatchEvent(new DragEvent('dragenter', Object.assign({}, base, { clientX: b.x, clientY: b.y })));
      toEl.dispatchEvent(new DragEvent('dragover', Object.assign({}, base, { clientX: b.x, clientY: b.y })));
      toEl.dispatchEvent(new DragEvent('drop', Object.assign({}, base, { clientX: b.x, clientY: b.y })));
      fromEl.dispatchEvent(new DragEvent('dragend', Object.assign({}, base, { clientX: b.x, clientY: b.y })));
    } catch (error) {
      pageError('E_INTERNAL', '原生拖拽事件派发失败：' + ((error && error.message) || error));
    }
    return { ok: true, mode: 'native', points: 0 };
  }

  async function actionDrag(args) {
    const mode = args.mode == null ? 'hold' : String(args.mode);
    if (mode !== 'hold' && mode !== 'click-move-click') {
      pageError('E_BAD_MODE', 'mode 只能是 hold 或 click-move-click');
    }
    const bits = Number(args.modifiers) || 0;
    const mods = {
      altKey: (bits & 1) !== 0,
      ctrlKey: (bits & 2) !== 0,
      metaKey: (bits & 4) !== 0,
      shiftKey: (bits & 8) !== 0,
    };
    const fromEl = resolveElement(targetArg(args.from, 'from'));
    const hasDelta = Number.isFinite(Number(args.dx)) || Number.isFinite(Number(args.dy));
    let toEl = null;
    if (args.to != null) toEl = resolveElement(targetArg(args.to, 'to'));
    else if (!hasDelta) pageError('E_BAD_ARG', 'drag 需要 --to 或 --dx/--dy');
    const rawSteps = Number(args.steps);
    const steps = Math.min(Math.max(Number.isFinite(rawSteps) && rawSteps > 0 ? Math.round(rawSteps) : 8, 2), 40);
    scrollIntoView(fromEl);
    await ensureActionable(fromEl, args, 'drag');
    const a = rectCenter(fromEl);
    const fromOffset = { x: Number(args.fromOffsetX) || 0, y: Number(args.fromOffsetY) || 0 };
    a.x += fromOffset.x;
    a.y += fromOffset.y;
    let b;
    if (toEl) {
      b = rectCenter(toEl);
      b.x += Number(args.toOffsetX) || 0;
      b.y += Number(args.toOffsetY) || 0;
    } else {
      b = { x: a.x + (Number(args.dx) || 0), y: a.y + (Number(args.dy) || 0) };
    }
    const holdMs = Math.min(Math.max(Number(args.holdMs) || 0, 0), 5000);
    const durationMs = Math.min(Math.max(Number(args.durationMs) || 0, 0), 5000);
    const hoverEl = toEl || eventTargetAt(b.x, b.y, fromEl);

    const draggable = fromEl.draggable === true || fromEl.getAttribute('draggable') === 'true';
    if (draggable && toEl) return nativeDragSequence(fromEl, toEl, a, b, mods);

    fireMouseTarget(fromEl, 'pointermove', a.x, a.y, Object.assign({ buttons: 0 }, mods));
    fireMouseTarget(fromEl, 'pointerdown', a.x, a.y, Object.assign({ buttons: 1 }, mods));
    if (mode === 'click-move-click') {
      fireMouseTarget(fromEl, 'pointerup', a.x, a.y, Object.assign({ buttons: 0 }, mods));
      fireMouseTarget(fromEl, 'click', a.x, a.y, Object.assign({ buttons: 0 }, mods));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        fireMouseTarget(eventTargetAt(x, y, fromEl), 'pointermove', x, y, Object.assign({ buttons: 0 }, mods));
      }
      fireMouseTarget(hoverEl, 'pointerdown', b.x, b.y, Object.assign({ buttons: 1 }, mods));
      fireMouseTarget(hoverEl, 'pointerup', b.x, b.y, Object.assign({ buttons: 0 }, mods));
      fireMouseTarget(hoverEl, 'click', b.x, b.y, Object.assign({ buttons: 0 }, mods));
      if (durationMs > 0) await sleepMs(durationMs);
      return { ok: true, mode: mode, points: steps };
    }

    // 长按语义：按下之后保持按住，再开始移动。之前把 sleep 放在 pointerdown 之前，
    // 实际效果只是"先等一会儿再按下"，控件收不到任何长按时长。
    if (holdMs > 0) await sleepMs(holdMs);

    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      fireMouseTarget(eventTargetAt(x, y, fromEl), 'pointermove', x, y, Object.assign({ buttons: 1 }, mods));
      if (durationMs > 0) await sleepMs(Math.max(1, Math.round(durationMs / steps)));
    }
    fireMouseTarget(hoverEl, 'pointermove', b.x, b.y, Object.assign({ buttons: 1 }, mods));
    fireMouseTarget(hoverEl, 'pointerup', b.x, b.y, Object.assign({ buttons: 0 }, mods));
    return { ok: true, mode: mode, points: steps };
  }

  function actionWheel(args) {
    const deltaY = Number(args.deltaY);
    const deltaX = Number(args.deltaX);
    const dy = Number.isFinite(deltaY) ? deltaY : 0;
    const dx = Number.isFinite(deltaX) ? deltaX : 0;
    if (dy === 0 && dx === 0) pageError('E_BAD_ARG', 'wheel 需要非零 deltaY 或 deltaX');
    let target = null;
    let x = Number(args.x);
    let y = Number(args.y);
    if (args.ref || args.selector) {
      target = resolveElement(args);
      scrollIntoView(target);
      const center = rectCenter(target);
      x = center.x;
      y = center.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = Math.round(window.innerWidth / 2);
      y = Math.round(window.innerHeight / 2);
    }
    const node = target || eventTargetAt(x, y, document.body);
    const modBits = Number(args.modifiers) || 0;
const beforeY = window.scrollY;
    const beforeX = window.scrollX;
    node.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0,
      altKey: (modBits & 1) !== 0,
      ctrlKey: (modBits & 2) !== 0,
      metaKey: (modBits & 4) !== 0,
      shiftKey: (modBits & 8) !== 0,
    }));
    const moved = Math.abs(window.scrollY - beforeY) > 1 || Math.abs(window.scrollX - beforeX) > 1;
    let synthetic = false;
    if (!moved && !target) {
      // 合成 wheel 事件不会触发浏览器默认滚动；没有指定元素时退化为直接滚动页面
      window.scrollBy({ top: dy, left: dx, behavior: 'instant' });
      synthetic = true;
    }
    return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX, synthetic: synthetic };
  }

  function actionBlur(args) {
    if (args.ref || args.selector) {
      const el = resolveElement(args);
      if (typeof el.blur === 'function') el.blur();
      return { ok: true };
    }
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    return { ok: true };
  }

  function uploadProbe(args) {
    const el = resolveElement(args);
    const tag = el.tagName.toLowerCase();
    return {
      tag,
      isFileInput: el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file',
    };
  }

  function base64ToBytes(input) {
    const text = String(input == null ? '' : input);
    const comma = text.indexOf(',');
    const clean = comma >= 0 ? text.slice(comma + 1) : text;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function actionUpload(args) {
    const el = resolveElement(args);
    const tag = el.tagName;
    const type = tag === 'INPUT' ? String(el.type || '').toLowerCase() : '';
    if (tag !== 'INPUT' || type !== 'file') pageError('E_BAD_ARG', 'upload 只支持 input[type=file]');
    return setFilesOnInput(el, args);
  }

  function actionUploadFirst(args) {
    const inputs = document.querySelectorAll('input[type="file"]');
    if (!inputs.length) pageError('E_NOT_FOUND', '页面上没有 input[type=file]');
    return setFilesOnInput(inputs[0], args);
  }

  function setFilesOnInput(el, args) {
    if (!Array.isArray(args.files) || !args.files.length) pageError('E_BAD_ARG', 'upload 需要 files 数组');
    let total = 0;
    const transfer = new DataTransfer();
    const names = [];
    for (const file of args.files) {
      const bytes = base64ToBytes(file && file.base64);
      total += bytes.length;
      if (total > 20 * 1024 * 1024) pageError('E_TOO_LARGE', '上传文件总大小超过 20MB');
      const name = String((file && file.name) || 'upload.bin');
      const mime = String((file && file.mime) || 'application/octet-stream');
      transfer.items.add(new File([bytes], name, { type: mime, lastModified: Date.now() }));
      names.push(name);
    }
    el.files = transfer.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, names: names };
  }

  /** 同源重放：在页面上下文发一次带 cookie 的请求（network.replay 用）。 */
  async function actionFetchRun(args) {
    const url = String(args.url || '');
    if (!url) pageError('E_BAD_ARG', 'fetch-run 需要 url');
    const method = String(args.method || 'GET').toUpperCase();
    const init = { method: method, credentials: 'include', redirect: 'follow' };
    if (args.headers && typeof args.headers === 'object') init.headers = args.headers;
    if (typeof args.body === 'string' && method !== 'GET' && method !== 'HEAD') init.body = args.body;
    const started = performance.now();
    let response = null;
    try {
      response = await fetch(url, init);
    } catch (error) {
      pageError('E_JS_ERROR', 'fetch 失败：' + ((error && error.message) || error));
    }
    const text = await response.text();
    const headers = {};
    response.headers.forEach(function (value, key) { headers[key] = value; });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
      body: truncate(text, 200000),
      durationMs: Math.round(performance.now() - started),
      url: response.url,
    };
  }

  // ===========================================================================
  // §J 消息分派与 installHumanWatchers
  // ===========================================================================
  function ok(result) {
    return { ok: true, result };
  }

  async function handle(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    try {
      // 观测代数守卫：调用方给了 expectRevision 就要求动作与观测在同一代 DOM 上发生。
      if (input.expectRevision != null) {
        const expected = Number(input.expectRevision);
        const current = currentRevision();
        if (!Number.isFinite(expected) || current !== expected) {
          pageError('E_OBSERVATION_CHANGED', '页面在观测后已变化（观测代数 ' + (Number.isFinite(expected) ? expected : '无效')
            + '，当前 ' + current + '）；重新 observe 后再操作', {
            expected: Number.isFinite(expected) ? expected : null,
            current,
            observed_changes: { revision_delta: Number.isFinite(expected) ? current - expected : null },
          });
        }
      }
      switch (name) {
        case 'mark-agent-input':
          markAgentInput();
          return ok(true);
        case 'observe':
          return ok(observe(input));
        case 'deep-vom':
          return ok(buildDeepVom(input));
        case 'snapshot':
          return ok(snapshot());
        case 'reset-refs':
          return ok(resetRefs());
        case 'click':
          return ok(await retryDetachedTarget(input, () => actionClick(input)));
        case 'hover':
          return ok(await retryDetachedTarget(input, () => actionHover(input)));
        case 'fill':
          return ok(await retryDetachedTarget(input, () => actionFill(input)));
        case 'press':
          return ok(await retryDetachedTarget(input, () => actionPress(input)));
        case 'select':
          return ok(await retryDetachedTarget(input, () => actionSelect(input)));
        case 'actionable':
          return ok(actionability(input));
        case 'row-anchor':
          // 只读：动作前取当前行事实；无行/非虚拟化行返回 anchor:null（fail-closed）。
          return ok(rowAnchorProbe(input));
        case 'fill-focus':
          return ok(fillFastTarget(input));
        case 'fill-verify':
          return ok(fillVerify(input));
        case 'focus':
          return ok(actionFocus(input));
        case 'scroll-to':
          return ok(actionScrollTo(input));
        case 'point':
          return ok(actionPoint(input));
        case 'ref-selector':
          return ok(refSelector(input));
        case 'frame-project-point':
          return ok(frameProjectPoint(input));
        case 'rect':
          return ok(actionRect(input));
        case 'auto-scroll':
          return ok(await actionAutoScroll());
        case 'read':
          return ok(withRevision(actionRead(input)));
        case 'extract':
          return ok(withRevision(capExtractBytes(actionExtract(input), input.maxBytes)));
        case 'drag':
          return ok(await actionDrag(input));
        case 'wheel':
          return ok(actionWheel(input));
        case 'blur':
          return ok(actionBlur(input));
        case 'upload':
          return ok(actionUpload(input));
        case 'upload-first':
          return ok(actionUploadFirst(input));
        case 'fetch-run':
          return ok(await actionFetchRun(input));
        case 'get-html':
          return ok(getHtml(input));
        case 'probe-state':
          return ok(probeState(input));
        case 'node-signature':
          return ok(actionNodeSignature(input));
        case 'ref-signatures':
          return ok(actionRefSignatures(input));
        case 'page-metrics':
          return ok(pageMetrics());
        case 'element-rect':
          return ok(elementRect(input));
        case 'hit-test':
          return ok(actionHitTest(input));
        case 'clear-vom-markers':
          return ok(clearVomMarkers());
        case 'expect-check':
          return ok(expectCheck(input));
        case 'help-criteria-check':
          return ok(helpCriteriaCheck(input));
        case 'perf-metrics':
          return ok(perfMetrics());
        case 'human-activity':
          return ok(humanActivity());
        case 'media-progress':
          return ok(mediaProgress());
        case 'frame-meta':
          return ok(frameMeta());
        case 'revision':
          return ok({ revision: currentRevision() });
        case 'visual-refs':
          return ok(visualRefs());
        case 'visual-scan':
          return ok(visualScan());
        case 'hit-at':
          return ok(hitAt(input));
        case 'click-point':
          return ok(await clickPoint(input));
        case 'upload-probe':
          return ok(uploadProbe(input));
        case 'scroll-to-y':
          return ok(scrollToY(input));
        default:
          return { ok: false, error: { code: 'E_UNKNOWN_METHOD', message: `页面侧未知方法: ${name}` } };
      }
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('E_')) {
        return { ok: false, error: { code: error.code, message: error.message, ...(error.data && typeof error.data === 'object' ? { data: error.data } : {}) } };
      }
      return {
        ok: false,
        error: { code: 'E_INTERNAL', message: String((error && error.message) || error) },
      };
    }
  }

  function installHumanWatchers() {
    try {
      if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
      const send = (event) => {
        try { const p = chrome.runtime.sendMessage({ type: event, at: Date.now() }); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* 离线忽略 */ }
      };
      let lastAt = 0;
      const onInput = (event) => {
        if (!event || event.isTrusted !== true) return;
        // 浮层自己的按钮不能算“人工接管页面”：否则点“交给 Agent”会立刻被自动暂停。
        const target = event.target;
        if (target && target.nodeType === 1 && target.closest && target.closest('[data-bb-ui], #__bb_takeover_host, #__bb_help_host, #__bb_help_highlight, #__bb_record_host, #__bb_manual_host, #__bb_borrow_modal, #__bb_control_hint, #__bb_human_banner')) return;
        const now = Date.now();
        // 与 content/human-watch.js 共用同一抑制标记：Agent 的可信输入不应被当成人工接管。
        if (agentInputRecent(now)) return;
        if (now - lastAt < 500) return;
        lastAt = now;
        send('bb.human.input');
      };
      document.addEventListener('keydown', onInput, true);
      document.addEventListener('pointerdown', onInput, true);
      window.addEventListener('blur', () => send('bb.human.blur'), true);
    } catch { /* 页面环境不支持时忽略 */ }
  }
  installHumanWatchers();

  globalThis[KEY] = {    version: LIB_VERSION,
    handle,
    isVisible,
    hitAt,
    visualScan,
    resetRefs,
  };
})();