// lib/session-queue.mjs —— 每 session 串行队列（容量/关闭/快照）。
//
// daemon 只负责把命令提交进来；队列保证同一 session 的命令按顺序执行，
// 避免扩展侧 ref-store / debugger / 输入状态被并发工具调用踩踏。

export const DEFAULT_QUEUE_CAPACITY = 64;

export class SessionQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createSessionQueue({ capacity = DEFAULT_QUEUE_CAPACITY } = {}) {
  const limit = Number(capacity) > 0 ? Number(capacity) : DEFAULT_QUEUE_CAPACITY;
  const queues = new Map();
  const closed = new Set();

  function enqueue(sessionId, task) {
    const id = String(sessionId);
    if (closed.has(id)) {
      return Promise.reject(new SessionQueueError('E_SESSION_STOPPED', '会话 ' + id + ' 已停止'));
    }
    let queue = queues.get(id);
    if (!queue) {
      queue = { chain: Promise.resolve(), size: 0, closed: false };
      queues.set(id, queue);
    }
    if (queue.closed) {
      return Promise.reject(new SessionQueueError('E_SESSION_STOPPED', '会话 ' + id + ' 已停止'));
    }
    if (queue.size >= limit) {
      return Promise.reject(new SessionQueueError('E_QUEUE_FULL', '会话 ' + id + ' 的命令队列已满（' + limit + '）'));
    }
    queue.size += 1;
    const run = queue.chain.then(task, task);
    queue.chain = run.then(() => {}, () => {});
    return run.finally(() => {
      queue.size -= 1;
    });
  }

  function drop(sessionId) {
    const id = String(sessionId);
    closed.add(id);
    const queue = queues.get(id);
    if (queue) queue.closed = true;
    queues.delete(id);
  }

  function snapshot() {
    return [...queues.entries()].map(([sessionId, queue]) => ({
      sessionId,
      pending: queue.size,
      closed: queue.closed === true,
    }));
  }

  return { capacity: limit, enqueue, drop, snapshot };
}
