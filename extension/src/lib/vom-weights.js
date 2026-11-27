// VOM 节点打分：把“可见性/交互性/语义/位置/重复”量化，用于排序与诊断。
// 纯函数；页面侧与 CLI 共用同一套权重。
// 可见性口径统一由 lib/vom-visibility.js 的 visibilityFlags 提供（分值必须零漂移）。
import { visibilityFlags } from './vom-visibility.js';

export const VOM_WEIGHTS_VERSION = 1;
/** token 估算安全系数：宁可多算，避免实际计费超预算。 */
export const VOM_TOKEN_SAFETY_FACTOR = 1.1;

export const DEFAULT_VOM_WEIGHTS = {
  interactive: 35,
  semanticRole: 14,
  formControl: 8,
  text: 4,
  area: 8,
  depth: -2,
  offscreen: -20,
  duplicate: -25,
  hidden: -70,
  disabled: -30,
  focused: 6,
  occluded: -10,
  inForm: 4,
  required: 3,
  invalid: 4,
  live: 2,
  heading: 4,
  lowContrast: -2,
  describedBy: 1,
  controls: 1,
  labelledBy: 1,
  pressed: 2,
  current: 3,
  hasPopup: 1,
  headingStrong: 2,
  range: 1,
  selected: 8,
  expanded: 2,
  checked: 2,
  landmark: 2,
};

function areaOf(node) {
  const rect = node && node.rect ? node.rect : {};
  const width = Number(rect.w != null ? rect.w : rect.width) || 0;
  const height = Number(rect.h != null ? rect.h : rect.height) || 0;
  return Math.max(0, width) * Math.max(0, height);
}

export function scoreVomNode(node, weights = DEFAULT_VOM_WEIGHTS) {
  const w = { ...DEFAULT_VOM_WEIGHTS, ...(weights || {}) };
  // 统一的可见性口径；与 vom-visibility 的 gate 判定同源，避免打分/过滤两套标准。
  const visibility = visibilityFlags(node);
  const factors = [];
  const add = (name, value, weight) => {
    if (!weight) return;
    factors.push({ name, value, weight, score: Math.round(value * weight) });
  };
  add('interactive', node && node.interactive === true ? 1 : 0, w.interactive);
  add('semanticRole', node && node.role ? 1 : 0, w.semanticRole);
  add('formControl', node && /textbox|searchbox|combobox|checkbox|radio|switch/i.test(String(node.role || '')) ? 1 : 0, w.formControl);
  const textLength = node && typeof node.name === 'string' ? node.name.length : 0;
  add('text', Math.min(3, textLength / 20), w.text);
  const area = areaOf(node);
  add('area', area > 0 ? Math.min(2, Math.log10(area / 100 + 1)) : 0, w.area);
  add('depth', Math.max(0, Number(node && node.depth) || 0), w.depth);
  add('offscreen', visibility.offscreen ? 1 : 0, w.offscreen);
  add('hidden', visibility.hiddenBlocked ? 1 : 0, w.hidden);
  add('hidden', visibility.hiddenAria ? 1 : 0, w.hidden);
  add('disabled', node && node.disabled === true ? 1 : 0, w.disabled);
  add('focused', node && node.focused === true ? 1 : 0, w.focused);
  add('occluded', visibility.occluded ? 1 : 0, w.occluded);
  add('inForm', node && node.inForm === true ? 1 : 0, w.inForm);
  add('required', node && node.required === true ? 1 : 0, w.required);
  add('invalid', node && node.invalid === true ? 1 : 0, w.invalid);
  add('live', node && ['polite', 'assertive'].includes(String(node.ariaLive || '').toLowerCase()) ? 1 : 0, w.live);
  add('heading', node && /^h[1-6]$/i.test(String(node.tag || '')) ? 1 : 0, w.heading);
  add('lowContrast', node && node.lowContrast === true ? 1 : 0, w.lowContrast);
  add('describedBy', node && (node.ariaDescribedBy || node.ariaErrorMessage) ? 1 : 0, w.describedBy);
  add('controls', node && node.ariaControls ? 1 : 0, w.controls);
  add('labelledBy', node && node.ariaLabelledBy ? 1 : 0, w.labelledBy);
  add('pressed', node && node.ariaPressed === true ? 1 : 0, w.pressed);
  add('current', node && node.ariaCurrent ? 1 : 0, w.current);
  add('hasPopup', node && node.ariaHasPopup ? 1 : 0, w.hasPopup);
  add('headingStrong', node && /^h[12]$/i.test(String(node.tag || '')) ? 1 : 0, w.headingStrong);
  add('range', node && Number.isFinite(Number(node.ariaValueNow)) ? 1 : 0, w.range);
  add('selected', node && node.selected === true ? 1 : 0, w.selected);
  add('expanded', node && node.expanded === true ? 1 : 0, w.expanded);
  add('checked', node && node.checked === true ? 1 : 0, w.checked);
  const landmark = (Array.isArray(node && node.ancestors) ? node.ancestors : []).some((item) => {
    const role = String(item && item.role || '');
    const tag = String(item && item.tag || '');
    return ['main', 'navigation', 'banner', 'contentinfo', 'region', 'form'].includes(role) || ['main', 'nav', 'header', 'footer', 'form'].includes(tag);
  });
  add('landmark', landmark ? 1 : 0, w.landmark);
  const score = factors.reduce((sum, factor) => sum + factor.score, 0);
  return { score, factors };
}

/** 给节点附加打分字段（不改变顺序）。 */
export function attachVomScores(nodes, options = {}) {
  const weights = { ...DEFAULT_VOM_WEIGHTS, ...(options.weights || {}) };
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const scored = scoreVomNode(node, weights);
    return { ...node, vomScore: scored.score, vomFactors: scored.factors.map((factor) => factor.name).filter(Boolean) };
  });
}

/** 按分数排序（同分保持原始顺序），可限制数量。 */
export function rankVomNodes(nodes, options = {}) {
  const scored = Array.isArray(nodes) ? nodes.slice() : [];
  const withScores = scored.map((node, index) => ({
    node: node && Number.isInteger(node.vomScore) ? node : { ...node, vomScore: scoreVomNode(node, options.weights).score },
    index,
  }));
  withScores.sort((a, b) => (b.node.vomScore - a.node.vomScore) || (a.index - b.index));
  const limit = Number(options.limit) > 0 ? Math.min(Math.round(Number(options.limit)), withScores.length) : withScores.length;
  return withScores.slice(0, limit).map((item) => item.node);
}

/** 按分数下限过滤节点（在排序/截断前使用）。 */
export function filterVomNodes(nodes, minScore = 0) {
  const floor = Number(minScore);
  if (!Number.isFinite(floor)) return Array.isArray(nodes) ? nodes : [];
  return (Array.isArray(nodes) ? nodes : []).filter((node) => Number(node && node.vomScore) >= floor);
}

const CJK_RANGES = [
  [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xac00, 0xd7af], [0xf900, 0xfaff], [0xff00, 0xffef],
];

function isCjk(code) {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

/** CJK 感知的 token 估算：CJK 约 1 字 1 token，其它文本约 4 字符 1 token。 */
export function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  let emoji = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    if (code == null) continue;
    if (/\p{Extended_Pictographic}/u.test(char)) emoji += 1;
    else if (isCjk(code)) cjk += 1;
    else if (!/\s/.test(char)) other += 1;
  }
  // emoji 通常占 2 token；比按 Latin 字符/4 更接近真实计费。
  return Math.ceil((cjk + emoji * 2 + other / 4) * VOM_TOKEN_SAFETY_FACTOR);
}

/** 节点成本：名称/角色文本 + 固定结构开销。 */
export function estimateVomTokens(node) {
  const name = String((node && node.name) || '');
  const role = String((node && node.role) || '');
  return 8 + estimateTextTokens(name + role);
}

/** 按节点数/token 预算截断（保持传入顺序），返回保留节点与丢弃统计。 */
export function selectVomNodes(nodes, { maxNodes = 0, maxTokens = 0 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const nodeLimit = Number(maxNodes) > 0 ? Math.floor(Number(maxNodes)) : 0;
  const tokenLimit = Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 0;
  if (!nodeLimit && !tokenLimit) {
    return { nodes: list, dropped: { nodes: 0, tokens: 0 } };
  }
  const kept = [];
  let tokens = 0;
  let droppedNodes = 0;
  let droppedTokens = 0;
  for (const node of list) {
    const cost = estimateVomTokens(node);
    const overNodes = nodeLimit > 0 && kept.length >= nodeLimit;
    const overTokens = tokenLimit > 0 && tokens + cost > tokenLimit;
    if (overNodes || overTokens) {
      droppedNodes += 1;
      droppedTokens += cost;
      continue;
    }
    kept.push(node);
    tokens += cost;
  }
  return { nodes: kept, dropped: { nodes: droppedNodes, tokens: droppedTokens } };
}
