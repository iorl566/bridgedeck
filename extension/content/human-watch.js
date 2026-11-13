// content/human-watch.js —— 页面加载即安装人类输入监听（隔离世界，可用 chrome.runtime）
(() => {
  try {
    if (globalThis.__bbHumanWatch) return;
    globalThis.__bbHumanWatch = true;
    const send = (type) => {
      try {
        const p = chrome.runtime.sendMessage({ type, at: Date.now() });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* 忽略 */ }
    };
    let lastAt = 0;
    const onInput = (event) => {
      if (!event || event.isTrusted !== true) return;
      const marker = Number(document.documentElement.getAttribute('data-bb-agent-input') || 0);
      if (marker && Date.now() - marker < 2000) return;
      const now = Date.now();
      if (now - lastAt < 500) return;
      lastAt = now;
      send('bb.human.input');
    };
    document.addEventListener('keydown', onInput, true);
    document.addEventListener('pointerdown', onInput, true);
    window.addEventListener('blur', () => send('bb.human.blur'), true);
  } catch { /* 忽略 */ }
})();
