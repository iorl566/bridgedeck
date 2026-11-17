// lib/observe-actions.mjs —— 把 VOM 节点压成模型可选的候选动作。
//
// 只描述“能做什么”，不执行；ref 仍由后续 click/fill/select 使用。
const FILL_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);

function labelOf(node) {
  const name = String(node.name || '').trim();
  if (name) return name;
  const placeholder = String(node.placeholder || '').trim();
  if (placeholder) return placeholder;
  const nearby = String(node.nearbyText || '').trim();
  if (nearby) return nearby;
  return String(node.tag || node.role || 'element');
}

function actionOf(node) {
  if (node.disabled === true) return '';
  const tag = String(node.tag || '').toLowerCase();
  const role = String(node.role || '').toLowerCase();
  const type = String(node.inputType || '').toLowerCase();
  if (tag === 'select') return 'select';
  // 自定义 combobox/listbox 不是原生 select：先点击展开，再由后续动作选具体项。
  if (role === 'combobox' || role === 'listbox') return 'click';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return 'click';
  if (tag === 'input' || tag === 'textarea' || role === 'textbox' || role === 'searchbox') {
    return type === 'checkbox' || type === 'radio' ? 'click' : 'fill';
  }
  if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') return 'click';
  if (node.clickable === true) return 'click';
  return '';
}

export function deriveActions(nodes, max = 80) {
  const list = Array.isArray(nodes) ? nodes : [];
  const seen = new Set();
  const out = [];
  for (const node of list) {
    if (!node || !node.ref || seen.has(node.ref)) continue;
    const action = actionOf(node);
    if (!action) continue;
    seen.add(node.ref);
    const item = {
      ref: node.ref,
      action,
      role: node.role || node.tag || '',
      name: labelOf(node),
      tag: node.tag || '',
    };
    if (node.inputType) item.inputType = String(node.inputType).toLowerCase();
    if (node.href) item.href = node.href;
    if (node.inViewport === false) item.offscreen = true;
    out.push(item);
    if (out.length >= Math.max(1, Math.min(Number(max) || 80, 200))) break;
  }
  return out;
}

/** 为自愈找同一语义的候选：优先 action+role+name，其次 action+name。 */
export function findHealingAction(actions, previous, command) {
  if (!previous) return null;
  const wanted = String(command || previous.action || '').toLowerCase();
  const candidates = (Array.isArray(actions) ? actions : []).filter((item) => {
    if (!item || !item.ref) return false;
    if (item.action !== wanted) return false;
    return item.name === previous.name;
  });
  if (!candidates.length) return null;
  const sameRole = candidates.find((item) => (item.role || '') === (previous.role || ''));
  return sameRole || candidates[0];
}
