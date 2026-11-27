// src/status-chip.js —— 执行期统一状态 chip（录制 / 截图中 / 录制视频）。
//
// 目标：把“执行期间右上/左下角的小状态条”收敛为一个组件，复用 record-overlay 的视觉语言
// （药丸、红/蓝状态点、计时、可选结束按钮），支持 update/remove。
// 与 record-overlay 的差异：record-overlay 只服务“操作录制”；这里覆盖：
//   kind=recording 录制用户操作（红点+计时）
//   kind=capture   整页/长截图进行中（蓝色脉冲+进度文案）
//   kind=video     视频录制中（红点+计时）
//
// 约束：注入函数必须自包含（会被 chrome.scripting.executeScript 序列化），不能引用模块作用域变量；
// 主题仍由 OVERLAY_THEME 的 token 作为参数传入。
export function installStatusChip({ kind = 'recording', label = '', detail = '', lang = 'zh', theme, startedAt = 0 } = {}) {
  const ID = '__bb_status_chip_host';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const rtl = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i.test(String(lang || '')) || document.documentElement.dir === 'rtl';
  const forced = document.documentElement.getAttribute('data-bb-theme');
  const dark = forced === 'dark' || (forced !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tokens = (theme && theme[dark ? 'dark' : 'light']) || {};
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-bb-ui', 'status-chip');
  host.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('data-bb-theme', dark ? 'dark' : 'light');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  for (const [key, value] of Object.entries(tokens)) host.style.setProperty(key, value);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.chip{position:fixed;inset-inline:0;margin-inline:auto;width:max-content;bottom:64px;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:999px;background:var(--bb-surface,#1c2230);color:var(--bb-fg,#fff);font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 26px var(--bb-shadow-strong,rgba(16,24,40,.28));pointer-events:none;user-select:none}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--bb-accent,#2f6fed);box-shadow:0 0 0 3px color-mix(in srgb, var(--bb-accent,#2f6fed) 22%, transparent);animation:bbpulse 1.6s ease-in-out infinite}',
    '.chip[data-kind="recording"] .dot,.chip[data-kind="video"] .dot{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22)}',
    '@keyframes bbpulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '.label{font-weight:600}',
    '.detail{opacity:.8}',
    '.time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.85;min-width:40px}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  ].join('');
  const defaultLabel = kind === 'capture'
    ? (lang === 'en' ? 'Capturing full page' : '正在截取整页')
    : kind === 'video'
      ? (lang === 'en' ? 'Recording video' : '正在录制视频')
      : (lang === 'en' ? 'Recording your actions' : '正在录制你的操作');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="chip" data-kind="' + kind + '"><span class="dot"></span><span class="label"></span><span class="detail"></span><span class="time"></span><span class="sr" role="status" aria-live="polite"></span></div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);
  const chip = shadow.querySelector('.chip');
  const labelNode = shadow.querySelector('.label');
  const detailNode = shadow.querySelector('.detail');
  const timeNode = shadow.querySelector('.time');
  const sr = shadow.querySelector('.sr');
  labelNode.textContent = label || defaultLabel;
  detailNode.textContent = detail || '';
  sr.textContent = (label || defaultLabel) + (detail ? '；' + detail : '');
  const started = Number(startedAt) || 0;
  if (!started) timeNode.style.display = 'none';
  const tick = () => {
    if (!started) return;
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    timeNode.textContent = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  };
  tick();
  const timer = started ? setInterval(tick, 1000) : null;
  return {
    update(next = {}) {
      if (next.label) labelNode.textContent = next.label;
      if (next.detail !== undefined) { detailNode.textContent = next.detail; sr.textContent = (labelNode.textContent || '') + (next.detail ? '；' + next.detail : ''); }
      if (next.kind) chip.setAttribute('data-kind', next.kind);
    },
    remove() {
      if (timer) clearInterval(timer);
      host.remove();
    },
  };
}
