// lib/color-contrast.mjs —— 颜色对比度的纯计算（与 page-lib 内的实现保持一致）。
//
// 解析 CSS 颜色（oklch/lab/color-mix 等）需要浏览器 canvas；这里只负责已经归一化为
// sRGB 的 {r,g,b,a}（0..255 / 0..1）的 luminance、alpha 合成与 WCAG 对比度。

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** sRGB 通道（0..255）→ 线性值（0..1）。 */
export function srgbToLinear(channel) {
  const value = clamp(Number(channel) || 0, 0, 255) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color) {
  const r = srgbToLinear(color && color.r);
  const g = srgbToLinear(color && color.g);
  const b = srgbToLinear(color && color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1..21）。 */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/** 把 top 以自身 alpha 合成到 bottom 上。 */
export function compositeOver(top, bottom) {
  const alpha = clamp(Number(top && top.a), 0, 1);
  const base = bottom || { r: 255, g: 255, b: 255, a: 1 };
  return {
    r: clamp((top.r * alpha) + (base.r * (1 - alpha)), 0, 255),
    g: clamp((top.g * alpha) + (base.g * (1 - alpha)), 0, 255),
    b: clamp((top.b * alpha) + (base.b * (1 - alpha)), 0, 255),
    a: 1,
  };
}

/** WCAG AA 正文阈值；大字/图形可另用 3.0。 */
export const AA_CONTRAST = 4.5;
