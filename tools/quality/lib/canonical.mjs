// tools/quality/lib/canonical.mjs —— 质量门禁的规范化与指纹原语（零依赖）。
//
// 门禁的第一性问题是"两次值得比较吗"：只要输入相同，规划/采样/解释层的输出就必须
// 逐字节一致。JSON.stringify 不是规范化函数（键顺序、NaN、-0、undefined 都会带来
// 伪差异），所以这里先定义**规范化 JSON**，再在其上做指纹。
//
// 约束：
// * 纯函数：不读时钟、不读环境、不写盘；门禁自身的确定性由本文件保证。
// * 指纹算法固定（sha256 截断 16 hex），跨进程/跨机器一致；不做"看起来随机"的哈希。
// * 规范化只做语义等价归一，不做业务字段裁剪；字段裁剪属于 stripVolatile 的显式调用。

import crypto from 'node:crypto';

export const CANONICAL_VERSION = 1;

/** 规范化用的特殊类型标记：确保这些值不会与用户数据里的普通对象混淆。 */
const MARKER = '$bq';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function scalarText(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      if (Number.isNaN(value)) return JSON.stringify({ [MARKER]: 'NaN' });
      if (value === Infinity) return JSON.stringify({ [MARKER]: 'Infinity' });
      if (value === -Infinity) return JSON.stringify({ [MARKER]: '-Infinity' });
      if (Object.is(value, -0)) return '0';
      return JSON.stringify(value);
    }
    case 'bigint':
      return JSON.stringify({ [MARKER]: 'bigint', value: value.toString() });
    case 'undefined':
      return JSON.stringify({ [MARKER]: 'undefined' });
    default:
      return JSON.stringify(String(value));
  }
}

/**
 * 规范化 JSON 文本：对象键排序、特殊值加标记、数组保持顺序。
 * 同一个语义值在任意键插入顺序下得到逐字节相同的文本。
 */
export function canonicalJson(value, options = {}) {
  const sortKeys = options.sortKeys !== false;
  const dropUndefined = options.dropUndefined !== false;
  const seen = new Set();

  const walk = (current, path) => {
    if (current === null || typeof current !== 'object') return scalarText(current);
    if (current instanceof Date) return JSON.stringify({ [MARKER]: 'date', value: current.toISOString() });
    if (typeof current.toJSON === 'function' && !Array.isArray(current) && !isPlainObject(current)) {
      return walk(current.toJSON(), path);
    }
    if (seen.has(current)) {
      // 循环引用不是合法输入：显式标注而不是抛错，便于门禁把问题作为 finding 报告。
      return JSON.stringify({ [MARKER]: 'circular', path });
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const parts = current.map((item, index) => walk(item, path + '[' + index + ']'));
        return '[' + parts.join(',') + ']';
      }
      if (!isPlainObject(current)) {
        return JSON.stringify({ [MARKER]: 'object', value: String(current) });
      }
      const keys = Object.keys(current);
      if (sortKeys) keys.sort();
      const parts = [];
      for (const key of keys) {
        const item = current[key];
        if (item === undefined) {
          if (dropUndefined) continue;
          parts.push(JSON.stringify(key) + ':' + scalarText(undefined));
          continue;
        }
        parts.push(JSON.stringify(key) + ':' + walk(item, path + '.' + key));
      }
      return '{' + parts.join(',') + '}';
    } finally {
      seen.delete(current);
    }
  };

  return walk(value, '$');
}

/** 稳定摘要：sha256 前 16 个 hex 字符（64 bit），足够门禁比对且便于报告阅读。 */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function digest16(text) {
  return sha256Hex(text).slice(0, 16);
}

/** 目标指纹：规范化 JSON 的摘要；同一输入永远同一指纹。 */
export function fingerprint(value, options = {}) {
  return digest16(canonicalJson(value, options));
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text == null ? '' : text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export { fnv1a };

/** 集合指纹：与元素顺序无关（多重集语义，重复元素仍然计数）。 */
export function multisetFingerprint(items, keyOf = (item) => canonicalJson(item)) {
  const keys = (Array.isArray(items) ? items : []).map((item) => String(keyOf(item))).sort();
  return fingerprint(keys);
}

/** 按给定字段稳定排序（不用 localeCompare：不同 ICU 版本结果可能不同）。 */
export function stableSortBy(list, keyOf) {
  const items = Array.isArray(list) ? list.slice() : [];
  const keyed = items.map((item, index) => ({ item, index, key: String(keyOf(item)) }));
  keyed.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return left.index - right.index;
  });
  return keyed.map((entry) => entry.item);
}

/** 轮换对象键顺序（测试"键顺序不应影响指纹"的构造工具）。 */
export function rotateKeys(object, offset = 1) {
  if (!isPlainObject(object)) return object;
  const keys = Object.keys(object);
  if (keys.length < 2) return object;
  const shift = ((Number(offset) || 0) % keys.length + keys.length) % keys.length;
  const rotated = keys.slice(shift).concat(keys.slice(0, shift));
  const out = {};
  for (const key of rotated) out[key] = object[key];
  return out;
}

export const VOLATILE_KEYS = Object.freeze([
  'at', 'savedAt', 'createdAt', 'approvedAt', 'startedAt', 'finishedAt', 'resolvedAt',
  'recoveredAt', 'staleAt', 'durationMs', 'totalMs', 'elapsedMs', 'tookMs', 'timestamp',
  'time', 'now', 'pid', 'hostname', 'tmpDir', 'file', 'dir', 'lockFile', 'lastSyncAt',
  'snapshotAt', 'head', 'digestMs', 'ms',
]);

function isVolatileKey(key, extra) {
  const text = String(key);
  if (VOLATILE_KEYS.includes(text)) return true;
  for (const pattern of extra) {
    if (pattern instanceof RegExp ? pattern.test(text) : text === String(pattern)) return true;
  }
  return false;
}

/**
 * 语义摘要：递归删除易变字段（时间/进程/绝对路径），用于"重复写同一份内容"的比对。
 * 只用于显式声明的写路径检查；不用于证明严格字节相等。
 */
export function stripVolatile(value, options = {}) {
  const extra = Array.isArray(options.extra) ? options.extra : [];
  const walk = (current) => {
    if (Array.isArray(current)) return current.map(walk);
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Date) return current.toISOString();
    const out = {};
    for (const key of Object.keys(current)) {
      if (isVolatileKey(key, extra)) continue;
      out[key] = walk(current[key]);
    }
    return out;
  };
  return walk(value);
}

/** 语义指纹：先裁剪易变字段再做规范化摘要。 */
export function semanticFingerprint(value, options = {}) {
  return fingerprint(stripVolatile(value, options));
}

/** 深相等（用于门禁断言，错误信息带路径）。 */
export function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      if (leftKeys[index] !== rightKeys[index]) return false;
      if (!deepEqual(left[leftKeys[index]], right[rightKeys[index]])) return false;
    }
    return true;
  }
  return false;
}

/** 找出两个结构的第一处差异（路径 + 左右值），没有差异返回 null。 */
export function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return { path, left: left.length, right: right.length, kind: 'length' };
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(left[index], right[index], path + '[' + index + ']');
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      const found = firstDifference(left[key], right[key], path + '.' + key);
      if (found) return found;
    }
    return null;
  }
  return { path, left, right, kind: 'value' };
}

/** 深冻结（测试/门禁防止下游模块修改输入证据）。 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
