// lib/page-policy.js —— 扩展侧页面策略：不把脚本/动作送进浏览器内部页。
//
// 这不是 daemon 的“会话范围”，而是扩展自己的最后一道闸：即使某个调用方
// 绕过 scope，chrome://、扩展页、devtools 也不能被注入或导航。
const RESTRICTED_SCHEME = /^(chrome|edge|devtools|chrome-extension|moz-extension|ms-browser-extension|view-source|javascript):/i;

/**
 * 返回受限原因；空字符串表示允许。
 * about:blank 允许（新建窗口/初始页），其它 about: 视为内部页。
 */
export function restrictedUrlReason(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^about:blank(?:[?#].*)?$/i.test(raw)) return '';
  if (/^about:/i.test(raw)) return 'about: 内部页面';
  if (RESTRICTED_SCHEME.test(raw)) return '浏览器内部或扩展页面';
  return '';
}
