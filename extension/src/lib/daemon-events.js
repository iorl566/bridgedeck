// src/lib/daemon-events.js —— daemon 事件发送出口（由 bridge 注册，其它模块直接调用）。
//
// 背景：会话暂停状态在 daemon 侧（`session.paused`），扩展内部只改 takeover/controller
// 状态不能解开会话；而 daemon 只接受扩展的 `event` 消息。0.3.0 只有 bridge.js 内部
// 能发事件（`getClient().sendJson`），于是“帮助完成 / cooperate handback”这类
// 明确交还控制权的路径无法主动解除 daemon 的 auto pause，只能等下一次 cooperate.sync
// 的 2s/3s 空闲自动恢复——期间所有动作都被 E_SESSION_PAUSED 拒绝。
//
// 本模块把发送能力做成可注册出口：bridge 启动时注册真正的 socket 发送器，
// takeover/help 等模块通过 sendDaemonEvent 发事件；单测可以直接注册假发送器，
// 不需要起 socket，也不需要 chrome.runtime 自消息（MV3 里同上下文 sendMessage
// 不会回传给发送者，靠消息转发在这里不可靠）。

let sender = null;

/** 注册 daemon 事件发送器（bridge 唯一调用点）；传 null 可解绑（测试/断线）。 */
export function registerDaemonEventSender(fn) {
  sender = typeof fn === 'function' ? fn : null;
  return Boolean(sender);
}

/** 是否已有可用出口（测试/诊断）。 */
export function hasDaemonEventSender() {
  return typeof sender === 'function';
}

/**
 * 发送一条 daemon 事件；没有出口时返回结构化失败，不抛异常
 * （扩展可能还没连上 daemon，调用方按“best effort”处理）。
 * @param {string} event 事件名（daemon/extension-events.js 的白名单）
 * @param {object} params 事件参数（必须 JSON 可序列化）
 */
export function sendDaemonEvent(event, params = {}) {
  if (typeof sender !== 'function') return { ok: false, code: 'NO_DAEMON_LINK', event };
  try {
    sender(String(event), params && typeof params === 'object' ? params : {});
    return { ok: true, event };
  } catch (error) {
    return { ok: false, code: 'DAEMON_EVENT_FAILED', event, error: String((error && error.message) || error) };
  }
}
