// ui/direction.js —— 同步设置扩展页方向。
// 扩展页 CSP 禁止内联脚本，所以方向必须在独立同步脚本里先设置，避免首帧 LTR 抖动。
// 规则：?dir=rtl|ltr 显式覆盖；否则跟随浏览器首选语言里的 RTL 语言。
(() => {
  const RTL_LANGS = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
  const root = document.documentElement;
  try {
    const forced = new URLSearchParams(location.search).get('dir');
    if (forced === 'rtl' || forced === 'ltr') {
      root.dir = forced;
      root.setAttribute('data-bb-dir', forced);
      return;
    }
    const languages = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ''];
    const rtl = languages.some((lang) => RTL_LANGS.test(String(lang || '').trim()));
    root.dir = rtl ? 'rtl' : 'ltr';
    root.setAttribute('data-bb-dir', rtl ? 'rtl' : 'ltr');
  } catch {
    root.dir = 'ltr';
  }
})();
