// ui/lib/aria-live.js —— 读屏播报队列（纯函数/可注入时钟，可在 Node 单测）。
//
// 页面的 aria-live 区域如果“来一条写一条”，会踩三个坑：
// 1. 连续操作时中间消息被覆盖（读屏只念最后一条）；
// 2. 同一句话重复播报（“已选择 3 项”连按三次选择键）；
// 3. 拦截式（assertive）消息被礼貌消息淹没。
//
// 本模块是一个「有界、去重、可合并」的播报队列：
// - polite / assertive 两个队列，assertive 优先；
// - 同一文本在 throttleMs 内只播一次；
// - 队列上限 maxQueue，超出丢最旧的 polite（assertive 不丢）；
// - 时钟可注入（`now`），测试不需要 sleep。

import { formatLabel } from './labels.js';

/** 播报语气：polite 排队，assertive 立即打断。 */
export const POLITENESS = Object.freeze(['polite', 'assertive']);

/** 默认节流窗口：同一句话 1.2 秒内不重复。 */
export const DEFAULT_THROTTLE_MS = 1200;

/** 默认队列上限。 */
export const DEFAULT_MAX_QUEUE = 8;

/**
 * 创建播报队列。
 * @param {{now?:()=>number, throttleMs?:number, maxQueue?:number, onAnnounce?:(item:object)=>void}} options
 */
export function createAnnouncer(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const throttleMs = Math.max(0, Number(options.throttleMs) || DEFAULT_THROTTLE_MS);
  const maxQueue = Math.max(1, Math.floor(Number(options.maxQueue) || DEFAULT_MAX_QUEUE));
  const onAnnounce = typeof options.onAnnounce === 'function' ? options.onAnnounce : null;
  const polite = [];
  const assertive = [];
  const lastSeen = new Map();
  let last = null;
  let sequence = 0;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener({ queue: [...assertive, ...polite], last }); } catch { /* 忽略 */ }
    }
  };
  function push(text, politeness) {
    const value = String(text === undefined || text === null ? '' : text).trim();
    if (!value) return { accepted: false, reason: 'empty' };
    const tone = POLITENESS.includes(politeness) ? politeness : 'polite';
    const stamp = now();
    const previous = lastSeen.get(value);
    if (previous !== undefined && stamp - previous < throttleMs) {
      return { accepted: false, reason: 'throttled', text: value };
    }
    lastSeen.set(value, stamp);
    if (lastSeen.size > 64) {
      // 防止长会话里 Map 无限增长：删掉最旧的一半。
      const entries = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, 32)) lastSeen.delete(key);
    }
    const item = { id: ++sequence, text: value, politeness: tone, at: stamp };
    if (tone === 'assertive') assertive.push(item);
    else polite.push(item);
    while (polite.length + assertive.length > maxQueue) {
      // 优先丢最旧的礼貌消息；没有礼貌消息时丢最旧的拦截消息。
      if (polite.length) polite.shift();
      else assertive.shift();
    }
    if (onAnnounce) {
      try { onAnnounce(item); } catch { /* 页面回调异常不影响队列 */ }
    }
    emit();
    return { accepted: true, item };
  }
  return {
    /** 礼貌播报（默认）。 */
    announce(text, options = {}) {
      return push(text, options.politeness || 'polite');
    },
    /** 拦截播报（错误/危险操作）。 */
    alert(text) {
      return push(text, 'assertive');
    },
    /** 取出下一条要写入 DOM 的消息（assertive 优先），为空返回 null。 */
    take() {
      const item = assertive.shift() || polite.shift() || null;
      if (item) {
        last = item;
        emit();
      }
      return item;
    },
    /** 当前下一条（不消费）。 */
    peek() {
      return assertive[0] || polite[0] || null;
    },
    /** 队列快照（测试断言用）。 */
    snapshot() {
      return {
        assertive: assertive.map((item) => item.text),
        polite: polite.map((item) => item.text),
        last: last ? last.text : '',
        size: assertive.length + polite.length,
        sequence,
      };
    },
    /** 清空队列（页面卸载/切换视图时）。 */
    clear() {
      assertive.length = 0;
      polite.length = 0;
      emit();
    },
    /** 订阅队列变化。 */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 是否还有待播报。 */
    get pending() { return assertive.length + polite.length; },
  };
}

/** 播报用的 aria 属性（页面直接挂到容器上）。 */
export function liveRegionAttrs(politeness = 'polite') {
  const tone = POLITENESS.includes(politeness) ? politeness : 'polite';
  return {
    role: tone === 'assertive' ? 'alert' : 'status',
    'aria-live': tone,
    'aria-atomic': 'true',
    'aria-relevant': 'text',
  };
}

/** 合并多条播报为一句（选择 + 过滤 + 排序同时变化时避免连播三句）。 */
export function joinAnnouncements(parts, { separator = '；' } = {}) {
  const list = (Array.isArray(parts) ? parts : []).map((part) => String(part || '').trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return list.join(separator);
}

/** 选择变化播报。 */
export function describeSelection(count, total, lang = 'zh') {
  return formatLabel('a11y.selectedOf', { count: Number(count) || 0, total: Number(total) || 0 }, lang);
}

/** 过滤变化播报。 */
export function describeFilter(matched, total, lang = 'zh') {
  return formatLabel('filter.matched', { matched: Number(matched) || 0, total: Number(total) || 0 }, lang);
}

/** 排序变化播报（`已按耗时降序排序`）。 */
export function describeSort(columnLabel, direction, lang = 'zh') {
  return formatLabel('a11y.sortedBy', {
    column: String(columnLabel || ''),
    direction: formatLabel(direction === 'desc' ? 'list.sortDesc' : 'list.sortAsc', {}, lang),
  }, lang);
}

/** 列配置变化播报。 */
export function describeColumns(visible, total, lang = 'zh') {
  return formatLabel('columns.visible', { count: Number(visible) || 0, total: Number(total) || 0 }, lang);
}

/** 导出/导入结果播报。 */
export function describeTransfer(kind, payload, lang = 'zh') {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (kind === 'export') {
    if (source.rows === 0) return formatLabel('export.noRows', {}, lang);
    const parts = [formatLabel('export.done', { count: Number(source.rows) || 0 }, lang)];
    if (source.redacted) parts.push(formatLabel('export.redacted', { count: source.redacted }, lang));
    if (source.truncated) parts.push(formatLabel('export.truncated', {}, lang));
    return joinAnnouncements(parts);
  }
  if (kind === 'import') {
    return formatLabel('import.done', { count: Number(source.rows) || 0, invalid: Number(source.invalid) || 0 }, lang);
  }
  return '';
}

/** 差异导航播报。 */
export function describeDiffPosition(index, total, lang = 'zh') {
  return formatLabel('diff.position', { index: Number(index) || 0, total: Number(total) || 0 }, lang);
}

/** 把 announcer 接到真实 DOM（页面只调用一次；纯逻辑仍在上面）。 */
export function bindAnnouncerToNode(announcer, node, { doc } = {}) {
  if (!announcer || !node) return { dispose() {} };
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef) return { dispose() {} };
  let timer = null;
  const flush = () => {
    const item = announcer.take();
    if (!item) return false;
    try { node.textContent = item.text; } catch { return false; }
    return true;
  };
  const schedule = () => {
    if (timer !== null) return;
    const run = () => {
      timer = null;
      flush();
      // 队列还有内容才继续调度，避免“永久 60ms 定时器”在空闲页面里空转。
      if (announcer.pending > 0) schedule();
    };
    timer = setTimeout(run, 60);
  };
  const unsubscribe = announcer.subscribe(schedule);
  return {
    flush,
    dispose() {
      unsubscribe();
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
  };
}

/** 断言式小工具：给控件补 aria 描述（不覆盖已有值）。 */
export function ariaDescribe(existing, extra) {
  const parts = [String(existing || '')];
  for (const [name, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(name + '=' + String(value));
  }
  return parts.filter(Boolean).join(' ');
}
