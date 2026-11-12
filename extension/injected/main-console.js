// injected/main-console.js
// 在页面主世界（MAIN world）拦截 console，把条目缓冲到 globalThis.__BB_MAIN_LOG__。
// 只在主文档、document_start 注入；导航后随文档重建，缓冲自然清空。
// 隔离世界（ISOLATED）读不到主世界的变量，所以 console 命令用 world:'MAIN' 注入读取。
(() => {
  'use strict';
  if (globalThis.__BB_MAIN_LOG__ && typeof globalThis.__BB_MAIN_LOG__.push === 'function') return;

  const MAX_ENTRIES = 2000;
  const MAX_TEXT = 2000;
  const entries = [];

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
    console[level] = function patchedConsole(...args) {
      try {
        push(level, args);
      } catch {
        // 缓冲失败不影响页面本身
      }
      return typeof original === 'function' ? original.apply(console, args) : undefined;
    };
  }

  // 未捕获异常也进同一缓冲（「网站调试」的「异常」来源）
  globalThis.addEventListener('error', (event) => {
    try {
      const message = event.message || (event.error && event.error.message) || 'Uncaught error';
      const where = event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
      push('error', ['Uncaught: ' + message + where]);
    } catch {
      // 忽略
    }
  }, true);
  globalThis.addEventListener('unhandledrejection', (event) => {
    try {
      push('error', ['Unhandled rejection: ' + stringify(event.reason)]);
    } catch {
      // 忽略
    }
  });

  // 命令归因：页面发出的同源 fetch/XHR 带上 x-bridge-command 头，供 webRequest 精确关联。
  if (!globalThis.__BB_COMMAND_TAG__) {
    globalThis.__BB_COMMAND_TAG__ = true;
    const commandId = () => {
      try { return document.documentElement.getAttribute('data-bb-command-id') || ''; } catch { return ''; }
    };
    const sameOrigin = (url) => {
      try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
    };
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === 'function') {
      globalThis.fetch = function taggedFetch(input, init) {
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
    }
    const XHR = globalThis.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      XHR.prototype.open = function taggedOpen(method, url, ...rest) {
        this.__bbCommandUrl = String(url || '');
        return originalOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.send = function taggedSend(...args) {
        const id = commandId();
        if (id) {
          try { this.setRequestHeader('x-bridge-command', id); } catch { /* 忽略 */ }
        }
        return originalSend.apply(this, args);
      };
    }
  }

  globalThis.__BB_MAIN_LOG__ = entries;
})();
