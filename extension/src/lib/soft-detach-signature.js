/** 软分离签名：URL/title/status 的稳定指纹，用于判断重挂后是否还是同一页。 */
function hash(value) {
  let h = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function signatureOfTab(tab) {
  if (!tab || typeof tab !== 'object') return '';
  return hash([tab.url || '', tab.title || '', tab.status || ''].join('|'));
}

export function sameSignature(before, after) {
  return Boolean(before) && Boolean(after) && before === after;
}
