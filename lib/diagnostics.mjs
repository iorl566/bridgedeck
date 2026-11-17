// lib/diagnostics.mjs —— 只报告自动化痕迹，不修改页面/指纹。
export function summarizePageDiagnostics(markers = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const webdriver = markers.webdriver;
  if (webdriver === true) add('warn', 'WEBDRIVER', 'navigator.webdriver=true：当前页面会认定为自动化浏览器');
  else if (webdriver === false) add('ok', 'WEBDRIVER', 'navigator.webdriver=false');
  else add('info', 'WEBDRIVER', '无法读取 navigator.webdriver');
  if (markers.mainWorldBB === true) add('warn', 'PAGE_GLOBAL', '主世界存在 __BB_PAGE__，页面可直接检测扩展');
  else add('ok', 'PAGE_GLOBAL', '主世界没有 __BB_PAGE__');
  if (markers.overlay === true) add('info', 'OVERLAY', '扩展浮层存在（页面可通过 DOM 检测；这是产品可见性提示）');
  if (markers.chrome === false) add('warn', 'CHROME_OBJECT', 'window.chrome 缺失，不像正常 Chromium 页面');
  if (Number(markers.plugins) === 0) add('info', 'PLUGINS', 'navigator.plugins 为空（部分检测器会关注）');
  if (String(markers.languages || '').trim() === '') add('info', 'LANGUAGES', 'navigator.languages 为空');
  const warn = findings.some((item) => item.level === 'warn');
  return { ok: !warn, findings, markers };
}
