// src/browser-driver/cdp-frames.js —— 扁平 frame 发现与 FrameGraph（ChromiumCdp mixin）。
import { CdpReadTimeoutError, READ_TIMEOUT_MS } from './command-deadline.js';
import { buildFrameGraph, omitFrameSubtrees } from './frame-graph.js';
import { settleBeforeDeadline } from './cdp-timing.js';

const FRAME_DISCOVERY_TIMEOUT_MS = 1_000;
const FRAME_DISCOVERY_QUIET_MS = 20;

export class CdpFrameMethods {
  /**
   * Return the per-tab frame discovery cache, creating it on first use.
   * @param {number} tabId
   * @returns {FrameDiscoveryState}
   */
  frameDiscoveryState(tabId) {
    let state = this.frameDiscovery.get(tabId);
    if (!state) {
      state = { sessions: new Set(), pending: new Set(), generation: 0, enabled: new Map(), frameIds: new Map() };
      this.frameDiscovery.set(tabId, state);
    }
    return state;
  }
  /**
   * Enable flattened target auto-attach for one target. The promise is shared
   * per target key so concurrent discovery does not resend the command, and a
   * failed attempt is forgotten so the next read retries.
   * @param {CdpTarget} target
   * @returns {Promise<void>}
   */
  enableFrameDiscovery(target) {
    const state = this.frameDiscoveryState(target.tabId);
    const key = target.sessionId ?? 'root';
    const existing = state.enabled.get(key);
    if (existing) return existing;
    let issued = false;
    const work = this.readGate.run(target, 'Target.setAutoAttach', () => {
      issued = true;
      return this.api.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      }).then(() => {
        if (state.enabled.get(key) === work) state.enabled.set(key, Promise.resolve());
      }, (error) => {
        if (state.enabled.get(key) === work) state.enabled.delete(key);
        throw error;
      });
    }).then(() => {}).catch((error) => {
      if ((!issued || !(error instanceof CdpReadTimeoutError)) && state.enabled.get(key) === work) state.enabled.delete(key);
      throw error;
    });
    state.enabled.set(key, work);
    return work;
  }
  /**
   * Track root-document changes and flattened child sessions from CDP events.
   * A detached child session also releases its read gate.
   * @param {CdpDebuggee} source
   * @param {string} method
   * @param {object} params
   */
  onFrameTargetEvent(source, method, params) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const raw = params ?? {};
    const frame = raw.frame;
    if (!source.sessionId && frame?.id && !frame.parentId && ['Page.frameNavigated', 'Page.documentOpened'].includes(method)) {
      this.frameDiscoveryState(tabId).rootFrameId = frame.id;
    }
    const rootRouteChanged = method === 'Page.navigatedWithinDocument'
      && raw.frameId === this.frameDiscovery.get(tabId)?.rootFrameId;
    if (!source.sessionId && (rootRouteChanged || method === 'DOM.documentUpdated'
      || (['Page.frameNavigated', 'Page.documentOpened'].includes(method) && frame && !frame.parentId))) {
      this.options.onDocumentChanged?.(tabId);
    }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
    if (!sessionId) return;
    if (method === 'Target.detachedFromTarget') {
      const state = this.frameDiscovery.get(tabId);
      state?.enabled.delete(sessionId);
      state?.frameIds.delete(sessionId);
      this.readGate.reset(tabId, sessionId);
      if (state?.sessions.delete(sessionId)) state.generation += 1;
      return;
    }
    if (method !== 'Target.attachedToTarget') return;
    const targetInfo = raw.targetInfo;
    if (targetInfo?.type && targetInfo.type !== 'iframe') return;
    const state = this.frameDiscoveryState(tabId);
    if (targetInfo?.type === 'iframe' && typeof targetInfo.targetId === 'string') state.frameIds.set(sessionId, targetInfo.targetId);
    if (state.sessions.has(sessionId)) return;
    state.sessions.add(sessionId);
    state.generation += 1;
    const task = this.initializeFrameTarget({ tabId, sessionId });
    state.pending.add(task);
    void task.finally(() => { state.pending.delete(task); });
  }
  /**
   * Configure a freshly attached child session. A timed-out setup keeps both
   * the session and its pending configuration instead of resending or losing it.
   * @param {CdpTarget} target Child target with a session id.
   * @returns {Promise<void>}
   */
  async initializeFrameTarget(target) {
    try {
      await this.enableFrameDiscovery(target);
    } catch (error) {
      if (error instanceof CdpReadTimeoutError) {
        // The command is still in flight and the browser keeps the child
        // session attached. Keep both the session and the pending
        // configuration until it settles instead of resending or losing it.
        console.debug('[bb cdp] child frame discovery timed out', { target });
        return;
      }
      const state = this.frameDiscovery.get(target.tabId);
      if (state?.sessions.delete(target.sessionId)) state.generation += 1;
      console.debug('[bb cdp] child frame target initialization failed', { target, err: error });
    }
  }
  /**
   * Retry setup for child sessions that are still attached without a finished
   * auto-attach promise.
   * @param {number} tabId
   */
  retryChildFrameDiscovery(tabId) {
    const state = this.frameDiscovery.get(tabId);
    if (!state) return;
    for (const sessionId of state.sessions) {
      if (state.enabled.has(sessionId)) continue;
      const task = this.initializeFrameTarget({ tabId, sessionId });
      state.pending.add(task);
      void task.finally(() => { state.pending.delete(task); });
    }
  }
  /**
   * Wait for child frame setup to quiesce, never past the discovery deadline.
   * Attach events may follow their command reply, so a short quiet window is
   * required before the tree is considered stable.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async drainFrameAttachTasks(tabId) {
    const deadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = this.frameDiscovery.get(tabId);
      const generation = state?.generation ?? 0;
      if (state?.pending.size && !(await settleBeforeDeadline([...state.pending], deadline))) break;
      // Target auto-attach may enqueue the next attached event after its
      // command promise settles. Wait for a short quiet window, then finish
      // only if neither the state object nor its generation changed.
      const quietTime = Math.min(FRAME_DISCOVERY_QUIET_MS, deadline - Date.now());
      if (quietTime <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, quietTime));
      const current = this.frameDiscovery.get(tabId);
      if (current === state && (current?.generation ?? 0) === generation && !current?.pending.size) return;
    }
    console.debug('[bb cdp] frame discovery did not reach quiescence before timeout', { tabId });
  }
  /**
   * Drop everything frame discovery and read gating keep for a tab.
   * @param {number} tabId
   */
  clearFrameState(tabId) {
    this.frameDiscovery.delete(tabId);
    this.readGate.reset(tabId);
  }
  /**
   * Flatten the tab's frame topology, attaching child targets first. Subtrees
   * whose renderer does not answer are reported as unavailable instead of
   * guessed, and the whole read fails if the attachment changes underneath it.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<CdpFrameGraph>}
   */
  async getFrameGraph(tabId, signal) {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    const attachmentId = this.getAttachmentId(tabId);
    const check = () => {
      signal?.throwIfAborted();
      if (attachmentId === undefined || this.getAttachmentId(tabId) !== attachmentId) {
        const error = new Error('Debugger attachment changed during frame discovery');
        error.name = 'CdpAttachmentChangedError';
        throw error;
      }
    };
    const read = async (target, method, params, timeoutMs) => {
      check();
      try {
        const result = await this.command(target, method, params, timeoutMs, check);
        check();
        return result;
      } catch (error) {
        check();
        throw error;
      }
    };
    check();
    await this.enableFrameDiscovery({ tabId }).catch((error) => { if (error instanceof CdpReadTimeoutError) throw error; });
    check();
    this.retryChildFrameDiscovery(tabId);
    await this.drainFrameAttachTasks(tabId);
    check();
    const sources = [];
    const unavailable = new Map();
    const isolateChildTimeout = (error, target) => {
      check();
      if (!(error instanceof CdpReadTimeoutError)) return;
      const frameId = target.sessionId && this.frameDiscovery.get(tabId)?.frameIds.get(target.sessionId);
      if (!frameId || frameId === sources[0]?.tree.frame.id || error.sessionId !== target.sessionId) throw error;
      unavailable.set(frameId, target);
    };
    const root = await read({ tabId }, 'Page.getFrameTree', {}, READ_TIMEOUT_MS);
    if (root.frameTree) sources.push({ target: { tabId }, tree: root.frameTree });
    const sessions = [...(this.frameDiscovery.get(tabId)?.sessions ?? [])];
    const childTrees = await Promise.all(sessions.map(async (sessionId) => {
      const target = { tabId, sessionId };
      try {
        const reply = await read(target, 'Page.getFrameTree', {}, READ_TIMEOUT_MS);
        if (reply.frameTree) this.frameDiscovery.get(tabId)?.frameIds.set(sessionId, reply.frameTree.frame.id);
        return reply.frameTree ? { target, tree: reply.frameTree } : null;
      } catch (error) {
        isolateChildTimeout(error, target);
        return null;
      }
    }));
    for (const source of childTrees) if (source) sources.push(source);
    const discovered = buildFrameGraph(sources);
    if (!discovered) throw new Error('Page.getFrameTree returned no root frame');
    const graph = omitFrameSubtrees(discovered, unavailable);
    const frameById = new Map(graph.frames.map((frame) => [frame.frameId, frame]));
    await Promise.all(graph.frames.map(async (frame) => {
      if (!frame.parentFrameId) return;
      const parent = frameById.get(frame.parentFrameId);
      if (!parent) return;
      try {
        const owner = await read(parent.target, 'DOM.getFrameOwner', { frameId: frame.frameId });
        if (owner.backendNodeId !== undefined) frame.ownerBackendNodeId = owner.backendNodeId;
      } catch (error) {
        isolateChildTimeout(error, parent.target);
      }
    }));
    check();
    return omitFrameSubtrees(discovered, unavailable);
  }
}
