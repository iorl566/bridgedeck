/** Chromium 家族识别：UA + userAgentData brands + Brave 注入对象。 */
export function detectBrowser({ userAgent = '', brands = [], hasBrave = false } = {}) {
  const ua = String(userAgent || '');
  const list = Array.isArray(brands) ? brands.map((item) => String(item && item.brand || '')).join(' ') : '';
  const has = (re) => re.test(ua) || re.test(list);
  if (has(/Edg\//i)) return 'edge';
  if (has(/OPR\/|Opera/i)) return 'opera';
  if (has(/Vivaldi/i)) return 'vivaldi';
  if (has(/Brave/i) || hasBrave) return 'brave';
  if (has(/Helium/i)) return 'helium';
  if (has(/Arc\//i) || /Arc/i.test(list)) return 'arc';
  if (has(/Chromium/i) && !/Chrome\//i.test(ua)) return 'chromium';
  if (has(/Chrome\//i)) return 'chrome';
  return 'chromium';
}

export function browserVersionOf(userAgent = '') {
  const match = /(?:Edg|OPR|Vivaldi|Brave|Helium|Arc|Chrome)\/([\d.]+)/i.exec(String(userAgent || ''));
  return match ? match[1] : '';
}
