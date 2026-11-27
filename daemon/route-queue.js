// daemon/route-queue.js —— 按会话/tab 串行队列派发命令。
//
// 首个分支：注入 commandQueue 时走 daemon/command-queue.js（session 串行 + tab 轮转公平 + 上限/诊断）；
// 未注入时保持 0.3.0 的两层 FIFO 行为（sessionQueue → tabQueue），旧调用点/单测零改动。

export async function runInQueues({ route, method, run, sessionQueue, tabQueue, bypass, commandQueue = null }) {
  const session = route && route.session ? route.session : null;
  const bypassed = Boolean(bypass && typeof bypass.has === 'function' && bypass.has(method));
  if (commandQueue && typeof commandQueue.dispatch === 'function') {
    const sessionId = session ? session.sessionId : null;
    const tabKey = session ? 'tab:' + session.tabId : null;
    return commandQueue.dispatch({ sessionId, tabKey, method, run, bypass: bypassed });
  }
  let result;
    if (route.session && !bypass.has(method)) {
      const tabKey = 'tab:' + route.session.tabId;
      // 控制权判定必须在 tab 队列内：两个会话同时写时，先到者认领租约，后到者才会被拒。
      result = await sessionQueue.enqueue(
        route.session.sessionId,
        () => tabQueue.enqueue(tabKey, run),
      );
    } else {
      result = await run();
    }
  
  return result;
}
