// content/human-watch.js —— 页面加载即安装人类输入监听（隔离世界，可用 chrome.runtime）
(() => {
  try {
    if (globalThis.__bbHumanWatch) return;
    globalThis.__bbHumanWatch = true;
    const send = (type, extra) => {
      try {
        const p = chrome.runtime.sendMessage(Object.assign({ type, at: Date.now() }, extra));
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* 忽略 */ }
    };
    const labelOf = (el) => String(
      el.getAttribute('aria-label')
      || el.getAttribute('name')
      || el.getAttribute('placeholder')
      || el.id
      || el.tagName
      || ''
    ).trim().slice(0, 120);
    const isSensitive = (el) => {
      const type = String(el.type || '').toLowerCase();
      const auto = String(el.getAttribute('autocomplete') || '').toLowerCase();
      return type === 'password' || type === 'file' || auto.includes('password') || auto.includes('one-time-code');
    };
    const snapshot = () => {
      const fields = [];
      for (const el of document.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
        if (fields.length >= 50) break;
        const sensitive = isSensitive(el);
        fields.push({
          selector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
          label: labelOf(el),
          value: sensitive ? '' : String(el.value != null ? el.value : el.textContent || '').slice(0, 200),
          sensitive,
          checked: el.checked === true,
        });
      }
      const media = [];
      for (const el of document.querySelectorAll('video,audio')) {
        if (media.length >= 10) break;
        media.push({
          selector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
          currentTime: Number(el.currentTime) || 0,
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          paused: el.paused === true,
          ended: el.ended === true,
        });
      }
      const active = document.activeElement;
      const editing = Boolean(active && (active.matches('input,textarea,select,[contenteditable="true"]')));
      const bodyText = document.body ? String(document.body.innerText || '') : '';
      return {
        fields,
        media,
        focus: active && active !== document.body ? labelOf(active) : null,
        editing,
        textLength: bodyText.length,
        textTail: bodyText.slice(-500),
      };
    };
    let timer = null;
    let lastFlush = 0;
    const flush = () => {
      timer = null;
      lastFlush = Date.now();
      send('bb.human.activity', { state: snapshot() });
    };
    const schedule = () => {
      const now = Date.now();
      if (now - lastFlush > 400) flush();
      else if (!timer) timer = setTimeout(flush, Math.max(0, 400 - (now - lastFlush)));
    };
    const onInput = (event) => {
      if (!event || event.isTrusted !== true) return;
      const marker = Number(document.documentElement.getAttribute('data-bb-agent-input') || 0);
      if (marker && Date.now() - marker < 10000) return;
      lastAt = Date.now();
      schedule();
    };
    let lastAt = 0;
    for (const type of ['keydown', 'pointerdown', 'input', 'change', 'focusin']) {
      document.addEventListener(type, onInput, true);
    }
    window.addEventListener('blur', () => {
      lastAt = 0;
      send('bb.human.blur');
    }, true);
    window.addEventListener('pagehide', () => {
      if (timer) clearTimeout(timer);
    }, true);
  } catch { /* 忽略 */ }
})();
