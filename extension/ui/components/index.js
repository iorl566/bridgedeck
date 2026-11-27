// extension/ui/components/index.js —— UI 基础组件库（2026-11-26，第一版）
//
// 目标：把 popup/audit 里重复的按钮/卡片/开关/字段/空态/分段控件收敛成可复用工厂，
// 统一 class、ARIA 与结构；页面脚本可按需 import：
//
//   import { createButton, createCard, createEmptyState } from './index.js';
//
// 约定：
// - 所有工厂接受可注入的 `doc`（默认 globalThis.document），便于单测用最小假 DOM；
// - 只负责“结构 + class + ARIA”，样式由 components.css / 各页 CSS 提供；
// - 不引入任何第三方依赖，保持零依赖扩展基线。

function defaultDoc(doc) {
  const scope = doc || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  if (!scope || typeof scope.createElement !== 'function') throw new Error('createElement 不可用：请注入 doc');
  return scope;
}

function setAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset || (node.dataset = {}), value);
    else if (key === 'onClick' || key === 'onChange') continue;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
}

function el(tag, attrs, children = []) {
  const node = defaultDoc(attrs && attrs.doc).createElement(tag);
  const { doc, ...rest } = attrs || {};
  setAttrs(node, rest);
  for (const child of children) if (child !== null && child !== undefined) node.appendChild(child);
  return node;
}

/** 按钮：variant = primary | subtle | ghost | danger */
export function createButton({ doc, label = '', variant = 'subtle', size = '', onClick, attrs = {} } = {}) {
  const classes = ['btn', variant, size].filter(Boolean).join(' ');
  const node = el('button', { doc, type: 'button', class: classes, ...attrs });
  node.textContent = label;
  if (typeof onClick === 'function') node.addEventListener('click', onClick);
  return node;
}

/** 卡片：可选标题（h2）+ 正文容器 */
export function createCard({ doc, title = '', className = '' } = {}) {
  const card = el('section', { doc, class: ['card', className].filter(Boolean).join(' ') });
  if (title) card.appendChild(el('h2', { doc, class: 'card-title', text: title }));
  const body = el('div', { doc, class: 'card-body' });
  card.appendChild(body);
  return { node: card, body };
}

/** 开关：role=switch + aria-checked，返回 { node, setChecked } */
export function createSwitch({ doc, label = '', checked = false, onChange, id = '' } = {}) {
  const node = el('button', { doc, type: 'button', class: 'sw', role: 'switch', 'aria-checked': checked ? 'true' : 'false' });
  if (id) node.id = id;
  if (label) node.setAttribute('aria-label', label);
  const setChecked = (value) => node.setAttribute('aria-checked', value ? 'true' : 'false');
  if (typeof onChange === 'function') {
    node.addEventListener('click', () => {
      const next = node.getAttribute('aria-checked') !== 'true';
      setChecked(next);
      onChange(next);
    });
  }
  return { node, setChecked };
}

/** 字段行：label + 控件（input/select/textarea 由调用方传入节点） */
export function createField({ doc, label = '', control, hint = '', htmlFor = '' } = {}) {
  const row = el('label', { doc, class: 'field' });
  if (htmlFor) row.setAttribute('for', htmlFor);
  if (label) row.appendChild(el('span', { doc, class: 'field-label', text: label }));
  if (control) row.appendChild(control);
  if (hint) row.appendChild(el('small', { doc, class: 'field-hint', text: hint }));
  return row;
}

/** 空态：虚线大卡片（title + hint + 可选 action 按钮） */
export function createEmptyState({ doc, title = '', hint = '', action = null, className = '' } = {}) {
  const node = el('div', { doc, class: ['bd-empty', 'state-block', className].filter(Boolean).join(' '), role: 'status', 'aria-live': 'polite' });
  if (title) node.appendChild(el('p', { doc, class: 'bd-empty-title', text: title }));
  if (hint) node.appendChild(el('p', { doc, class: 'bd-empty-hint', text: hint }));
  if (action) node.appendChild(action);
  return node;
}

/** 分段控件：items=[{ value, label }]，返回 { node, setValue } */
export function createSegmented({ doc, items = [], value = null, onChange } = {}) {
  const node = el('div', { doc, class: 'seg', role: 'tablist' });
  const buttons = new Map();
  const setValue = (next) => {
    for (const [itemValue, button] of buttons) {
      const active = itemValue === next;
      button.className = active ? 'on' : '';
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  };
  for (const item of items) {
    const button = el('button', { doc, type: 'button', role: 'tab', class: item.value === value ? 'on' : '' });
    if (item.id) button.id = item.id;
    button.textContent = item.label;
    button.setAttribute('aria-selected', item.value === value ? 'true' : 'false');
    buttons.set(item.value, button);
    if (typeof onChange === 'function') button.addEventListener('click', () => { setValue(item.value); onChange(item.value); });
    node.appendChild(button);
  }
  return { node, setValue };
}
