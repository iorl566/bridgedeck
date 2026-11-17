// src/cooperation.js —— 协作输入层的后台侧：输入锁与 passthrough 的 RPC 封装。
import { withTimeout } from './timeout.js';

function token() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* 忽略 */ }
  return 'coop-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

async function send(tabId, message) {
  if (!Number.isInteger(Number(tabId))) return null;
  try {
    return await withTimeout(
      chrome.tabs.sendMessage(Number(tabId), message, { frameId: 0 }),
      1500,
      'cooperation message',
    );
  } catch {
    // 受限页面/标签已关闭/内容脚本未就绪：调用方按"无锁"继续。
    return null;
  }
}

/** 读取当前页面的协作快照（字段/媒体/焦点/文本尾部）；失败返回 { ok:false }。 */
export async function readCooperation(tabId) {
  const reply = await send(tabId, { type: 'bb.cooperation.read' });
  return reply && reply.ok === true ? reply.state : null;
}

/** 打开/关闭页面输入锁；返回内容脚本确认的状态。 */
export async function setCooperationBlocked(tabId, blocked) {
  const reply = await send(tabId, { type: 'bb.cooperation.block', blocked: Boolean(blocked) });
  return reply && reply.ok === true ? reply.blocked === true : false;
}

/** 为一次 Agent 输入打开 passthrough（锁失效），返回 token；失败返回 null。 */
export async function beginCooperationPassthrough(tabId) {
  const lease = token();
  const reply = await send(tabId, { type: 'bb.cooperation.passthrough', token: lease, active: true });
  return reply && reply.ok === true ? lease : null;
}

/** 结束一次 passthrough。 */
export async function endCooperationPassthrough(tabId, lease) {
  if (!lease) return;
  await send(tabId, { type: 'bb.cooperation.passthrough', token: lease, active: false });
}

/** 清掉该 tab 所有 passthrough 租约（录制开始/结束时与 bsk 对齐）。 */
export async function clearCooperationPassthroughs(tabId) {
  await send(tabId, { type: 'bb.cooperation.passthrough-clear' });
}

/** 包住一次 Agent 原生输入：进入时解锁，结束后恢复。 */
export async function withCooperationPassthrough(tabId, fn) {
  const lease = await beginCooperationPassthrough(tabId);
  try {
    return await fn();
  } finally {
    if (lease) await endCooperationPassthrough(tabId, lease);
  }
}
