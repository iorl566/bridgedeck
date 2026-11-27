import { isRecordFrameQueryMessage, RECORD_FRAME_PORT, RECORD_FRAME_START } from './frame-bridge.js';

/**
 * Coordinates one recording across every document in a tab.
 *
 * @typedef {object} RecordingCaptureScope
 * @property {number} tabId
 * @property {string} documentId
 * @property {number} browserFrameId
 * @property {string} producerId
 *
 * @typedef {object} FrameAgent
 * @property {number} tabId
 * @property {string} documentId
 * @property {number} browserFrameId
 * @property {string} requestId
 * @property {string} producerId
 * @property {{ postMessage: (message: object) => void, disconnect?: () => void }} port
 * @property {Map<string, (ok: boolean) => void>} stopWaiters
 *
 * @typedef {object} BrowserFrame
 * @property {number} frameId
 * @property {string} [documentId]
 *
 * @typedef {object} BrowserFrameNavigation
 * @property {number} frameId
 * @property {string} [documentId]
 * @property {number} tabId
 * @property {'committed' | 'completed'} lifecycle
 *
 * @typedef {object} ArmedRecording
 * @property {string} requestId
 * @property {number} startedAtMs
 * @property {Set<number>} tabIds
 * @property {Map<string, FrameAgent>} agents
 * @property {(scope: RecordingCaptureScope) => void | Promise<void>} [onDocumentReady]
 * @property {boolean} finishing
 *
 * @typedef {object} RecordFrameCoordinatorDeps
 * @property {(tabId: number) => Promise<BrowserFrame[]>} getAllFrames
 * @property {(tabId: number, message: object, target: { documentId?: string, frameId?: number }) => Promise<unknown>} sendToDocument
 * @property {(listener: (frame: BrowserFrameNavigation) => void) => () => void} [subscribeFrameNavigation]
 * @property {(listener: (port: object) => void) => void} [onConnect]
 * @property {(listener: (message: unknown, sender: object, sendResponse: (response: object) => void) => boolean) => void} [onMessage]
 * @property {(listener: (port: object) => void) => void} [offConnect]
 * @property {(listener: (message: unknown, sender: object, sendResponse: (response: object) => void) => boolean) => void} [offMessage]
 */

const RECORD_FRAME_STOP_TIMEOUT_MS = 5000;

function documentKey(tabId, documentId) {
  return `${tabId}:${documentId}`;
}

/** Coordinates one recording across every document in a tab. */
export class RecordFrameCoordinator {
  /** @param {RecordFrameCoordinatorDeps} [deps] */
  constructor(deps = {}) {
    this.deps = deps;
    this.recordings = new Map();
    this.attached = false;
    this.detachFrameNavigation = null;
  }

  /** @returns {() => void} Removes every listener and cancels live recordings. */
  attach() {
    if (this.attached) return () => {};
    this.attached = true;
    this.deps.onConnect?.(this.onConnect);
    this.deps.onMessage?.(this.onMessage);
    this.detachFrameNavigation = this.deps.subscribeFrameNavigation?.(this.onFrameNavigation) ?? null;
    return () => {
      if (!this.attached) return;
      this.attached = false;
      this.deps.offConnect?.(this.onConnect);
      this.deps.offMessage?.(this.onMessage);
      this.detachFrameNavigation?.();
      this.detachFrameNavigation = null;
      for (const recording of this.recordings.values()) this.cancelAgents(recording);
      this.recordings.clear();
    };
  }

  /**
   * @param {string} requestId
   * @param {number} startedAtMs
   * @param {number} initialTabId
   * @param {(scope: RecordingCaptureScope) => void | Promise<void>} [onDocumentReady]
   * @returns {void}
   */
  begin(requestId, startedAtMs, initialTabId, onDocumentReady) {
    const previous = this.recordings.get(requestId);
    if (previous) this.cancelAgents(previous);
    this.recordings.set(requestId, {
      requestId,
      startedAtMs,
      // Register the initial tab before navigation begins.
      tabIds: new Set([initialTabId]),
      agents: new Map(),
      ...(onDocumentReady ? { onDocumentReady } : {}),
      finishing: false,
    });
  }

  /**
   * @param {string} requestId
   * @param {number} tabId
   * @returns {Promise<boolean>} Whether the root frame reported a started agent.
   */
  async armTab(requestId, tabId) {
    const recording = this.recordings.get(requestId);
    if (!recording || recording.finishing) return false;
    recording.tabIds.add(tabId);
    let frames;
    try {
      frames = await this.deps.getAllFrames(tabId);
    } catch {
      frames = [{ frameId: 0 }];
    }
    if (!frames.some((frame) => frame.frameId === 0)) frames.unshift({ frameId: 0 });
    const results = await Promise.all(frames.map(async (frame) => ({ frameId: frame.frameId, started: await this.startFrame(recording, tabId, frame) })));
    return results.some((result) => result.frameId === 0 && result.started);
  }

  /** Register an already-connected frame agent (used by the browser port). */
  /**
   * Register an already-connected frame agent.
   *
   * @param {string} requestId
   * @param {FrameAgent} agent
   * @returns {boolean}
   */
  registerAgent(requestId, agent) {
    const recording = this.recordings.get(requestId);
    if (!recording || recording.finishing) return false;
    const key = documentKey(agent.tabId, agent.documentId);
    const previous = recording.agents.get(key);
    if (previous && previous !== agent) previous.port?.disconnect?.();
    recording.agents.set(key, agent);
    return true;
  }

  /**
   * @param {string} requestId
   * @param {string} producerId
   * @param {object} sender
   * @returns {RecordingCaptureScope | null}
   */
  sourceFor(requestId, producerId, sender) {
    const tabId = sender?.tab?.id;
    const documentId = sender?.documentId;
    const browserFrameId = sender?.frameId;
    const recording = this.recordings.get(requestId);
    if (typeof tabId !== 'number' || typeof documentId !== 'string' || typeof browserFrameId !== 'number' || !recording) return null;
    const agent = recording.agents.get(documentKey(tabId, documentId));
    if (!agent || agent.producerId !== producerId) return null;
    return { tabId: agent.tabId, documentId: agent.documentId, browserFrameId: agent.browserFrameId, producerId: agent.producerId };
  }

  /**
   * @param {string} requestId
   * @returns {Promise<boolean>}
   */
  async stop(requestId) {
    const recording = this.recordings.get(requestId);
    if (!recording) return true;
    recording.finishing = true;
    const commandId = crypto.randomUUID();
    const results = await Promise.all([...recording.agents.values()].map((agent) => this.stopAgent(agent, requestId, commandId)));
    const succeeded = results.every(Boolean);
    if (succeeded) this.recordings.delete(requestId);
    else recording.finishing = false;
    return succeeded;
  }

  /**
   * @param {string} requestId
   * @returns {void}
   */
  cancel(requestId) {
    const recording = this.recordings.get(requestId);
    if (!recording) return;
    this.cancelAgents(recording);
    this.recordings.delete(requestId);
  }

  /**
   * @param {number} [tabId]
   * @returns {{ active: boolean, requestId?: string, startedAtMs?: number }}
   */
  query(tabId) {
    const recording = typeof tabId === 'number' ? [...this.recordings.values()].find((candidate) => !candidate.finishing && candidate.tabIds.has(tabId)) : undefined;
    return recording ? { active: true, requestId: recording.requestId, startedAtMs: recording.startedAtMs } : { active: false };
  }

  /**
   * @param {unknown} message
   * @param {object} sender
   * @param {(response: object) => void} sendResponse
   * @returns {boolean}
   */
  onMessage = (message, sender, sendResponse) => {
    if (!isRecordFrameQueryMessage(message)) return false;
    sendResponse(this.query(sender?.tab?.id));
    return false;
  };

  /**
   * @param {BrowserFrameNavigation} frame
   * @returns {void}
   */
  onFrameNavigation = (frame) => {
    if (frame.frameId === 0) return;
    for (const recording of this.recordings.values()) {
      if (recording.finishing || !recording.tabIds.has(frame.tabId)) continue;
      void (async () => {
        const started = await this.startFrame(recording, frame.tabId, frame);
        if (!started || frame.lifecycle !== 'completed' || recording.finishing) return;
        const agent = frame.documentId ? recording.agents.get(documentKey(frame.tabId, frame.documentId)) : [...recording.agents.values()].find((candidate) => candidate.tabId === frame.tabId && candidate.browserFrameId === frame.frameId);
        if (!agent) return;
        await recording.onDocumentReady?.({ tabId: agent.tabId, documentId: agent.documentId, browserFrameId: agent.browserFrameId, producerId: agent.producerId });
      })();
    }
  };

  async startFrame(recording, tabId, frame) {
    const message = { type: RECORD_FRAME_START, requestId: recording.requestId, startedAtMs: recording.startedAtMs };
    try {
      const response = await this.deps.sendToDocument(tabId, message, { ...(frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId }) });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  stopAgent(agent, requestId, commandId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { agent.stopWaiters.delete(commandId); resolve(false); }, RECORD_FRAME_STOP_TIMEOUT_MS);
      agent.stopWaiters.set(commandId, (ok) => { clearTimeout(timer); resolve(ok); });
      try {
        agent.port.postMessage({ type: 'stop', requestId, commandId });
      } catch {
        clearTimeout(timer);
        agent.stopWaiters.delete(commandId);
        resolve(true);
      }
    });
  }

  cancelAgents(recording) {
    for (const agent of recording.agents.values()) {
      try { agent.port.postMessage({ type: 'cancel', requestId: recording.requestId }); } catch { /* destroyed document */ }
    }
  }

  /**
   * @param {object} port
   * @returns {void}
   */
  onConnect = (port) => {
    if (port.name !== RECORD_FRAME_PORT) return;
    let registered = null;
    port.onMessage.addListener((message) => {
      if (message?.type === 'ready') {
        if (typeof message.requestId !== 'string' || typeof message.producerId !== 'string') { port.disconnect(); return; }
        if (registered) {
          if (registered.requestId === message.requestId && registered.producerId === message.producerId) port.postMessage({ type: 'ready_ack', requestId: message.requestId, producerId: message.producerId });
          else port.disconnect();
          return;
        }
        const recording = this.recordings.get(message.requestId);
        const sender = port.sender;
        if (!recording || recording.finishing || typeof sender?.tab?.id !== 'number' || typeof sender.documentId !== 'string' || typeof sender.frameId !== 'number' || !recording.tabIds.has(sender.tab.id) || !message.producerId) { port.disconnect(); return; }
        const agent = { tabId: sender.tab.id, documentId: sender.documentId, browserFrameId: sender.frameId, requestId: message.requestId, producerId: message.producerId, port, stopWaiters: new Map() };
        registered = agent;
        this.registerAgent(message.requestId, agent);
        port.postMessage({ type: 'ready_ack', requestId: message.requestId, producerId: message.producerId });
        return;
      }
      if (message?.type === 'stopped' && registered && message.requestId === registered.requestId && typeof message.commandId === 'string') {
        registered.stopWaiters.get(message.commandId)?.(message.ok === true);
        registered.stopWaiters.delete(message.commandId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (!registered) return;
      for (const resolve of registered.stopWaiters.values()) resolve(true);
      const recording = this.recordings.get(registered.requestId);
      const key = documentKey(registered.tabId, registered.documentId);
      if (recording?.agents.get(key) === registered) recording.agents.delete(key);
    });
  };
}

export const recordFrameCoordinator = new RecordFrameCoordinator();
