// tools/longtail/lib/prng.mjs —— 确定性随机数 / 稳定哈希 / 指纹（长尾规模生成器共用）。
//
// 为什么不用 Math.random / Date.now：
//   长尾预算门禁的**夹具内容**必须可复现。同一个 seed 在任意进程、任意机器上都要生成
//   同一份页面图 / HAR / record program / 视频 manifest，否则 "≥1000 refs / ≥5MB / ≥200 步"
//   这类规模断言就退化成"这次刚好够"，而 `--check` 也无法用指纹发现夹具漂移。
//
// 本模块只做四件事：
//   1. mulberry32 PRNG（32 位状态，纯整数运算，跨平台一致）；
//   2. fnv1a/mix 稳定哈希 + 16 进制指纹（用于 seed 派生、夹具/产物指纹）；
//   3. stableStringify（对象键排序的 JSON，用于把结构变成可比较的规范文本）；
//   4. sha256Hex（视频 manifest seal 的真实摘要；Node crypto，不落仓库）。
//
// 约定：所有导出的随机函数都是**纯确定性的**——相同 seed + 相同调用序列 → 相同结果。
// 不要在生成器里插入条件性随机调用（例如"仅当某环境变量存在时多抽一次"），否则序列会漂移。

import { createHash } from 'node:crypto';

export const LONGTAIL_PRNG_VERSION = 1;

/** 默认 seed：固定常量，保证不带 --seed 时也完全确定。 */
export const DEFAULT_SEED = 0x5eed1e55;

export const UINT32_MAX = 0xffffffff;

// ---------------------------------------------------------------------------
// 32 位整数工具
// ---------------------------------------------------------------------------

/** 把任意值归一成 32 位无符号整数（数字取低 32 位，字符串先哈希）。 */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
  if (typeof seed === 'bigint') return Number(seed & 0xffffffffn) >>> 0;
  if (typeof seed === 'string' && seed !== '') return hash32(seed);
  return DEFAULT_SEED;
}

/** 32 位雪崩混合（splitmix32 finalizer）：把相邻 seed 打散成互不相关的状态。 */
export function mix32(value) {
  let x = (Number(value) || 0) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** FNV-1a 32 位哈希（文本 → uint32，跨进程稳定，不依赖 V8 字符串内部实现）。 */
export function hash32(text) {
  const source = String(text == null ? '' : text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 组合多个值成一个 uint32：位置参与哈希，避免 (a,b) 与 (b,a) 撞车。 */
export function hash32Join(...parts) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    hash = mix32(hash ^ hash32(typeof part === 'string' ? part : stableStringify(part)));
  }
  return hash >>> 0;
}

/** 64 位风格指纹（两个独立 32 位哈希拼 16 位十六进制）：给夹具/产物做稳定 ID。 */
export function fingerprintOf(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const left = hash32('lt:left:' + text);
  const right = mix32(hash32('lt:right:' + text) ^ left);
  return left.toString(16).padStart(8, '0') + right.toString(16).padStart(8, '0');
}

/** seed 派生：rootSeed + 用途标签/序号 → 子 seed（各生成器互不干扰）。 */
export function deriveSeed(rootSeed, ...labels) {
  const base = normalizeSeed(rootSeed);
  let seed = mix32(base ^ 0x9e3779b9);
  for (const label of labels) {
    seed = mix32(seed ^ hash32(typeof label === 'string' ? label : stableStringify(label)));
  }
  return seed >>> 0;
}

// ---------------------------------------------------------------------------
// 稳定文本化
// ---------------------------------------------------------------------------

/** JSON 规范化的递归副本：键排序、NaN/Infinity → null、undefined 属性丢弃。 */
function canonicalize(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string' || type === 'boolean') return value;
  if (type !== 'object') return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item === undefined ? null : item));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item === 'function') continue;
    out[key] = canonicalize(item);
  }
  return out;
}

/** 键排序后的 JSON 文本（同结构 → 同文本，跨进程稳定）。 */
export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/** 结构指纹（stableStringify 后哈希，16 位十六进制）。 */
export function stableHash(value) {
  return fingerprintOf(value);
}

// ---------------------------------------------------------------------------
// 确定性 PRNG
// ---------------------------------------------------------------------------

/**
 * 创建确定性随机源。
 * @param {string|number} [seed]
 * @returns {{
 *   seed:number, version:number,
 *   draws:()=>number,
 *   nextU32:()=>number, nextFloat:()=>number,
 *   int:(min:number,max:number)=>number, index:(length:number)=>number,
 *   chance:(p:number)=>boolean, bool:()=>boolean,
 *   pick:(list:Array)=>any, pickWeighted:(list:Array,weightOf:Function)=>any,
 *   shuffle:(list:Array)=>Array, sample:(list:Array,count:number)=>Array,
 *   uuid:()=>string, hex:(length:number)=>string,
 *   fork:(label:string)=>object
 * }}
 */
export function createRng(seed = DEFAULT_SEED) {
  let state = mix32(normalizeSeed(seed));
  const initial = state;
  let drawCount = 0;

  function nextU32() {
    drawCount += 1;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  function nextFloat() {
    // 2^32 分母，落在 [0, 1)（不会产出 1，避免越界）。
    return nextU32() / 4294967296;
  }

  function int(min, max) {
    const low = Math.ceil(Number(min));
    const high = Math.floor(Number(max));
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return low;
    const span = high - low + 1;
    if (span <= 1) return low;
    return low + Math.floor(nextFloat() * span);
  }

  function index(length) {
    const size = Math.floor(Number(length));
    if (!Number.isFinite(size) || size <= 0) return -1;
    return int(0, size - 1);
  }

  function chance(probability = 0.5) {
    const p = Math.min(1, Math.max(0, Number(probability)));
    return nextFloat() < p;
  }

  function bool() {
    return nextU32() % 2 === 0;
  }

  function pick(list) {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    return list[index(list.length)];
  }

  /** 按权重取一个元素；权重非正的项被跳过；全 0 时退化为均匀取。 */
  function pickWeighted(list, weightOf) {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const weights = list.map((item, position) => {
      const weight = typeof weightOf === 'function' ? Number(weightOf(item, position)) : (item && Number(item.weight)) || 0;
      return Number.isFinite(weight) && weight > 0 ? weight : 0;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return pick(list);
    let threshold = nextFloat() * total;
    for (let position = 0; position < list.length; position += 1) {
      threshold -= weights[position];
      if (threshold < 0) return list[position];
    }
    return list[list.length - 1];
  }

  /** Fisher-Yates 洗牌（返回新数组，不改入参）。 */
  function shuffle(list) {
    const copy = Array.isArray(list) ? list.slice() : [];
    for (let position = copy.length - 1; position > 0; position -= 1) {
      const swap = int(0, position);
      const current = copy[position];
      copy[position] = copy[swap];
      copy[swap] = current;
    }
    return copy;
  }

  /** 不重复抽样（count > list.length 时只返回全部，顺序仍确定）。 */
  function sample(list, count) {
    const size = Math.max(0, Math.floor(Number(count) || 0));
    return shuffle(list).slice(0, Math.min(size, Array.isArray(list) ? list.length : 0));
  }

  function hex(length = 8) {
    const target = Math.max(0, Math.floor(Number(length) || 0));
    let out = '';
    while (out.length < target) out += nextU32().toString(16).padStart(8, '0');
    return out.slice(0, target);
  }

  function uuid() {
    const a = nextU32().toString(16).padStart(8, '0');
    const b = nextU32().toString(16).padStart(8, '0');
    const c = nextU32().toString(16).padStart(8, '0');
    const d = nextU32().toString(16).padStart(8, '0');
    return a + '-' + b.slice(0, 4) + '-' + b.slice(4) + '-' + c.slice(0, 4) + '-' + c.slice(4) + d;
  }

  /** 分叉：子生成器与父序列解耦，但同一个 (seed, label, drawCount) 仍完全可复现。 */
  function fork(label) {
    return createRng(mix32(initial ^ hash32Join('fork', label, drawCount)));
  }

  return {
    seed: initial,
    version: LONGTAIL_PRNG_VERSION,
    draws: () => drawCount,
    nextU32,
    nextFloat,
    int,
    index,
    chance,
    bool,
    pick,
    pickWeighted,
    shuffle,
    sample,
    hex,
    uuid,
    fork,
  };
}

/** 便捷函数：给定 seed 与用途标签直接创建一个 RNG。 */
export function rngFor(seed, ...labels) {
  return createRng(deriveSeed(seed, ...labels));
}

// ---------------------------------------------------------------------------
// 文本/字节工具
// ---------------------------------------------------------------------------

/** UTF-8 字节数（不复制大字符串）。 */
export function utf8Bytes(text) {
  return Buffer.byteLength(String(text == null ? '' : text), 'utf8');
}

/**
 * 生成确定性的中英文混合填充文本，用于把夹具撑到目标体积。
 * 文本内容只依赖 (rng, length)，不含时间戳/进程信息。
 */
export function fillerText(rng, length, alphabetSeed = '') {
  const target = Math.max(0, Math.floor(Number(length) || 0));
  const chunks = [];
  const words = ['观测', '元素', '请求', '分片', '回放', '预算', 'node', 'edge', 'har', 'frame', 'segment', 'replay'];
  let written = 0;
  const pad = alphabetSeed ? hash32(alphabetSeed).toString(36) : '';
  while (written < target) {
    const word = words[rng.int(0, words.length - 1)];
    const separator = rng.chance(0.25) ? '\n' : (rng.chance(0.5) ? ' ' : '');
    const token = (pad ? pad.slice(0, rng.int(0, pad.length)) : '') + word + separator;
    chunks.push(token);
    written += token.length;
  }
  return chunks.join('').slice(0, target);
}

/** 读取十六进制摘要工具：只接受 64 位小写 hex（sha256）。 */
export function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// 真实摘要（视频 manifest seal / 夹具完整性证据）
// ---------------------------------------------------------------------------

/** SHA-256（hex）。视频 manifest 的 sealManifest 直接用它当 digest 实现。 */
export async function sha256Hex(input) {
  const hash = createHash('sha256');
  if (input instanceof Uint8Array) hash.update(input);
  else hash.update(String(input == null ? '' : input), 'utf8');
  return hash.digest('hex');
}

/** 同步 SHA-256（测试/小文本用；大文件仍建议异步版本）。 */
export function sha256HexSync(input) {
  const hash = createHash('sha256');
  if (input instanceof Uint8Array) hash.update(input);
  else hash.update(String(input == null ? '' : input), 'utf8');
  return hash.digest('hex');
}

/** JSON 内容的 sha256（夹具完整性指纹）。 */
export async function jsonSha256(value) {
  return sha256Hex(stableStringify(value));
}
