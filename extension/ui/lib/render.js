// ui/lib/render.js —— 纯渲染描述（无 DOM，可在 Node 单测）。
//
// 页面需要“构建一棵小 DOM”时，先建描述对象（可断言、可序列化），再交给 lib/dom.js
// 挂到真实 DOM。这样视图逻辑（views/*.js）保持 100% 纯函数，Node 测试能直接断言
// tag/属性/文本，而不用引入 jsdom。
//
// 描述格式：
//   { tag: 'div', attrs: { class: 'row', 'data-x': '1' }, text: 'hello', children: [...] }
// - attrs 允许 class/dataset/aria-*；事件写在 `on` 对象里（dom.js 负责 addEventListener）。
// - text 与 children 互斥，text 优先（用 textContent，绝不拼 innerHTML）。
// - style 只接受对象（键值 → el.style.setProperty），避免字符串解析。

export const TEXT_NODE = '#text';

/** 元素描述工厂：`h('div', { class: 'row' }, ['a', h('span', {}, 'b')])`。 */
export function h(tag, attrs, children) {
  const node = { tag: String(tag || 'div') };
  if (attrs && typeof attrs === 'object') node.attrs = { ...attrs };
  if (children !== undefined && children !== null) {
    node.children = Array.isArray(children) ? children : [children];
  }
  return node;
}

/** 文本节点描述。 */
export function text(value) {
  return { tag: TEXT_NODE, text: String(value === undefined || value === null ? '' : value) };
}

/** 片段：children 平铺，无额外包装元素。 */
export function fragment(children) {
  return { tag: '#fragment', children: Array.isArray(children) ? children : [children] };
}

/** 展平任意嵌套（数组/描述/字符串/null），过滤空值。 */
export function flattenNodes(input) {
  const out = [];
  const stack = Array.isArray(input) ? [...input] : [input];
  while (stack.length) {
    const item = stack.shift();
    if (item === undefined || item === null || item === false) continue;
    if (Array.isArray(item)) { stack.unshift(...item); continue; }
    if (typeof item === 'string' || typeof item === 'number') { out.push(text(item)); continue; }
    if (typeof item === 'object' && item.tag) out.push(item);
  }
  return out;
}

/** 统计描述树：{elements, texts, maxDepth, bytes}，测试/预算断言用。 */
export function describeTree(node) {
  const stats = { elements: 0, texts: 0, maxDepth: 0, textBytes: 0 };
  const walk = (item, depth) => {
    if (item === undefined || item === null || item === false) return;
    if (typeof item === 'string' || typeof item === 'number') {
      stats.texts += 1;
      stats.textBytes += String(item).length;
      stats.maxDepth = Math.max(stats.maxDepth, depth);
      return;
    }
    if (item.tag === TEXT_NODE) {
      stats.texts += 1;
      stats.textBytes += String(item.text || '').length;
      return;
    }
    if (item.tag === '#fragment') {
      for (const child of item.children || []) walk(child, depth);
      return;
    }
    stats.elements += 1;
    if (item.text !== undefined && item.text !== null) {
      stats.texts += 1;
      stats.textBytes += String(item.text).length;
    }
    for (const child of item.children || []) walk(child, depth + 1);
  };
  walk(node, 0);
  return stats;
}

/** 生成稳定路径（用于测试定位与 aria 描述）：“0/div.2/button”。 */
export function nodePath(parts) {
  return (Array.isArray(parts) ? parts : []).filter((part) => part !== '').join('/');
}

/** 给描述补 aria 属性（不覆盖已有值）。 */
export function withAria(node, attrs) {
  if (!node || node.tag === TEXT_NODE) return node;
  const next = { ...node, attrs: { ...(node.attrs || {}) } };
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (next.attrs[name] !== undefined) continue;
    next.attrs[name] = String(value);
  }
  return next;
}

/** 给描述补 class（去重、保序）。 */
export function withClass(node, className) {
  if (!node || node.tag === TEXT_NODE) return node;
  const existing = String((node.attrs && node.attrs.class) || '').split(/\s+/).filter(Boolean);
  const incoming = String(className || '').split(/\s+/).filter(Boolean);
  const merged = [...new Set([...existing, ...incoming])];
  return { ...node, attrs: { ...(node.attrs || {}), class: merged.join(' ') } };
}

/** 条件渲染：condition 为真返回 node，否则 null（页面不用写三目）。 */
export function when(condition, node) {
  return condition ? node : null;
}

/** 列表渲染：每项 → 描述。 */
export function mapNodes(items, mapper) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item, index) => mapper(item, index)).filter((node) => node !== null && node !== undefined);
}

/**
 * 关键行容器（列表行）：统一 role/aria 与选中态。
 * @param {{index:number, total:number, label:string, selected?:boolean, disabled?:boolean, children:Array}} options
 */
export function listRow({ index, total, label, selected = false, disabled = false, children = [] } = {}) {
  const node = h('div', {
    class: 'list-row' + (selected ? ' selected' : '') + (disabled ? ' disabled' : ''),
    role: 'row',
    'aria-rowindex': String((Number(index) || 0) + 1),
    'aria-selected': selected ? 'true' : 'false',
    'aria-label': label || '',
    tabindex: selected ? '0' : '-1',
  }, children);
  if (disabled) node.attrs['aria-disabled'] = 'true';
  return node;
}

/** 状态角色：列表容器（role=list/listbox/table 三选一）。 */
export function listRole(kind) {
  if (kind === 'table') return { role: 'table', 'aria-rowcount': undefined };
  if (kind === 'listbox') return { role: 'listbox', 'aria-multiselectable': 'true' };
  return { role: 'list' };
}

/** 按钮描述（不含真实事件：on 由页面填）。 */
export function button({ label, tone = '', disabled = false, attrs = {}, on = null } = {}) {
  const node = h('button', {
    type: 'button',
    class: 'btn' + (tone ? ' ' + tone : ''),
    'aria-label': label || '',
    ...attrs,
  }, label || '');
  if (disabled) node.attrs.disabled = '';
  if (on) node.on = on;
  return node;
}

/** 可排序表头描述：aria-sort + 可点击。 */
export function sortHeader({ label, sortDirection = null, on = null } = {}) {
  const attrs = { scope: 'col', class: 'sortable' };
  if (sortDirection === 'ascending' || sortDirection === 'descending') attrs['aria-sort'] = sortDirection;
  const node = h('th', attrs, [
    label || '',
    sortDirection === 'ascending' ? ' ▲' : sortDirection === 'descending' ? ' ▼' : '',
  ]);
  if (on) node.on = on;
  return node;
}

/** 时间线柱描述：role=img + 可访问名称（读屏能把整条时间线读出来）。 */
export function timelineBar({ x, y, width, height, label, tone = '', on = null } = {}) {
  const node = h('span', {
    class: 'tl-bar' + (tone ? ' ' + tone : ''),
    role: 'img',
    'aria-label': label || '',
    style: { insetInlineStart: Math.round(x) + 'px', top: Math.round(y) + 'px', width: Math.max(2, Math.round(width)) + 'px', height: Math.max(2, Math.round(height)) + 'px' },
  });
  if (on) node.on = on;
  return node;
}

/** 刻度描述。 */
export function timelineTick({ x, label } = {}) {
  return h('span', { class: 'tl-tick', style: { insetInlineStart: Math.round(x) + 'px' }, 'aria-hidden': 'true' }, label || '');
}

/** 差异行描述：type 决定 class 与 aria 前缀。 */
export function diffRow({ type, leftNumber = '', rightNumber = '', text: content = '', ariaLabel = '' } = {}) {
  return h('div', {
    class: 'diff-row ' + (type || 'equal'),
    role: 'row',
    'aria-label': ariaLabel || undefined,
  }, [
    h('span', { class: 'diff-num', 'aria-hidden': 'true' }, leftNumber === null || leftNumber === undefined ? '' : String(leftNumber)),
    h('span', { class: 'diff-num', 'aria-hidden': 'true' }, rightNumber === null || rightNumber === undefined ? '' : String(rightNumber)),
    h('span', { class: 'diff-text mono' }, [type === 'insert' ? '+ ' : type === 'delete' ? '- ' : '  ', String(content === undefined || content === null ? '' : content)]),
  ]);
}

/** 空/错/载入的通用容器描述。 */
export function stateBlock({ kind = 'empty', message = '', retry = null, role = 'status' } = {}) {
  const node = h('div', {
    class: 'state-block ' + kind,
    role,
    'aria-live': 'polite',
  }, [message || '']);
  if (retry && typeof retry.on === 'function') {
    node.children = [message || '', button({ label: retry.label || 'Retry', on: { click: retry.on } })];
  }
  return node;
}
