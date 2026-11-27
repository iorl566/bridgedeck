// src/lib/virtual-row-guard.js —— 虚拟列表行稳定性分类器（纯函数，不依赖 DOM）。
//
// 输入是一行/一格的“事实快照”：role、aria-rowindex、data-index、transform、
// 父容器 scrollTop，以及上一次观测的对应值。虚拟列表靠 transform 平移 + 行回收
// 呈现可视行，ref 很容易落到滚动后复用出来的另一行上；分类器给出可复现的拒绝
// 证据，动作层据此要求重新 observe，而不是把值写进错误的行。
const TRANSLATE_TOLERANCE_PX = 0.5;
const SCROLL_TOLERANCE_PX = 1;

const REASON_BY_CHECK = {
  role: 'unknown-row',
  index: 'index-mismatch',
  'index-shift': 'index-shifted',
  'row-key': 'row-recycled',
  transform: 'translated',
  'transform-shift': 'transform-shifted',
  'row-recycled': 'row-recycled',
  'container-recycled': 'container-recycled',
  scroll: 'scroll-shifted',
  attached: 'detached',
};

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function pickNumber(input, keys) {
  for (const key of keys) {
    const value = toNumber(input[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickString(input, keys) {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null) return String(input[key]);
  }
  return null;
}

function numbersIn(text) {
  return (String(text).match(/-?[0-9.]+(?:e[-+]?[0-9]+)?/gi) || []).map(Number);
}

/** 解析 transform 的平移量；matrix/matrix3d 与 translate/translate3d 都还原成像素。 */
export function parseRowTransform(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '' || raw.toLowerCase() === 'none') return { x: 0, y: 0, raw };
  // 只取括号内的数字，避免把 translate3d 里的 3 当成平移量。
  const inner = /\(([^)]*)\)/.exec(raw);
  const numbers = inner ? numbersIn(inner[1]) : [];
  if (/^matrix3d\(/i.test(raw)) {
    return { x: Number(numbers[12]) || 0, y: Number(numbers[13]) || 0, raw };
  }
  if (/^matrix\(/i.test(raw)) {
    return { x: Number(numbers[4]) || 0, y: Number(numbers[5]) || 0, raw };
  }
  if (/translatey\(/i.test(raw)) return { x: 0, y: Number(numbers[0]) || 0, raw };
  if (/translate3d\(/i.test(raw)) return { x: Number(numbers[0]) || 0, y: Number(numbers[1]) || 0, raw };
  if (/translate\(/i.test(raw)) return { x: Number(numbers[0]) || 0, y: Number(numbers[1]) || 0, raw };
  // rotate/scale 等不含平移：按 0 处理，稳定性交给其它检查。
  return { x: 0, y: 0, raw };
}

function classifyKind(role, tag, ariaRowIndex, dataIndex) {
  if (role === 'row' || tag === 'tr') return 'row';
  if (['gridcell', 'cell', 'columnheader', 'rowheader'].includes(role) || tag === 'td' || tag === 'th') return 'cell';
  if (ariaRowIndex !== null || dataIndex !== null) return 'row';
  return 'unknown';
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

/**
 * 分类一行/一格是否还能当作稳定锚点。
 * @param {object} facts 行事实：role/tag/ariaRowIndex/dataIndex/transform/scrollTop 及 previous* 快照。
 * @returns {{stable: boolean, reason: string, rowIndex: number|null, kind: string, checks: Array, evidence: object}}
 */
export function classifyVirtualRow(facts = {}) {
  const input = facts && typeof facts === 'object' ? facts : {};
  const role = String(input.role || '').toLowerCase();
  const tag = String(input.tag || input.tagName || '').toLowerCase();
  const ariaRowIndex = pickNumber(input, ['ariaRowIndex', 'aria-rowindex']);
  const dataIndex = pickNumber(input, ['dataIndex', 'data-index']);
  const previousRowIndex = pickNumber(input, ['previousRowIndex', 'previous-rowindex', 'previous-row-index']);
  const rowKey = pickString(input, ['rowKey', 'key']);
  const previousRowKey = pickString(input, ['previousRowKey', 'previousKey']);
  const transform = parseRowTransform(input.transform);
  const previousTransform = input.previousTransform === undefined || input.previousTransform === null
    ? null
    : parseRowTransform(input.previousTransform);
  const scrollTop = pickNumber(input, ['scrollTop', 'parentScrollTop', 'containerScrollTop', 'parent-scroll-top']);
  const previousScrollTop = pickNumber(input, ['previousScrollTop', 'previousParentScrollTop', 'previous-scroll-top']);
  const recycled = input.recycled === true || input.rowRecycled === true || input['row-recycled'] === true;
  const containerRecycled = input.containerRecycled === true || input['container-recycled'] === true;
  const detached = input.detached === true;

  const rowIndex = ariaRowIndex !== null ? ariaRowIndex : dataIndex;
  const kind = classifyKind(role, tag, ariaRowIndex, dataIndex);
  const checks = [];

  checks.push(check('role', kind !== 'unknown', { role: role || null, tag: tag || null, kind }));

  // aria-rowindex 与 data-index 是两条独立来源；回收/重排时经常只更新其中一条。
  const indexMismatch = ariaRowIndex !== null && dataIndex !== null && ariaRowIndex !== dataIndex;
  checks.push(check('index', !indexMismatch, { ariaRowIndex, dataIndex }));

  // 与上次观测相比行号变了：同一 DOM 位置被复用成了另一行。
  const indexShifted = previousRowIndex !== null && rowIndex !== null && previousRowIndex !== rowIndex;
  checks.push(check('index-shift', !indexShifted, { previousRowIndex, rowIndex }));

  const keyChanged = previousRowKey !== null && rowKey !== null && previousRowKey !== rowKey;
  checks.push(check('row-key', !keyChanged, { rowKey, previousRowKey }));

  // 虚拟列表用 transform 把行平移到可视区；非零平移 = 行位置不可信。
  const translated = Math.abs(transform.y) > TRANSLATE_TOLERANCE_PX || Math.abs(transform.x) > TRANSLATE_TOLERANCE_PX;
  checks.push(check('transform', !translated, { translateX: transform.x, translateY: transform.y, raw: transform.raw || null }));

  const transformShifted = previousTransform !== null
    && (Math.abs(previousTransform.y - transform.y) > TRANSLATE_TOLERANCE_PX
      || Math.abs(previousTransform.x - transform.x) > TRANSLATE_TOLERANCE_PX);
  checks.push(check('transform-shift', !transformShifted, {
    from: previousTransform ? { x: previousTransform.x, y: previousTransform.y } : null,
    to: { x: transform.x, y: transform.y },
  }));

  checks.push(check('row-recycled', !recycled, { recycled }));
  checks.push(check('container-recycled', !containerRecycled, { containerRecycled }));

  const scrollShifted = scrollTop !== null && previousScrollTop !== null && Math.abs(scrollTop - previousScrollTop) > SCROLL_TOLERANCE_PX;
  checks.push(check('scroll', !scrollShifted, {
    scrollTop,
    previousScrollTop,
    deltaPx: scrollTop !== null && previousScrollTop !== null ? scrollTop - previousScrollTop : null,
  }));

  checks.push(check('attached', !detached, { detached }));

  const failed = checks.find((item) => item.ok !== true) || null;
  return {
    stable: failed === null,
    reason: failed ? (REASON_BY_CHECK[failed.name] || failed.name) : 'stable',
    rowIndex,
    kind,
    checks,
    evidence: failed ? { check: failed.name, ...failed.detail } : {},
  };
}

// ---------------------------------------------------------------------------
// 行锚点契约（camelCase）：observe payload 的 node.anchor = {
//   ariaRowIndex, dataIndex, transform, rowKey, rowText, containerScrollTop,
//   recycled, role, tag
// }
// 动作层（fill/click）在派发前拿“当前 anchor”和期望 anchor 逐字段比对；
// 这里的函数全部是纯函数，扩展运行时与真实 DOM 夹具共用。
// ---------------------------------------------------------------------------

const TRANSFORM_TOLERANCE_PX = 0.5;

const ANCHOR_REASON_MESSAGE = {
  'row-recycled': '行已被回收复用（rowKey/回收标记变化）',
  'index-mismatch': '行号已变化（aria-rowindex/data-index 与 observe 时不一致）',
  'row-text-changed': '行内容已变化（rowText 与 observe 时不一致）',
  translated: '行已平移（transform 与 observe 时不一致）',
  'scroll-shifted': '行容器已滚动（containerScrollTop 与 observe 时不一致）',
  'container-recycled': '行容器已重建（container 标识变化）',
  'unknown-row': '行角色变化，无法确认还是同一行',
  'anchor-missing': '动作前读不到当前行事实（行已不在虚拟列表/元素已脱离文档）',
  'not-virtualized': 'observe 时是虚拟行，动作时已不是虚拟行（列表结构变化）',
  'target-not-found': '动作前找不到目标元素（可能已被回收）',
  'target-detached': '动作前目标已脱离文档',
};

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function digestText(value) {
  const text = normalizeText(value);
  // 只用于证据比对：长度 + 首尾采样哈希，不保存页面正文。
  let hash = 5381;
  const sample = text.slice(0, 24) + '|' + text.slice(-24);
  for (let index = 0; index < sample.length; index += 1) {
    hash = ((hash << 5) + hash + sample.charCodeAt(index)) >>> 0;
  }
  return { length: text.length, sampleHash: hash.toString(16).padStart(8, '0') };
}

/**
 * 把任意来源（observe payload / page-lib row-anchor / 旧 snake_case）的行锚点
 * 归一成契约字段；非法值一律 null，不抛异常。
 */
export function normalizeRowAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
  const ariaRowIndex = pickNumber(anchor, ['ariaRowIndex', 'aria_row_index', 'aria-rowindex']);
  const dataIndex = pickNumber(anchor, ['dataIndex', 'data_index', 'data-index']);
  const rowKey = pickString(anchor, ['rowKey', 'row_key', 'dataRowKey', 'data-row-key', 'key']);
  const rowText = pickString(anchor, ['rowText', 'row_text', 'text']);
  // transform 可能是原始 computed string，也可能是已经解析过的 { x, y, raw }：两者都要兼容。
  const rawTransform = anchor.transform;
  let transform;
  if (rawTransform && typeof rawTransform === 'object') {
    const parsedX = Number(rawTransform.x);
    const parsedY = Number(rawTransform.y);
    transform = {
      x: Number.isFinite(parsedX) ? parsedX : 0,
      y: Number.isFinite(parsedY) ? parsedY : 0,
      raw: typeof rawTransform.raw === 'string' ? rawTransform.raw : 'none',
    };
  } else {
    transform = parseRowTransform(rawTransform === undefined || rawTransform === null ? 'none' : String(rawTransform));
  }
  const containerScrollTop = pickNumber(anchor, ['containerScrollTop', 'container_scroll_top', 'scrollTop', 'scroll_top']);
  const recycled = anchor.recycled === true || anchor.rowRecycled === true;
  const role = pickString(anchor, ['role']);
  const tag = pickString(anchor, ['tag', 'tagName', 'tag_name']);
  const containerKey = pickString(anchor, ['containerKey', 'container_key']);
  return {
    ariaRowIndex,
    dataIndex,
    rowIndex: ariaRowIndex !== null ? ariaRowIndex : dataIndex,
    rowKey,
    rowText,
    text: rowText,
    transform,
    containerScrollTop,
    recycled,
    role,
    tag,
    containerKey,
  };
}

/** 行锚点证据摘要：给错误 data/日志用，不含页面正文。 */
export function rowAnchorDigest(anchor) {
  const facts = normalizeRowAnchor(anchor);
  if (!facts) return null;
  return {
    ariaRowIndex: facts.ariaRowIndex,
    dataIndex: facts.dataIndex,
    rowIndex: facts.rowIndex,
    rowKeyHash: facts.rowKey === null ? null : digestText(facts.rowKey).sampleHash,
    rowText: facts.rowText === null ? null : digestText(facts.rowText),
    transform: { x: facts.transform.x, y: facts.transform.y, raw: facts.transform.raw.slice(0, 60) },
    containerScrollTop: facts.containerScrollTop,
    recycled: facts.recycled,
    role: facts.role,
    tag: facts.tag,
    containerKey: facts.containerKey,
  };
}

/**
 * 动作前“当前行事实”的页面侧探针表达式（IIFE 字符串，供 MAIN world eval 使用）。
 * 规则与 page-lib 的 row-anchor 命令一致：只有带虚拟化线索的行才产出 anchor，
 * 普通静态表格返回 anchor:null，避免误伤。
 */
export function buildRowAnchorProbeExpression(options = {}) {
  const selector = String(options.selector || '');
  const maxText = Math.min(500, Math.max(1, Number(options.maxText) || 200));
  if (!selector) throw new Error('buildRowAnchorProbeExpression 需要 selector');
  return `(function () {
  var selector = ${JSON.stringify(selector)};
  var maxText = ${maxText};
  function normalizeText(value) { return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim(); }
  function num(value) { if (value === null || value === undefined || value === '') return null; var parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  function attr(node, name) { return node && node.getAttribute ? node.getAttribute(name) : null; }
  function firstScrollable(node) {
    var current = node && node.parentElement;
    var depth = 0;
    while (current && depth < 12) {
      try {
        var style = getComputedStyle(current);
        if (/(auto|scroll)/.test(String(style.overflowY || '')) && current.scrollHeight > current.clientHeight + 1) return current;
      } catch (error) { /* 忽略 */ }
      current = current.parentElement;
      depth += 1;
    }
    return null;
  }
  function hasVirtualClue(row, container) {
    var current = row;
    var depth = 0;
    while (current && depth < 5) {
      if (attr(current, 'aria-rowindex') !== null) return true;
      if (attr(current, 'data-index') !== null || attr(current, 'data-row-index') !== null) return true;
      if (attr(current, 'data-row-key') !== null || attr(current, 'data-key') !== null || attr(current, 'data-id') !== null) return true;
      current = current.parentElement; depth += 1;
    }
    try { if (getComputedStyle(row).transform && getComputedStyle(row).transform !== 'none') return true; } catch (error) { /* 忽略 */ }
    if (container) {
      var role = String(attr(container, 'role') || '').toLowerCase();
      if (['grid', 'treegrid', 'listbox', 'table'].indexOf(role) >= 0) return true;
      if (attr(container, 'aria-rowcount') !== null) return true;
    }
    return false;
  }
  var el;
  try { el = document.querySelector(selector); } catch (error) { return { ok: false, cause: 'bad-selector', anchor: null }; }
  if (!el) return { ok: false, cause: 'target-not-found', anchor: null };
  if (el.isConnected !== true) return { ok: false, cause: 'target-detached', anchor: null };
  var row = el.closest ? el.closest('tr,[role="row"],[aria-rowindex],[data-index],[data-row-key]') : null;
  if (!row) return { ok: true, cause: 'no-row', anchor: null };
  var container = firstScrollable(row);
  if (!hasVirtualClue(row, container)) return { ok: true, cause: 'not-virtualized', anchor: null };
  var ariaRowIndex = null;
  var dataIndex = null;
  var rowKey = null;
  var current = row;
  var depth = 0;
  while (current && depth < 5) {
    if (ariaRowIndex === null) ariaRowIndex = num(attr(current, 'aria-rowindex'));
    if (dataIndex === null) dataIndex = num(attr(current, 'data-index')) !== null ? num(attr(current, 'data-index')) : num(attr(current, 'data-row-index'));
    if (rowKey === null) rowKey = attr(current, 'data-row-key') || attr(current, 'data-key') || attr(current, 'data-id') || current.id || null;
    current = current.parentElement; depth += 1;
  }
  var transform = 'none';
  try { transform = String(getComputedStyle(row).transform || 'none'); } catch (error) { /* 忽略 */ }
  var role = attr(row, 'role') || (row.tagName === 'TR' ? 'row' : '');
  return {
    ok: true,
    cause: 'row',
    anchor: {
      ariaRowIndex: ariaRowIndex,
      dataIndex: dataIndex,
      transform: transform,
      rowKey: rowKey === null || rowKey === '' ? null : String(rowKey),
      rowText: normalizeText(row.textContent || '').slice(0, maxText),
      containerScrollTop: container ? Math.round(container.scrollTop * 100) / 100 : null,
      containerKey: container ? (container.id || attr(container, 'data-testid') || attr(container, 'class') || null) : null,
      recycled: false,
      role: String(role).toLowerCase(),
      tag: String(row.tagName || '').toLowerCase()
    }
  };
})()`;
}

/** 解析 MAIN world 探针的返回值（两种形状：{ok,anchor,cause} 或裸 anchor）。 */
export function parseRowAnchorProbe(raw) {
  if (raw && typeof raw === 'object' && raw.ok === false) {
    return { ok: false, cause: String(raw.cause || 'probe-failed'), anchor: null };
  }
  const payload = raw && typeof raw === 'object' && raw.anchor !== undefined ? raw.anchor : raw;
  if (payload == null) {
    return { ok: true, cause: String((raw && raw.cause) || 'no-anchor'), anchor: null };
  }
  return { ok: true, cause: 'anchor', anchor: normalizeRowAnchor(payload) };
}

function checkItem(name, ok, detail) {
  return { name, ok, ...detail };
}

/**
 * 期望 anchor（observe 时）与当前 anchor（动作前）的逐字段比对。
 * 返回结构：
 *   稳定：{ ok:true, stable:true, guard:'virtual-row', reason:'stable', checks, rowIndex, kind, evidence }
 *   不稳定：{ ok:false, stable:false, code:'E_TARGET_MISMATCH', guard:'virtual-row', reason, message, evidence, checks }
 */
export function compareRowAnchor(expectedAnchor, currentAnchor, options = {}) {
  const expected = normalizeRowAnchor(expectedAnchor);
  if (!expected) {
    return { ok: true, stable: null, guard: 'virtual-row', reason: 'no-expected-anchor', skipped: true, checks: [], evidence: { guard: 'virtual-row', skip: 'no-expected-anchor' } };
  }
  const scrollTolerance = Number.isFinite(options.scrollTolerancePx) ? options.scrollTolerancePx : SCROLL_TOLERANCE_PX;
  const transformTolerance = Number.isFinite(options.transformTolerancePx) ? options.transformTolerancePx : TRANSFORM_TOLERANCE_PX;
  const hasIdentity = expected.rowIndex !== null || expected.rowKey !== null || expected.rowText !== null;
  if (!hasIdentity) {
    return {
      ok: true,
      stable: null,
      guard: 'virtual-row',
      reason: 'no-anchor-identity',
      skipped: true,
      checks: [],
      evidence: { guard: 'virtual-row', skip: 'no-anchor-identity', expected: rowAnchorDigest(expected) },
    };
  }
  const current = normalizeRowAnchor(currentAnchor);
  const checks = [];
  const failed = () => checks.find((item) => item.ok !== true) || null;

  const expectIndex = expected.rowIndex;
  const currentIndex = current ? current.rowIndex : null;
  if (expected.recycled) {
    checks.push(checkItem('recycled', false, { expected: true }));
  } else {
    checks.push(checkItem('recycled', true, { expected: false }));
  }
  if (!current) {
    const cause = String(options.cause || 'anchor-missing');
    checks.push(checkItem('current-anchor', false, { cause }));
  } else {
    checks.push(checkItem('current-anchor', true, { cause: options.cause || 'anchor' }));
    // 当前行事实自己带“已回收”标记：页面/页面库已经证明这一行被复用过。
    checks.push(checkItem('current-recycled', current.recycled !== true, { recycled: current.recycled }));
    checks.push(checkItem('row-index', !(expectIndex !== null && currentIndex !== null && expectIndex !== currentIndex), {
      expected: expectIndex,
      current: currentIndex,
    }));
    checks.push(checkItem('aria-rowindex',
      !(expected.ariaRowIndex !== null && current.ariaRowIndex !== null && expected.ariaRowIndex !== current.ariaRowIndex),
      { expected: expected.ariaRowIndex, current: current.ariaRowIndex }));
    checks.push(checkItem('data-index',
      !(expected.dataIndex !== null && current.dataIndex !== null && expected.dataIndex !== current.dataIndex),
      { expected: expected.dataIndex, current: current.dataIndex }));
    checks.push(checkItem('row-key',
      !(expected.rowKey !== null && current.rowKey !== null && expected.rowKey !== current.rowKey),
      { expectedRowKeyHash: digestText(expected.rowKey).sampleHash, currentRowKeyHash: digestText(current.rowKey).sampleHash, expected: expected.rowKey, current: current.rowKey }));
    const expectedText = expected.rowText === null ? null : normalizeText(expected.rowText);
    const currentText = current.rowText === null ? null : normalizeText(current.rowText);
    checks.push(checkItem('row-text',
      !(expectedText !== null && currentText !== null && expectedText !== currentText),
      { expected: expectedText === null ? null : digestText(expectedText), current: currentText === null ? null : digestText(currentText) }));
    const dx = Math.abs(expected.transform.x - current.transform.x);
    const dy = Math.abs(expected.transform.y - current.transform.y);
    checks.push(checkItem('transform', !(dx > transformTolerance || dy > transformTolerance), {
      expected: { x: expected.transform.x, y: expected.transform.y, raw: expected.transform.raw.slice(0, 60) },
      current: { x: current.transform.x, y: current.transform.y, raw: current.transform.raw.slice(0, 60) },
      delta: { x: roundPx(dx), y: roundPx(dy) },
    }));
    const scrollKnown = expected.containerScrollTop !== null && current.containerScrollTop !== null;
    checks.push(checkItem('container-scroll', !(scrollKnown && Math.abs(expected.containerScrollTop - current.containerScrollTop) > scrollTolerance), {
      expected: expected.containerScrollTop,
      current: current.containerScrollTop,
      deltaPx: scrollKnown ? roundPx(current.containerScrollTop - expected.containerScrollTop) : null,
    }));
    const containerComparable = Boolean(expected.containerKey && current.containerKey);
    checks.push(checkItem('container', !(containerComparable && expected.containerKey !== current.containerKey), {
      expected: expected.containerKey || null,
      current: current.containerKey || null,
    }));
    const roleComparable = Boolean(expected.role && current.role);
    checks.push(checkItem('role', !(roleComparable && expected.role !== current.role), {
      expected: expected.role || null,
      current: current.role || null,
    }));
  }

  const failure = failed();
  const rowIndex = currentIndex !== null ? currentIndex : expectIndex;
  const kind = classifyKind(current ? current.role : expected.role, current ? current.tag : expected.tag, rowIndex, null);
  if (!failure) {
    return {
      ok: true,
      stable: true,
      guard: 'virtual-row',
      reason: 'stable',
      rowIndex,
      kind,
      checks,
      evidence: {
        guard: 'virtual-row',
        check: 'all',
        expected: rowAnchorDigest(expected),
        current: rowAnchorDigest(current),
      },
    };
  }
  const reason = failure.name === 'current-anchor'
    ? anchorMissingReason(String(failure.cause || 'anchor-missing'))
    : ANCHOR_REASON_BY_CHECK[failure.name] || failure.name;
  const message = '目标所在行不稳定（' + reason + '）：' + (ANCHOR_REASON_MESSAGE[reason] || failure.name) + '，请重新 observe 后再操作';
  return {
    ok: false,
    stable: false,
    code: 'E_TARGET_MISMATCH',
    guard: 'virtual-row',
    reason,
    message,
    rowIndex,
    kind,
    checks,
    evidence: {
      guard: 'virtual-row',
      reason,
      check: failure.name,
      ...failure,
      expected: rowAnchorDigest(expected),
      current: current ? rowAnchorDigest(current) : null,
    },
  };
}

function roundPx(value) {
  return Math.round(value * 100) / 100;
}

const ANCHOR_REASON_BY_CHECK = {
  'recycled': 'row-recycled',
  'current-anchor': 'anchor-missing',
  'current-recycled': 'row-recycled',
  'row-index': 'index-mismatch',
  'aria-rowindex': 'index-mismatch',
  'data-index': 'index-mismatch',
  'row-key': 'row-recycled',
  'row-text': 'row-text-changed',
  'transform': 'translated',
  'container-scroll': 'scroll-shifted',
  'container': 'container-recycled',
  'role': 'unknown-row',
};

function anchorMissingReason(cause) {
  if (cause === 'target-not-found') return 'target-not-found';
  if (cause === 'target-detached') return 'target-detached';
  if (cause === 'not-virtualized') return 'not-virtualized';
  return 'anchor-missing';
}

/**
 * 调用方是否直接给了“分类器风格”的 legacy 行事实（previous 系列/detached/containerRecycled）。
 * 这类事实不需要读页面，可以先用 checkRowAnchor 纯函数判定。
 */
export function hasLegacyRowFacts(anchor) {
  if (!anchor || typeof anchor !== 'object') return false;
  const keys = [
    'previousRowIndex', 'previousRowKey', 'previousTransform', 'previousScrollTop',
    'detached', 'containerRecycled', 'rowRecycled',
  ];
  return keys.some((key) => anchor[key] !== undefined);
}

/**
 * 把期望 anchor 映射成 classifyVirtualRow 的 previous* 字段：
 * 调用方同时拿到当前行事实时，可以用旧分类器做一次交叉验证。
 */
export function rowAnchorAsPrevious(anchor) {
  const facts = normalizeRowAnchor(anchor);
  if (!facts) return {};
  return {
    ...(facts.rowIndex !== null ? { previousRowIndex: facts.rowIndex } : {}),
    ...(facts.rowKey !== null ? { previousRowKey: facts.rowKey } : {}),
    ...(facts.transform.raw !== 'none' ? { previousTransform: facts.transform.raw } : {}),
    ...(facts.containerScrollTop !== null ? { previousScrollTop: facts.containerScrollTop } : {}),
  };
}

/**
 * 动作层用的行锚点检查：稳定返回 { ok:true, classification }；
 * 不稳定返回带错误码与拒绝证据的 { ok:false }，调用方直接转协议错误。
 */
export function checkRowAnchor(facts = {}) {
  const classification = classifyVirtualRow(facts);
  if (classification.stable) return { ok: true, classification };
  return {
    ok: false,
    code: 'E_TARGET_MISMATCH',
    message: '目标所在行不稳定（' + classification.reason + '）：虚拟列表可能已回收/平移该行，请重新 observe',
    classification,
    evidence: classification.evidence,
  };
}
