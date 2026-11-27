// extension/src/lib/replay-target.js —— 回放目标（元素引用）还原（纯函数，零 chrome 依赖）。
//
// 录制 step 的 target 有两种形态：1) 0.3.0 录制器 {selector}/{text}/{name}（record-steps.js）；
// 2) 对照实现（reference/extension-mirror/src/lib/describe-target.js）的语义描述符
//    { tag, role, name, name_attr, placeholder, nearby_label }。
// 回放时“同一个元素”通常已换 backendNodeId 甚至换了一份 DOM；本模块负责：
//   - 归一两种 target（normalizeTargetDescriptor）并按可证明程度排候选（locatorCandidates）；
//   - 用页面快照匹配：唯一命中才算成功，多命中一律 AMBIGUOUS（拒绝猜）；
//   - 规划逐 step 还原结果（planTargetRestoration）：exact / fallback / ambiguous /
//     missing / forbidden / planned，带理由码与候选证据。
//
// 不变量：纯函数（无时钟/随机数/chrome）、不修改入参、匿名目标 → forbidden；
// 文档/帧身份变化由 replay-boundary 判定，本模块只消费 boundaryScopeKey。

import { stableHash } from '../record-steps.js';
import { boundaryFromStep, boundaryScopeKey } from './replay-boundary.js';

/** 目标还原模型版本。 */
export const REPLAY_TARGET_VERSION = 1;

/** 规范化后目标的字段上限（防止恶意录制把计划撑爆）。 */
export const TARGET_LIMITS = Object.freeze({
  maxText: 120,
  maxSelector: 400,
  maxName: 160,
  maxAttributeKeys: 24,
  maxCandidates: 16,
  maxNodes: 4000,
  minTextLength: 2,
  maxAlternatives: 3,
});

/** 定位策略，顺序即默认优先级（越靠前越“可证明”，越靠后越依赖语义猜测）。 */
export const TARGET_STRATEGIES = Object.freeze([
  'selector',
  'id',
  'testid',
  'name-attr',
  'placeholder',
  'aria-label',
  'label-text',
  'role-name',
  'link-text',
  'text',
  'node-signature',
]);

const STRATEGY_RANK = new Map(TARGET_STRATEGIES.map((strategy, index) => [strategy, index]));

/** 逐 step 的还原状态。 */
export const TARGET_STATUS = Object.freeze({
  EXACT: 'exact',
  FALLBACK: 'fallback',
  AMBIGUOUS: 'ambiguous',
  MISSING: 'missing',
  FORBIDDEN: 'forbidden',
  PLANNED: 'planned',
  NOT_REQUIRED: 'not-required',
});

/** 需要阻断的状态（回放不能继续）。 */
export const TARGET_BLOCKING_STATUSES = Object.freeze([TARGET_STATUS.AMBIGUOUS, TARGET_STATUS.MISSING, TARGET_STATUS.FORBIDDEN]);

/** 失败/降级理由码（与 replay-explain 的 TARGET_* 目录对齐）。 */
export const TARGET_CODES = Object.freeze({
  NOT_REQUIRED: 'TARGET_NOT_REQUIRED',
  ANONYMOUS: 'TARGET_ANONYMOUS',
  NO_SNAPSHOT: 'TARGET_NO_SNAPSHOT',
  EMPTY_SNAPSHOT: 'TARGET_EMPTY_SNAPSHOT',
  EXACT_SELECTOR: 'TARGET_EXACT_SELECTOR',
  UNIQUE_MATCH: 'TARGET_UNIQUE_MATCH',
  GEOMETRY_TIEBREAK: 'TARGET_GEOMETRY_TIEBREAK',
  SCORE_MARGIN: 'TARGET_SCORE_MARGIN',
  AMBIGUOUS: 'TARGET_AMBIGUOUS',
  NO_MATCH: 'TARGET_NO_MATCH',
  ONLY_HIDDEN: 'TARGET_ONLY_HIDDEN',
  STALE_DOCUMENT: 'TARGET_STALE_DOCUMENT',
  UNSTABLE_SELECTOR: 'TARGET_UNSTABLE_SELECTOR',
  INVALID_DESCRIPTOR: 'TARGET_INVALID_DESCRIPTOR',
});

/** 选择器稳定度阈值：低于它即视为“易碎”，只作为后备候选。 */
const SELECTOR_STABLE_MIN = 50;

// ---------------------------------------------------------------------------
// 文本与选择器基础
// ---------------------------------------------------------------------------

/** 折叠空白并截断（比较/展示统一口径）。 */
export function normalizeTargetText(value, max = TARGET_LIMITS.maxText) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : TARGET_LIMITS.maxText;
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

/** 归一化 CSS 选择器：折叠选择器内部的空白（不影响字符串字面量以外场景）。 */
export function normalizeSelector(selector) {
  return normalizeTargetText(selector, TARGET_LIMITS.maxSelector).replace(/\s*([>+~,])\s*/g, '$1');
}

/**
 * 拆分选择器的结构，用于稳定度评分与解释。
 * 只做轻量解析（不实现完整 CSS 语法），足够判断“是否脆弱”。
 * @param {string} selector
 * @returns {{selector:string, parts:Array<object>, depth:number, ids:string[], classes:string[], tags:string[], attrs:string[], hasNth:boolean, hasUniversal:boolean}}
 */
export function decomposeSelector(selector) {
  const text = normalizeSelector(selector);
  const base = { selector: text, parts: [], depth: 0, ids: [], classes: [], tags: [], attrs: [], hasNth: false, hasUniversal: false };
  if (!text) return base;
  // 先按组合器切，再逐段提取 #id / .class / [attr] / tag / :nth-*。
  const rawParts = text.split(/(?=[>+~])|\s+/).map((part) => part.trim()).filter(Boolean);
  for (const raw of rawParts) {
    if (raw === '>' || raw === '+' || raw === '~') continue;
    const part = { raw, tag: '', ids: [], classes: [], attrs: [], pseudo: [] };
    const tagMatch = raw.match(/^([a-zA-Z][\w-]*|\*)/);
    if (tagMatch) {
      part.tag = tagMatch[1];
      if (part.tag === '*') base.hasUniversal = true;
      else base.tags.push(part.tag);
    }
    for (const match of raw.matchAll(/#([\w-]+)/g)) {
      part.ids.push(match[1]);
      base.ids.push(match[1]);
    }
    for (const match of raw.matchAll(/\.([\w-]+)/g)) {
      part.classes.push(match[1]);
      base.classes.push(match[1]);
    }
    for (const match of raw.matchAll(/\[([^\]]*)\]/g)) {
      part.attrs.push(match[1]);
      base.attrs.push(match[1]);
    }
    for (const match of raw.matchAll(/:([\w-]+)(?:\([^)]*\))?/g)) {
      part.pseudo.push(match[1]);
      if (/^nth-/.test(match[1])) base.hasNth = true;
    }
    base.parts.push(part);
  }
  base.depth = base.parts.length;
  return base;
}

/**
 * 选择器稳定度评分（0..100）。
 * 奖励：稳定 id、data-testid、name/aria-label 等语义属性；
 * 惩罚：nth-child/nth-of-type、长链、散列 class、随机 id、纯标签。
 * @param {string} selector
 * @returns {{score:number, stable:boolean, reasons:string[], parts:number, selector:string}}
 */
export function selectorStability(selector) {
  const decomposed = decomposeSelector(selector);
  const reasons = [];
  let score = 60;
  if (!decomposed.selector) {
    return { score: 0, stable: false, reasons: ['empty'], parts: 0, selector: '' };
  }
  if (decomposed.hasNth) {
    score -= 25;
    reasons.push('nth-position');
  }
  if (decomposed.hasUniversal) {
    score -= 20;
    reasons.push('universal-selector');
  }
  if (decomposed.depth > 5) {
    score -= 20;
    reasons.push('deep-chain');
  } else if (decomposed.depth > 3) {
    score -= 8;
    reasons.push('medium-chain');
  }
  const hashedClasses = decomposed.classes.filter(isHashedToken);
  if (hashedClasses.length) {
    score -= 20;
    reasons.push('hashed-class');
  }
  const dynamicIds = decomposed.ids.filter((id) => isHashedToken(id) || /^:|\d{4,}/.test(id));
  if (dynamicIds.length) {
    score -= 18;
    reasons.push('dynamic-id');
  } else if (decomposed.ids.length) {
    score += 22;
    reasons.push('stable-id');
  }
  if (decomposed.attrs.some((attr) => /^data-(?:test|testid|test-id|qa|cy)\s*=/i.test(attr))) {
    score += 18;
    reasons.push('test-id-attr');
  }
  if (decomposed.attrs.some((attr) => /^(?:name|aria-label|role|type)\s*=/i.test(attr))) {
    score += 8;
    reasons.push('semantic-attr');
  }
  if (!decomposed.ids.length && !decomposed.attrs.length && !decomposed.classes.length && decomposed.tags.length === 1) {
    score -= 15;
    reasons.push('tag-only');
  }
  const clamped = Math.max(0, Math.min(100, score));
  return {
    score: clamped,
    stable: clamped >= SELECTOR_STABLE_MIN && !reasons.includes('nth-position') && !reasons.includes('hashed-class'),
    reasons,
    parts: decomposed.depth,
    selector: decomposed.selector,
  };
}

/** 是否像构建工具生成的散列 token（长十六进制 / 混合大小写随机串）。 */
function isHashedToken(value) {
  const token = String(value || '');
  if (!token) return false;
  if (/^[0-9a-f]{8,}$/i.test(token)) return true;
  if (/^(?:css|sc|jsx|emotion)-[a-z0-9]{4,}$/i.test(token)) return true;
  return /[a-z][0-9]|[0-9][a-z]/.test(token) && token.length >= 8 && /[A-Z]/.test(token);
}

// ---------------------------------------------------------------------------
// 描述符归一化
// ---------------------------------------------------------------------------

const TARGET_ALIASES = Object.freeze({
  selector: ['selector', 'css', 'cssSelector', 'css_selector'],
  id: ['id', 'elementId'],
  testid: ['testid', 'testId', 'data-testid', 'dataTestid'],
  name: ['name', 'accessibleName', 'label'],
  nameAttr: ['name_attr', 'nameAttr', 'formName'],
  placeholder: ['placeholder'],
  ariaLabel: ['aria_label', 'ariaLabel', 'aria'],
  nearbyLabel: ['nearby_label', 'nearbyLabel', 'labelText'],
  text: ['text', 'visibleText', 'innerText'],
  role: ['role'],
  tag: ['tag', 'tagName'],
});

function pickField(source, aliases, max) {
  for (const key of aliases) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = normalizeTargetText(value, max);
    if (text) return text;
  }
  return '';
}

/**
 * 归一化 target（兼容 0.3.0 的 {selector/text/name} 与对照实现语义描述符）。
 * 空/非法输入 → null（调用方按“无目标”处理）。
 * @param {unknown} target
 * @returns {null|object}
 */
export function normalizeTargetDescriptor(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const source = target;
  const selector = pickField(source, TARGET_ALIASES.selector, TARGET_LIMITS.maxSelector);
  const id = pickField(source, TARGET_ALIASES.id, TARGET_LIMITS.maxName);
  const testid = pickField(source, TARGET_ALIASES.testid, TARGET_LIMITS.maxName);
  const name = pickField(source, TARGET_ALIASES.name, TARGET_LIMITS.maxName);
  const nameAttr = pickField(source, TARGET_ALIASES.nameAttr, TARGET_LIMITS.maxName);
  const placeholder = pickField(source, TARGET_ALIASES.placeholder, TARGET_LIMITS.maxName);
  const ariaLabel = pickField(source, TARGET_ALIASES.ariaLabel, TARGET_LIMITS.maxName);
  const nearbyLabel = pickField(source, TARGET_ALIASES.nearbyLabel, TARGET_LIMITS.maxName);
  const text = pickField(source, TARGET_ALIASES.text, TARGET_LIMITS.maxText);
  const role = pickField(source, TARGET_ALIASES.role, 40).toLowerCase();
  const tag = pickField(source, TARGET_ALIASES.tag, 40).toLowerCase();
  const attributes = normalizeAttributes(source.attributes);
  const geometry = normalizeGeometry(source.geometry || source.rect);
  const descriptor = {
    version: REPLAY_TARGET_VERSION,
    selector,
    id,
    testid,
    name,
    nameAttr,
    placeholder,
    ariaLabel,
    nearbyLabel,
    text,
    role,
    tag,
    attributes,
    geometry,
    selectorStability: selector ? selectorStability(selector) : null,
  };
  if (isAnonymousDescriptor(descriptor)) return null;
  return descriptor;
}

function normalizeAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= TARGET_LIMITS.maxAttributeKeys) break;
    const name = normalizeTargetText(key, 60).toLowerCase();
    if (!name) continue;
    const text = normalizeTargetText(raw, 200);
    if (!text) continue;
    out[name] = text;
    count += 1;
  }
  return out;
}

/** 归一化几何：{x,y,w,h} 数字，非法 → null。 */
export function normalizeGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = value.rect && typeof value.rect === 'object' ? { ...value, ...value.rect } : value;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w !== undefined ? rect.w : rect.width);
  const h = Number(rect.h !== undefined ? rect.h : rect.height);
  if (![x, y, w, h].every((item) => Number.isFinite(item))) return null;
  return { x, y, w, h };
}

/**
 * 匿名目标判定：没有任何可用于重新定位的信息。
 * 只有 tag/role 也算匿名（裸 div/span 不唯一）。
 */
export function isAnonymousDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return true;
  return !(descriptor.selector
    || descriptor.id
    || descriptor.testid
    || descriptor.name
    || descriptor.nameAttr
    || descriptor.placeholder
    || descriptor.ariaLabel
    || descriptor.nearbyLabel
    || descriptor.text);
}

/** 描述符签名（用于去重/计划指纹；不含 geometry，位置会变不算身份）。 */
export function targetSignature(descriptor) {
  if (!descriptor) return '';
  const material = [
    descriptor.selector,
    descriptor.id,
    descriptor.testid,
    descriptor.name,
    descriptor.nameAttr,
    descriptor.placeholder,
    descriptor.ariaLabel,
    descriptor.nearbyLabel,
    descriptor.text,
    descriptor.role,
    descriptor.tag,
  ].join('\u0001');
  return stableHash(material);
}

/** 目标是否“敏感”（密码/验证码/一次性口令），回放时应要求人工补值。 */
export function isSensitiveTarget(descriptor) {
  if (!descriptor) return false;
  const haystack = [descriptor.name, descriptor.nameAttr, descriptor.placeholder, descriptor.ariaLabel, descriptor.nearbyLabel, descriptor.text, descriptor.selector]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /pass(?:word|code)?|pwd|secret|otp|one-time|token|验证码|口令|密码/.test(haystack);
}

// ---------------------------------------------------------------------------
// 候选定位
// ---------------------------------------------------------------------------

/**
 * 由描述符生成有序候选定位（确定顺序 = 策略优先级 → 置信分 → 值字典序）。
 * @param {unknown} target 原始 target 或已归一描述符
 * @param {{maxCandidates?:number}} [options]
 * @returns {{descriptor:object|null, candidates:Array<object>}}
 */
export function locatorCandidates(target, options = {}) {
  const descriptor = target && target.version === REPLAY_TARGET_VERSION ? target : normalizeTargetDescriptor(target);
  if (!descriptor) return { descriptor: null, candidates: [] };
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? Math.min(options.maxCandidates, TARGET_LIMITS.maxCandidates)
    : TARGET_LIMITS.maxCandidates;
  const raw = [];
  const add = (strategy, value, score, extra = {}) => {
    const text = normalizeTargetText(value, strategy === 'selector' ? TARGET_LIMITS.maxSelector : TARGET_LIMITS.maxName);
    if (!text) return;
    raw.push({ strategy, value: text, score, ...extra });
  };
  if (descriptor.selector) {
    const stability = descriptor.selectorStability || selectorStability(descriptor.selector);
    add('selector', descriptor.selector, stability.score / 100, { stable: stability.stable, selectorReasons: stability.reasons });
  }
  if (descriptor.id) add('id', descriptor.id, 0.95);
  if (descriptor.testid) add('testid', descriptor.testid, 0.92);
  if (descriptor.nameAttr) add('name-attr', descriptor.nameAttr, 0.82);
  if (descriptor.placeholder) add('placeholder', descriptor.placeholder, 0.78);
  if (descriptor.ariaLabel) add('aria-label', descriptor.ariaLabel, 0.84);
  if (descriptor.nearbyLabel) add('label-text', descriptor.nearbyLabel, 0.74);
  if (descriptor.role && (descriptor.name || descriptor.ariaLabel)) {
    add('role-name', descriptor.name || descriptor.ariaLabel, 0.8, { role: descriptor.role });
  }
  const isLink = descriptor.tag === 'a' || descriptor.role === 'link';
  if (isLink && (descriptor.name || descriptor.text)) add('link-text', descriptor.name || descriptor.text, 0.76);
  if (descriptor.text) add('text', descriptor.text, 0.62);
  if (descriptor.name) add('text', descriptor.name, 0.6);
  if (descriptor.tag && (descriptor.role || descriptor.nameAttr)) {
    add('node-signature', [descriptor.tag, descriptor.role || '', descriptor.nameAttr || ''].join('|'), 0.45);
  }
  // 去重（策略+值）并稳定排序。
  const seen = new Set();
  const deduped = [];
  for (const candidate of raw) {
    const key = candidate.strategy + '\u0000' + candidate.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  deduped.sort((left, right) => {
    const rankDiff = (STRATEGY_RANK.get(left.strategy) || 0) - (STRATEGY_RANK.get(right.strategy) || 0);
    if (rankDiff !== 0) return rankDiff;
    if (right.score !== left.score) return right.score - left.score;
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  });
  return {
    descriptor,
    candidates: deduped.slice(0, maxCandidates).map((candidate, index) => ({ ...candidate, order: index })),
  };
}

/** 策略优先级（数字越小越优先；未知策略排最后）。 */
export function strategyRank(strategy) {
  const rank = STRATEGY_RANK.get(String(strategy || ''));
  return rank === undefined ? TARGET_STRATEGIES.length : rank;
}

// ---------------------------------------------------------------------------
// 快照与匹配
// ---------------------------------------------------------------------------

/**
 * 归一化一份快照节点。快照由运行时采集（例如 evaluate 收集 selector/role/name 等），
 * 本模块只做纯比较，不依赖 DOM。
 * @param {unknown} nodes
 * @returns {Array<object>}
 */
export function normalizeSnapshotNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const out = [];
  for (let index = 0; index < list.length && out.length < TARGET_LIMITS.maxNodes; index += 1) {
    const node = list[index];
    if (!node || typeof node !== 'object') continue;
    const id = normalizeTargetText(node.id, TARGET_LIMITS.maxName);
    const testid = normalizeTargetText(node.testid !== undefined ? node.testid : node['data-testid'], TARGET_LIMITS.maxName);
    const name = normalizeTargetText(node.name !== undefined ? node.name : node.accessibleName, TARGET_LIMITS.maxName);
    const nameAttr = normalizeTargetText(node.nameAttr !== undefined ? node.nameAttr : node.name_attr, TARGET_LIMITS.maxName);
    const placeholder = normalizeTargetText(node.placeholder, TARGET_LIMITS.maxName);
    const ariaLabel = normalizeTargetText(node.ariaLabel !== undefined ? node.ariaLabel : node.aria_label, TARGET_LIMITS.maxName);
    const nearbyLabel = normalizeTargetText(node.nearbyLabel !== undefined ? node.nearbyLabel : node.nearby_label, TARGET_LIMITS.maxName);
    const text = normalizeTargetText(node.text !== undefined ? node.text : node.innerText, TARGET_LIMITS.maxText);
    const selector = normalizeSelector(node.selector || '');
    const selectors = Array.isArray(node.selectors) ? node.selectors.map((item) => normalizeSelector(item)).filter(Boolean) : [];
    const role = normalizeTargetText(node.role, 40).toLowerCase();
    const tag = normalizeTargetText(node.tag, 40).toLowerCase();
    const normalized = {
      index: out.length,
      key: normalizeTargetText(node.key, 80) || '',
      id,
      testid,
      name,
      nameAttr,
      placeholder,
      ariaLabel,
      nearbyLabel,
      text,
      selector,
      selectors,
      role,
      tag,
      attributes: normalizeAttributes(node.attributes),
      visible: node.visible !== false && node.hidden !== true,
      disabled: node.disabled === true,
      geometry: normalizeGeometry(node.rect || node.geometry),
    };
    if (!normalized.key) {
      normalized.key = 'n' + stableHash([normalized.index, normalized.tag, normalized.selector, normalized.name, normalized.text, normalized.nameAttr].join('|'));
    }
    out.push(normalized);
  }
  return out;
}

/** 节点签名（tag|role|nameAttr|name），用于 node-signature 策略。 */
export function nodeSignature(node) {
  if (!node) return '';
  return [normalizeTargetText(node.tag, 40), normalizeTargetText(node.role, 40), normalizeTargetText(node.name, TARGET_LIMITS.maxName), normalizeTargetText(node.nameAttr || node.name_attr, TARGET_LIMITS.maxName)].join('|');
}

function eqExact(left, right) {
  return normalizeTargetText(left, TARGET_LIMITS.maxText) === normalizeTargetText(right, TARGET_LIMITS.maxText);
}

function eqLoose(left, right) {
  return normalizeTargetText(left, TARGET_LIMITS.maxText).toLowerCase() === normalizeTargetText(right, TARGET_LIMITS.maxText).toLowerCase();
}

/** 轻量近似：前缀命中（文本策略的最后兜底，分数更低）。 */
function prefixMatch(candidate, value) {
  const left = normalizeTargetText(candidate, TARGET_LIMITS.maxText).toLowerCase();
  const right = normalizeTargetText(value, TARGET_LIMITS.maxText).toLowerCase();
  if (left.length < TARGET_LIMITS.minTextLength || right.length < TARGET_LIMITS.minTextLength) return false;
  return right.startsWith(left) || left.startsWith(right);
}

/**
 * 单个节点 vs 单个候选的匹配。返回 {matched, score(0..1), reason}。
 */
export function matchNode(node, candidate) {
  if (!node || !candidate) return { matched: false, score: 0, reason: 'missing' };
  const value = candidate.value;
  switch (candidate.strategy) {
    case 'selector': {
      if (!node.selector && !(node.selectors && node.selectors.length)) break;
      if (eqExact(node.selector, value)) return { matched: true, score: 1, reason: 'selector-exact' };
      if (Array.isArray(node.selectors) && node.selectors.some((selector) => eqExact(selector, value))) {
        return { matched: true, score: 0.96, reason: 'selector-list' };
      }
      return { matched: false, score: 0, reason: 'selector-miss' };
    }
    case 'id':
      return eqExact(node.id, value) ? { matched: true, score: 1, reason: 'id-exact' } : { matched: false, score: 0, reason: 'id-miss' };
    case 'testid':
      return eqExact(node.testid, value) ? { matched: true, score: 1, reason: 'testid-exact' } : { matched: false, score: 0, reason: 'testid-miss' };
    case 'name-attr':
      return eqLoose(node.nameAttr, value) ? { matched: true, score: 0.98, reason: 'name-exact' } : { matched: false, score: 0, reason: 'name-miss' };
    case 'placeholder':
      return eqLoose(node.placeholder, value) ? { matched: true, score: 0.95, reason: 'placeholder-exact' } : { matched: false, score: 0, reason: 'placeholder-miss' };
    case 'aria-label':
      return eqLoose(node.ariaLabel, value) ? { matched: true, score: 0.97, reason: 'aria-exact' } : { matched: false, score: 0, reason: 'aria-miss' };
    case 'label-text':
      if (eqLoose(node.nearbyLabel, value)) return { matched: true, score: 0.92, reason: 'label-exact' };
      if (eqLoose(node.name, value)) return { matched: true, score: 0.82, reason: 'label-as-name' };
      return { matched: false, score: 0, reason: 'label-miss' };
    case 'role-name': {
      const role = normalizeTargetText(candidate.role || '', 40).toLowerCase();
      if (role && !eqLoose(node.role, role)) return { matched: false, score: 0, reason: 'role-miss' };
      if (eqLoose(node.name, value)) return { matched: true, score: 0.94, reason: 'role-name-exact' };
      if (prefixMatch(value, node.name)) return { matched: true, score: 0.7, reason: 'role-name-prefix' };
      return { matched: false, score: 0, reason: 'role-name-miss' };
    }
    case 'link-text':
      if (eqLoose(node.text, value) || eqLoose(node.name, value)) return { matched: true, score: 0.9, reason: 'link-text-exact' };
      if (prefixMatch(value, node.text) || prefixMatch(value, node.name)) return { matched: true, score: 0.68, reason: 'link-text-prefix' };
      return { matched: false, score: 0, reason: 'link-text-miss' };
    case 'text':
      if (eqLoose(node.text, value)) return { matched: true, score: 0.86, reason: 'text-exact' };
      if (eqLoose(node.name, value)) return { matched: true, score: 0.8, reason: 'text-as-name' };
      if (prefixMatch(value, node.text)) return { matched: true, score: 0.64, reason: 'text-prefix' };
      return { matched: false, score: 0, reason: 'text-miss' };
    case 'node-signature':
      return eqLoose(nodeSignature(node), value) ? { matched: true, score: 0.55, reason: 'signature-exact' } : { matched: false, score: 0, reason: 'signature-miss' };
    default:
      return { matched: false, score: 0, reason: 'unknown-strategy' };
  }
}

/**
 * 几何亲和度：录制时的元素框与候选框的重叠/距离，用于多命中时的确定性打破平局。
 * 返回 0..1；无几何信息 → null。
 */
export function geometryAffinity(recorded, candidate) {
  const left = normalizeGeometry(recorded);
  const right = normalizeGeometry(candidate);
  if (!left || !right) return null;
  const leftCx = left.x + left.w / 2;
  const leftCy = left.y + left.h / 2;
  const rightCx = right.x + right.w / 2;
  const rightCy = right.y + right.h / 2;
  const distance = Math.hypot(leftCx - rightCx, leftCy - rightCy);
  const scale = Math.max(1, Math.hypot(left.w, left.h), Math.hypot(right.w, right.h));
  const distanceScore = Math.max(0, 1 - distance / (scale * 2));
  const overlap = overlapRatio(left, right);
  return Math.max(0, Math.min(1, distanceScore * 0.5 + overlap * 0.5));
}

function overlapRatio(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const areaLeft = Math.max(1, left.w * left.h);
  const areaRight = Math.max(1, right.w * right.h);
  return Math.min(1, inter / Math.min(areaLeft, areaRight));
}

/**
 * 在一份快照上执行“候选 → 命中”匹配。
 * 规则：按候选顺序尝试；唯一命中即成功；多命中时几何平局优先，其次分层差，
 * 都打不破 → AMBIGUOUS（不猜）。全部落空 → MISSING。
 * @param {Array<object>} candidates locatorCandidates().candidates
 * @param {Array<object>} nodes normalizeSnapshotNodes() 的输出
 * @param {{geometry?:object|null, includeHidden?:boolean, ambiguityMargin?:number,
 *          minScore?:number, maxAlternatives?:number}} [options]
 * @returns {object}
 */
export function matchCandidates(candidates, nodes, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const allNodes = Array.isArray(nodes) ? nodes : [];
  const includeHidden = options.includeHidden === true;
  const visibleNodes = includeHidden ? allNodes : allNodes.filter((node) => node.visible !== false);
  const margin = Number.isFinite(Number(options.ambiguityMargin)) ? Math.max(0, Number(options.ambiguityMargin)) : 0.08;
  const minScore = Number.isFinite(Number(options.minScore)) ? Math.max(0, Number(options.minScore)) : 0.3;
  const maxAlternatives = Number.isInteger(options.maxAlternatives) && options.maxAlternatives > 0
    ? Math.min(options.maxAlternatives, TARGET_LIMITS.maxAlternatives)
    : TARGET_LIMITS.maxAlternatives;
  const geometry = normalizeGeometry(options.geometry);
  const tried = [];
  let hiddenHits = 0;

  for (const candidate of list) {
    const hits = [];
    for (const node of visibleNodes) {
      const match = matchNode(node, candidate);
      if (!match.matched) continue;
      const confidence = Number(candidate.score) * match.score;
      if (confidence < minScore) continue;
      const affinity = geometry ? geometryAffinity(geometry, node.geometry) : null;
      hits.push({
        node,
        nodeKey: node.key,
        score: affinity === null ? confidence : confidence * (0.75 + 0.25 * affinity),
        matchScore: match.score,
        reason: match.reason,
      });
    }
    if (!hits.length && !includeHidden) {
      // 记录“只在隐藏节点里命中”，便于解释“元素存在但不可见”。
      for (const node of allNodes) {
        if (node.visible !== false) continue;
        const match = matchNode(node, candidate);
        if (match.matched) { hiddenHits += 1; break; }
      }
      tried.push({ strategy: candidate.strategy, value: candidate.value, count: 0 });
      continue;
    }
    tried.push({ strategy: candidate.strategy, value: candidate.value, count: hits.length });
    if (!hits.length) continue;
    if (hits.length === 1) {
      const hit = hits[0];
      return {
        ok: true,
        status: primaryStrategy(candidate.strategy) ? TARGET_STATUS.EXACT : TARGET_STATUS.FALLBACK,
        strategy: candidate.strategy,
        candidate,
        candidateIndex: candidate.order,
        node: hit.node,
        nodeKey: hit.nodeKey,
        score: roundScore(hit.score),
        alternatives: [],
        reasonCode: primaryStrategy(candidate.strategy) ? TARGET_CODES.EXACT_SELECTOR : TARGET_CODES.UNIQUE_MATCH,
        ambiguity: null,
        tried,
      };
    }
    // 多命中：先按几何/分数稳定排序，再看能否确定性打破。
    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.node.index - right.node.index;
    });
    const top = hits[0];
    const second = hits[1];
    const gap = top.score - second.score;
    if (gap >= margin) {
      return {
        ok: true,
        status: TARGET_STATUS.FALLBACK,
        strategy: candidate.strategy,
        candidate,
        candidateIndex: candidate.order,
        node: top.node,
        nodeKey: top.nodeKey,
        score: roundScore(top.score),
        alternatives: hits.slice(1, 1 + maxAlternatives).map((hit) => ({ nodeKey: hit.nodeKey, score: roundScore(hit.score), strategy: candidate.strategy })),
        reasonCode: geometry ? TARGET_CODES.GEOMETRY_TIEBREAK : TARGET_CODES.SCORE_MARGIN,
        ambiguity: { count: hits.length, margin: roundScore(gap) },
        tried,
      };
    }
    return {
      ok: false,
      status: TARGET_STATUS.AMBIGUOUS,
      strategy: candidate.strategy,
      candidate,
      candidateIndex: candidate.order,
      node: null,
      nodeKey: '',
      score: roundScore(top.score),
      alternatives: hits.slice(0, maxAlternatives).map((hit) => ({ nodeKey: hit.nodeKey, score: roundScore(hit.score), strategy: candidate.strategy })),
      reasonCode: TARGET_CODES.AMBIGUOUS,
      ambiguity: { count: hits.length, margin: roundScore(gap), requiredMargin: margin },
      tried,
    };
  }
  return {
    ok: false,
    status: TARGET_STATUS.MISSING,
    strategy: '',
    candidate: null,
    candidateIndex: -1,
    node: null,
    nodeKey: '',
    score: 0,
    alternatives: [],
    reasonCode: hiddenHits ? TARGET_CODES.ONLY_HIDDEN : TARGET_CODES.NO_MATCH,
    ambiguity: null,
    tried,
  };
}

function primaryStrategy(strategy) {
  return strategy === 'selector' || strategy === 'id' || strategy === 'testid';
}

function roundScore(score) {
  const number = Number(score);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 快照索引与逐 step 还原规划
// ---------------------------------------------------------------------------

/**
 * 把多种快照输入归一成按“文档+帧”索引：
 *   - Map<boundaryScopeKey, nodes>；
 *   - { [boundaryScopeKey]: nodes }；
 *   - [{ boundary, nodes }]；
 *   - 单份节点数组 → 通配 '*'（未验证作用域）。
 * @returns {{byScope:Map<string, Array<object>>, wildcard:Array<object>|null, scopes:string[]}}
 */
export function buildSnapshotIndex(snapshots) {
  const byScope = new Map();
  let wildcard = null;
  const add = (key, nodes) => {
    const normalized = normalizeSnapshotNodes(nodes);
    const scope = normalizeTargetText(key, 240) || '*';
    if (scope === '*') {
      wildcard = normalized;
      return;
    }
    if (!byScope.has(scope)) byScope.set(scope, []);
    const target = byScope.get(scope);
    for (const node of normalized) target.push({ ...node, index: target.length });
  };
  if (snapshots instanceof Map) {
    for (const [key, nodes] of snapshots.entries()) add(key, nodes);
  } else if (Array.isArray(snapshots)) {
    const looksLikeEntries = snapshots.some((entry) => entry && typeof entry === 'object' && (Array.isArray(entry.nodes) || entry.boundary));
    if (looksLikeEntries) {
      for (const entry of snapshots) {
        if (!entry || typeof entry !== 'object') continue;
        const boundary = entry.boundary || entry.identity || null;
        add(entry.scope || (boundary ? boundaryScopeKey(boundary) : '*'), entry.nodes || []);
      }
    } else {
      add('*', snapshots);
    }
  } else if (snapshots && typeof snapshots === 'object') {
    for (const [key, nodes] of Object.entries(snapshots)) add(key, nodes);
  }
  return { byScope, wildcard, scopes: [...byScope.keys()].sort() };
}

/** 为一个 step 取目标描述符：优先 step.target，其次 params 里的 selector/text/name。 */
export function targetOfStep(step) {
  if (!step || typeof step !== 'object') return null;
  const direct = normalizeTargetDescriptor(step.target);
  if (direct) return direct;
  const params = step.params && typeof step.params === 'object' ? step.params : null;
  if (!params) return null;
  return normalizeTargetDescriptor({
    selector: params.selector,
    text: params.text,
    name: params.name,
    role: params.role,
    tag: params.tag,
    placeholder: params.placeholder,
    name_attr: params.name_attr,
    aria_label: params.aria_label,
  });
}

/**
 * 规划一批 step 的目标还原。
 * @param {Array<object>} steps 回放计划 step（含 target/params/boundary）
 * @param {unknown} snapshots 快照（见 buildSnapshotIndex）
 * @param {{requireSnapshot?:boolean, includeHidden?:boolean, ambiguityMargin?:number,
 *          minScore?:number, mode?:string}} [options]
 * @returns {object}
 */
export function planTargetRestoration(steps, snapshots, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const index = buildSnapshotIndex(snapshots);
  const requireSnapshot = options.requireSnapshot === true;
  const out = new Array(list.length);
  const blockers = [];
  const warnings = [];
  let previousBoundary = null;

  for (let position = 0; position < list.length; position += 1) {
    const step = list[position] || {};
    const descriptor = targetOfStep(step);
    const boundary = boundaryFromStep(step);
    const scope = boundaryScopeKey(boundary);
    const params = step.params && typeof step.params === 'object' ? step.params : null;
    const hasTargetInfo = Boolean(step.target)
      || Boolean(params && (params.selector || params.text || params.name || params.role || params.testid));
    // 动作步骤必须有可还原目标（匿名动作 → forbidden）；observe 只有带目标时才需要还原。
    const targetRequired = step.kind === 'action' || (step.kind === 'observe' && hasTargetInfo);
    const rebind = Boolean(previousBoundary && (previousBoundary.revision !== boundary.revision || previousBoundary.urlKey !== boundary.urlKey || previousBoundary.documentId !== boundary.documentId));
    previousBoundary = boundary;
    if (!targetRequired) {
      out[position] = {
        index: position,
        ref: step.ref || '',
        status: TARGET_STATUS.NOT_REQUIRED,
        reasonCode: TARGET_CODES.NOT_REQUIRED,
        required: false,
        rebind,
        scope,
        strategy: '',
        nodeKey: '',
        candidates: [],
        alternatives: [],
        ambiguity: null,
        blocked: false,
      };
      continue;
    }
    if (!descriptor) {
      const status = TARGET_STATUS.FORBIDDEN;
      out[position] = {
        index: position,
        ref: step.ref || '',
        status,
        reasonCode: TARGET_CODES.ANONYMOUS,
        required: true,
        rebind,
        scope,
        strategy: '',
        nodeKey: '',
        candidates: [],
        alternatives: [],
        ambiguity: null,
        blocked: true,
        detail: '目标没有任何可重新定位的信息（无 selector/id/name/text），回放拒绝猜测',
      };
      blockers.push({ code: TARGET_CODES.ANONYMOUS, index: position, ref: step.ref || '', message: '匿名目标无法还原' });
      continue;
    }
    const { candidates } = locatorCandidates(descriptor, options);
    const nodes = index.byScope.get(scope) || index.wildcard || null;
    if (!nodes) {
      const status = requireSnapshot ? TARGET_STATUS.MISSING : TARGET_STATUS.PLANNED;
      out[position] = {
        index: position,
        ref: step.ref || '',
        status,
        reasonCode: TARGET_CODES.NO_SNAPSHOT,
        required: true,
        rebind,
        scope,
        strategy: '',
        nodeKey: '',
        candidates: candidates.map(publicCandidate),
        alternatives: [],
        ambiguity: null,
        blocked: requireSnapshot,
        detail: requireSnapshot ? '缺少该文档/帧的快照，无法验证目标可还原' : '未提供快照：只排候选策略，运行期再验证',
      };
      if (requireSnapshot) blockers.push({ code: TARGET_CODES.NO_SNAPSHOT, index: position, ref: step.ref || '', message: '缺少快照' });
      else warnings.push({ code: TARGET_CODES.NO_SNAPSHOT, index: position, ref: step.ref || '', message: '仅静态候选（未验证）' });
      continue;
    }
    if (!nodes.length) {
      out[position] = {
        index: position,
        ref: step.ref || '',
        status: TARGET_STATUS.MISSING,
        reasonCode: TARGET_CODES.EMPTY_SNAPSHOT,
        required: true,
        rebind,
        scope,
        strategy: '',
        nodeKey: '',
        candidates: candidates.map(publicCandidate),
        alternatives: [],
        ambiguity: null,
        blocked: true,
      };
      blockers.push({ code: TARGET_CODES.EMPTY_SNAPSHOT, index: position, ref: step.ref || '', message: '快照为空' });
      continue;
    }
    const match = matchCandidates(candidates, nodes, {
      geometry: descriptor.geometry,
      includeHidden: options.includeHidden === true,
      ambiguityMargin: options.ambiguityMargin,
      minScore: options.minScore,
    });
    const status = match.status;
    const blocked = TARGET_BLOCKING_STATUSES.includes(status);
    out[position] = {
      index: position,
      ref: step.ref || '',
      status,
      reasonCode: match.reasonCode,
      required: true,
      rebind,
      scope,
      scopeVerified: index.byScope.has(scope),
      strategy: match.strategy,
      candidate: match.candidate ? publicCandidate(match.candidate) : null,
      nodeKey: match.nodeKey,
      score: match.score,
      candidates: candidates.map(publicCandidate),
      alternatives: match.alternatives,
      ambiguity: match.ambiguity,
      tried: match.tried.slice(0, 6),
      blocked,
    };
    if (blocked) {
      blockers.push({
        code: match.reasonCode,
        index: position,
        ref: step.ref || '',
        status,
        message: status === TARGET_STATUS.AMBIGUOUS ? '目标多命中，拒绝猜测' : status === TARGET_STATUS.MISSING ? '目标在快照中找不到' : '目标不可还原',
      });
    } else if (status === TARGET_STATUS.FALLBACK) {
      warnings.push({ code: TARGET_CODES.UNIQUE_MATCH, index: position, ref: step.ref || '', message: '主策略未命中，使用后备定位' });
    }
  }
  const counts = countStatuses(out);
  return {
    ok: blockers.length === 0,
    version: REPLAY_TARGET_VERSION,
    steps: out,
    blockers,
    warnings,
    summary: {
      ...counts,
      candidates: out.reduce((sum, item) => sum + (item && Array.isArray(item.candidates) ? item.candidates.length : 0), 0),
      scopes: index.scopes.length,
      wildcard: Boolean(index.wildcard),
    },
    fingerprint: stableHash(out.map((item) => [item.status, item.ref, item.strategy, item.nodeKey].join('@')).join('>')),
  };
}

function publicCandidate(candidate) {
  if (!candidate) return null;
  return {
    strategy: candidate.strategy,
    value: candidate.strategy === 'selector' ? candidate.value : normalizeTargetText(candidate.value, TARGET_LIMITS.maxName),
    score: roundScore(candidate.score),
    order: candidate.order,
    ...(candidate.role ? { role: candidate.role } : {}),
    ...(candidate.stable === false ? { stable: false } : {}),
  };
}

function countStatuses(plan) {
  const counts = {
    total: plan.length,
    exact: 0,
    fallback: 0,
    ambiguous: 0,
    missing: 0,
    forbidden: 0,
    planned: 0,
    notRequired: 0,
  };
  for (const item of plan) {
    if (!item) continue;
    switch (item.status) {
      case TARGET_STATUS.EXACT: counts.exact += 1; break;
      case TARGET_STATUS.FALLBACK: counts.fallback += 1; break;
      case TARGET_STATUS.AMBIGUOUS: counts.ambiguous += 1; break;
      case TARGET_STATUS.MISSING: counts.missing += 1; break;
      case TARGET_STATUS.FORBIDDEN: counts.forbidden += 1; break;
      case TARGET_STATUS.PLANNED: counts.planned += 1; break;
      case TARGET_STATUS.NOT_REQUIRED: counts.notRequired += 1; break;
      default: break;
    }
  }
  return counts;
}

/** 只排候选、不验证（无快照时的静态计划；也是 replan 前的预检）。 */
export function staticTargetPlan(steps, options = {}) {
  return planTargetRestoration(steps, null, options);
}

/** 汇总目标计划（输出字段用：少而稳定）。 */
export function summarizeTargetPlan(targetPlan) {
  if (!targetPlan || typeof targetPlan !== 'object') {
    return { version: REPLAY_TARGET_VERSION, total: 0, exact: 0, fallback: 0, ambiguous: 0, missing: 0, forbidden: 0, planned: 0, notRequired: 0, blockers: 0, warnings: 0, fingerprint: '' };
  }
  const summary = targetPlan.summary || {};
  return {
    version: REPLAY_TARGET_VERSION,
    ok: targetPlan.ok !== false,
    total: summary.total || 0,
    exact: summary.exact || 0,
    fallback: summary.fallback || 0,
    ambiguous: summary.ambiguous || 0,
    missing: summary.missing || 0,
    forbidden: summary.forbidden || 0,
    planned: summary.planned || 0,
    notRequired: summary.notRequired || 0,
    candidates: summary.candidates || 0,
    scopes: summary.scopes || 0,
    blockers: Array.isArray(targetPlan.blockers) ? targetPlan.blockers.length : 0,
    warnings: Array.isArray(targetPlan.warnings) ? targetPlan.warnings.length : 0,
    fingerprint: targetPlan.fingerprint || '',
  };
}

/** 目标计划里所有阻断码（去重、稳定排序）。 */
export function targetBlockerCodes(targetPlan) {
  const blockers = targetPlan && Array.isArray(targetPlan.blockers) ? targetPlan.blockers : [];
  return [...new Set(blockers.map((blocker) => String(blocker && blocker.code || '')).filter(Boolean))].sort();
}

/** 需要人工介入的目标（敏感字段 / human-gate）：回放前必须补值或确认。 */
export function targetsNeedingHuman(steps, targetPlan) {
  const list = Array.isArray(steps) ? steps : [];
  const plans = targetPlan && Array.isArray(targetPlan.steps) ? targetPlan.steps : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const step = list[index] || {};
    const plan = plans[index] || null;
    // human 合成步骤本身代表暂停点，不再重复计入“需要人工的目标”。
    if (step.kind === 'human') continue;
    const descriptor = targetOfStep(step);
    if (!descriptor && !step.humanGate) continue;
    if (step.humanGate || isSensitiveTarget(descriptor)) {
      out.push({
        index,
        ref: step.ref || '',
        method: step.method || '',
        valueKind: step.humanGate && step.humanGate.valueKind ? String(step.humanGate.valueKind) : 'text',
        reason: step.humanGate && step.humanGate.reason ? String(step.humanGate.reason) : '目标看起来是敏感字段，回放需人工补值',
        status: plan ? plan.status : TARGET_STATUS.PLANNED,
        scope: plan ? plan.scope : '',
      });
    }
  }
  return out;
}

/**
 * 校验一个目标计划的结构自洽（verify 用）：
 *   - steps 数量与输入一致；
 *   - 状态必须是已知枚举；
 *   - blocked 状态必须出现在 blockers 里；
 *   - exact/fallback 必须有命中 nodeKey。
 * @returns {{ok:boolean, issues:Array<object>}}
 */
export function verifyTargetPlan(targetPlan, expectedSteps) {
  const issues = [];
  if (!targetPlan || !Array.isArray(targetPlan.steps)) {
    return { ok: false, issues: [{ code: 'TARGET_PLAN_SHAPE', message: '目标计划缺少 steps' }] };
  }
  if (Number.isInteger(expectedSteps) && targetPlan.steps.length !== expectedSteps) {
    issues.push({ code: 'TARGET_PLAN_LENGTH', message: '目标计划长度与 step 数不一致', expected: expectedSteps, actual: targetPlan.steps.length });
  }
  const knownStatuses = new Set(Object.values(TARGET_STATUS));
  const blockerIndexes = new Set((targetPlan.blockers || []).map((blocker) => blocker && blocker.index));
  for (const item of targetPlan.steps) {
    if (!item) {
      issues.push({ code: 'TARGET_PLAN_EMPTY_STEP', message: '目标计划里有空 step' });
      continue;
    }
    if (!knownStatuses.has(item.status)) {
      issues.push({ code: 'TARGET_PLAN_STATUS', message: '未知目标状态', index: item.index, status: item.status });
    }
    if (item.blocked && !blockerIndexes.has(item.index)) {
      issues.push({ code: 'TARGET_PLAN_BLOCKER_MISSING', message: 'blocked 步骤没有对应 blocker', index: item.index });
    }
    if ((item.status === TARGET_STATUS.EXACT || item.status === TARGET_STATUS.FALLBACK) && !item.nodeKey) {
      issues.push({ code: 'TARGET_PLAN_NO_NODE', message: '命中状态缺少 nodeKey', index: item.index });
    }
    if (item.status === TARGET_STATUS.NOT_REQUIRED && item.blocked) {
      issues.push({ code: 'TARGET_PLAN_NOT_REQUIRED_BLOCKED', message: 'not-required 步骤不应被阻断', index: item.index });
    }
  }
  return { ok: issues.length === 0, issues };
}
