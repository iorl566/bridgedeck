// ui/lib/empty-state.js —— 空态深度模型（纯函数，无 DOM/chrome，可在 Node 单测）。
//
// 空列表有七种完全不同的原因，对应完全不同的下一步：
//   1. 首次进入（什么都没做过）→ 导入/载入；
//   2. 过滤后为空（本来有数据）→ 清除过滤，而不是“重试”；
//   3. 加载失败 → 重试 + 错误码；
//   4. 没有权限 → 去设置开权限；
//   5. 还没选记录（对比/详情）→ 先选；
//   6. 数据太大被拒 → 缩小范围/拆分；
//   7. 能力不支持 → 说明原因。
//
// 如果统一显示“没有数据”，用户会以为是产品坏了。本模块把“原因 → 文案/动作/播报/图标”
// 收敛成一份模型，页面只 mount。lib/states.js 仍负责 loading/error/empty 的四态，
// 本模块负责 empty 内部的细分（两者不冲突：states.js 判「是不是空」，本模块判「为什么空」）。

import { formatLabel } from './labels.js';

/** 空态原因（顺序即“优先级”，resolve 时按此顺序判定）。 */
export const EMPTY_REASONS = Object.freeze([
  'error',
  'permission',
  'too-large',
  'needs-selection',
  'no-match',
  'first-run',
  'unsupported',
]);

/** 原因 → 文案 key（标题/正文）。 */
const TEXT_KEYS = Object.freeze({
  'first-run': { title: 'empty.noDataTitle', body: 'empty.noDataBody' },
  'no-match': { title: 'empty.noMatchTitle', body: 'empty.noMatchBody' },
  'error': { title: 'empty.errorTitle', body: 'empty.errorBody' },
  'permission': { title: 'empty.permissionTitle', body: 'empty.permissionBody' },
  'needs-selection': { title: 'empty.selectionTitle', body: 'empty.selectionBody' },
  'too-large': { title: 'empty.tooLargeTitle', body: 'empty.tooLargeBody' },
  'unsupported': { title: 'empty.errorTitle', body: 'empty.unsupportedBody' },
});

/** 原因 → 语义色（CSS class 后缀，不是颜色值）。 */
const TONES = Object.freeze({
  'first-run': 'muted',
  'no-match': 'muted',
  'error': 'err',
  'permission': 'warn',
  'needs-selection': 'muted',
  'too-large': 'warn',
  'unsupported': 'warn',
});

/**
 * 判定空态原因。
 * @param {{total?:number, matched?:number, query?:string, error?:any, permission?:boolean,
 *   selectionPending?:boolean, selectionCount?:number, tooLarge?:boolean, unsupported?:boolean}} input
 * @returns {string} EMPTY_REASONS 之一
 */
export function resolveEmptyReason(input = {}) {
  const total = Number(input.total) || 0;
  const matched = input.matched === undefined ? total : (Number(input.matched) || 0);
  if (input.error) return 'error';
  if (input.permission === true) return 'permission';
  if (input.tooLarge === true) return 'too-large';
  if (input.selectionPending === true && !(Number(input.selectionCount) > 0)) return 'needs-selection';
  if (input.unsupported === true) return 'unsupported';
  if (total > 0 && matched === 0) return 'no-match';
  if (String(input.query || '').trim() && matched === 0) return 'no-match';
  return 'first-run';
}

/** 区分「一条数据都没有」与「有数据但被过滤掉了」（给 stats/aria 用）。 */
export function distinguishEmpty(input = {}) {
  const total = Number(input.total) || 0;
  const matched = input.matched === undefined ? total : (Number(input.matched) || 0);
  if (total === 0) return { kind: 'no-data', filtered: false, total, matched };
  if (matched === 0) return { kind: 'no-match', filtered: Boolean(String(input.query || '').trim()), total, matched };
  return { kind: 'has-data', filtered: false, total, matched };
}

/** 原因 → 建议动作（key + labels key + 语义）。页面按 kind 绑定事件。 */
export function emptyActionsFor(surface, reason, options = {}) {
  const lang = options.lang || 'zh';
  const actions = [];
  const add = (key, labelKey, kind, primary) => actions.push({ key, label: formatLabel(labelKey, {}, lang), kind, primary: Boolean(primary) });
  switch (reason) {
    case 'error':
      add('retry', 'empty.retry', 'primary', true);
      break;
    case 'permission':
      add('settings', 'empty.openSettings', 'primary', true);
      break;
    case 'too-large':
      add('import', 'empty.import', 'primary', true);
      break;
    case 'needs-selection':
      add('clear-selection', 'empty.selectFirst', 'primary', true);
      break;
    case 'no-match':
      add('clear-filter', 'empty.clearFilters', 'primary', true);
      add('reduce', 'empty.reduce', 'secondary', false);
      break;
    case 'unsupported':
      add('refresh', 'empty.retry', 'secondary', false);
      break;
    default:
      // 首次进入：不同表面给最相关的入口（工作台 → 导入；记录页 → 载入；其它 → 刷新）。
      if (surface === 'workspace') add('import', 'empty.import', 'primary', true);
      else if (['ops', 'record', 'longshot', 'audit', 'debug'].includes(surface)) add('load', 'empty.load', 'primary', true);
      else add('refresh', 'empty.retry', 'primary', true);
      break;
  }
  return actions;
}

/**
 * 完整空态模型（页面 mount 用）。
 * @param {{surface?:string, reason?:string, lang?:string, query?:string, total?:number,
 *   matched?:number, error?:any, limit?:number, detail?:string, actions?:Array}} input
 */
export function buildEmptyState(input = {}) {
  const lang = input.lang || 'zh';
  const reason = EMPTY_REASONS.includes(input.reason) ? input.reason : resolveEmptyReason(input);
  const keys = TEXT_KEYS[reason] || TEXT_KEYS['first-run'];
  const bodyKey = reason === 'too-large' ? 'empty.tooLargeBody' : keys.body;
  const params = {
    // no-match 的正文说“排除了全部 N 行”，N 是数据总数而不是匹配数（匹配数是 0）。
    total: reason === 'no-match' ? (Number(input.total) || 0) : (Number(input.matched !== undefined ? input.matched : input.total) || 0),
    limit: Number(input.limit) || 0,
    count: Number(input.total) || 0,
  };
  const title = formatLabel(keys.title, params, lang);
  const body = input.detail ? String(input.detail) : formatLabel(bodyKey, params, lang);
  const actions = Array.isArray(input.actions) ? input.actions : emptyActionsFor(input.surface || '', reason, { lang });
  return {
    reason,
    kind: reason === 'error' ? 'error' : (reason === 'no-match' ? 'no-match' : 'empty'),
    tone: TONES[reason] || 'muted',
    title,
    body,
    // 读屏播报：标题 + 正文（aria-live 区域不该只播“没有内容”）。
    announcement: title + '：' + body,
    actions,
    // 数据状态提示：过滤为空时明确告诉用户“不是没数据，是条件太严”。
    filtered: reason === 'no-match',
    query: String(input.query || ''),
    // 说明性脚注：过滤为空时提示总行数，避免用户以为数据丢了。
    footnote: reason === 'no-match'
      ? formatLabel('empty.filteredFootnote', { total: Number(input.total) || 0 }, lang)
      : '',
    role: reason === 'error' ? 'alert' : 'status',
    live: reason === 'error' ? 'assertive' : 'polite',
    icon: iconFor(reason),
  };
}

/** 语义图标名（CSS 用 `data-icon` 渲染圆点/三角，不用 emoji 文本，避免读屏念表情）。 */
export function iconFor(reason) {
  switch (reason) {
    case 'error': return 'alert';
    case 'permission': return 'lock';
    case 'too-large': return 'scale';
    case 'needs-selection': return 'cursor';
    case 'no-match': return 'search';
    case 'unsupported': return 'ban';
    default: return 'inbox';
  }
}

/** 空态是否应该提供“清除过滤”（避免给首屏一个无效按钮）。 */
export function shouldSuggestClearFilters(reason) {
  return reason === 'no-match';
}

/** 多个区块的空态聚合：任一 error 优先，其次 permission/too-large，最后 no-match。 */
export function aggregateEmptyReasons(reasons) {
  const list = (Array.isArray(reasons) ? reasons : []).filter((reason) => EMPTY_REASONS.includes(reason));
  for (const reason of ['error', 'permission', 'too-large', 'needs-selection', 'unsupported', 'no-match']) {
    if (list.includes(reason)) return reason;
  }
  return list[0] || 'first-run';
}

/** 把 table model（lib/table.js）转成空态输入，页面少写一段映射。 */
export function emptyInputFromTable(model, extra = {}) {
  const source = model && typeof model === 'object' ? model : {};
  return {
    total: Number(source.total) || 0,
    matched: Number(source.matched !== undefined ? source.matched : source.filtered) || 0,
    query: String(source.query || ''),
    ...extra,
  };
}

/** 空态统计行文本：`0 / 128 行`。 */
export function emptyCounterText(input, lang = 'zh') {
  const total = Number(input && input.total) || 0;
  const matched = Number(input && input.matched !== undefined ? input.matched : total) || 0;
  return formatLabel('empty.counter', { matched, total }, lang);
}

/** 空态文案目录（供页面/测试复用，避免散落字符串）。 */
export function emptyStateCatalog() {
  const out = {};
  for (const reason of EMPTY_REASONS) {
    out[reason] = {
      title: TEXT_KEYS[reason].title,
      body: TEXT_KEYS[reason].body,
      tone: TONES[reason],
    };
  }
  return out;
}
