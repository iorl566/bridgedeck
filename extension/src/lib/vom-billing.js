// 可插拔计费（架构层）：当前默认 CJK 启发式；历史/兼容模型可切换。
import { estimateTextTokens, estimateVomTokens, VOM_TOKEN_SAFETY_FACTOR } from './vom-weights.js';
import { countO200k, isO200kLoaded } from './o200k.js';

export const VOM_BILLING_MODEL = 'o200k';

const MODELS = {
  'cjk-heuristic-v2': {
    text: (value) => estimateTextTokens(value),
    unit: (node) => estimateVomTokens(node),
  },
  o200k: {
    text: (value) => countO200k(value),
    unit: (node) => 8 + countO200k([node && node.name, node && node.role, node && node.tag].filter(Boolean).join(' ')),
  },
  'chars-per-4': {
    text: (value) => Math.ceil((String(value || '').length / 4) * VOM_TOKEN_SAFETY_FACTOR),
    unit: (node) => 8 + Math.ceil((String((node && node.name) || '').length / 4) * VOM_TOKEN_SAFETY_FACTOR),
  },
};

export function listBillingModels() {
  return Object.keys(MODELS);
}

/** 允许后续注入真实 tokenizer（如 o200k/BPE），无需改调用方。 */
export function registerBillingModel(name, impl) {
  const key = String(name || '').trim();
  if (!key) throw new Error('billing model 需要名称');
  if (!impl || typeof impl.text !== 'function' || typeof impl.unit !== 'function') {
    throw new Error('billing model 需要 text/unit 函数');
  }
  MODELS[key] = { text: impl.text, unit: impl.unit };
  return key;
}

export function createBillingLedger(nodes, { model = VOM_BILLING_MODEL, safetyFactor = VOM_TOKEN_SAFETY_FACTOR } = {}) {
  const impl = MODELS[model];
  if (!impl) throw new Error('未知 VOM billing model：' + model);
  if (model === 'o200k' && !isO200kLoaded()) throw new Error('o200k 词表未加载');
  const list = Array.isArray(nodes) ? nodes : [];
  let total = 0;
  let text = 0;
  let structural = 0;
  for (const node of list) {
    total += impl.unit(node);
    text += impl.text([node && node.name, node && node.role, node && node.tag].filter(Boolean).join(' '));
    structural += 8;
  }
  return {
    model,
    safetyFactor,
    nodes: list.length,
    totalTokens: total,
    textTokens: text,
    structuralTokens: structural,
    averageTokens: list.length ? Math.round((total / list.length) * 10) / 10 : 0,
  };
}
