// packages/vom/src/tokens.ts —— VOM token 估算（CJK/emoji 感知，类型化移植）。
//
// 源：extension/src/lib/vom-weights.js 的 VOM_TOKEN_SAFETY_FACTOR / estimateTextTokens /
// estimateVomTokens（差分测试对拍，逐字段相等）。这里只搬“计费”这一层，不搬打分权重：
// 关系折叠（compress）与预算裁剪都依赖同一套 token 口径，两处各写一份必然漂移。
//
// 口径：
// - CJK（含假名/谚文/全角区）约 1 字 1 token；
// - emoji 记 2 token（比按 Latin 字符/4 更接近真实计费）；
// - 其它非空白字符 4 字 1 token；
// - 总和乘安全系数 1.1 后向上取整 —— 宁可多算，避免实际计费超预算；
// - 节点成本 = 8（固定结构开销）+ 名称/角色文本成本。

/** token 估算安全系数：宁可多算，避免实际计费超预算。 */
export const VOM_TOKEN_SAFETY_FACTOR = 1.1;

/** CJK 码位区间（假名、CJK 扩展 A、CJK 基本区、谚文、兼容表意、全角）。 */
const CJK_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
] as const);

/** 是否为 CJK 码位。 */
function isCjk(code: number): boolean {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

/**
 * CJK 感知的文本 token 估算。
 * 入参按 `String(text || '')` 归一（null/undefined/0/'' 都算空文本），按码位遍历。
 */
export function estimateTextTokens(text: unknown): number {
  let cjk = 0;
  let other = 0;
  let emoji = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    if (code == null) continue;
    if (/\p{Extended_Pictographic}/u.test(char)) emoji += 1;
    else if (isCjk(code)) cjk += 1;
    else if (!/\s/.test(char)) other += 1;
  }
  return Math.ceil((cjk + emoji * 2 + other / 4) * VOM_TOKEN_SAFETY_FACTOR);
}

/** 节点事实里的最小文本面：只读 name/role 两个字段（其余字段忽略）。 */
export interface VomTokenNodeFacts {
  readonly name?: unknown;
  readonly role?: unknown;
}

/** 节点成本：名称/角色文本 + 固定结构开销 8。 */
export function estimateVomTokens(node: VomTokenNodeFacts | null | undefined): number {
  const name = String((node && node.name) || '');
  const role = String((node && node.role) || '');
  return 8 + estimateTextTokens(name + role);
}
