// ui/lib/keyboard.js —— 纯键盘模型（无 DOM/chrome，可在 Node 单测）。
//
// 页面里到处是 `if (event.key === 'ArrowDown')`；这里把「按键 → 意图」收敛成一份表，
// 保证列表、时间线、对比视图的键盘行为一致，并且与输入法/修饰键的兼容性只写一次。
//
// 关键兼容点（真实页面会踩）：
// - 输入法组合期间（isComposing / keyCode 229）不能响应单键快捷键，否则中文输入会被吞；
// - 在 input/textarea/select/contenteditable 里不能抢走方向键与空格；
// - Cmd/Ctrl/Alt 组合键不当作列表导航（留给浏览器/系统）；
// - 长按重复事件（event.repeat）只允许「导航类」意图重复。

/** 可安全 preventDefault 的导航意图。 */
export const NAVIGATION_INTENTS = Object.freeze([
  'up', 'down', 'left', 'right', 'home', 'end', 'page-up', 'page-down', 'next', 'prev',
]);

/** 意图 → 默认按键（页面帮助文本/文档用）。 */
export const KEY_BINDINGS = Object.freeze({
  up: ['ArrowUp', 'k'],
  down: ['ArrowDown', 'j'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  home: ['Home'],
  end: ['End'],
  'page-up': ['PageUp'],
  'page-down': ['PageDown'],
  next: ['n'],
  prev: ['p'],
  activate: ['Enter'],
  select: [' '],
  'select-all': ['a'],
  close: ['Escape'],
  'open-filter': ['/'],
  'open-compare': ['c'],
  retry: ['r'],
  'zoom-in': ['+', '='],
  'zoom-out': ['-', '_'],
  reset: ['0'],
});

/** 从事件或普通对象里取 key（兼容测试传入纯对象）。 */
export function keyOf(event) {
  if (!event || typeof event !== 'object') return '';
  const key = event.key;
  return key === undefined || key === null ? '' : String(key);
}

/** 输入法组合中？测试可直接传 {isComposing:true} 或 {keyCode:229}。 */
export function isComposingEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.isComposing === true) return true;
  const code = Number(event.keyCode);
  return code === 229 || Number(event.which) === 229;
}

/** 事件是否来自可编辑控件（页面不该在这些控件上抢键）。 */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
  if (target.isContentEditable === true) return true;
  const role = String(target.getAttribute ? target.getAttribute('role') || '' : '').toLowerCase();
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** 是否有会改变语义的修饰键（Shift 不算，Shift+方向用于范围选择）。 */
export function hasCommandModifier(event) {
  if (!event || typeof event !== 'object') return false;
  return event.ctrlKey === true || event.metaKey === true || event.altKey === true;
}

/**
 * 按键 → 意图列表（按顺序），没有命中返回 []。
 * 冲突处理：Space 在输入控件里返回 []；'/' 只在非输入态打开筛选。
 */
export function intentsFor(key, options = {}) {
  const name = String(key === undefined || key === null ? '' : key);
  if (!name) return [];
  const editable = options.editable === true;
  const out = [];
  switch (name) {
    case 'ArrowUp': out.push('up'); break;
    case 'ArrowDown': out.push('down'); break;
    case 'ArrowLeft': out.push('left'); break;
    case 'ArrowRight': out.push('right'); break;
    case 'Home': out.push('home'); break;
    case 'End': out.push('end'); break;
    case 'PageUp': out.push('page-up'); break;
    case 'PageDown': out.push('page-down'); break;
    case 'Enter': out.push('activate'); break;
    case ' ': case 'Spacebar': out.push('select'); break;
    case 'Escape': out.push('close'); break;
    case '/': if (!editable) out.push('open-filter'); break;
    case '+': case '=': out.push('zoom-in'); break;
    case '-': case '_': out.push('zoom-out'); break;
    case '0': out.push('reset'); break;
    case 'j': if (options.vimKeys !== false) out.push('down'); break;
    case 'k': if (options.vimKeys !== false) out.push('up'); break;
    case 'g': if (options.vimKeys !== false) out.push('home'); break;
    case 'G': if (options.vimKeys !== false) out.push('end'); break;
    default: break;
  }
  return out;
}

/**
 * 把一次键盘事件解析成页面意图。
 * @returns {{intent:string|null, intents:string[], shift:boolean, editable:boolean, handled:boolean, reason:string}}
 */
export function resolveEvent(event, options = {}) {
  const key = keyOf(event);
  const editable = options.editable === true || Boolean(event && event.editable === true) || isEditableTarget(options.target || (event && event.target));
  const composing = isComposingEvent(event);
  const modifier = hasCommandModifier(event);
  const repeat = Boolean(event && event.repeat);
  const result = { intent: null, intents: [], shift: Boolean(event && event.shiftKey), editable, handled: false, reason: 'none' };
  if (composing) { result.reason = 'composing'; return result; }
  if (modifier) {
    // Ctrl/Cmd+R 之类属于浏览器；但 Ctrl+A 在列表上表达“全选”，单独放行。
    if ((event.ctrlKey === true || event.metaKey === true) && (key === 'a' || key === 'A') && !editable) {
      result.intent = 'select-all';
      result.intents = ['select-all'];
      result.handled = true;
      result.reason = 'select-all';
    } else {
      result.reason = 'modifier';
    }
    return result;
  }
  const intents = intentsFor(key, { editable, vimKeys: options.vimKeys });
  if (!intents.length) { result.reason = key === 'Escape' ? 'escape' : 'unbound'; return result; }
  // 输入控件里只保留 Escape（关闭预览/对话框）。
  if (editable && intents[0] !== 'close') { result.reason = 'editable'; return result; }
  if (repeat && !NAVIGATION_INTENTS.includes(intents[0])) {
    result.reason = 'repeat';
    return result;
  }
  result.intent = intents[0];
  result.intents = intents;
  result.handled = true;
  result.reason = 'bound';
  return result;
}

/** 匹配单键或 "Ctrl+K" / "Shift+Enter" 形式的快捷键表。 */
export function matchesShortcut(event, shortcut) {
  const text = String(shortcut || '');
  if (!text) return false;
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const keyName = parts.pop();
  const wantCtrl = parts.some((part) => /^(ctrl|cmd|meta)$/i.test(part));
  const wantShift = parts.some((part) => /^shift$/i.test(part));
  const wantAlt = parts.some((part) => /^alt$/i.test(part));
  const key = keyOf(event).toLowerCase();
  if (key !== String(keyName).toLowerCase()) return false;
  const ctrl = Boolean(event && (event.ctrlKey || event.metaKey));
  return ctrl === wantCtrl
    && Boolean(event && event.shiftKey) === wantShift
    && Boolean(event && event.altKey) === wantAlt;
}

/**
 * 快捷键表匹配：传 { 'r': 'refresh', 'Ctrl+k': 'palette' }。
 * 修饰键更多的组合优先（'Ctrl+k' 先于 'k'）。
 */
export function shortcutIntent(event, bindings = {}) {
  const entries = Object.entries(bindings)
    .filter(([shortcut]) => matchesShortcut(event, shortcut))
    .sort((a, b) => b[0].split('+').length - a[0].split('+').length);
  return entries.length ? entries[0][1] : null;
}

/** 方向键 → 网格移动（列表/时间线共用）。wrap 为 true 时首尾循环。 */
export function moveIndex(index, delta, total, { wrap = false } = {}) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (count === 0) return -1;
  const current = Math.min(count - 1, Math.max(0, Math.floor(Number(index) || 0)));
  const next = current + Math.floor(Number(delta) || 0);
  if (wrap) return ((next % count) + count) % count;
  return Math.min(count - 1, Math.max(0, next));
}

/**
 * 把意图应用到「选中行」。
 * @returns {number} 新行号（-1 表示还没选中）
 */
export function intentToIndex(intent, { index = -1, total = 0, pageSize = 20, wrap = false } = {}) {
  switch (intent) {
    // 还没有选中时按 ↓/n 选中第一项（列表刚获得焦点时的常见预期）。
    case 'up': return index < 0 ? (total > 0 ? 0 : -1) : moveIndex(index, -1, total, { wrap });
    case 'down': return index < 0 ? (total > 0 ? 0 : -1) : moveIndex(index, 1, total, { wrap });
    case 'home': return total > 0 ? 0 : -1;
    case 'end': return total > 0 ? total - 1 : -1;
    case 'page-up': return moveIndex(index, -Math.max(1, pageSize), total, { wrap: false });
    case 'page-down': return moveIndex(index, Math.max(1, pageSize), total, { wrap: false });
    case 'next': return moveIndex(index, 1, total, { wrap: false });
    case 'prev': return moveIndex(index, -1, total, { wrap: false });
    default: return index;
  }
}

/** 类型前置（typeahead）匹配：在最近一次按键后继续按字母收窄候选。 */
export function typeaheadMatch(labels, query) {
  const needle = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
  const list = Array.isArray(labels) ? labels : [];
  if (!needle) return -1;
  return list.findIndex((label) => String(label === undefined || label === null ? '' : label).toLowerCase().startsWith(needle));
}

/** 键盘提示文本的按键名归一化（用于 aria-describedby 与页脚提示）。 */
export function keyLabel(key) {
  const name = String(key || '');
  const map = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ' ': 'Space', Enter: 'Enter', Escape: 'Esc', PageUp: 'PgUp', PageDown: 'PgDn',
  };
  return map[name] || name;
}
