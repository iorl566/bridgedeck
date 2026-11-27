// ui/lib/dom.js —— 渲染描述 → 真实 DOM 的挂载器（唯一接触 document 的新模块）。
//
// 与 lib/render.js 分工：render.js 只产出描述（纯函数、可单测），这里把描述变成
// 真实节点。页面只 import 本文件，不再各写 createElement 循环。
//
// 安全：只用 textContent / setAttribute，不拼 innerHTML；`attrs` 里的 onerror 之类
// 内联事件不会被写进 DOM（事件只能通过 `on` 对象注册）。

import { TEXT_NODE } from './render.js';

function isElementLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number';
}

/** 应用 style 对象（支持 kebab-case 与 camelCase；忽略事件处理器）。 */
function applyStyle(node, style) {
  if (!style || typeof style !== 'object') return;
  for (const [property, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    const name = String(property).startsWith('--')
      ? String(property)
      : String(property).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
    if (/^(--[a-z0-9-]+|[a-z][a-z0-9-]*)$/i.test(name)) node.style.setProperty(name, String(value));
  }
}

/** 应用 dataset 对象。 */
function applyDataset(node, dataset) {
  if (!dataset || typeof dataset !== 'object') return;
  for (const [key, value] of Object.entries(dataset)) {
    if (value === undefined || value === null) continue;
    node.dataset[key] = String(value);
  }
}

function applyAttrs(node, attrs) {
  if (!attrs || typeof attrs !== 'object') return;
  for (const [name, raw] of Object.entries(attrs)) {
    if (raw === undefined || raw === null || raw === false) continue;
    const key = String(name);
    if (key === 'class' || key === 'className') {
      node.className = String(raw);
      continue;
    }
    if (key === 'dataset') { applyDataset(node, raw); continue; }
    if (key === 'style') { applyStyle(node, raw); continue; }
    if (/^on[a-z]+$/i.test(key)) continue; // 拒绝内联事件处理器
    if (key === 'value' && 'value' in node) { node.value = String(raw); continue; }
    if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden' || key === 'inert') {
      if (raw === true || raw === '') node.setAttribute(key, '');
      continue;
    }
    node.setAttribute(key, raw === true ? '' : String(raw));
  }
}

/** 把 on 对象登记为真实事件监听（addEventListener），返回解绑函数数组。 */
function applyEvents(node, handlers) {
  const cleanups = [];
  if (!handlers || typeof handlers !== 'object') return cleanups;
  for (const [type, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;
    const eventName = String(type).replace(/^on/, '').toLowerCase();
    node.addEventListener(eventName, handler);
    cleanups.push(() => node.removeEventListener(eventName, handler));
  }
  return cleanups;
}

/**
 * 描述 → DOM 节点。
 * @param {object} descriptor lib/render.js 产出的描述
 * @param {Document} [doc]
 * @returns {{node: Node, cleanups: Array<Function>}}
 */
export function createNode(descriptor, doc = document) {
  if (descriptor === undefined || descriptor === null) {
    return { node: doc.createTextNode(''), cleanups: [] };
  }
  if (isElementLike(descriptor)) return { node: descriptor, cleanups: [] };
  if (typeof descriptor === 'string' || typeof descriptor === 'number') {
    return { node: doc.createTextNode(String(descriptor)), cleanups: [] };
  }
  if (descriptor.tag === TEXT_NODE) {
    return { node: doc.createTextNode(String(descriptor.text === undefined ? '' : descriptor.text)), cleanups: [] };
  }
  if (descriptor.tag === '#fragment') {
    const fragment = doc.createDocumentFragment();
    const cleanups = [];
    for (const child of descriptor.children || []) {
      const built = createNode(child, doc);
      fragment.appendChild(built.node);
      cleanups.push(...built.cleanups);
    }
    return { node: fragment, cleanups };
  }
  const element = doc.createElement(descriptor.tag);
  applyAttrs(element, descriptor.attrs);
  if (descriptor.text !== undefined && descriptor.text !== null) element.textContent = String(descriptor.text);
  const cleanups = applyEvents(element, descriptor.on);
  for (const child of descriptor.children || []) {
    const built = createNode(child, doc);
    element.appendChild(built.node);
    cleanups.push(...built.cleanups);
  }
  return { node: element, cleanups };
}

/** 清空容器并挂载描述；返回 {node, cleanups}。 */
export function mount(container, descriptor, doc = document) {
  if (!container) return { node: null, cleanups: [] };
  container.textContent = '';
  const built = createNode(descriptor, doc || container.ownerDocument || document);
  if (built.node) container.appendChild(built.node);
  return built;
}

/** 追加描述（不清空）。 */
export function append(container, descriptor, doc) {
  if (!container) return { node: null, cleanups: [] };
  const built = createNode(descriptor, doc || container.ownerDocument || document);
  if (built.node) container.appendChild(built.node);
  return built;
}

/** 设置文本（不重建节点，保留事件监听）。 */
export function setText(node, value) {
  if (!node) return;
  const next = String(value === undefined || value === null ? '' : value);
  if (node.textContent !== next) node.textContent = next;
}

/** 显示/隐藏（hidden 属性 + aria-hidden 同步）。 */
export function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) {
    node.hidden = true;
    node.setAttribute('aria-hidden', 'true');
  } else {
    node.hidden = false;
    node.removeAttribute('aria-hidden');
  }
}

/** 焦点：元素存在、可见、未 aria-hidden 时才聚焦（并吞掉异常）。 */
export function focusNode(node, options = {}) {
  if (!node || typeof node.focus !== 'function') return false;
  if (node.hidden || node.closest && node.closest('[aria-hidden="true"],[inert]')) return false;
  try {
    node.focus({ preventScroll: options.preventScroll !== false });
    return true;
  } catch {
    return false;
  }
}

/** 把一个可滚动容器里的行滚到可见（配合 lib/virtual-list 的 offsetOf）。 */
export function scrollRowIntoView(scroller, row, { block = 'nearest' } = {}) {
  if (!scroller || !row) return false;
  try {
    row.scrollIntoView({ block, inline: 'nearest' });
    return true;
  } catch {
    return false;
  }
}

/** 事件解绑收集器：页面卸载时统一释放。 */
export function createCleanupBag() {
  const cleanups = [];
  return {
    add(cleanup) {
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      else if (Array.isArray(cleanup)) cleanups.push(...cleanup.filter((item) => typeof item === 'function'));
      return cleanup;
    },
    addAll(list) { if (Array.isArray(list)) cleanups.push(...list.filter((item) => typeof item === 'function')); },
    dispose() {
      while (cleanups.length) {
        const cleanup = cleanups.pop();
        try { cleanup(); } catch { /* 忽略 */ }
      }
    },
    get size() { return cleanups.length; },
  };
}

/** 滚动监听节流：页面滚动时重算虚拟窗口（rAF 合并）。 */
export function onScrollThrottled(element, handler, win = window) {
  if (!element || typeof handler !== 'function') return () => {};
  let queued = false;
  const listener = () => {
    if (queued) return;
    queued = true;
    const run = () => {
      queued = false;
      try { handler(element.scrollTop, element); } catch { /* 忽略 */ }
    };
    if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(run);
    else setTimeout(run, 16);
  };
  element.addEventListener('scroll', listener, { passive: true });
  return () => element.removeEventListener('scroll', listener);
}

/** 读取容器的可见高度（虚拟列表用）。 */
export function measureViewport(element) {
  if (!element) return 0;
  const height = Number(element.clientHeight);
  return Number.isFinite(height) && height > 0 ? height : 0;
}
