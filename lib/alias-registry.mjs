// lib/alias-registry.mjs —— 会话内的短证据别名（o1..oN / c1..cN）。
//
// 观察 id / capture id 很长，agent 引用时容易抄错；daemon 为每个会话维护
// 单调递增的短别名，调用方可以像 @eN 一样写 --observation o2 / --capture c1。
// 别名只在本会话内有效，会话结束即清除。
export class AliasRegistry {
  constructor() {
    this.sessions = new Map();
  }

  #bucket(sessionId) {
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = { observations: [], captures: [] };
      this.sessions.set(sessionId, bucket);
    }
    return bucket;
  }

  #listFor(sessionId, kind) {
    const bucket = this.#bucket(sessionId);
    return kind === 'capture' ? bucket.captures : bucket.observations;
  }

  prefix(kind) {
    return kind === 'capture' ? 'c' : 'o';
  }

  /** 已登记过就返回同一个别名，否则追加。 */
  register(sessionId, kind, id) {
    if (!sessionId || !id) return null;
    const list = this.#listFor(sessionId, kind);
    let index = list.indexOf(String(id));
    if (index < 0) {
      list.push(String(id));
      index = list.length - 1;
    }
    return this.prefix(kind) + (index + 1);
  }

  /** 解析 oN / cN；不是别名或已过期时返回 null。 */
  resolve(sessionId, kind, alias) {
    const match = /^([oc])(\d+)$/.exec(String(alias == null ? '' : alias));
    if (!match || !sessionId) return null;
    if (match[1] !== this.prefix(kind)) return null;
    const index = Number(match[2]) - 1;
    const list = this.#listFor(sessionId, kind);
    return index >= 0 && index < list.length ? list[index] : null;
  }

  clear(sessionId) {
    if (sessionId) this.sessions.delete(sessionId);
  }
}
