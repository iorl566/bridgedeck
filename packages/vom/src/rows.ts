// packages/vom/src/rows.ts —— 虚拟列表 row facts 契约（类型化移植）。
//
// 源：extension/src/lib/vom-rows.js（行为逐字段等价的基线，差分测试对拍）。
//
// 页面侧（extension/injected/parts/20-observe.part 的 rowFactsOf）产出行事实；
// 扩展侧在这里做唯一一次 normalize，保证 payload 与动作守卫看到同一份字段：
//   anchor = { ariaRowIndex, dataIndex, transform, rowKey, rowText, containerScrollTop, recycled }
// 另有 role/tag 两个辅助字段（classifyVirtualRow 需要据此判 kind），不属于七个主字段。
//
// 约定（移植时逐条保留）：
//   - 缺失/不可解析一律 null（不是 0/''）；recycled 缺省 false；
//   - transform 保留页面 computed style 的原始字符串（"none"/"matrix(...)"/"translateY(...)"），
//     解析交给 src/lib/virtual-row-guard.js 的 parseRowTransform；
//   - rowText 截断 200、rowKey 截断 120、transform 截断 200，避免大页面把观测撑爆。

import type {
  RowAnchor,
  RowAnchorInput,
  RowAnchorRaw,
  RowAnchorSummary,
  RowNodeFacts,
} from './types.ts';

/** row anchor 契约版本。 */
export const VOM_ROW_ANCHOR_VERSION = 1;

/** 七个契约字段（W2 fill/click 的 rowAnchor 消费按这些键名）。 */
export const ROW_ANCHOR_FIELDS: readonly string[] = Object.freeze([
  'ariaRowIndex',
  'dataIndex',
  'transform',
  'rowKey',
  'rowText',
  'containerScrollTop',
  'recycled',
]);

/** 辅助字段：不参与稳定性比较，但交给 classifyVirtualRow 判行/格类型。 */
export const ROW_ANCHOR_AUX_FIELDS: readonly string[] = Object.freeze(['role', 'tag']);

/** 整数或 null：null/undefined/'' 归 null，非整数（含小数、NaN、布尔）归 null。 */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/** 折叠空白后截断；空串归 null。 */
function stringOrNull(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** 原样字符串（不折叠空白）后截断；空串归 null。 */
function rawStringOrNull(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * containerScrollTop：有限数字（含数字字符串、''→0）保留一位小数；
 * NaN/undefined/对象归 null；显式 null 也归 null。
 */
function containerScrollTopOf(value: unknown): number | null {
  const number = Number(value);
  if (Number.isFinite(number) && value !== null) return Math.round(number * 10) / 10;
  return null;
}

/** 页面侧 anchor（可能来自旧页面库/用户手写）→ 契约对象；无有效事实时返回 null。 */
export function normalizeRowAnchor(raw: RowAnchorInput): RowAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as RowAnchorRaw;
  const anchor: RowAnchor = {
    ariaRowIndex: numberOrNull(source.ariaRowIndex != null ? source.ariaRowIndex : source['aria-rowindex']),
    dataIndex: numberOrNull(source.dataIndex != null ? source.dataIndex : source['data-index']),
    transform: rawStringOrNull(source.transform, 200),
    rowKey: stringOrNull(source.rowKey, 120),
    rowText: stringOrNull(source.rowText != null ? source.rowText : source.text, 200),
    containerScrollTop: containerScrollTopOf(source.containerScrollTop),
    recycled: source.recycled === true,
  };
  const role = stringOrNull(source.role, 40);
  const tag = stringOrNull(source.tag, 40);
  if (role) anchor.role = role.toLowerCase();
  if (tag) anchor.tag = tag.toLowerCase();
  // 全是空事实（既没有行索引/行键/行文本/变换）就当没有 anchor，避免 payload 里出现空对象。
  const meaningful = anchor.ariaRowIndex != null || anchor.dataIndex != null || anchor.rowKey != null
    || anchor.rowText != null || (anchor.transform != null && anchor.transform !== 'none');
  return meaningful ? anchor : null;
}

/** 动作前比对：观察时的 anchor 与当前行事实是否仍指同一行。 */
export function rowAnchorChanged(previous: RowAnchorInput, current: RowAnchorInput): boolean {
  const before = normalizeRowAnchor(previous);
  const after = normalizeRowAnchor(current);
  if (!before && !after) return false;
  if (!before || !after) return true;
  if (before.rowText !== after.rowText) return true;
  if (before.rowKey != null && after.rowKey != null && before.rowKey !== after.rowKey) return true;
  if (before.ariaRowIndex != null && after.ariaRowIndex != null && before.ariaRowIndex !== after.ariaRowIndex) return true;
  if (before.dataIndex != null && after.dataIndex != null && before.dataIndex !== after.dataIndex) return true;
  if (before.transform !== after.transform) return true;
  // 容器滚动位移本身不一定换行，但会改变行在视口中的位置；动作守卫要的是“观测后有没有动过”。
  if (before.containerScrollTop != null && after.containerScrollTop != null
    && Math.abs(before.containerScrollTop - after.containerScrollTop) > 1) return true;
  return false;
}

/** 单行 anchor 的可读签名（诊断/去重用）。 */
export function rowAnchorSignature(anchor: RowAnchorInput): string {
  const value = normalizeRowAnchor(anchor);
  if (!value) return '';
  return [
    value.ariaRowIndex == null ? '-' : value.ariaRowIndex,
    value.dataIndex == null ? '-' : value.dataIndex,
    value.rowKey == null ? '-' : value.rowKey,
    value.rowText == null ? '-' : value.rowText,
    value.transform == null ? '-' : value.transform,
  ].join('\u0000');
}

/** 一行人类可读描述（observe 诊断/vomExplain 用）。 */
export function describeRowAnchor(anchor: RowAnchorInput): string {
  const value = normalizeRowAnchor(anchor);
  if (!value) return '';
  const parts: string[] = [];
  if (value.ariaRowIndex != null) parts.push('ariaRowIndex=' + value.ariaRowIndex);
  if (value.dataIndex != null) parts.push('dataIndex=' + value.dataIndex);
  if (value.rowKey != null) parts.push('rowKey=' + value.rowKey);
  if (value.transform != null && value.transform !== 'none') parts.push('transform=' + value.transform);
  if (value.containerScrollTop != null) parts.push('scrollTop=' + value.containerScrollTop);
  if (value.rowText != null) parts.push('text=' + JSON.stringify(value.rowText.slice(0, 60)));
  if (value.recycled) parts.push('recycled');
  return parts.join(' ');
}

/** 节点列表的 row facts 汇总（observe 输出的 rowAnchors 诊断）。 */
export function summarizeRowAnchors(nodes: unknown): RowAnchorSummary {
  const list: unknown[] = Array.isArray(nodes) ? nodes : [];
  const byRole: Record<string, number> = {};
  const containers = new Set<number>();
  let anchored = 0;
  let recycled = 0;
  let withRowKey = 0;
  let withIndex = 0;
  let transformed = 0;
  for (const node of list) {
    if (!node || typeof node !== 'object') continue;
    const facts = node as RowNodeFacts;
    // 注意：与 anchorOf 不同，JS 基线的 summary 只读 node.anchor，不读 rowAnchor 兼容字段。
    const anchor = normalizeRowAnchor(facts.anchor);
    if (!anchor) continue;
    anchored += 1;
    if (anchor.recycled) recycled += 1;
    if (anchor.rowKey != null) withRowKey += 1;
    if (anchor.ariaRowIndex != null || anchor.dataIndex != null) withIndex += 1;
    if (anchor.transform != null && anchor.transform !== 'none') transformed += 1;
    const scrollTop = anchor.containerScrollTop;
    if (scrollTop != null) containers.add(scrollTop);
    const kind = anchor.role || anchor.tag || 'unknown';
    byRole[kind] = (byRole[kind] || 0) + 1;
  }
  return {
    version: VOM_ROW_ANCHOR_VERSION,
    total: list.length,
    anchored,
    recycled,
    withRowKey,
    withIndex,
    transformed,
    containers: containers.size,
    byRole,
  };
}

/** 取节点上的 anchor（兼容页面侧原始字段名），统一走 normalize。 */
export function anchorOf(node: unknown): RowAnchor | null {
  if (!node || typeof node !== 'object') return null;
  const facts = node as RowNodeFacts;
  return normalizeRowAnchor(facts.anchor || facts.rowAnchor || null);
}

/** 版本读取器（诊断用，避免调用方 import 常量时拿到未冻结值）。 */
export function rowAnchorVersion(): number {
  return VOM_ROW_ANCHOR_VERSION;
}
