// src/command-deadline.js —— 每条扩展命令的硬截止时间。
//
// bridge 用它与命令执行竞速；超时后调用 cancelCommand(id) 触发协作式取消，
// 并立刻返回 E_TIMEOUT，而不是等底层 chrome.* / CDP 自己恢复。

export const MIN_DEADLINE_MS = 1000;

export function createDeadline(ms, label = 'command') {
  const limit = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.max(MIN_DEADLINE_MS, Math.round(Number(ms))) : 60000;
  const startedAt = Date.now();
  let expired = false;
  let timer = null;
  let rejectFn = null;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    timer = setTimeout(() => {
      expired = true;
      const error = new Error(`${label} 超时（${limit}ms）`);
      error.code = 'E_TIMEOUT';
      reject(error);
    }, limit);
  });
  return {
    limit,
    startedAt,
    promise,
    get expired() { return expired; },
    remaining() { return Math.max(0, limit - (Date.now() - startedAt)); },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      // 让可能挂起的 rejectFn 不再保持引用
      rejectFn = null;
    },
  };
}
