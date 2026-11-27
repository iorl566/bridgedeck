// ui/lib/selection.js —— 纯多选模型（无 DOM/chrome，可在 Node 单测）。
//
// audit「按会话批量导出」、ops「对比两次录制」、debug「选择两条历史」都需要
// 「点击 / Cmd 点击切换 / Shift 点击连选」；浏览器原生 <select multiple> 的 Shift
// 行为不可控，这里自己实现，且保持不可变（每次操作返回新集合）。
//
// 约定：
// - 只存字符串 key（数字 id 也统一转字符串）；
// - anchor 是 Shift 连选的锚点；
// - shiftRange 对“未排序的输入顺序”也生效（用 order 数组定位，而不是比较数值）。

function toKey(value) {
  return String(value === undefined || value === null ? '' : value);
}

function normalizeOrder(order, keys) {
  const list = Array.isArray(order) ? order.map(toKey) : [];
  const seen = new Set(list);
  for (const key of keys) if (!seen.has(key)) { list.push(key); seen.add(key); }
  return list;
}

/**
 * @param {{order?:Array<string|number>, selected?:Iterable<string|number>, limit?:number}} [options]
 */
export function createSelection(options = {}) {
  let order = Array.isArray(options.order) ? options.order.map(toKey) : [];
  let selected = new Set(Array.from(options.selected || [], toKey));
  let anchor = null;
  const limit = Math.max(0, Math.floor(Number(options.limit) || 0));

  function capped(set) {
    if (!limit || set.size <= limit) return set;
    const kept = new Set();
    for (const key of order) {
      if (kept.size >= limit) break;
      if (set.has(key)) kept.add(key);
    }
    for (const key of set) {
      if (kept.size >= limit) break;
      kept.add(key);
    }
    return kept;
  }

  function visible(keys) {
    order = normalizeOrder(order, keys.map(toKey));
    return order;
  }

  return {
    setOrder(keys) {
      order = normalizeOrder(order, (Array.isArray(keys) ? keys : []).map(toKey));
      return order.slice();
    },
    get order() { return order.slice(); },
    get selected() { return [...selected]; },
    get size() { return selected.size; },
    get anchor() { return anchor; },
    get limit() { return limit; },
    has(key) { return selected.has(toKey(key)); },
    isSelected(key) { return selected.has(toKey(key)); },
    /** 单击：toggle 语义（保留其它选择，更新锚点）。 */
    click(key) {
      const value = toKey(key);
      const next = new Set(selected);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      selected = capped(next);
      anchor = value;
      return [...selected];
    },
    /** Shift 单击：从 anchor 到 key 的区间改为选中（已选的其它项保持）。 */
    shiftClick(key) {
      const value = toKey(key);
      const list = order;
      const targetIndex = list.indexOf(value);
      const anchorIndex = anchor === null ? -1 : list.indexOf(anchor);
      if (targetIndex < 0) return [...selected];
      if (anchorIndex < 0) {
        selected = capped(new Set([...selected, value]));
        anchor = value;
        return [...selected];
      }
      const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      const next = new Set(selected);
      for (let index = from; index <= to; index += 1) next.add(list[index]);
      selected = capped(next);
      return [...selected];
    },
    /** 直接设置锚点（例如键盘选择后）。 */
    setAnchor(key) {
      anchor = key === null || key === undefined ? null : toKey(key);
      return anchor;
    },
    selectAll(keys) {
      const list = Array.isArray(keys) ? keys.map(toKey) : order;
      selected = capped(new Set(list));
      return [...selected];
    },
    clear() {
      selected = new Set();
      anchor = null;
      return [];
    },
    /** 删除已选（列表数据刷新后 prune 掉不存在的 key）。 */
    prune(keys) {
      const alive = new Set((Array.isArray(keys) ? keys : []).map(toKey));
      const next = new Set();
      for (const key of selected) if (alive.has(key)) next.add(key);
      selected = next;
      if (anchor !== null && !alive.has(anchor)) anchor = null;
      return [...selected];
    },
    /** 移除单条（保留其它选择与锚点）。 */
    remove(key) {
      const value = toKey(key);
      const next = new Set(selected);
      next.delete(value);
      selected = next;
      if (anchor === value) anchor = null;
      return [...selected];
    },
    /** 选中集合按列表顺序排序（导出/对比时顺序稳定）。 */
    ordered() {
      const picked = [];
      for (const key of order) if (selected.has(key)) picked.push(key);
      const seen = new Set(picked);
      for (const key of selected) if (!seen.has(key)) picked.push(key);
      return picked;
    },
    summary() {
      return { size: selected.size, limit, full: limit > 0 && selected.size >= limit, keys: [...selected] };
    },
    visible,
  };
}

/** 无状态辅助：两个集合的差集/交集（对比视图用）。 */
export function intersect(a, b) {
  const left = new Set(Array.from(a || [], toKey));
  const right = new Set(Array.from(b || [], toKey));
  const out = [];
  for (const key of left) if (right.has(key)) out.push(key);
  return out;
}

export function difference(a, b) {
  const left = new Set(Array.from(a || [], toKey));
  const right = new Set(Array.from(b || [], toKey));
  const out = [];
  for (const key of left) if (!right.has(key)) out.push(key);
  return out;
}
