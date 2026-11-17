// src/overlay-theme.js —— 页面内浮层的统一设计 token（借用模态/Toast、Help、Takeover）。
//
// 浮层代码会被 chrome.scripting.executeScript 序列化到页面里执行，不能 import
// 模块；因此后台把这份 token 表作为参数传进去，页面函数只负责把变量写到浮层
// host 的 inline style 上。这样四个浮层共享同一套颜色/圆角/阴影，深色模式也
// 只在一个地方维护。
//
// 页面可用 document.documentElement[data-bb-theme="dark|light"] 强制主题，
// 否则跟随 prefers-color-scheme。

/** @typedef {'light' | 'dark'} OverlayThemeMode */

/**
 * 统一设计 token。属性名就是 CSS 自定义属性名，页面函数直接 setProperty。
 * 数值需通过 tests/unit/overlay-theme.test.mjs 的 WCAG AA 对比度检查。
 */
export const OVERLAY_THEME = Object.freeze({
  light: Object.freeze({
    '--bb-bg': '#ffffff',
    '--bb-surface': '#f7f9fc',
    '--bb-surface-raised': '#ffffff',
    '--bb-fg': '#1c2230',
    '--bb-muted': '#667085',
    '--bb-body': '#475569',
    '--bb-line': '#dbe4f5',
    '--bb-accent': '#2f6fed',
    '--bb-accent-strong': '#1d4ed8',
    '--bb-accent-fg': '#ffffff',
    '--bb-accent-soft': '#e8f0ff',
    '--bb-accent-line': '#cfe0ff',
    '--bb-warn-bg': '#fdeccd',
    '--bb-warn-fg': '#8a4b08',
    '--bb-shadow': 'rgba(28,34,48,.18)',
    '--bb-shadow-strong': 'rgba(28,34,48,.28)',
    '--bb-backdrop': 'rgba(15,23,42,.42)',
  }),
  dark: Object.freeze({
    '--bb-bg': '#151922',
    '--bb-surface': '#1c2230',
    '--bb-surface-raised': '#232c3d',
    '--bb-fg': '#e6eaf2',
    '--bb-muted': '#98a2b3',
    '--bb-body': '#b8c4d8',
    '--bb-line': '#2a3140',
    '--bb-accent': '#5b8cff',
    '--bb-accent-strong': '#a9c1ff',
    '--bb-accent-fg': '#0b1020',
    '--bb-accent-soft': '#22304b',
    '--bb-accent-line': '#334a72',
    '--bb-warn-bg': '#3b2a12',
    '--bb-warn-fg': '#f3c77a',
    '--bb-shadow': 'rgba(0,0,0,.45)',
    '--bb-shadow-strong': 'rgba(0,0,0,.6)',
    '--bb-backdrop': 'rgba(0,0,0,.62)',
  }),
});

/**
 * 返回某个模式下的 token 表；未知模式回退到 light。
 * @param {unknown} theme
 * @param {OverlayThemeMode} mode
 * @returns {Record<string, string>}
 */
export function overlayThemeTokens(theme, mode) {
  const source = theme && typeof theme === 'object' ? theme : OVERLAY_THEME;
  const tokens = source[mode === 'dark' ? 'dark' : 'light'];
  return tokens && typeof tokens === 'object' ? tokens : OVERLAY_THEME.light;
}

/**
 * 从 DOM 解析当前主题。页面可用 data-bb-theme 强制覆盖系统偏好，
 * 方便真机验收和自动化测试。
 * @param {{ getAttribute?: (name: string) => string | null }} root
 * @param {MediaQueryList | null} media
 * @returns {OverlayThemeMode}
 */
export function overlayThemeMode(root, media) {
  const forced = root && typeof root.getAttribute === 'function' ? root.getAttribute('data-bb-theme') : null;
  if (forced === 'dark' || forced === 'light') return forced;
  return media && media.matches ? 'dark' : 'light';
}

/**
 * 把 token 表写成 `--bb-*: value` 的样式字符串（诊断/测试可用）。
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
export function overlayThemeCssText(tokens) {
  return Object.keys(tokens || {}).map((key) => key + ':' + tokens[key]).join(';');
}
