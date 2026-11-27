// src/content/record-overlay.ts —— 页面内“正在录制你的操作”浮层（自包含注入函数）。
//
// record.start 时由 background 通过 `chrome.scripting.executeScript` 注入到目标标签页主文档；
// record.stop 时注入 `removeRecordOverlay` 移除。E2E 24c 用页面 HTML 里是否出现
// `__bb_record_host` 判定浮层出现/移除。
//
// 约束（与 src/record/capture.ts 相同）：executeScript({func}) 序列化函数源码后执行，
// 函数体不能引用模块作用域符号；这里所有 helper 都内联，类型只用 `import type`。
//
// 设计：
// - closed shadow DOM：页面样式（含 `* { }` 重置）不会影响浮层，浮层也不污染页面；
// - host 固定 `position:fixed;inset:0;pointer-events:none`，只有胶囊可交互；
// - role=status + aria-live=polite：开始/结束对屏幕阅读器播报，但不抢页面焦点；
// - 结束按钮 / Esc → 移除浮层 + 发 `bb.record.finish`（background 停录落库）。

import type { RecordOverlayInstallResult } from '../record/types.ts';

export interface RecordOverlayOptions {
  startedAt?: number;
  lang?: string;
  /** 强制深/浅色（缺省跟随系统）。 */
  theme?: 'dark' | 'light';
}

/**
 * 注入录制浮层（幂等：同名 host 已存在时先移除再重建）。
 * 返回是否成功注入（无 DOM 的注入上下文返回 false）。
 */
export function installRecordOverlay(
  startedAt: number | undefined,
  lang: string | undefined,
  theme?: 'dark' | 'light',
): RecordOverlayInstallResult {
  const ID = '__bb_record_host';
  // 注意：executeScript({func}) 会丢掉模块作用域，注入函数内所有依赖必须本地定义。
  const RTL_LANG = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc || !doc.documentElement) return { ok: false, reason: 'no-dom' };
  const win = window as unknown as Window & { matchMedia?: (query: string) => { matches: boolean } };
  const language = String(lang || 'zh').toLowerCase();
  const isEnglish = language.startsWith('en');
  const label = isEnglish ? 'Recording your actions' : '正在录制你的操作';
  const finishText = isEnglish ? 'Finish' : '结束';
  const a11yStart = isEnglish ? 'Recording your actions; press Escape to finish' : '正在录制你的操作，按 Esc 结束';

  const old = doc.getElementById(ID);
  if (old) old.remove();
  // 重复注入时上一份浮层的计时器必须清掉，否则常驻 interval 会泄漏（Node 单测会挂住）。
  const previousTimer = (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer;
  if (previousTimer) clearInterval(previousTimer);
  const host = doc.createElement('div');
  host.id = ID;
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', label);
  host.setAttribute('aria-keyshortcuts', 'Escape');
  const rtl = RTL_LANG.test(language) || doc.documentElement.dir === 'rtl';
  host.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : null;
  if (!shadow) return { ok: false, reason: 'no-shadow' };
  const forcedDark = theme === 'dark';
  const forcedLight = theme === 'light';
  const prefersDark = Boolean(win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = forcedDark || (!forcedLight && prefersDark);
  host.setAttribute('data-bb-theme', dark ? 'dark' : 'light');

  const style = doc.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '.bb-pill{position:fixed;inset-inline-start:18px;bottom:18px;display:flex;align-items:center;gap:9px;',
    'padding:8px 10px 8px 12px;border-radius:999px;background:#1c2230;color:#fff;',
    'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 26px rgba(16,24,40,.28);',
    'pointer-events:auto;cursor:grab;user-select:none;max-width:min(80vw,420px)}',
    '.bb-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22);',
    'animation:bbpulse 1.6s ease-in-out infinite;flex:0 0 auto}',
    '@keyframes bbpulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '.bb-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bb-time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.8;min-width:42px}',
    '.bb-finish{height:24px;padding:0 10px;border:0;border-radius:999px;background:#ef4444;color:#fff;',
    'font-size:11px;font-weight:600;cursor:pointer}',
    '.bb-finish:focus-visible{outline:2px solid #6fa0ff;outline-offset:2px}',
  ].join('');
  const pill = doc.createElement('div');
  pill.className = 'bb-pill';
  pill.setAttribute('tabindex', '0');
  const dot = doc.createElement('span');
  dot.className = 'bb-dot';
  const labelNode = doc.createElement('span');
  labelNode.className = 'bb-label';
  labelNode.textContent = label;
  const time = doc.createElement('span');
  time.className = 'bb-time';
  time.textContent = '00:00';
  const finish = doc.createElement('button');
  finish.className = 'bb-finish';
  finish.setAttribute('type', 'button');
  finish.setAttribute('aria-label', finishText);
  finish.textContent = finishText;
  const live = doc.createElement('span');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.textContent = a11yStart;
  live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
  pill.append(dot, labelNode, time, finish, live);
  shadow.append(style, pill);
  doc.documentElement.appendChild(host);

  const started = Number(startedAt) || Date.now();
  const tick = (): void => {
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    time.textContent = mm + ':' + ss;
  };
  tick();
  const timer = setInterval(tick, 1000);
  (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer = timer;

  const remove = (): void => {
    const running = (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer;
    if (running) clearInterval(running);
    (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer = undefined;
    if (host.isConnected !== false) host.remove();
  };
  const finishRecording = (): void => {
    remove();
    try {
      const chromeApi = (globalThis as unknown as {
        chrome?: { runtime?: { sendMessage?: (message: unknown) => unknown } };
      }).chrome;
      if (chromeApi && chromeApi.runtime && typeof chromeApi.runtime.sendMessage === 'function') {
        const reply = chromeApi.runtime.sendMessage({ type: 'bb.record.finish' });
        if (reply && typeof (reply as { catch?: unknown }).catch === 'function') {
          (reply as Promise<unknown>).catch(() => undefined);
        }
      }
    } catch {
      // 后台不可达时浮层仍然要关闭
    }
  };
  finish.addEventListener('click', finishRecording);
  pill.addEventListener('keydown', (event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    finishRecording();
  });

  return { ok: true, existing: false };
}

/** 移除录制浮层（record.stop 时注入；页面里没有浮层也返回 ok）。 */
export function removeRecordOverlay(): boolean {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc) return false;
  const ID = '__bb_record_host';
  const timer = (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer;
  if (timer) clearInterval(timer);
  (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer = undefined;
  const host = doc.getElementById(ID);
  if (!host) return false;
  host.remove();
  return true;
}
