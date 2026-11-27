// ui/contrast-audit.js —— WCAG AA 对比度门禁（纯函数，测试/CI 复用）。
//
// 覆盖范围：
// - extension/ui/popup.css、ui.css 的浅色/深色 token，以及 [dir="rtl"] 覆盖块；
// - extension/src/overlay-theme.js 的 light/dark 浮层 token；
// - 样式规则里同时声明了 color 与 background 的“字面色对”；
// - 焦点环/开关轨道等非文本控件（阈值 3:1）。
//
// 失败信息必须包含模式、前景 token/色值、背景 token/色值和实际比值。
// 颜色计算与 lib/color-contrast.mjs 语义一致（该文件是 CLI 侧实现，扩展页不能 import
// extension 目录外的模块，所以这里做一份纯函数副本，并在单测里做双实现一致性校验）。

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
export const AA_NON_TEXT = 3;

const NAMED = {
  white: '#ffffff',
  black: '#000000',
  transparent: 'rgba(0,0,0,0)',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 解析 #rgb/#rgba/#rrggbb/#rrggbbaa、rgb()/rgba()、命名色；失败返回 null。 */
export function parseColor(value) {
  if (value == null) return null;
  let text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (NAMED[text]) text = NAMED[text];
  if (text.startsWith('#')) {
    let hex = text.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, a };
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) => {
      const number = parseFloat(part);
      if (Number.isNaN(number)) return NaN;
      return part.endsWith('%') ? (number / 100) * 255 : number;
    };
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    const alphaPart = parts[3];
    const a = alphaPart == null ? 1 : alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart);
    if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  }
  return null;
}

/** 十六进制展示（去掉 alpha；半透明色直接说明 rgba）。 */
export function formatColor(color) {
  if (!color) return '(unresolved)';
  const to = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  const hex = '#' + to(color.r) + to(color.g) + to(color.b);
  return color.a < 1 ? hex + '/' + color.a.toFixed(2) : hex;
}

/** sRGB → WCAG 相对亮度。 */
export function relativeLuminance(color) {
  const channel = (value) => {
    const c = clamp(Number(value) || 0, 0, 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color && color.r) + 0.7152 * channel(color && color.g) + 0.0722 * channel(color && color.b);
}

/** 把前景按 alpha 合成到背景上。 */
export function compositeOver(foreground, background) {
  const top = foreground || { r: 0, g: 0, b: 0, a: 0 };
  const base = background || { r: 255, g: 255, b: 255, a: 1 };
  const alpha = clamp(Number(top.a ?? 1), 0, 1);
  return {
    r: clamp(top.r * alpha + base.r * (1 - alpha), 0, 255),
    g: clamp(top.g * alpha + base.g * (1 - alpha), 0, 255),
    b: clamp(top.b * alpha + base.b * (1 - alpha), 0, 255),
    a: 1,
  };
}

/** WCAG 对比度（1..21）。 */
export function contrastRatio(foreground, background) {
  const fg = compositeOver(foreground, background);
  const a = relativeLuminance(fg);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * 解析 CSS 规则（含 @media 上下文与行号）。
 * @param {string} cssText
 */
export function parseStyleRules(cssText) {
  const text = String(cssText || '');
  const rules = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const stack = [];
  let headerStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      const header = text.slice(headerStart, index).trim();
      const isAtRule = header.startsWith('@');
      stack.push({
        kind: isAtRule ? 'at' : 'rule',
        header,
        media: isAtRule && /^@media/i.test(header) ? header : (stack[stack.length - 1]?.media || ''),
        bodyStart: index + 1,
      });
      headerStart = index + 1;
    } else if (char === '}') {
      const frame = stack.pop();
      if (frame && frame.kind === 'rule') {
        const body = text.slice(frame.bodyStart, index);
        const declarations = [];
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon <= 0) continue;
          const prop = part.slice(0, colon).trim().toLowerCase();
          const value = part.slice(colon + 1).trim();
          if (!prop || !/^[-a-z]+$/.test(prop)) continue;
          declarations.push({ prop, value, line: lineOf(frame.bodyStart + colon) });
        }
        rules.push({ selector: frame.header, media: frame.media, declarations, line: lineOf(frame.bodyStart) });
      }
      headerStart = index + 1;
    } else if (char === ';' && stack.length === 0) {
      headerStart = index + 1;
    }
  }
  return rules;
}

/**
 * 从 CSS 文本里收集自定义属性 token，按 light/dark + RTL 覆盖分类。
 * @returns {{light: Record<string,string>, dark: Record<string,string>, rtlLight: Record<string,string>, rtlDark: Record<string,string>, sources: string[]}}
 */
export function collectThemeTokens(cssText) {
  const tokens = { light: {}, dark: {}, rtlLight: {}, rtlDark: {} };
  for (const rule of parseStyleRules(cssText)) {
    const darkQuery = /prefers-color-scheme\s*:\s*dark/i.test(rule.media);
    const rtl = /\[dir="rtl"\]/.test(rule.selector);
    const target = rtl
      ? (darkQuery ? tokens.rtlDark : tokens.rtlLight)
      : (darkQuery ? tokens.dark : tokens.light);
    for (const declaration of rule.declarations) {
      if (!declaration.prop.startsWith('--')) continue;
      target[declaration.prop] = declaration.value;
    }
  }
  tokens.sources = [];
  return tokens;
}

/** 解析 var(--x[, fallback])，支持递归与 token 覆盖。 */
export function resolveColor(value, tokens = {}) {
  let text = String(value || '').trim();
  for (let depth = 0; depth < 10; depth += 1) {
    const direct = parseColor(text);
    if (direct) return direct;
    const match = /^var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^)]+))?\)$/.exec(text);
    if (!match) return null;
    const token = match[1];
    const fallback = match[2] && match[2].trim();
    const next = tokens[token] ?? fallback;
    if (next === undefined) return null;
    text = String(next).trim();
  }
  return null;
}

/** 合并一组 token（后面的覆盖前面的），用于 light+RTL 覆盖。 */
export function mergeTokens(...sets) {
  return Object.assign({}, ...sets.filter(Boolean));
}

/**
 * 审计一组 token 对。
 * @param {Array<{mode:string, rtl?:boolean, tokens:Record<string,string>}>} themeSets
 * @param {Array<{fg:string,bg:string,min?:number,label?:string}>} pairs
 */
export function auditTokenPairs(themeSets, pairs) {
  const failures = [];
  let checked = 0;
  for (const theme of themeSets) {
    for (const pair of pairs) {
      const min = pair.min || AA_NORMAL;
      const fgValue = theme.tokens[pair.fg];
      const bgValue = theme.tokens[pair.bg];
      if (fgValue === undefined || bgValue === undefined) {
        failures.push({
          mode: theme.mode,
          rtl: Boolean(theme.rtl),
          label: pair.label || (pair.fg + ' on ' + pair.bg),
          fgName: pair.fg,
          bgName: pair.bg,
          fg: '(missing token)',
          bg: '(missing token)',
          ratio: 0,
          min,
          message: theme.mode + (theme.rtl ? ' RTL' : '') + ' ' + pair.fg + ' on ' + pair.bg + ' = 缺 token',
        });
        continue;
      }
      const fg = resolveColor(fgValue, theme.tokens);
      const bg = resolveColor(bgValue, theme.tokens);
      if (!fg || !bg) {
        failures.push({
          mode: theme.mode,
          rtl: Boolean(theme.rtl),
          label: pair.label || (pair.fg + ' on ' + pair.bg),
          fgName: pair.fg,
          bgName: pair.bg,
          fg: formatColor(fg),
          bg: formatColor(bg),
          ratio: 0,
          min,
          message: theme.mode + (theme.rtl ? ' RTL' : '') + ' ' + pair.fg + ' on ' + pair.bg + ' = 无法解析颜色',
        });
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      checked += 1;
      if (ratio + 1e-9 < min) {
        failures.push({
          mode: theme.mode,
          rtl: Boolean(theme.rtl),
          label: pair.label || (pair.fg + ' on ' + pair.bg),
          fgName: pair.fg,
          bgName: pair.bg,
          fg: formatColor(fg),
          bg: formatColor(bg),
          ratio,
          min,
          message: formatFailure({ mode: theme.mode, rtl: Boolean(theme.rtl), fgName: pair.fg, bgName: pair.bg, fg, bg, ratio, min }),
        });
      }
    }
  }
  return { ok: failures.length === 0, checked, failures };
}

/** 校验一组样式规则中同时含 color 与 background 的字面色对。 */
export function auditStyleRules(rules, themeSets) {
  const failures = [];
  let checked = 0;
  for (const theme of themeSets) {
    for (const rule of rules) {
      const byProp = (names) => rule.declarations.find((declaration) => names.includes(declaration.prop));
      const fgDecl = byProp(['color', '-webkit-text-fill-color']);
      const bgDecl = byProp(['background', 'background-color']);
      if (!fgDecl || !bgDecl) continue;
      const fg = resolveColor(fgDecl.value, theme.tokens);
      const bg = resolveColor(bgDecl.value, theme.tokens);
      // transparent 背景意味着继承祖先背景，规则级审计无法确定真实底色；
      // 这类组合由 TEXT_TOKEN_PAIRS 的语义 token 对覆盖，避免误报。
      if (!fg || !bg || bg.a === 0) continue;
      const ratio = contrastRatio(fg, bg);
      checked += 1;
      if (ratio + 1e-9 < AA_NORMAL) {
        failures.push({
          mode: theme.mode,
          rtl: Boolean(theme.rtl),
          label: rule.selector,
          fgName: fgDecl.value,
          bgName: bgDecl.value,
          fg: formatColor(fg),
          bg: formatColor(bg),
          ratio,
          min: AA_NORMAL,
          message: formatFailure({
            mode: theme.mode,
            rtl: Boolean(theme.rtl),
            fgName: rule.selector + ' color=' + fgDecl.value,
            bgName: 'background=' + bgDecl.value,
            fg,
            bg,
            ratio,
            min: AA_NORMAL,
          }),
        });
      }
    }
  }
  return { ok: failures.length === 0, checked, failures };
}

/** 单条失败信息：必须包含前景/背景/比值。 */
export function formatFailure({ mode, rtl, fgName, bgName, fg, bg, ratio, min }) {
  return (mode || 'light') + (rtl ? ' RTL' : '') + ' ' + fgName + ' on ' + bgName
    + ': ' + formatColor(fg) + ' on ' + formatColor(bg)
    + ' = ' + Number(ratio).toFixed(2) + ' < ' + min;
}

/** 汇总多份审计结果；ok 取交集。 */
export function combineReports(reports) {
  const failures = [];
  let checked = 0;
  for (const report of reports) {
    checked += report.checked || 0;
    failures.push(...(report.failures || []));
  }
  return { ok: failures.length === 0, checked, failures };
}

/** 常用 token 对：正文/次要文字/强调/危险/成功。 */
export const TEXT_TOKEN_PAIRS = Object.freeze([
  { fg: '--fg', bg: '--bg' },
  { fg: '--fg', bg: '--card' },
  { fg: '--muted', bg: '--bg' },
  { fg: '--muted', bg: '--card' },
  { fg: '--accent-fg', bg: '--accent' },
  { fg: '--danger', bg: '--bg' },
  { fg: '--danger', bg: '--card' },
  { fg: '--ok', bg: '--bg' },
  { fg: '--ok', bg: '--card' },
]);

/** 非文本关键控件：焦点环、开关轨道（3:1）。 */
export const NON_TEXT_TOKEN_PAIRS = Object.freeze([
  { fg: '--accent', bg: '--bg', min: AA_NON_TEXT, label: 'focus-ring' },
  { fg: '--accent', bg: '--card', min: AA_NON_TEXT, label: 'focus-ring-on-card' },
  { fg: '--off', bg: '--bg', min: AA_NON_TEXT, label: 'switch-track' },
  { fg: '--off', bg: '--card', min: AA_NON_TEXT, label: 'switch-track-on-card' },
]);

/** 浮层 token 对（与 tests/unit/overlay-theme.test.mjs 的口径一致，多覆盖文本/警告色）。 */
export const OVERLAY_TOKEN_PAIRS = Object.freeze([
  { fg: '--bb-fg', bg: '--bb-bg' },
  { fg: '--bb-fg', bg: '--bb-surface' },
  { fg: '--bb-fg', bg: '--bb-surface-raised' },
  { fg: '--bb-muted', bg: '--bb-surface' },
  { fg: '--bb-muted', bg: '--bb-surface-raised' },
  { fg: '--bb-body', bg: '--bb-surface' },
  { fg: '--bb-body', bg: '--bb-surface-raised' },
  { fg: '--bb-accent-fg', bg: '--bb-accent' },
  { fg: '--bb-accent-strong', bg: '--bb-accent-soft' },
  { fg: '--bb-warn-fg', bg: '--bb-warn-bg' },
]);
