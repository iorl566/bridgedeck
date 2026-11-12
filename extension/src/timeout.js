// src/timeout.js —— 给可能挂起的 chrome.* 调用加硬超时
/**
 * 把 promise 包成带超时的版本。超时后 reject 一个带 message 的 Error，
 * 调用方按普通错误处理，避免整条命令被 60s 命令超时兜底。
 */
export function withTimeout(promise, ms, label) {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : 10000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error((label || 'chrome API') + ' 超时（' + limit + 'ms）'));
    }, limit);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
