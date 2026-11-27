// tools/quality/lib/prng.mjs —— 门禁夹具的确定性随机源。
//
// 夹具不能用 Math.random()/Date.now()：否则"重复 N 次指纹一致"就变成测运气。
// 这里实现固定算法（mulberry32 + xorshift32 洗牌）并给出一组 golden 向量；
// 跨进程稳定靠"算法固定 + seed 固定"，不依赖 V8 版本。

import { fnv1a } from './canonical.mjs';

/** 把任意 label/数字混成 32 位无符号 seed。 */
export function hashSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 数字 seed 也走字符串哈希，避免大整数精度差异。
    return Number.parseInt(fnv1a('seed:' + Math.floor(value)), 16) >>> 0;
  }
  return Number.parseInt(fnv1a('seed:' + String(value == null ? '' : value)), 16) >>> 0;
}

/** 由基础 seed + 逻辑标签派生子 seed：同一对输入永远同一 seed。 */
export function deriveSeed(base, label) {
  return hashSeed(hashSeed(base) + '|' + String(label));
}

/** mulberry32：32 位状态、单轮 mix，跨实现稳定。 */
export function mulberry32(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 无符号 32 位序列（用于生成稳定 id/字节流）。 */
export function xorshift32(seed) {
  let state = (seed >>> 0) || 0x1234567;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/**
 * 门禁用 RNG 句柄：同一 seed 得到同一序列。
 * 方法全部只依赖内部状态；不读时钟、不读环境变量。
 */
export function createRng(seed) {
  const nextFloat = mulberry32(hashSeed(seed));
  const nextUint = xorshift32(deriveSeed(seed, 'uint'));
  let draws = 0;
  const api = {
    seed: hashSeed(seed),
    get draws() {
      return draws;
    },
    next() {
      draws += 1;
      return nextFloat();
    },
    uint() {
      draws += 1;
      return nextUint();
    },
    int(min, max) {
      const low = Math.ceil(Number(min));
      const high = Math.floor(Number(max));
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return low;
      return low + Math.floor(api.next() * (high - low + 1));
    },
    bool(probability = 0.5) {
      return api.next() < Number(probability);
    },
    pick(list) {
      const items = Array.isArray(list) ? list : [];
      if (!items.length) return undefined;
      return items[api.int(0, items.length - 1)];
    },
    shuffle(list) {
      const items = Array.isArray(list) ? list.slice() : [];
      for (let index = items.length - 1; index > 0; index -= 1) {
        const target = api.int(0, index);
        const swap = items[index];
        items[index] = items[target];
        items[target] = swap;
      }
      return items;
    },
    hex(length = 8) {
      const size = Math.max(1, Math.floor(Number(length)));
      let text = '';
      while (text.length < size) {
        text += api.uint().toString(16).padStart(8, '0');
      }
      return text.slice(0, size);
    },
    string(length = 8, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
      const size = Math.max(1, Math.floor(Number(length)));
      let text = '';
      for (let index = 0; index < size; index += 1) text += api.pick(alphabet.split(''));
      return text;
    },
  };
  return api;
}

/** 生成确定性的 uint32 序列（测试 golden 向量用）。 */
export function uintSequence(seed, count) {
  const rng = createRng(seed);
  const out = [];
  for (let index = 0; index < Math.max(0, Math.floor(count)); index += 1) out.push(rng.uint());
  return out;
}

/** 生成确定性的 [0,1) 浮点序列（测试 golden 向量用）。 */
export function floatSequence(seed, count) {
  const rng = createRng(seed);
  const out = [];
  for (let index = 0; index < Math.max(0, Math.floor(count)); index += 1) out.push(rng.next());
  return out;
}

/** 固定时钟：门禁里任何需要"时间"的夹具都从这里取，保证与真实时间无关。 */
export function createFixedClock(startMs = 1700000000000) {
  let current = Number(startMs);
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms = 1) => {
      current += Math.max(0, Number(ms) || 0);
      return current;
    },
    snapshot: () => current,
  };
}

/** 单调递增 id 序列（替代随机 id，让指纹稳定）。 */
export function idSequence(prefix, width = 4) {
  let index = 0;
  return () => String(prefix) + String(index += 1).padStart(width, '0');
}
