// ui/lib/diff.js —— 纯文本/记录差异（无 DOM/chrome，可在 Node 单测）。
//
// 两个真实场景：
// 1. debug 页对比两份采集记录：请求列表、控制台输出 → 结构化差异（按 key 对齐）；
// 2. ops 页对比两次录制 / audit 页对比两个快照：步骤序列 / 任务序列 → 按键对齐差异。
//
// 另有文本差异（unified hunks + 并排行）用于 JSON 预览里的「哪几行变了」。
//
// 算法：先剥掉公共前后缀，再对中间段做 LCS；中间段过大（> 256×256 有效格）时降级为
// 「整段替换」，保证页面在超长 JSON 上不会卡死（宁缺毋滥，不抛错）。

/** 统一换行并切行（保留空行，末尾换行不产生额外空行）。 */
export function splitLines(text) {
  const source = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
  if (source === '') return [];
  const lines = source.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 单词切分：英文按词，CJK 按字；标点独立成 token，便于逐字差异。 */
export function splitWords(text) {
  const source = String(text === undefined || text === null ? '' : text);
  if (!source) return [];
  const tokens = source.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\sA-Za-z0-9_\u4e00-\u9fff]/g);
  return tokens || [];
}

const LCS_CELL_LIMIT = 65536; // 256×256：超过则整段替换（页面不卡）

/** 公共前后缀剥离，返回 [prefixLen, aMid, bMid, suffixLen]。 */
export function stripCommon(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return {
    prefix,
    suffix,
    leftMiddle: left.slice(prefix, left.length - suffix),
    rightMiddle: right.slice(prefix, right.length - suffix),
  };
}

/**
 * LCS 差异（逐行/逐词通用）。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type:'equal'|'delete'|'insert', aIndex:number|null, bIndex:number|null, text:string}>}
 */
export function diffSequences(a, b) {
  const left = Array.isArray(a) ? a.map(String) : [];
  const right = Array.isArray(b) ? b.map(String) : [];
  const { prefix, suffix } = stripCommon(left, right);
  const out = [];
  for (let index = 0; index < prefix; index += 1) {
    out.push({ type: 'equal', aIndex: index, bIndex: index, text: left[index] });
  }
  const leftMid = left.slice(prefix, left.length - suffix);
  const rightMid = right.slice(prefix, right.length - suffix);
  const leftOffset = prefix;
  const rightOffset = prefix;
  const n = leftMid.length;
  const m = rightMid.length;
  if (n * m > LCS_CELL_LIMIT) {
    // 降级：中间段整体删除 + 整体插入（保守但不卡页面）。
    for (let index = 0; index < n; index += 1) out.push({ type: 'delete', aIndex: leftOffset + index, bIndex: null, text: leftMid[index] });
    for (let index = 0; index < m; index += 1) out.push({ type: 'insert', aIndex: null, bIndex: rightOffset + index, text: rightMid[index] });
  } else if (n === 0) {
    for (let index = 0; index < m; index += 1) out.push({ type: 'insert', aIndex: null, bIndex: rightOffset + index, text: rightMid[index] });
  } else if (m === 0) {
    for (let index = 0; index < n; index += 1) out.push({ type: 'delete', aIndex: leftOffset + index, bIndex: null, text: leftMid[index] });
  } else {
    // DP 表：table[i][j] = LCS(leftMid[i:], rightMid[j:]) 的长度。
    const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] = leftMid[i] === rightMid[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (leftMid[i] === rightMid[j]) {
        out.push({ type: 'equal', aIndex: leftOffset + i, bIndex: rightOffset + j, text: leftMid[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        out.push({ type: 'delete', aIndex: leftOffset + i, bIndex: null, text: leftMid[i] });
        i += 1;
      } else {
        out.push({ type: 'insert', aIndex: null, bIndex: rightOffset + j, text: rightMid[j] });
        j += 1;
      }
    }
    while (i < n) { out.push({ type: 'delete', aIndex: leftOffset + i, bIndex: null, text: leftMid[i] }); i += 1; }
    while (j < m) { out.push({ type: 'insert', aIndex: null, bIndex: rightOffset + j, text: rightMid[j] }); j += 1; }
  }
  for (let index = 0; index < suffix; index += 1) {
    const aIndex = left.length - suffix + index;
    const bIndex = right.length - suffix + index;
    out.push({ type: 'equal', aIndex, bIndex, text: left[aIndex] });
  }
  return out;
}

/** 文本行差异。 */
export function diffLines(aText, bText) {
  return diffSequences(splitLines(aText), splitLines(bText));
}

/** 文本词差异（CJK 逐字）。 */
export function diffWords(aText, bText) {
  return diffSequences(splitWords(aText), splitWords(bText));
}

/** 统计：新增/删除/未变行数 + 是否相同。 */
export function diffStats(ops) {
  const list = Array.isArray(ops) ? ops : [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of list) {
    if (op.type === 'insert') added += 1;
    else if (op.type === 'delete') removed += 1;
    else unchanged += 1;
  }
  return { added, removed, unchanged, total: list.length, changed: added + removed, identical: added === 0 && removed === 0 };
}

/**
 * unified diff 分块：把差异行 ± context 行合成 hunk（与 `git diff` 的形状一致）。
 * @returns {Array<{aStart:number,bStart:number,aCount:number,bCount:number,ops:Array}>}
 */
export function unifiedHunks(ops, { context = 3 } = {}) {
  const list = Array.isArray(ops) ? ops : [];
  const radius = Math.max(0, Math.floor(Number(context) || 0));
  const changeIndices = [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].type !== 'equal') changeIndices.push(index);
  }
  if (!changeIndices.length) return [];
  // 合并相邻的差异窗口
  const ranges = [];
  for (const index of changeIndices) {
    const start = Math.max(0, index - radius);
    const end = Math.min(list.length, index + radius + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map((range) => {
    const slice = list.slice(range.start, range.end);
    let aStart = null;
    let bStart = null;
    let aCount = 0;
    let bCount = 0;
    for (const op of slice) {
      if (op.aIndex !== null && op.aIndex !== undefined) {
        if (aStart === null) aStart = op.aIndex;
        aCount += 1;
      }
      if (op.bIndex !== null && op.bIndex !== undefined) {
        if (bStart === null) bStart = op.bIndex;
        bCount += 1;
      }
    }
    return {
      aStart: aStart === null ? 0 : aStart,
      bStart: bStart === null ? 0 : bStart,
      aCount,
      bCount,
      ops: slice,
    };
  });
}

/** 并排渲染行：delete 放左、insert 放右，成对时同一行显示（context 两侧都有）。 */
export function sideBySide(ops) {
  const list = Array.isArray(ops) ? ops : [];
  const rows = [];
  let pendingDeletes = [];
  const flush = () => {
    for (const op of pendingDeletes) rows.push({ type: 'delete', left: op, right: null });
    pendingDeletes = [];
  };
  for (const op of list) {
    if (op.type === 'equal') {
      flush();
      rows.push({ type: 'equal', left: op, right: op });
    } else if (op.type === 'delete') {
      pendingDeletes.push(op);
    } else {
      if (pendingDeletes.length) {
        const left = pendingDeletes.shift();
        rows.push({ type: 'change', left, right: op });
      } else {
        rows.push({ type: 'insert', left: null, right: op });
      }
    }
  }
  flush();
  return rows;
}

/** 行号区间（渲染 gutter）：返回 "12" 或 "12–18"。 */
export function lineRangeLabel(start, count) {
  const first = Math.max(0, Math.floor(Number(start) || 0));
  const length = Math.max(0, Math.floor(Number(count) || 0));
  if (length === 0) return '';
  if (length === 1) return String(first + 1);
  return (first + 1) + '–' + (first + length);
}

/**
 * 结构化键对齐差异（记录/快照对比）。
 * @param {Array<object>} leftRows
 * @param {Array<object>} rightRows
 * @param {{keyOf:(row:any)=>string, valueOf?:(row:any)=>any, equal?:(a:any,b:any)=>boolean}} options
 * @returns {{added:Array, removed:Array, changed:Array, same:Array, matched:number, left:number, right:number}}
 */
export function keyedDiff(leftRows, rightRows, options = {}) {
  const left = Array.isArray(leftRows) ? leftRows : [];
  const right = Array.isArray(rightRows) ? rightRows : [];
  const opts = options && typeof options === 'object' ? options : {};
  // 注意：不能用 `typeof opts.valueOf === 'function'` 判断 —— 普通对象都继承
  // Object.prototype.valueOf，直接调用会抛 "Cannot convert undefined or null to object"。
  const own = (name) => Object.prototype.hasOwnProperty.call(opts, name);
  const keyOf = typeof opts.keyOf === 'function' ? opts.keyOf : (row) => String(row && (row.id ?? row.key ?? row.url));
  const valueOf = own('valueOf') && typeof opts.valueOf === 'function' ? opts.valueOf : (row) => row;
  const equal = own('equal') && typeof opts.equal === 'function'
    ? opts.equal
    : (a, b) => JSON.stringify(valueOf(a)) === JSON.stringify(valueOf(b));
  const leftMap = new Map();
  for (const row of left) {
    const key = String(keyOf(row));
    if (!leftMap.has(key)) leftMap.set(key, row);
  }
  const rightMap = new Map();
  for (const row of right) {
    const key = String(keyOf(row));
    if (!rightMap.has(key)) rightMap.set(key, row);
  }
  const added = [];
  const removed = [];
  const changed = [];
  const same = [];
  for (const [key, row] of rightMap) {
    if (!leftMap.has(key)) added.push({ key, row });
  }
  for (const [key, row] of leftMap) {
    if (!rightMap.has(key)) removed.push({ key, row });
    else {
      const other = rightMap.get(key);
      if (equal(row, other)) same.push({ key, left: row, right: other });
      else changed.push({ key, left: row, right: other });
    }
  }
  return {
    added,
    removed,
    changed,
    same,
    matched: changed.length + same.length,
    left: left.length,
    right: right.length,
  };
}

/**
 * 两步对比：请求按 "METHOD url" 对齐，控制台按 "level:text" 计数对齐。
 * 这是 debug 页「对比两次采集」的核心：请求是集合差异，控制台是多重集差异。
 */
export function compareCaptureRuns(left, right) {
  const leftRequests = Array.isArray(left && left.requests) ? left.requests : [];
  const rightRequests = Array.isArray(right && right.requests) ? right.requests : [];
  const requests = keyedDiff(leftRequests, rightRequests, {
    keyOf: (row) => (String(row.method || 'GET').toUpperCase() + ' ' + String(row.url || '')),
    valueOf: (row) => ({ status: row.status ?? null, durationMs: row.durationMs ?? null }),
  });
  const tally = (list) => {
    const map = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
      const key = String(entry.level || 'log') + ': ' + String(entry.text || '').slice(0, 500);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };
  const leftConsole = tally(left && left.console);
  const rightConsole = tally(right && right.console);
  const consoleAdded = [];
  const consoleRemoved = [];
  const consoleSame = [];
  for (const [key, count] of rightConsole) {
    const before = leftConsole.get(key) || 0;
    if (count > before) consoleAdded.push({ key, count: count - before });
    else if (count === before) consoleSame.push({ key, count });
  }
  for (const [key, count] of leftConsole) {
    const after = rightConsole.get(key) || 0;
    if (count > after) consoleRemoved.push({ key, count: count - after });
  }
  const requestOps = diffStats(diffSequences(
    leftRequests.map((row) => String(row.method || '') + ' ' + String(row.url || '')),
    rightRequests.map((row) => String(row.method || '') + ' ' + String(row.url || '')),
  ));
  const consoleOps = diffStats(diffSequences(
    [...leftConsole.entries()].map(([key, count]) => key + ' ×' + count),
    [...rightConsole.entries()].map(([key, count]) => key + ' ×' + count),
  ));
  return {
    requests,
    console: { added: consoleAdded, removed: consoleRemoved, same: consoleSame },
    requestStats: requestOps,
    consoleStats: consoleOps,
    summary: {
      added: requests.added.length + consoleAdded.reduce((total, item) => total + item.count, 0),
      removed: requests.removed.length + consoleRemoved.reduce((total, item) => total + item.count, 0),
      changed: requests.changed.length,
      identical: requests.added.length === 0
        && requests.removed.length === 0
        && requests.changed.length === 0
        && consoleAdded.length === 0
        && consoleRemoved.length === 0,
    },
  };
}

/**
 * 事件序列对比（ops 录制）：按事件摘要对齐，返回新增/移除/相同。
 * @param {Array<object>} leftEvents
 * @param {Array<object>} rightEvents
 */
export function compareEventSequences(leftEvents, rightEvents, options = {}) {
  const summarize = typeof options.summarize === 'function'
    ? options.summarize
    : (event) => {
      if (!event || typeof event !== 'object') return String(event);
      const type = event.type || event.kind || 'event';
      const target = event.selector || event.target || event.url || event.text || '';
      return String(type) + ' ' + String(target).slice(0, 120);
    };
  const left = (Array.isArray(leftEvents) ? leftEvents : []).map(summarize);
  const right = (Array.isArray(rightEvents) ? rightEvents : []).map(summarize);
  const ops = diffSequences(left, right);
  const stats = diffStats(ops);
  return {
    ops,
    stats,
    hunks: unifiedHunks(ops, { context: options.context === undefined ? 2 : options.context }),
    leftCount: left.length,
    rightCount: right.length,
    identical: stats.identical,
  };
}
