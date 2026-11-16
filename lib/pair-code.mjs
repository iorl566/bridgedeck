// lib/pair-code.mjs —— 本机配对的 6 位确认码。
import crypto from 'node:crypto';

export function createPairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** 只接受 6 位数字；空/不足/非数字返回 ''。 */
export function normalizePairCode(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  return digits.length === 6 ? digits : '';
}

/** 定长比较，避免明显的时序侧信道。 */
export function pairCodeMatches(expected, provided) {
  const a = normalizePairCode(expected);
  const b = normalizePairCode(provided);
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}
