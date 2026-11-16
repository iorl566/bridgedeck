// injected/main-console-restore.js
// 还原 injected/main-console.js 打过的主世界补丁（console / fetch / XHR），
// 并清掉 __BB_MAIN_LOG__、__BB_COMMAND_TAG__、data-bb-command-id 这些可被
// 页面读到的标记。幂等：没有安装过时什么也不做。
(() => {
  'use strict';
  try {
    if (typeof globalThis.__BB_RESTORE_HOOKS__ === 'function') {
      globalThis.__BB_RESTORE_HOOKS__();
      return 'restored';
    }
    try { document.documentElement.removeAttribute('data-bb-command-id'); } catch { /* 忽略 */ }
    return 'idle';
  } catch (error) {
    return 'error: ' + String((error && error.message) || error);
  }
})();
