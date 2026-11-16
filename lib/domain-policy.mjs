// lib/domain-policy.mjs —— 会话级域名白/黑名单。
//
// 空 allow = 不限制；deny 优先。域名按“自身 + 子域”匹配，支持 *.example.com。
export function normalizeDomains(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  for (const raw of list) {
    let text = String(raw || '').trim().toLowerCase();
    if (!text) continue;
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    text = text.split('/')[0].split('?')[0].split('#')[0];
    text = text.replace(/:\d+$/, '');
    text = text.replace(/^\*\./, '');
    if (!text || !/^[a-z0-9.-]+$/.test(text)) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function hostMatches(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const p = String(pattern || '').toLowerCase().replace(/\.$/, '');
  if (!h || !p) return false;
  return h === p || h.endsWith('.' + p);
}

export function domainAllowed(allowDomains, denyDomains, url) {
  const allow = normalizeDomains(allowDomains);
  const deny = normalizeDomains(denyDomains);
  if (!allow.length && !deny.length) return { allowed: true, reason: '' };
  let host = '';
  try {
    host = new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: '无法解析目标 URL' };
  }
  const denied = deny.find((pattern) => hostMatches(host, pattern));
  if (denied) return { allowed: false, reason: '命中拒绝域名 ' + denied };
  if (allow.length && !allow.some((pattern) => hostMatches(host, pattern))) {
    return { allowed: false, reason: '不在允许域名列表' };
  }
  return { allowed: true, reason: '' };
}
