// src/human-decisions.js —— 页面回传的人为决定（borrow/help）与等待器。
const waiters = new Map();



/** 内容脚本回传用户决定（borrow 允许/拒绝、help 完成/跳过）。 */
export function resolveHumanDecision(message) {
  const requestId = message && message.requestId;
  if (!requestId) return false;
  const waiter = waiters.get(requestId);
  if (!waiter) return false;
  waiters.delete(requestId);
  clearTimeout(waiter.timer);
  waiter.resolve(message);
  return true;
}


export function waitHumanDecision(requestId, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (waiters.delete(requestId)) resolve(onTimeout());
    }, timeoutMs);
    waiters.set(requestId, { resolve, timer });
  });
}