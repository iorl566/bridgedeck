// lib/session-state.mjs —— 会话生命周期状态机（starting → active → stopping → gone）。
//
// daemon 用它拒绝重复 start / 重复 stop，并让 status 暴露当前阶段。
export const SESSION_PHASES = ['starting', 'active', 'stopping', 'recovering'];

export function createSessionState() {
  const states = new Map();

  function get(sessionId) {
    return states.get(String(sessionId)) || null;
  }

  function phase(sessionId) {
    return get(sessionId)?.phase || null;
  }

  function begin(sessionId) {
    const id = String(sessionId);
    const current = states.get(id);
    if (current && (current.phase === 'starting' || current.phase === 'active')) {
      const error = new Error('会话已经在启动或运行中：' + id);
      error.code = 'E_SESSION_BUSY';
      throw error;
    }
    states.set(id, { phase: 'starting', since: Date.now() });
  }

  function recover(sessionId) {
    const id = String(sessionId);
    states.set(id, { phase: 'recovering', since: Date.now() });
  }

  function activate(sessionId) {
    const current = states.get(String(sessionId));
    if (!current) {
      states.set(String(sessionId), { phase: 'active', since: Date.now() });
      return;
    }
    current.phase = 'active';
    current.since = Date.now();
  }

  function requestStop(sessionId) {
    const id = String(sessionId);
    const current = states.get(id);
    if (current && current.phase === 'stopping') return false;
    states.set(id, { phase: 'stopping', since: Date.now() });
    return true;
  }

  function finish(sessionId) {
    states.delete(String(sessionId));
  }

  function list() {
    return [...states.entries()].map(([sessionId, value]) => ({ sessionId, phase: value.phase, since: value.since }));
  }

  return { begin, recover, activate, requestStop, finish, phase, get, list };
}
