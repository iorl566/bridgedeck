// packages/vom/src/color.ts —— 颜色解析与 WCAG 对比度（纯函数，无 DOM 依赖）。
//
// 源语义：extension/injected/parts/30-resolve.part 的 parseCssColor / compositeColor /
// relativeLuminance / contrastRatio（差分测试对拍）。
//
// 浏览器里 getComputedStyle 的颜色可能是 oklch()/color-mix()/color(srgb ...) 等新语法；
// JS 参考用 1x1 canvas 让浏览器统一归一化成 sRGB。TS 侧同一条路径由调用方以
// `CssColorParser` 注入（内容脚本里就是 canvas），这里另外提供一份纯 TS 兜底解析
// （hex / rgb / hsl / 常用命名色 / oklch / oklab / color-mix / color(srgb)），
// 保证 Node 单测（无 canvas）与老浏览器都能给出确定的数值。

/** 归一化颜色（sRGB 0..255 + alpha 0..1）。 */
export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** 外部颜色归一钩子（浏览器 canvas）：返回 null 表示解析失败。 */
export type CssColorParser = (text: string) => RgbaColor | null;

/** 解析失败/空值时的哨兵。 */
export const TRANSPARENT: RgbaColor = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

const NAMED_COLORS: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze({
  transparent: [0, 0, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  green: [0, 128, 0],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  navy: [0, 0, 128],
  orange: [255, 165, 0],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  whitesmoke: [245, 245, 245],
  gainsboro: [220, 220, 220],
  currentcolor: [0, 0, 0],
});

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function alphaOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const text = raw.trim();
  if (!text) return 1;
  const number = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
  return clamp01(number);
}

/** 数字或百分比（percentBase=255 表示 100% 对应 255）。 */
function numberOrPercent(raw: string, percentBase = 255): number {
  const text = raw.trim();
  if (text.endsWith('%')) {
    const percent = Number(text.slice(0, -1));
    return clampByte((percent / 100) * percentBase);
  }
  return clampByte(Number(text));
}

/** hue（deg/grad/rad/turn 或纯数字）。 */
function hueOf(raw: string): number {
  const text = raw.trim().toLowerCase();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return 0;
  if (text.endsWith('grad')) return (number * 360) / 400;
  if (text.endsWith('rad')) return (number * 180) / Math.PI;
  if (text.endsWith('turn')) return number * 360;
  return number;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp01(saturation);
  const l = clamp01(lightness);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

function srgbEncode(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function srgbDecode(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** oklab → sRGB（Björn Ottosson 的矩阵常数）。 */
function oklabToRgb(lightness: number, a: number, b: number, alpha: number): RgbaColor {
  const l = Number.isFinite(lightness) ? lightness : 0;
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = lPrime * lPrime * lPrime;
  const m3 = mPrime * mPrime * mPrime;
  const s3 = sPrime * sPrime * sPrime;
  const linearR = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const linearG = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const linearB = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return {
    r: clampByte(srgbEncode(clamp01(linearR)) * 255),
    g: clampByte(srgbEncode(clamp01(linearG)) * 255),
    b: clampByte(srgbEncode(clamp01(linearB)) * 255),
    a: clamp01(alpha),
  };
}

/** 百分比或数字：oklch 的 L 允许 0..1 或 0%..100%。 */
function unitOrPercent(raw: string): number {
  const text = raw.trim();
  if (text.endsWith('%')) return clamp01(Number(text.slice(0, -1)) / 100);
  return clamp01(Number(text));
}

/** 百分比或小数：oklab 的 a/b 允许 ±100% = ±0.4。 */
function chromaOf(raw: string): number {
  const text = raw.trim();
  if (text.endsWith('%')) return (Number(text.slice(0, -1)) / 100) * 0.4;
  return Number(text);
}

function splitColorArgs(text: string): string[] {
  const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const slash = body.indexOf('/');
  const main = slash >= 0 ? body.slice(0, slash) : body;
  const rest = slash >= 0 ? body.slice(slash + 1) : undefined;
  const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
  const out = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (rest !== undefined) out.push(rest.trim());
  return out;
}

/** color-mix(in srgb, c1 p1%, c2 p2%)（递归解析；按 premultiplied alpha 混合）。 */
function mixColors(text: string, hook?: CssColorParser): RgbaColor | null {
  const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const parts = body.split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  const space = String(parts[0] ?? '').toLowerCase();
  if (!space.startsWith('in ')) return null;
  const colors: Array<{ color: RgbaColor; weight: number | null }> = [];
  for (const part of parts.slice(1)) {
    const match = /^(.*?)(?:\s+([0-9.]+)%)?$/.exec(part);
    if (!match) continue;
    const rawColor = String(match[1] ?? '').trim();
    if (!rawColor) continue;
    const color = parseCssColor(rawColor, hook);
    if (!color) return null;
    const rawWeight = match[2] === undefined ? null : Number(match[2]) / 100;
    colors.push({ color, weight: rawWeight == null || !Number.isFinite(rawWeight) || rawWeight < 0 ? null : rawWeight });
  }
  if (colors.length < 2) return null;
  // 百分比缺省时按规范补齐：未指定的颜色平分剩余百分比。
  const specified = colors.reduce((sum, item) => sum + (item.weight ?? 0), 0);
  const missing = colors.filter((item) => item.weight == null).length;
  const remaining = Math.max(0, 1 - specified);
  const resolved = colors.map((item) => ({
    color: item.color,
    weight: item.weight ?? (missing > 0 ? remaining / missing : 0),
  }));
  const totalWeight = resolved.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) return null;
  const alphaSum = resolved.reduce((sum, item) => sum + item.color.a * item.weight, 0);
  const channel = (key: 'r' | 'g' | 'b'): number => {
    if (!(alphaSum > 0)) return 0;
    const sum = resolved.reduce((acc, item) => acc + item.color[key] * item.color.a * item.weight, 0);
    return clampByte(sum / alphaSum);
  };
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: clamp01(alphaSum / totalWeight) };
}

/** 纯 TS 兜底解析（无 canvas 时）。 */
export function parseCssColorFallback(raw: string | null | undefined): RgbaColor | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'transparent') return TRANSPARENT;
  if (NAMED_COLORS[text]) {
    const named = NAMED_COLORS[text];
    return { r: named[0], g: named[1], b: named[2], a: 1 };
  }
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex.slice(0, 1) + hex.slice(0, 1), 16);
      const g = Number.parseInt(hex.slice(1, 2) + hex.slice(1, 2), 16);
      const b = Number.parseInt(hex.slice(2, 3) + hex.slice(2, 3), 16);
      const a = hex.length === 4 ? Number.parseInt(hex.slice(3, 4) + hex.slice(3, 4), 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  if (text.startsWith('rgb')) {
    const parts = splitColorArgs(text);
    if (parts.length < 3) return null;
    return {
      r: numberOrPercent(parts[0] ?? '0'),
      g: numberOrPercent(parts[1] ?? '0'),
      b: numberOrPercent(parts[2] ?? '0'),
      a: alphaOf(parts[3]),
    };
  }
  if (text.startsWith('hsl')) {
    const parts = splitColorArgs(text);
    if (parts.length < 3) return null;
    const hue = hueOf(parts[0] ?? '0');
    const saturation = numberOrPercent(parts[1] ?? '0') / 100;
    const lightness = numberOrPercent(parts[2] ?? '0') / 100;
    const [r, g, b] = hslToRgb(hue, saturation, lightness);
    return { r, g, b, a: alphaOf(parts[3]) };
  }
  if (text.startsWith('oklch')) {
    const parts = splitColorArgs(text);
    if (parts.length < 3) return null;
    const lightness = unitOrPercent(parts[0] ?? '0');
    const chroma = chromaOf(parts[1] ?? '0');
    const hue = (hueOf(parts[2] ?? '0') * Math.PI) / 180;
    return oklabToRgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue), alphaOf(parts[3]));
  }
  if (text.startsWith('oklab')) {
    const parts = splitColorArgs(text);
    if (parts.length < 3) return null;
    return oklabToRgb(unitOrPercent(parts[0] ?? '0'), chromaOf(parts[1] ?? '0'), chromaOf(parts[2] ?? '0'), alphaOf(parts[3]));
  }
  if (text.startsWith('color-mix')) return mixColors(text);
  if (text.startsWith('color(')) {
    const parts = splitColorArgs(text);
    // color(srgb r g b [/ a])；其它色彩空间交给 canvas 钩子。
    const space = String(parts[0] ?? '').toLowerCase();
    if (space !== 'srgb' || parts.length < 4) return null;
    return {
      r: clampByte(Number(parts[1]) * 255),
      g: clampByte(Number(parts[2]) * 255),
      b: clampByte(Number(parts[3]) * 255),
      a: alphaOf(parts[4]),
    };
  }
  return null;
}

/**
 * CSS 颜色 → 归一化 RGBA。
 *
 * 解析顺序：纯 TS 兜底 → 外部钩子（浏览器 canvas）。纯解析覆盖浏览器会保留色彩空间的
 * `oklch()/oklab()/color-mix()/color(srgb ...)`；钩子只作为最后兜底（未知语法）。
 */
export function parseCssColor(raw: string | null | undefined, hook?: CssColorParser): RgbaColor | null {
  const pure = parseCssColorFallback(raw);
  if (pure) return pure;
  if (hook) {
    try {
      return hook(String(raw ?? ''));
    } catch {
      return null;
    }
  }
  return null;
}

/** 半透明前景叠到不透明背景上（sRGB 直接插值，与 JS 基线一致）。 */
export function compositeColor(top: RgbaColor, bottom?: RgbaColor | null): RgbaColor {
  const alpha = clamp01(Number(top.a) || 0);
  const base = bottom ?? { r: 255, g: 255, b: 255, a: 1 };
  return {
    r: top.r * alpha + base.r * (1 - alpha),
    g: top.g * alpha + base.g * (1 - alpha),
    b: top.b * alpha + base.b * (1 - alpha),
    a: 1,
  };
}

/** WCAG 相对亮度（sRGB）。 */
export function relativeLuminance(color: RgbaColor): number {
  return 0.2126 * srgbDecode(clampByte(color.r) / 255)
    + 0.7152 * srgbDecode(clampByte(color.g) / 255)
    + 0.0722 * srgbDecode(clampByte(color.b) / 255);
}

/** WCAG 对比度（1..21）。 */
export function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/** 对比度保留两位小数（observe 节点字段口径，与 JS 基线一致）。 */
export function roundContrast(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(2));
}
