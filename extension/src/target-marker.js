// src/target-marker.js —— Agent 当前操作目标的轻量标记。
//
// 只负责在视口坐标画一个环 + "Agent" 标签；不拦截事件，TTL 自动消失。
// 函数会被 executeScript 序列化，不能引用模块级变量。

export function installTargetMarker(x, y, ttlMs, theme) {
  const ID = '__bb_agent_target';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const px = Number(x) || 0;
  const py = Number(y) || 0;
  const ttl = Math.max(400, Math.min(Number(ttlMs) || 2000, 10000));
  const forced = document.documentElement.getAttribute('data-bb-theme');
  const dark = forced === 'dark' || (forced !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tokens = (theme && theme[dark ? 'dark' : 'light']) || {};
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-bb-ui', 'agent-target');
  host.setAttribute('data-bb-theme', dark ? 'dark' : 'light');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:' + px + 'px;top:' + py + 'px;width:0;height:0;z-index:2147483646;pointer-events:none;';
  for (const [key, value] of Object.entries(tokens)) host.style.setProperty(key, value);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>'
    + '.ring{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border:2px solid var(--bb-accent,#2f6fed);border-radius:50%;box-shadow:0 0 0 4px var(--bb-accent-soft,rgba(47,111,237,.25));animation:bbtarget 1.4s ease-out infinite}'
    + '.tag{position:absolute;left:18px;top:-13px;padding:2px 7px;border-radius:999px;background:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff);font:600 10px/1.4 system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 12px var(--bb-shadow,rgba(16,24,40,.2))}'
    + '@keyframes bbtarget{0%{transform:scale(.7);opacity:.9}70%{transform:scale(1.15);opacity:.35}100%{transform:scale(1);opacity:.9}}'
    + '</style><div class="ring"></div><div class="tag">Agent</div>';
  document.documentElement.appendChild(host);
  globalThis['set' + 'Timeout'](() => host.remove(), ttl);
  return { ok: true, x: px, y: py, ttl };
}
