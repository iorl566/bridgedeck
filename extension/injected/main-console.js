// injected/main-console.js
// 在页面主世界（MAIN world）拦截 console，把条目缓冲到 globalThis.__BB_MAIN_LOG__。
//
// 重要：这份脚本不再由 manifest 静态注册（那会让扩展在用户浏览的每个页面
// 都留下被 patch 的 console/fetch/XHR，被像素扫描、rebrowser 一类检测器直接
// 识别为自动化）。现在只由 src/page-hooks.js 在真正需要时按需注入，命令结束
// 或页面卸载后由 injected/main-console-restore.js 还原原生函数。
//
// 还原契约：patch 期间把还原函数挂到 globalThis.__BB_RESTORE_HOOKS__，
// restore 脚本调用它即可回到原生实现（幂等，重复调用安全）。
(() => {
  'use strict';
  if (globalThis.__BB_RESTORE_HOOKS__) return; // 已安装

  const MAX_ENTRIES = 2000;
  const MAX_TEXT = 2000;
  const entries = [];
  const restorers = [];

  function stringify(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
    if (type === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (type === 'symbol') return String(value);
    if (value instanceof Error) return String(value.stack || value);
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (key, item) => {
        if (typeof item === 'bigint') return `${item}n`;
        if (typeof item === 'function') return `[function ${item.name || 'anonymous'}]`;
        if (typeof item === 'symbol') return String(item);
        if (item instanceof Error) return String(item.stack || item);
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
          if (item instanceof Element) {
            return `<${item.tagName.toLowerCase()}${item.id ? ` id="${item.id}"` : ''}>`;
          }
        }
        return item;
      });
    } catch {
      return String(value);
    }
  }

  function push(level, args) {
    let text;
    try {
      text = Array.from(args).map(stringify).join(' ');
    } catch {
      text = '[无法格式化的 console 参数]';
    }
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
    entries.push({ level, text, ts: Date.now() });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    const patched = function patchedConsole(...args) {
      try {
        push(level, args);
      } catch {
        // 缓冲失败不影响页面本身
      }
      return typeof original === 'function' ? original.apply(console, args) : undefined;
    };
    console[level] = patched;
    restorers.push(() => {
      if (console[level] === patched) console[level] = original;
    });
  }

  const onError = (event) => {
    try {
      const message = event.message || (event.error && event.error.message) || 'Uncaught error';
      const where = event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
      push('error', ['Uncaught: ' + message + where]);
    } catch {
      // 忽略
    }
  };
  const onRejection = (event) => {
    try {
      push('error', ['Unhandled rejection: ' + stringify(event.reason)]);
    } catch {
      // 忽略
    }
  };
  globalThis.addEventListener('error', onError, true);
  globalThis.addEventListener('unhandledrejection', onRejection);
  restorers.push(() => {
    globalThis.removeEventListener('error', onError, true);
    globalThis.removeEventListener('unhandledrejection', onRejection);
  });

  // 命令归因：页面发出的同源 fetch/XHR 带上 x-bridge-command 头，供 CDP 的
  // 请求头精确关联。仅在钩子生效期间存在。
  const originalFetch = globalThis.fetch;
  let originalXhrOpen = null;
  let originalXhrSend = null;
  if (typeof originalFetch === 'function') {
    const taggedFetch = function taggedFetch(input, init) {
      const id = commandId();
      if (!id) return originalFetch.call(this, input, init);
      try {
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        headers.set('x-bridge-command', id);
        return originalFetch.call(this, input, { ...(init || {}), headers });
      } catch {
        return originalFetch.call(this, input, init);
      }
    };
    globalThis.fetch = taggedFetch;
    restorers.push(() => {
      if (globalThis.fetch === taggedFetch) globalThis.fetch = originalFetch;
    });
  }
  const XHR = globalThis.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    originalXhrOpen = XHR.prototype.open;
    originalXhrSend = XHR.prototype.send;
    const taggedOpen = function taggedOpen(method, url, ...rest) {
      this.__bbCommandUrl = String(url || '');
      return originalXhrOpen.call(this, method, url, ...rest);
    };
    const taggedSend = function taggedSend(...args) {
      const id = commandId();
      if (id) {
        try { this.setRequestHeader('x-bridge-command', id); } catch { /* 忽略 */ }
      }
      return originalXhrSend.apply(this, args);
    };
    XHR.prototype.open = taggedOpen;
    XHR.prototype.send = taggedSend;
    restorers.push(() => {
      if (XHR.prototype.open === taggedOpen) XHR.prototype.open = originalXhrOpen;
      if (XHR.prototype.send === taggedSend) XHR.prototype.send = originalXhrSend;
    });
  }

  function commandId() {
    try { return document.documentElement.getAttribute('data-bb-command-id') || ''; } catch { return ''; }
  }

  globalThis.__BB_MAIN_LOG__ = entries;
  globalThis.__BB_COMMAND_TAG__ = true;
  globalThis.__BB_RESTORE_HOOKS__ = () => {
    for (let i = restorers.length - 1; i >= 0; i -= 1) {
      try { restorers[i](); } catch { /* 忽略 */ }
    }
    restorers.length = 0;
    try { delete globalThis.__BB_MAIN_LOG__; } catch { globalThis.__BB_MAIN_LOG__ = undefined; }
    try { delete globalThis.__BB_COMMAND_TAG__; } catch { globalThis.__BB_COMMAND_TAG__ = undefined; }
    try { delete globalThis.__BB_RESTORE_HOOKS__; } catch { globalThis.__BB_RESTORE_HOOKS__ = undefined; }
    try { document.documentElement.removeAttribute('data-bb-command-id'); } catch { /* 忽略 */ }
  };
})();
