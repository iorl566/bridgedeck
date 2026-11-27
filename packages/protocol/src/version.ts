// packages/protocol/src/version.ts —— 协议版本解析与比较（纯函数）。
//
// 与 lib/protocol.mjs 的 parseProtocol / compareProtocol / protocolAtLeast 逐字段
// 等价（差分测试在 test/version.test.ts 用同一批输入对拍），并补上结构化版本对象
// 的类型约束与几个只读辅助函数。语义要点：
// - 同 major 内允许 minor 偏斜（1.8 扩展仍可连接 1.9 daemon）；
// - 数字形式 1.9 按整数部分为 major、小数部分四舍五入到一位为 minor；
// - 无法解析返回 null，调用方必须把 null 当“不满足”处理，不能当 0。

import type { ProtocolVersion } from './types.ts';

/** 版本字符串形态：'1.8' / '1' / ' 1.9 '（两端空白容忍）。 */
const PROTOCOL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * 解析协议版本。
 * - 数字且有限且 >= 0：major = 整数部分，minor = 小数部分×10 后四舍五入；
 * - 字符串：`^(\d+)(?:\.(\d+))?$`，两端 trim；
 * - 其余（null/undefined/NaN/负数/对象）返回 null。
 */
export function parseProtocol(value: unknown): ProtocolVersion | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const major = Math.trunc(value);
    return { major, minor: Math.round((value - major) * 10) };
  }
  const text = String(value == null ? '' : value).trim();
  const match = PROTOCOL_PATTERN.exec(text);
  if (!match) return null;
  const majorText = match[1];
  const minorText = match[2];
  if (majorText === undefined) return null;
  return { major: Number(majorText), minor: Number(minorText === undefined ? '0' : minorText) };
}

/** 版本标签：能解析就格式化，否则 'unknown'（与 JS 侧 `protocol || 'unknown'` 同义）。 */
export function protocolLabel(value: unknown): string {
  const parsed = parseProtocol(value);
  if (parsed) return formatProtocol(parsed);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'unknown';
}

/** 版本对象 → 'major.minor'。 */
export function formatProtocol(version: ProtocolVersion): string {
  return version.major + '.' + version.minor;
}

/**
 * 协议版本比较：a>b 返回正数，a<b 返回负数，相等 0，任一侧无法解析返回 null。
 * major 优先，其次 minor；不比较补丁号（协议面只有两段）。
 */
export function compareProtocol(a: unknown, b: unknown): number | null {
  const pa = parseProtocol(a);
  const pb = parseProtocol(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

/** 对端协议是否达到 required 最低版本；任一侧无法解析时返回 null（调用方按拒绝处理）。 */
export function protocolAtLeast(actual: unknown, required: unknown): boolean | null {
  const order = compareProtocol(actual, required);
  return order === null ? null : order >= 0;
}

/**
 * 一组版本里最低的版本（按 major.minor 排序）；空列表或全部不可解析返回 null。
 * 供诊断输出“需要至少 X”时使用。
 */
export function lowestProtocol(versions: readonly unknown[]): string | null {
  let lowest: string | null = null;
  for (const value of versions) {
    const parsed = parseProtocol(value);
    if (!parsed) continue;
    const text = formatProtocol(parsed);
    if (lowest === null) {
      lowest = text;
      continue;
    }
    const order = compareProtocol(text, lowest);
    if (order !== null && order < 0) lowest = text;
  }
  return lowest;
}

/**
 * 判断一个客户端版本是否落在“同 major 但低于当前 minor”的兼容偏斜区间：
 * 例如 baseline=1.8 / current=1.9 时 '1.8' 是偏斜客户端，'1.9' 不是，'2.0' 也不是。
 */
export function isSkewedProtocol(
  value: unknown,
  current: string,
  baseline: string,
): boolean {
  const actual = parseProtocol(value);
  const target = parseProtocol(current);
  const floor = parseProtocol(baseline);
  if (!actual || !target || !floor) return false;
  if (actual.major !== target.major) return false;
  const actualText = formatProtocol(actual);
  return (compareProtocol(actualText, formatProtocol(floor)) ?? -1) >= 0
    && (compareProtocol(actualText, formatProtocol(target)) ?? 1) < 0;
}
