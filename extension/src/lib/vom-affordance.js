// lib/vom-affordance.js —— 从观察节点事实推导 affordance（纯函数，可单测）。
//
// 输入是页面侧格式化的节点事实（role/tag/inputType/aria-*/contenteditable/tabindex/href/value…），
// 输出 { type, confidence, evidence, alternatives }：
//   - type：activate | type | toggle | select | drag | scroll | dismiss | hover | focus | upload；
//   - confidence：0..1，命中越直接越高；
//   - evidence：[{ rule, field, value }]（规则名 + 命中字段），用于解释与回归；
//   - alternatives：同一节点其它可行 affordance（按置信度取前 2）。
// 不读页面、不依赖 DOM；页面侧补充事实（scrollable/contentEditable 等）由
// injected/parts 的 affordanceFactsOf / hit-at 提供，这里只做归约。

export const AFFORDANCE_VERSION = 1;

export const AFFORDANCE_TYPES = Object.freeze([
  'activate', 'type', 'toggle', 'select', 'drag', 'scroll', 'dismiss', 'hover', 'focus', 'upload',
]);

// 同分时按此顺序取主 affordance（越靠前越具体）。
const TYPE_PRIORITY = Object.freeze([
  'upload', 'toggle', 'select', 'type', 'drag', 'scroll', 'dismiss', 'hover', 'activate', 'focus',
]);

const ACTIVATE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
]);
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const SELECT_ROLES = new Set(['combobox', 'listbox']);
const TYPE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
]);
const SCROLL_OVERFLOW = /^(auto|scroll|overlay)$/;
// 关闭语义按钮：只按“短名字”匹配，避免把“取消订单”“关闭账户”等业务按钮误当 dismiss。
const CLOSE_NAMES = /^(close|dismiss|cancel|关闭|取消|关闭对话框|关闭弹窗|关闭窗口|×|✕)$/i;
const CANCEL_PREFIX = /^(close|dismiss|cancel|关闭|取消)/i;

function roleOf(node) {
  return String((node && node.role) || '').toLowerCase();
}

function tagOf(node) {
  return String((node && node.tag) || '').toLowerCase();
}

function chainOf(node) {
  const chain = [];
  if (node && Array.isArray(node.ancestors)) {
    for (const item of node.ancestors) if (item) chain.push(item);
  }
  return chain;
}

function roundConfidence(value) {
  return Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100) / 100;
}

function addCandidate(list, type, confidence, rule, field, value) {
  if (!AFFORDANCE_TYPES.includes(type)) return;
  list.push({ type, confidence: roundConfidence(confidence), rule, field, value });
}

function isDialogAncestor(node) {
  return chainOf(node).some((item) => {
    const role = String(item.role || '').toLowerCase();
    const tag = String(item.tag || '').toLowerCase();
    return role === 'dialog' || role === 'alertdialog' || tag === 'dialog';
  });
}

/**
 * 从节点事实推导 affordance。
 * @param {object} node 观察节点（page-lib formatNode 的字段子集）
 * @returns {{type:string, confidence:number, evidence:Array<{rule:string,field:string,value:any}>, alternatives:Array<{type:string,confidence:number}>}}
 */
export function affordanceForNode(node) {
  if (!node || typeof node !== 'object') return { type: 'none', confidence: 0, evidence: [], alternatives: [] };
  const role = roleOf(node);
  const tag = tagOf(node);
  const inputType = String(node.inputType || node.type || '').toLowerCase();
  const name = String(node.name || '').trim();
  const candidates = [];

  // upload：文件选择控件
  if (tag === 'input' && inputType === 'file') addCandidate(candidates, 'upload', 0.95, 'input:file', 'inputType', 'file');
  else if ((role === 'button' || tag === 'button') && /(upload|上传)/i.test(name)) addCandidate(candidates, 'upload', 0.4, 'name:upload', 'name', name.slice(0, 40));

  // toggle：勾选/开关/展开
  if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) addCandidate(candidates, 'toggle', 0.92, 'input:checkable', 'inputType', inputType);
  if (TOGGLE_ROLES.has(role)) addCandidate(candidates, 'toggle', 0.9, 'role:checkable', 'role', role);
  if (tag === 'summary') addCandidate(candidates, 'toggle', 0.9, 'tag:summary', 'tag', 'summary');
  if (typeof node.ariaPressed === 'boolean') addCandidate(candidates, 'toggle', 0.85, 'aria:pressed', 'ariaPressed', node.ariaPressed);
  else if (typeof node.expanded === 'boolean') addCandidate(candidates, 'toggle', 0.55, 'aria:expanded', 'expanded', node.expanded);

  // select：原生/自绘下拉与选项
  if (tag === 'select') addCandidate(candidates, 'select', 0.92, 'tag:select', 'tag', 'select');
  if (SELECT_ROLES.has(role)) addCandidate(candidates, 'select', 0.85, 'role:combobox', 'role', role);
  if (role === 'option') addCandidate(candidates, 'select', 0.6, 'role:option', 'role', 'option');

  // type：可输入文本
  if (tag === 'textarea') addCandidate(candidates, 'type', 0.92, 'tag:textarea', 'tag', 'textarea');
  if (tag === 'input' && TEXT_INPUT_TYPES.has(inputType || 'text')) addCandidate(candidates, 'type', 0.9, 'input:text', 'inputType', inputType || 'text');
  if (node.contentEditable === true || String(node.contenteditable || '') === 'true') addCandidate(candidates, 'type', 0.9, 'editable:contenteditable', 'contentEditable', true);
  if (TYPE_ROLES.has(role)) addCandidate(candidates, 'type', 0.8, 'role:editable', 'role', role);
  if (role === 'spinbutton') addCandidate(candidates, 'drag', 0.5, 'role:spinbutton', 'role', 'spinbutton');

  // drag：拖拽/滑块
  if (node.draggable === true) addCandidate(candidates, 'drag', 0.9, 'attr:draggable', 'draggable', true);
  if (node.dragHint === 'draggable') addCandidate(candidates, 'drag', 0.9, 'fact:dragHint', 'dragHint', 'draggable');
  else if (node.dragHint === 'drag-handle') addCandidate(candidates, 'drag', 0.7, 'fact:dragHint', 'dragHint', 'drag-handle');
  if (role === 'slider') addCandidate(candidates, 'drag', 0.8, 'role:slider', 'role', 'slider');

  // scroll：可滚动容器（overflow 事实来自页面侧 affordanceFactsOf）
  const overflow = String(node.overflowY || node.overflow || '').toLowerCase();
  if (node.scrollable === true || SCROLL_OVERFLOW.test(overflow)) {
    addCandidate(candidates, 'scroll', node.scrollable === true ? 0.85 : 0.65, 'fact:scrollable', 'scrollable', true);
  }

  // dismiss：对话框/关闭按钮
  if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') addCandidate(candidates, 'dismiss', 0.45, 'role:dialog', 'role', role || tag);
  if (CLICKABLE_ROLES.has(role) || tag === 'button' || tag === 'a') {
    if (CLOSE_NAMES.test(name) || (CANCEL_PREFIX.test(name) && name.length <= 12)) {
      const inDialog = isDialogAncestor(node);
      // 关闭语义优先于普通 activate（置信度必须高于 0.85 的按钮规则）。
      addCandidate(candidates, 'dismiss', inDialog ? 0.9 : 0.72, inDialog ? 'name:close+anchor:dialog' : 'name:close', 'name', name.slice(0, 40));
    }
  }

  // hover：悬浮展开（子菜单/预览）
  const hasPopup = String(node.ariaHasPopup || '').toLowerCase();
  if (hasPopup) {
    const hoverRule = role === 'menuitem' ? 0.88 : 0.62;
    addCandidate(candidates, 'hover', hoverRule, role === 'menuitem' ? 'aria:haspopup+role:menuitem' : 'aria:haspopup', 'ariaHasPopup', hasPopup);
  }
  if (node.hoverable === true) addCandidate(candidates, 'hover', 0.6, 'fact:hoverable', 'hoverable', true);

  // activate：可点击/可触发
  if (ACTIVATE_ROLES.has(role)) addCandidate(candidates, 'activate', 0.85, 'role:actionable', 'role', role);
  if (tag === 'button') addCandidate(candidates, 'activate', 0.85, 'tag:button', 'tag', 'button');
  else if (tag === 'a' && (node.href || String(node.role || '') === 'link')) addCandidate(candidates, 'activate', 0.85, 'tag:link', 'tag', 'a');
  if (node.href) addCandidate(candidates, 'activate', 0.8, 'attr:href', 'href', String(node.href).slice(0, 80));
  if (node.clickable === true) addCandidate(candidates, 'activate', 0.5, 'fact:clickable', 'clickable', true);
  if (!role && String(node.cursor || '') === 'pointer') addCandidate(candidates, 'activate', 0.4, 'style:cursor', 'cursor', 'pointer');

  // focus：可聚焦（通常是 type/select 的备选）
  const tabIndex = Number.isInteger(node.tabIndex) ? node.tabIndex : (Number.isInteger(node.tabindex) ? node.tabindex : null);
  if (TYPE_ROLES.has(role) || SELECT_ROLES.has(role) || node.contentEditable === true || (tabIndex != null && tabIndex >= 0)) {
    addCandidate(candidates, 'focus', 0.35, 'fact:focusable', 'tabIndex', tabIndex);
  }

  if (!candidates.length) return { type: 'none', confidence: 0, evidence: [], alternatives: [] };

  // 同 type 取最高置信度，保留全部 evidence（最多 4 条）。
  const byType = new Map();
  for (const candidate of candidates) {
    const current = byType.get(candidate.type);
    if (!current || candidate.confidence > current.confidence) {
      byType.set(candidate.type, {
        type: candidate.type,
        confidence: candidate.confidence,
        evidence: (current ? current.evidence : []).concat([{ rule: candidate.rule, field: candidate.field, value: candidate.value }]),
      });
    } else {
      current.evidence.push({ rule: candidate.rule, field: candidate.field, value: candidate.value });
    }
  }
  const ordered = [...byType.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type);
  });
  const primary = ordered[0];
  const evidence = [];
  const seenRules = new Set();
  for (const item of primary.evidence) {
    if (seenRules.has(item.rule)) continue;
    seenRules.add(item.rule);
    evidence.push(item);
    if (evidence.length >= 4) break;
  }
  return {
    type: primary.type,
    confidence: primary.confidence,
    evidence,
    alternatives: ordered.slice(1, 3).map((item) => ({ type: item.type, confidence: item.confidence })),
  };
}

/** 观察节点集合的 affordance 计数（纯统计，不含文本）。 */
export function summarizeAffordances(nodes) {
  const byType = {};
  let total = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const affordance = affordanceForNode(node);
    if (!affordance.type || affordance.type === 'none') continue;
    byType[affordance.type] = (byType[affordance.type] || 0) + 1;
    total += 1;
  }
  return { version: AFFORDANCE_VERSION, total, byType };
}
