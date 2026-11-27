// src/cooperation.js —— 协作输入层的后台侧：输入锁、passthrough、controller 快照与 authority 对齐。
//
// 0.3.0 之后本模块承担四件事：
//   1. 输入锁（bb.cooperation.block）与一次性 passthrough 租约的签发/消费；
//   2. authority 对齐：内容脚本拒绝旧 generation 时抬到内容权威代 +1 再重试一次；
//   3. 四项 revision/epoch 的推进与 stale 证据（委托 control-generation/revision-chain）；
//   4. controller/toolbar 只读快照：把 takeove/borrow/浮层/capture 抑制/归因证据
//      聚合给 UI 与 CLI（cooperate sync / 状态查询）读。
import { withTimeout } from './timeout.js';
import { bridgeError } from './errors.js';
import { log } from './log.js';
import {
  alignControlGeneration,
  bumpControlGeneration,
  controlGeneration,
  controlGenerationRecord,
  observeControlRevisions,
  raiseControlGeneration,
} from './control-generation.js';
import { execPageAllFrames } from './inject.js';
import { captureSuppression } from './lib/capture-suppression.js';
import { passthroughTokens, TOKEN_ERROR } from './lib/passthrough-token.js';
import { mergeCooperationFrames } from './lib/cooperation-aggregate.js';
import { controllerState } from './lib/controller-state.js';
import { borrowGate } from './lib/borrow-confirm.js';
import { suppressionScope } from './lib/suppression-scope.js';
import { getOverlayState } from './overlay-state.js';
import { getHumanState } from './human-state.js';
import { buildHumanInputEvidence, describeHumanInput } from './lib/attribution-evidence.js';
import { buildControllerToolbarSnapshot, describeControllerToolbar } from './lib/controller-toolbar.js';

const PASSTHROUGH_TTL_MS = 30000;

/** tab id 规整：null/''/非数字都视为没有 tab（Number(null)===0 会把“没传”误判成 tab 0）。 */
function tabIdOf(tabId) {
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

/** passthrough 租约的 grantee：绑定到 tab，跨 tab 消费会被 E_TOKEN_GRANTEE 拒绝。 */
function passthroughGrantee(tabId) {
  const id = Number(tabId);
  return Number.isInteger(id) ? 'coop:' + id : 'coop:unknown';
}

async function send(tabId, message) {
  if (tabIdOf(tabId) == null) return null;
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

function isStale(reply) {
  return Boolean(reply && reply.ok === false && reply.stale === true);
}

/**
 * 最近一次协作读取的缓存（per tab）：四项 revision 的 DOM 侧与多 frame 归因证据都
 * 从这里取，避免快照接口为了一个字段再注入一次脚本。
 */
const lastCooperationRead = new Map(); // tabId -> { at, merged, frames }
/** 最近一次 authority 对齐证据（per tab），供快照报告 stale 方向。 */
const lastAlignment = new Map();

function rememberCooperationRead(tabId, merged, frames) {
  const id = tabIdOf(tabId);
  if (id == null) return merged;
  if (merged) {
    lastCooperationRead.set(id, { at: Date.now(), merged, frames: Array.isArray(frames) ? frames : [] });
    const aggregate = merged.aggregateFrameState || merged.frameState || {};
    const revision = Number.isInteger(merged.revision) ? merged.revision : aggregate.revision;
    if (Number.isInteger(revision)) {
      // 同文档取 max、换文档重置并推进 frameEpoch（revision-chain 的 observe 语义）。
      observeControlRevisions(id, { revision, document: aggregate.document || '' });
    }
  }
  return merged;
}

function rememberAlignment(tabId, alignment) {
  const id = tabIdOf(tabId);
  if (id == null || !alignment) return;
  lastAlignment.set(id, { ...alignment, at: Date.now() });
}

/**
 * 带 authority 对齐的协作消息：内容脚本拒绝旧 generation 时，把后台 generation
 * 抬到内容脚本权威代 +1 后重试一次。绝不对"旧 authority"静默降级，也绝不让
 * service worker 重启后的 generation 回退把动作卡死。
 */
async function sendWithAuthority(tabId, buildMessage, generation) {
  const id = Number(tabId);
  const requested = Number.isInteger(Number(generation)) ? Number(generation) : controlGeneration(id);
  let reply = await send(id, buildMessage(requested));
  if (!isStale(reply)) return reply;
  const contentGeneration = Number(reply.generation);
  const next = Number.isInteger(contentGeneration) && contentGeneration >= requested
    ? raiseControlGeneration(id, contentGeneration + 1)
    : bumpControlGeneration(id);
  const alignment = alignControlGeneration(id, { generation: Number.isInteger(contentGeneration) ? contentGeneration : 0 });
  rememberAlignment(id, alignment);
  log('cooperation authority stale：tab=' + id + ' requested=' + requested + ' content=' + (Number.isInteger(contentGeneration) ? contentGeneration : '?') + ' retry=' + next);
  reply = await send(id, buildMessage(next));
  if (isStale(reply)) {
    throw bridgeError('E_COOPERATION_STALE', '协作输入层 authority 已失效且无法重新对齐（tab ' + id + '）');
  }
  return reply;
}

/** 读取当前页面的协作快照（字段/媒体/焦点/文本尾部）；失败返回 { ok:false }。 */
export async function readCooperation(tabId) {
  const reply = await send(tabId, { type: 'bb.cooperation.read' });
  const state = reply && reply.ok === true ? reply.state : null;
  if (state) {
    const frames = [{ frameId: 0, url: (state.frameState && state.frameState.document) || '', hidden: false, state }];
    rememberCooperationRead(tabId, mergeCooperationFrames(frames, { topFrameId: 0 }), frames);
  }
  return state;
}

/** 读取所有 frame 的协作快照并聚合；隐藏 frame 记入 frameGaps。没有可读 frame 时返回 null。 */
export async function readCooperationFrames(tabId) {
  if (tabIdOf(tabId) == null) return null;
  const injected = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), allFrames: true },
    world: 'ISOLATED',
    func: () => {
      try {
        const api = globalThis.__bbCooperation;
        return api && typeof api.readState === 'function' ? api.readState() : null;
      } catch {
        return null;
      }
    },
  }).catch(() => []);
  const entries = (Array.isArray(injected) ? injected : [])
    .filter((item) => item && item.result)
    .map((item) => ({ frameId: item.frameId, result: item.result }));
  if (!entries.length) return null;
  const metas = await execPageAllFrames(tabId, 'frame-meta', {}).catch(() => []);
  const hiddenByFrame = new Map(
    (Array.isArray(metas) ? metas : [])
      .filter((item) => item && item.result)
      .map((item) => [item.frameId, item.result.hidden === true]),
  );
  const frames = entries.map((item) => ({
    frameId: item.frameId,
    url: (item.result && item.result.url) || '',
    hidden: hiddenByFrame.get(item.frameId) === true,
    state: item.result,
  }));
  const merged = mergeCooperationFrames(frames, { topFrameId: 0 });
  return rememberCooperationRead(tabId, merged, frames);
}

/** 打开/关闭页面输入锁；返回内容脚本确认的状态。authority stale 时尝试对齐。 */
export async function setCooperationBlocked(tabId, blocked, generation) {
  try {
    const reply = await sendWithAuthority(
      tabId,
      (gen) => ({ type: 'bb.cooperation.block', blocked: Boolean(blocked), generation: gen }),
      generation,
    );
    return reply && reply.ok === true ? reply.blocked === true : false;
  } catch (error) {
    // 输入锁本身是"提示/保护"而非动作，无法对齐时记录并保持无锁，不阻断调用方。
    log('cooperation block 失败：' + ((error && error.message) || error));
    return false;
  }
}

/** passthrough 开始时把 controller 标记为 Agent 动作中（held/handoff 不翻转状态）。 */
function noteAgentActivity(tabId, source) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const current = controllerState.get(id);
  if (current === 'held') {
    // 暂停中不应该有 passthrough；保留 held 状态并留拒绝证据，避免被动作偷偷解除。
    const gate = controllerState.actionGate(id, source);
    log('cooperation passthrough 在 held 状态下开始：tab=' + id + '（保持暂停）');
    return gate;
  }
  const moved = controllerState.transition(id, 'agent.claim', { source, holder: passthroughGrantee(id) });
  if (!moved.ok) log('cooperation controller 迁移被拒绝：' + moved.code + ' tab=' + id);
  return moved;
}

/** 为一次 Agent 输入打开 passthrough（锁失效），返回一次性租约 token；expectation 描述本次输入类型。 */
export async function beginCooperationPassthrough(tabId, generation, expectation = null, options = {}) {
  const grantee = passthroughGrantee(tabId);
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PASSTHROUGH_TTL_MS;
  const minted = passthroughTokens.mint({ grantee, ttlMs });
  if (!minted.ok) {
    // 令牌存储异常（grantee 缺失/超上限）：按“无租约”降级，不阻断调用方。
    log('cooperation passthrough 令牌签发失败：' + minted.code);
    return null;
  }
  const lease = minted.token;
  try {
    const reply = await sendWithAuthority(
      tabId,
      (gen) => ({ type: 'bb.cooperation.passthrough', token: lease, active: true, generation: gen, ...(expectation ? { expectation } : {}) }),
      generation,
    );
    if (!(reply && reply.ok === true)) {
      // 内容脚本没接受：撤销令牌，避免悬挂的一次性租约。
      passthroughTokens.revoke(lease);
      return null;
    }
    noteAgentActivity(tabId, 'passthrough');
    return lease;
  } catch (error) {
    passthroughTokens.revoke(lease);
    throw error;
  }
}

/** 结束一次 passthrough：消费令牌（幂等）并通知内容脚本恢复；返回结构化结果。 */
export async function endCooperationPassthrough(tabId, lease) {
  if (!lease) return { ok: false, code: TOKEN_ERROR.UNKNOWN, error: '没有租约' };
  const consumed = passthroughTokens.consume(lease, passthroughGrantee(tabId));
  // 即使令牌已过期/已用/越权，也照旧通知内容脚本清理，保证输入锁一定恢复。
  await send(tabId, { type: 'bb.cooperation.passthrough', token: lease, active: false });
  return consumed;
}

/** 精确归因：给内容脚本一个带坐标/类型的 Agent 输入期待（点击前调用）。 */
export async function armCooperationExpectation(tabId, expectation) {
  if (!expectation || typeof expectation !== 'object') return;
  await send(tabId, { type: 'bb.cooperation.expect', expectation });
}

/** 清掉该 tab 所有 passthrough 租约（录制开始/结束时）：撤销令牌 + 通知内容脚本。 */
export async function clearCooperationPassthroughs(tabId) {
  const revoked = passthroughTokens.clearGrantee(passthroughGrantee(tabId));
  await send(tabId, { type: 'bb.cooperation.passthrough-clear' });
  return revoked;
}

/** 只读校验一个 passthrough 租约（不消费）：返回结构化结果，供诊断/决策使用。 */
export function verifyCooperationPassthrough(tabId, lease) {
  return passthroughTokens.verify(lease, passthroughGrantee(tabId));
}

/**
 * 注册“控制器外部来源”（目前是 takeover 状态）。用注册而不是直接 import，
 * 是为了避免 cooperation ↔ takeover 的循环依赖（takeover 依赖 setCooperationBlocked）。
 */
const controllerSources = new Map();
export function registerControllerSource(name, reader) {
  const key = String(name || '');
  if (!key || typeof reader !== 'function') return controllerSources.size;
  controllerSources.set(key, reader);
  return controllerSources.size;
}

function readControllerSource(name, tabId, fallback = null) {
  const reader = controllerSources.get(String(name));
  if (typeof reader !== 'function') return fallback;
  try {
    const value = reader(tabId);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * controller/borrow/toolbar 只读快照（UI 与 CLI 共用）。纯聚合：不触发页面注入、
 * 不改任何状态；数据来源是内存中的 controller 状态机、借用闸门、浮层注册表、
 * capture 抑制、passthrough 租约与最近一次协作读取的归因证据。
 */
export function cooperationControllerSnapshot(tabId, options = {}) {
  const id = tabIdOf(tabId);
  const valid = id != null;
  if (!valid) {
    return buildControllerToolbarSnapshot({ tabId: null, at: Date.now(), controller: null, takeover: null, borrow: null, overlays: null, capture: null, suppression: null, passthrough: null, human: null, revisions: null });
  }
  const takeover = readControllerSource('takeover', id, {});
  const overlays = getOverlayState(id);
  const borrowStatus = borrowGate.status(id);
  const capture = captureSuppression.snapshot(id);
  const suppression = suppressionScope.snapshot(id);
  const revisions = controlGenerationRecord(id) || {};
  const alignment = lastAlignment.get(id) || null;
  const read = lastCooperationRead.get(id) || null;
  const frameState = read && read.merged ? (read.merged.aggregateFrameState || read.merged.frameState) : null;
  const humanInput = options.humanInput !== undefined
    ? options.humanInput
    : buildHumanInputEvidence({
      frameState: frameState || {},
      frames: read ? read.frames : [],
      humanState: getHumanState(id),
      expectation: options.expectation || null,
      agentWindow: options.agentWindow || null,
      now: Date.now(),
    });
  const borrow = borrowStatus
    ? {
      status: borrowStatus.status,
      requestId: borrowStatus.requestId,
      requestedAt: borrowStatus.requestedAt,
      pendingMs: borrowStatus.pendingMs,
      timeoutMs: borrowStatus.timeoutMs,
      surface: borrowStatus.surface,
      title: borrowStatus.title,
      decision: borrowStatus.decision,
      controlled: takeover && takeover.borrowed === true,
    }
    : { status: 'none', controlled: Boolean(takeover && takeover.borrowed === true) };
  const snapshot = buildControllerToolbarSnapshot({
    tabId: id,
    at: Date.now(),
    controller: controllerState.snapshot(id),
    takeover,
    borrow,
    overlays,
    capture,
    suppression,
    passthrough: { list: passthroughTokens.list(passthroughGrantee(id)) },
    human: humanInput,
    revisions: { ...revisions, stale: Boolean(alignment && alignment.stale), staleSide: alignment ? alignment.side : null, alignedAt: alignment ? alignment.at : 0 },
    generation: controlGeneration(id),
    agentWindow: options.agentWindow || null,
  });
  return snapshot;
}

/**
 * 协作运行时状态：capture 引用计数抑制（overlay-suppress 共用同一单例）+ 本 tab
 * 的 passthrough 租约 + controller/toolbar 快照。只读，供诊断/悬浮窗/CLI 读取。
 */
export function cooperationRuntimeState(tabId) {
  const id = tabIdOf(tabId);
  const valid = id != null;
  const snapshot = cooperationControllerSnapshot(valid ? id : null);
  return {
    tabId: valid ? id : null,
    capture: captureSuppression.snapshot(valid ? id : null),
    captures: captureSuppression.list(),
    passthrough: passthroughTokens.list(valid ? passthroughGrantee(id) : undefined),
    controller: snapshot.controller,
    toolbar: snapshot.toolbar,
    borrow: snapshot.borrow,
    revisions: snapshot.revisions,
    humanInput: snapshot.human,
    suppression: snapshot.suppression,
    blocking: snapshot.blocking,
    summary: describeControllerToolbar(snapshot),
    attributionSummary: describeHumanInput(snapshot.human),
  };
}

/** 顶部 frame 的归因一页摘要（CLI `cooperate sync` 用）：不需要再次注入页面。 */
export function cooperationAttributionSummary(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return null;
  const read = lastCooperationRead.get(id);
  if (!read) return null;
  return buildHumanInputEvidence({
    frameState: read.merged ? (read.merged.aggregateFrameState || read.merged.frameState) : {},
    frames: read.frames,
    humanState: getHumanState(id),
    now: Date.now(),
  });
}

/** 最近一次协作读取的合并快照（服务同步/归因用），没有读取过时返回 null。 */
export function lastCooperationFrames(tabId) {
  const id = tabIdOf(tabId);
  const read = id == null ? null : lastCooperationRead.get(id);
  return read ? read.merged : null;
}

/** tab 关闭/会话结束：清掉本 tab 的缓存（避免长生命周期 SW 里无界增长）。 */
export function forgetCooperation(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return { ok: false };
  lastCooperationRead.delete(id);
  lastAlignment.delete(id);
  passthroughTokens.clearGrantee(passthroughGrantee(id));
  return { ok: true };
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
