// lib/page-policy.js —— 扩展侧页面策略：不把脚本/动作送进浏览器内部页。
//
// 这不是 daemon 的“会话范围”，而是扩展自己的最后一道闸：即使某个调用方
// 绕过 scope，chrome://、扩展页、devtools 也不能被注入或导航。
const RESTRICTED_PROTOCOLS = new Set(['chrome:', 'edge:', 'devtools:', 'chrome-extension:', 'moz-extension:', 'ms-browser-extension:', 'view-source:', 'javascript:']);

/**
 * 返回受限原因；空字符串表示允许。
 * 先剥离浏览器会忽略的 C0/换行，再按 URL 规范化后的 protocol 判定。
 */
export function restrictedUrlReason(url) {
  const raw = String(url || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return '无法解析的 URL'; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'about:') return parsed.pathname.toLowerCase() === 'blank' ? '' : 'about: 内部页面';
  if (RESTRICTED_PROTOCOLS.has(protocol)) return '浏览器内部或扩展页面';
  return '';
}
