// injected/page-lib.js
// 页面侧（ISOLATED world）能力库：observe / snapshot / 动作命令 / 等待探测。
// 通过 chrome.scripting.executeScript(files) 按需补注入，也作为 content script 在 document_start 注入。
// 所有状态挂在 globalThis.__BB_PAGE__（同一 frame 的隔离世界在多次注入间共享），导航后随文档重建。
(() => {
  'use strict';

  const KEY = '__BB_PAGE__';
  const LIB_VERSION = 32;
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
  };

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
  function refFor(el) {
    const existing = state.elRefs.get(el);
    if (existing && state.refs.get(existing) === el) return existing;
    state.seq += 1;
    state.refs.set(state.seq, el);
    state.elRefs.set(el, state.seq);
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

  function pageError(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
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

  function statusFlags(el, role) {
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
    const title = normalizeText(document.title || '');
    lines.push(title ? `- document ${quoteName(truncate(title, NAME_MAX))}` : '- document');
    const maxDepth = Number(options.maxDepth);
    const ctx = {
      lines, withRefs, probeHover, refs: 0, nodes: options.collectNodes ? [] : null, paintSeq: 0,
      markVom: !!options.markVom, vomSeq: 0,
      maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 0, truncated: false,
      surfaces: { iframes: 0, shadows: 0 },
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
  function stealthHidden(el) {
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
  function walk(el, depth) {
      if (!el || el.nodeType !== 1) return;
      if (ctx.maxDepth && depth > ctx.maxDepth) { ctx.truncated = true; return; }
      if (el.tagName === 'IFRAME') ctx.surfaces.iframes += 1;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (!isVisible(el)) return;
      if (!stealthInteractive(el) && stealthHidden(el)) return;
      if (isGridNode(el)) {
        const cols = gridHeaderCells(el).map(function (cell) { return normalizeText(cell.textContent || ''); }).filter(Boolean);
        const gridLine = '  '.repeat(depth) + '- grid' + (cols.length ? ' ' + quoteName(truncate(cols.join(' | '), NAME_MAX)) : '');
        lines.push(gridLine);
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
            }
          }
        }
        // 只读大表折叠：超过 40 行且行内没有可交互元素时，只保留前 40 行并标注剩余数量。
        const readOnlyRows = entries.length > 40 && !entries.some((entry) => entry.row.querySelector && entry.row.querySelector('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]'));
        let emittedRows = 0;
        for (const entry of entries) {
          const text = entry.cells.map(function (cell) { return normalizeText(cell.textContent || ''); }).filter(Boolean).join(' | ');
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
          }
          return;
        }
      }
      const role = roleOf(el);
      let emitted = false;
      if (role && SEMANTIC_ROLES.has(role)) {
        lines.push(formatNode(el, role, depth, ctx));
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

    if (document.body) {
      for (const child of document.body.children) walk(child, 1);
    }
    if (ctx.truncated) lines.push('- …（已按 --max-depth ' + ctx.maxDepth + ' 截断更深层）');
    if (options.debugSurfaces) lines.push('- surfaces iframes=' + ctx.surfaces.iframes + ' open-shadow=' + ctx.surfaces.shadows);
    return { lines, refs: ctx.refs, nodes: ctx.nodes || [] };
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
    return { state: 'blocked', by: nodeBrief(hit), byOwnOverlay: isOwnOverlayNode(hit) };
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
   * 与 Playwright/BrowserSkill 的 actionability 对齐；--force 只绕过遮挡类检查。
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
      ctx.nodes.push({
        ref: refId != null ? '@e' + refId : null,
        vomId,
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
        readonly: el.readOnly === true,
        placeholder: el.getAttribute('placeholder') || null,
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
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
        contrast: contrast == null ? null : Number(contrast.toFixed(2)),
        lowContrast: contrast != null && textBearing && contrast < 4.5,
      });
    }
    if (role === 'link' && el.href && /^https?:/i.test(el.href)) {
      line += ' → ' + truncate(el.href.replace(/^https?:\/\//i, ''), 90);
    }
    line += statusFlags(el, role)
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

  function observe(args) {
    const built = buildObservation({ withRefs: true, probeHover: !!args.probeHover, maxDepth: args.maxDepth, debugSurfaces: !!args.debugSurfaces, collectNodes: !!args.vom, markVom: !!args.markVom });
    return {
      url: location.href,
      title: document.title || '',
      observation: built.lines.join('\n'),
      refs: built.refs,
      nodes: built.nodes || [],
      blocking: detectBlockingLayer(),
    };
  }

  function snapshot() {
    const built = buildObservation({ withRefs: true, probeHover: false });
    return { text: built.lines.join('\n'), refs: built.refs };
  }

  function resetRefs() {
    state.refs.clear();
    state.elRefs = new WeakMap();
    state.seq = 0;
    return { ok: true };
  }

  // ---------- 元素解析 ----------

  function resolveElement(args) {
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    if (hasRef === hasSelector) {
      pageError('E_BAD_ARG', 'ref 与 selector 必须恰好给一个');
    }
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

  // ---------- 页面动作 ----------

  async function actionClick(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    await ensureActionable(el, args, 'click');
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch {
      // 忽略 focus 失败
    }
    if (!el.isConnected) pageError('E_NOT_ACTIONABLE', '目标在聚焦时被替换（detached）');
    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    return { ok: true };
  }

  async function actionHover(args) {
    const el = resolveElement(args);
    scrollIntoView(el);
    await ensureActionable(el, args, 'hover');
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
    let code = '';
    if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
    else if (/^\d$/.test(key)) code = `Digit${key}`;
    else if (key === ' ') code = 'Space';
    else if (/^F([1-9]|1[0-2])$/i.test(key)) code = key.toUpperCase();
    else code = key;
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

  function fillFastTarget(args) {
    const el = resolveElement(args);
    if (!el) pageError('E_NOT_FOUND', '页面没有可填写元素');
    const tag = el.tagName.toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const isCe = el.isContentEditable === true;
    if (tag !== 'input' && tag !== 'textarea' && !isCe) pageError('E_TARGET_NOT_FILLABLE', '目标不可填写');
    if (el.disabled === true || el.readOnly === true) pageError('E_TARGET_NOT_FILLABLE', '目标已禁用或只读');
    const textLike = isCe || tag === 'textarea' || (tag === 'input' && ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type));
    if (!textLike) return { ok: true, textLike: false };
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
      try { if (typeof el.select === 'function') el.select(); } catch { /* 忽略 */ }
      return { ok: true, textLike: true, occluded: true, reason: 'occluded' };
    }
    try { document.documentElement.setAttribute('data-bb-agent-input', String(Date.now())); } catch { /* 忽略 */ }
    try { el.focus({ preventScroll: false }); } catch { /* 忽略 */ }
    try { if (typeof el.select === 'function') el.select(); } catch { /* 忽略 */ }
    return { ok: true, textLike: true, tag: tag, type: type, hadValue: String(el.value == null ? '' : el.value).length > 0 };
  }

  function fillVerify(args) {
    const el = resolveElement(args);
    const expected = typeof args.expected === 'string' ? args.expected : '';
    const sensitive = el ? sensitiveField(el) : false;
    const actual = el ? String(el.value != null ? el.value : normalizeText(el.textContent || '')) : '';
    return { ok: true, sensitive: sensitive, value: sensitive ? null : actual, formatted: actual !== expected, matches: actual === expected };
  }

  function actionability(args) {
    const el = resolveElement(args);
    if (!el) pageError('E_NOT_FOUND', '页面没有可操作元素');
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
    if (el.disabled === true) pageError('E_BAD_ARG', '控件已禁用，无法选择');
    if (typeof args.value !== 'string') pageError('E_BAD_ARG', 'select 需要字符串 value');
    scrollIntoView(el);
    await ensureActionable(el, args, 'select');
    const wanted = args.value;
    const options = Array.from(el.options);
    let chosen = options.find((item) => item.value === wanted);
    if (!chosen) {
      const byLabel = options.filter((item) => normalizeText(item.textContent) === wanted);
      if (byLabel.length > 1) {
        pageError('E_OPTION_AMBIGUOUS', `“${wanted}” 匹配 ${byLabel.length} 个选项，请改用 value：` + byLabel.slice(0, 12).map((item) => item.value).join(' / '));
      }
      if (byLabel.length === 0) {
        pageError('E_OPTION_NOT_FOUND', `找不到“${wanted}”；可选：` + options.slice(0, 12).map((item) => normalizeText(item.textContent)).join(' / '));
      }
      chosen = byLabel[0];
    }
    el.value = chosen.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: chosen.value, label: normalizeText(chosen.textContent) };
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
    const children = top
      ? Array.from(document.querySelectorAll('iframe')).slice(0, 50).map(function (el) {
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
          url: el.src || '',
          hidden,
          offscreen,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          reason: hidden ? 'not-visible' : offscreen ? 'offscreen' : null,
        };
      })
      : [];
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
    };
  }

  function scrollToY(args) {
    const y = Number(args.y);
    window.scrollTo(0, Number.isFinite(y) ? y : 0);
    return { scrollY: window.scrollY };
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

  function tableExtract(table, maxRows) {
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
    const rows = [];
    let truncated = false;
    for (const cells of bodyGrid) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const out = {};
      for (let c = 0; c < width; c += 1) out['c' + (c + 1)] = cells[c] === undefined ? '' : cells[c];
      rows.push(out);
    }
    const warnings = [];
    if (!headerRows.length) warnings.push('未找到表头，列名用 cN 代替');
    return {
      kind: 'table',
      columns: columns,
      rows: rows,
      rowCount: rows.length,
      totalRows: bodyGrid.length,
      columnCount: width,
      complete: !truncated && warnings.length === 0,
      truncated: truncated,
      warnings: warnings,
    };
  }

  function listExtract(root, maxRows) {
    let items = [];
    if (root.matches && root.matches('ul,ol,[role=list]')) {
      items = Array.from(root.children).filter(function (node) {
        if (node.nodeType !== 1) return false;
        return node.tagName === 'LI' || node.getAttribute('role') === 'listitem' || node.hasAttribute('role');
      });
    }
    if (!items.length) items = Array.from(root.querySelectorAll('li,[role=listitem]'));
    const rows = [];
    let truncated = false;
    for (const item of items) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const link = item.querySelector ? item.querySelector('a[href]') : null;
      const row = { index: rows.length + 1, text: truncate(normalizeText(item.textContent || ''), 500) };
      if (link) row.href = link.href;
      rows.push(row);
    }
    return {
      kind: 'list',
      columns: [{ key: 'index', label: '#' }, { key: 'text', label: 'text' }],
      rows: rows,
      rowCount: rows.length,
      totalRows: items.length,
      complete: !truncated,
      truncated: truncated,
      warnings: [],
    };
  }

  function listExtractFields(root, args) {
    const maxRows = boundedMaxRows(args);
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
    const rows = [];
    let truncated = false;
    for (const item of items) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const row = { index: rows.length + 1 };
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
    }
    return { kind: 'list', columns: columns, rows: rows, rowCount: rows.length, totalRows: items.length, complete: !truncated, truncated: truncated, warnings: [] };
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

  function gridExtract(node, maxRows) {
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
    for (const index of sorted) {
      if (outRows.length >= maxRows) { truncated = true; break; }
      const bucket = byRow.get(index);
      const out = {};
      orderedCols.forEach(function (colId, i) { out['c' + (i + 1)] = bucket[colId] === undefined ? '' : bucket[colId]; });
      outRows.push(out);
    }
    return {
      kind: 'table',
      columns: columns,
      rows: outRows,
      rowCount: outRows.length,
      totalRows: sorted.length,
      columnCount: orderedCols.length,
      complete: !truncated && headerCells.length > 0,
      truncated: truncated,
      warnings: headerCells.length ? [] : ['未找到列头，列名用 cN 代替'],
    };
  }

  function discoverTargets() {
    state.extractTargets = new Map();
    const found = [];
    let seq = 0;
    const nodes = document.querySelectorAll('table, ul, ol, [role="table"], [role="list"], [role="grid"], [role="treegrid"], .ag-root');
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      if (node.closest('table') && node.tagName !== 'TABLE' && node.tagName !== 'UL' && node.tagName !== 'OL') continue;
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
      found.push({ id: seq, kind: kind, label: truncate(label, 60), rows: rows, columns: columns });
      if (found.length >= 20) break;
    }
    return { targets: found };
  }

  function boundedMaxRows(args) {
    const rawMax = Number(args.maxRows);
    return Math.min(Math.max(Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : 500, 1), 5000);
  }

  function capExtractBytes(result, maxBytes) {
    const budget = Number(maxBytes);
    if (!Number.isFinite(budget) || budget <= 0) return result;
    if (JSON.stringify(result).length <= budget) return result;
    result.truncated = true;
    result.complete = false;
    if (Array.isArray(result.rows)) {
      while (result.rows.length > 0 && JSON.stringify(result).length > budget) result.rows.pop();
    }
    return result;
  }

  function actionExtract(args) {
    if (args.discover === true) return discoverTargets();
    if (args.mode === 'list') {
      let root = null;
      if (args.ref || args.selector) root = resolveElement(args);
      else if (args.target != null && args.target !== '') {
        const node = state.extractTargets ? state.extractTargets.get(Number(args.target)) : null;
        if (!node || !node.isConnected) pageError('E_STALE_REF', 'target ' + args.target + ' 不在当前列表里，请重新 extract discover');
        root = node;
      } else {
        root = document.querySelector('ul,ol,[role=list],main') || document.body;
      }
      if (!root) pageError('E_NOT_FOUND', '页面没有可导出的列表');
      return listExtractFields(root, args);
    }
    if (args.target != null && args.target !== '') {
      const id = Number(args.target);
      const node = state.extractTargets ? state.extractTargets.get(id) : null;
      if (!node || !node.isConnected) pageError('E_STALE_REF', 'target ' + args.target + ' 不在当前列表里，请重新 extract discover');
      if (node.tagName === 'TABLE') return tableExtract(node, boundedMaxRows(args));
      if (isGridNode(node)) return gridExtract(node, boundedMaxRows(args));
      return listExtract(node, boundedMaxRows(args));
    }
    const rawMax = Number(args.maxRows);
    const maxRows = boundedMaxRows(args);
    let root = null;
    if (args.ref || args.selector) root = resolveElement(args);
    else root = document.querySelector('table') || document.querySelector('[role="grid"], [role="treegrid"], .ag-root') || document.querySelector('ul,ol,[role=list]');
    if (!root) pageError('E_NOT_FOUND', '页面没有可导出的表格或列表');
    if (root.tagName === 'TABLE') return tableExtract(root, maxRows);
    if (isGridNode(root)) return gridExtract(root, maxRows);
    const table = root.querySelector ? root.querySelector('table') : null;
    if (table) return tableExtract(table, maxRows);
    return listExtract(root, maxRows);
  }

  // ---------- v0.2：拖拽 / 滚轮 / 失焦 / 上传 ----------

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
    ensureActionable(fromEl, args, 'drag');
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
    if (holdMs > 0) await sleepMs(holdMs);

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

  // ---------- 入口 ----------

  function ok(result) {
    return { ok: true, result };
  }

  async function handle(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    try {
      switch (name) {
        case 'observe':
          return ok(observe(input));
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
        case 'rect':
          return ok(actionRect(input));
        case 'auto-scroll':
          return ok(await actionAutoScroll());
        case 'read':
          return ok(actionRead(input));
        case 'extract':
          return ok(capExtractBytes(actionExtract(input), input.maxBytes));
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
        case 'perf-metrics':
          return ok(perfMetrics());
        case 'human-activity':
          return ok(humanActivity());
        case 'media-progress':
          return ok(mediaProgress());
        case 'frame-meta':
          return ok(frameMeta());
        case 'visual-refs':
          return ok(visualRefs());
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
        return { ok: false, error: { code: error.code, message: error.message } };
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
        const now = Date.now();
        // 与 content/human-watch.js 共用同一抑制标记：Agent 的可信输入不应被当成人工接管。
        const marker = Number(document.documentElement.getAttribute('data-bb-agent-input') || 0);
        if (marker && now - marker < 2000) return;
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
    resetRefs,
  };
})();