// src/operations.js —— 被弹窗挂起的动作登记表（operation await/cancel）
const OPERATION_TTL_MS = 5 * 60 * 1000;
const OPERATION_MAX = 64;
const operations = new Map();

function pruneOperations() {
  const now = Date.now();
  for (const [id, operation] of operations) {
    if (operation.settled && now - operation.startedAt > OPERATION_TTL_MS) operations.delete(id);
  }
  if (operations.size <= OPERATION_MAX) return;
  const ordered = [...operations.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
  while (operations.size > OPERATION_MAX && ordered.length) {
    const [id] = ordered.shift();
    operations.delete(id);
  }
}

export function registerOperation(operation) {
  pruneOperations();
  operations.set(operation.id, operation);
  return operation;
}

export function settleOperation(operation, payload) {
  if (!operation) return;
  operation.settled = true;
  operation.state = payload.state;
  operation.payload = payload;
  const waiters = operation.waiters.splice(0);
  for (const resolve of waiters) resolve(payload);
}

export function awaitOperation(id, timeoutMs) {
  const operation = operations.get(id);
  if (!operation) return Promise.resolve({ state: 'unknown' });
  if (operation.settled) return Promise.resolve(operation.payload);
  if (operation.cancelled) return Promise.resolve({ state: 'cancelled' });
  const limit = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 300000);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ state: 'running' });
    }, limit);
    operation.waiters.push((payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function cancelOperation(id) {
  const operation = operations.get(id);
  if (!operation) return { ok: false, error: '未知 operation：' + id };
  operation.cancelled = true;
  settleOperation(operation, { state: 'cancelled' });
  return { ok: true, id };
}
