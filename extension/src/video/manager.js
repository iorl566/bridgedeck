import { VideoError } from './errors.js';
import { isAgentControlledTab } from '../session-manager/manager.js';
import { isVideoId, publicVideo, validateVideoStart, VIDEO_CHUNK_BYTES, VIDEO_PRESETS, VIDEO_RETENTION_MS, VIDEO_VERSION, completeStop } from './types.js';

/**
 * @typedef {object} VideoManagerDeps
 * @property {object} sessions
 * @property {object} cdp
 * @property {object} tabs
 * @property {object} host
 * @property {() => string} owner
 * @property {object} [store]
 * @property {(tabId: number, recordingId: string | null) => Promise<{ interactive?: boolean }>} overlay
 * @property {() => void} [changed]
 *
 * @typedef {object} ActiveVideo
 * @property {object} value
 * @property {boolean} suspended
 * @property {number} epoch
 * @property {number} origin
 * @property {boolean} [pumping]
 * @property {object} [pending]
 * @property {object} [lease]
 * @property {boolean} [releasing]
 * @property {object} [stopping]
 */

// Allow slow pages to settle without spending an entire long recording on a
// frozen frame. The selected recording deadline can still end the wait sooner.
export const VIDEO_NAVIGATION_TIMEOUT_MS = 60_000;

/** Owns capture authorization and the recording lifecycle; encoding is remote. */
export class VideoManager {
  constructor({ store, now = Date.now, createId, createCapability, createOwner = () => 'local', ...deps } = {}) {
    this.store = store;
    this.now = now;
    this.createId = createId ?? (() => `vid_${crypto.randomUUID().replaceAll('-', '')}`);
    this.createCapability = createCapability ?? (() => crypto.randomUUID().replaceAll('-', ''));
    this.createOwner = createOwner;
    this.deps = deps;
    this.active = new Map();
    this.actionStarts = new Set();
    this.navigationTimeoutMs = deps.navigationTimeoutMs ?? VIDEO_NAVIGATION_TIMEOUT_MS;
    this.ready = this.recover().catch((error) => {
      console.warn('Video recovery unavailable', error);
      throw error;
    });
    void this.ready.catch(() => {});
  }

  /** Open storage and resume/fail recordings interrupted by a restart. */
  async recover() {
    await this.store.prepare?.();
    for (const value of await this.store.list()) {
      if (['ready', 'failed'].includes(value.state)) continue;
      try {
        if (!this.deps.host?.request) throw new Error('video host unavailable');
        await this.deps.host.request({ action: 'recover', recording_id: value.recording_id });
      } catch (error) {
        await this.store.put({
          ...value,
          state: 'failed',
          stop_reason: 'browser_restarted',
          completeness: 'partial',
          error: String(error),
        });
      }
    }
  }

  /** Start a recording, reusing the grant for the same owner and request id. */
  async start(options, signal) {
    if (signal?.aborted) throw new VideoError({ code: 'cancelled', message: 'video start cancelled' });
    const invalid = validateVideoStart(options);
    if (invalid) throw new VideoError({ code: 'invalid_params', message: invalid });
    await this.ready;
    if (this.deps.sessions) {
      const session = this.deps.sessions.get(options.session_id);
      if (!session) throw new VideoError({ code: 'permission_denied', message: 'Video requires an active task' });
      if (options.tab_id !== undefined) {
        const tab = await this.deps.tabs?.get?.(options.tab_id);
        if (!tab || tab.windowId !== session.agentWindowId || !isAgentControlledTab(session, options.tab_id)) {
          throw new VideoError({ code: 'permission_denied', message: 'Video requires a task-created or borrowed tab' });
        }
      }
    }
    const owner = this.createOwner();
    const existing = (await this.store.list()).find((value) => value.owner === owner && value.request_id === options.request_id && value.expires_at > this.now());
    if (existing) return { recording: publicVideo(existing), capability: existing.capability };
    if (this.active.size > 0) throw new VideoError({ code: 'invalid_params', message: 'A video is already recording or being finalized' });
    if (this.actionStarts.has(options.session_id)) throw new VideoError({ code: 'invalid_params', message: 'Stop action recording before starting a video' });
    if (signal?.aborted) throw new VideoError({ code: 'cancelled', message: 'video start cancelled' });
    await this.store.reserve?.();
    if (signal?.aborted) throw new VideoError({ code: 'cancelled', message: 'video start cancelled' });
    const id = this.createId();
    if (!isVideoId(id)) throw new VideoError({ code: 'invalid_params', message: 'invalid recording id' });
    const quality = options.quality ?? 'standard';
    const now = this.now();
    let title = 'Video';
    try { title = (await this.deps.tabs?.get?.(options.tab_id))?.title ?? 'Video'; } catch { /* tab gone */ }
    const recording = {
      recording_id: id,
      session_id: options.session_id,
      tab_id: options.tab_id ?? 0,
      title,
      state: 'starting',
      quality,
      created_at: now,
      expires_at: now + VIDEO_RETENTION_MS,
      max_duration_ms: options.max_duration_ms ?? 60_000,
      duration_ms: 0,
      byte_size: 0,
      width: 0,
      height: 0,
      frames: 0,
      dropped_frames: 0,
      exported: false,
    };
    const stored = { ...recording, owner, capability: this.createCapability(), request_id: options.request_id };
    if (signal?.aborted) throw new VideoError({ code: 'cancelled', message: 'video start cancelled' });
    await this.store.put(stored);
    this.active.set(id, stored);
    const grant = { recording: publicVideo(stored), capability: stored.capability };
    if (!this.deps.cdp || !this.deps.host?.request) return grant;
    try {
      return await this.begin(stored, signal);
    } catch (error) {
      await this.failStart(stored, error).catch(() => {});
      throw error;
    }
  }

  /** Paint the first frame, start the remote encoder, then attach the screencast. */
  async begin(stored, signal) {
    const tab = stored.tab_id;
    const check = () => {
      signal?.throwIfAborted?.();
      if (this.active.get(stored.recording_id) !== stored) throw new VideoError({ code: 'cancelled', message: 'Video start cancelled' });
    };
    check();
    if (this.deps.overlay) {
      const overlay = await this.deps.overlay(tab, stored.recording_id);
      if (overlay?.interactive) throw new Error('Finish the current browser confirmation before starting a video');
    }
    check();
    this.deps.cdp.trackSessionTab?.(stored.session_id, tab);
    await this.deps.cdp.send(tab, 'Page.enable', undefined, signal);
    check();
    if (this.deps.cdp.acquireBackgroundExecution) await this.deps.cdp.acquireBackgroundExecution(stored.session_id, tab);
    check();
    const first = await this.deps.cdp.send(tab, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 }, signal);
    check();
    const started = await this.deps.host.request({ action: 'start', recording: this.recordingValue(stored), image: first.data });
    const value = started?.recording_id === stored.recording_id ? started : { ...stored, state: 'recording', started_at: this.now() };
    for (const key of Object.keys(stored)) delete stored[key];
    Object.assign(stored, value, { state: 'recording', suspended: false, epoch: 0, origin: performance.now() });
    await this.store.put(this.recordingValue(stored));
    check();
    if (this.deps.screencasts?.(this.deps.cdp)?.acquire) {
      const size = VIDEO_PRESETS[stored.quality].maxDimension;
      stored.lease = await this.deps.screencasts(this.deps.cdp).acquire(tab, {
        format: 'jpeg', quality: 80, maxWidth: size, maxHeight: size,
        frame: (frame) => this.receive(stored, frame),
      }, signal);
    }
    this.deps.changed?.();
    return { recording: publicVideo(this.recordingValue(stored)), capability: stored.capability };
  }

  receive(active, frame) {
    if (this.active.get(active.recording_id) !== active || active.stopReason) return;
    if (active.suspended) { active.pending = frame; return; }
    this.deps.host.request({
      action: 'frame', recording_id: active.recording_id, image: frame.data,
      elapsed_ms: Math.max(0, this.now() - (active.started_at ?? active.created_at)),
    }).catch(() => { void this.stop(active.recording_id, 'capture_failed').catch(() => {}); });
  }

  async failStart(stored, error) {
    if (this.deps.host?.request) {
      const stopped = await this.deps.host.request({ action: 'stop', recording_id: stored.recording_id, reason: 'capture_failed' }).catch(() => undefined);
      if (stopped?.state === 'ready' || stopped?.state === 'failed') {
        this.active.delete(stored.recording_id);
        return;
      }
    }
    await this.store.put({ ...this.recordingValue(stored), state: 'failed', completeness: 'partial', stop_reason: 'capture_failed', error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    this.active.delete(stored.recording_id);
    this.deps.changed?.();
  }

  /** Strip capture-only bookkeeping so it is never persisted with the recording. */
  recordingValue(value) {
    const { stopping, stopReason, navigation, documentId, epoch, suspended, ...recording } = value;
    return recording;
  }

  /** Stop one active recording once; a navigation failure is never reported as complete. */
  async stop(id, reason = 'user_stopped') {
    const active = this.active.get(id);
    if (!active) return this.get(id);
    if (active.stopping) return active.stopping;
    active.stopReason ??= active.navigation && ['user_stopped', 'duration_limit', 'size_limit'].includes(reason) ? 'capture_failed' : reason;
    const effective = active.stopReason;
    active.stopping = (async () => {
      let finished = this.recordingValue(active);
      if (this.deps.host?.request) {
        const reply = await this.deps.host.request({ action: 'stop', recording_id: id, reason: effective }).catch(() => undefined);
        if (reply?.recording?.recording_id === id) finished = { ...finished, ...this.recordingValue(reply.recording) };
      }
      let recording = { ...finished, state: 'ready', stop_reason: effective, completeness: completeStop(effective) ? 'complete' : 'partial' };
      recording = this.preserveNavigationFailure(active, recording);
      await this.store.put(recording);
      return recording;
    })().finally(() => {
      this.clearNavigation(active);
      this.active.delete(id);
      this.deps.changed?.();
    });
    return active.stopping;
  }

  findActiveByTab(tabId) {
    return [...this.active.values()].find((value) => value.tab_id === tabId);
  }

  markNavigation(active, startedAt = this.now()) {
    clearTimeout(active.navigation?.timer);
    active.navigation = {
      previousDocument: active.documentId,
      startedAt,
      timer: setTimeout(() => {
        if (this.active.get(active.recording_id) === active) void this.stop(active.recording_id, 'capture_failed').catch(() => {});
      }, this.navigationTimeoutMs),
    };
    active.navigation.timer?.unref?.();
  }

  clearNavigation(active) {
    if (!active?.navigation) return;
    clearTimeout(active.navigation.timer);
    active.navigation = undefined;
  }

  /** The encoder's timer can beat delivery of the navigation message; keep the failure. */
  preserveNavigationFailure(active, value) {
    if (!active?.navigation || value.completeness !== 'complete') return value;
    return { ...value, completeness: 'partial', stop_reason: 'capture_failed' };
  }

  isControlledTab(session, tabId) {
    if (!session) return false;
    if (!session.agentCreatedTabs && !session.borrowedTabs && !session.observedTabs) return true;
    return !!(
      session.agentCreatedTabs?.has?.(tabId) ||
      session.borrowedTabs?.has?.(tabId) ||
      session.observedTabs?.has?.(tabId)
    );
  }

  async disconnect() {
    for (const id of [...this.active.keys()]) await this.stop(id, 'disconnected').catch(() => {});
  }

  reserveActionRecording(sessionId) {
    if (this.isRecording(sessionId)) return undefined;
    this.actionStarts.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.actionStarts.delete(sessionId);
    };
  }

  async stopSession(sessionId, reason = 'session_ended') {
    for (const id of [...this.active.keys()]) {
      if (this.active.get(id)?.session_id === sessionId) await this.stop(id, reason).catch(() => {});
    }
  }

  async stopTab(tabId, reason = 'tab_closed') {
    for (const id of [...this.active.keys()]) {
      if (this.active.get(id)?.tab_id === tabId) await this.stop(id, reason).catch(() => {});
    }
  }

  async finished(id) {
    const active = this.active.get(id);
    const stored = await this.store.get(id).catch(() => undefined);
    let result = stored;
    if (stored) {
      const value = this.preserveNavigationFailure(active, {
        ...this.recordingValue(stored),
        state: stored.state === 'failed' ? 'failed' : 'ready',
      });
      await this.store.put(value);
      result = value;
    }
    this.clearNavigation(active);
    this.active.delete(id);
    this.deps.changed?.();
    await this.deps.host?.closeWhenIdle?.().catch?.(() => {});
    return result;
  }

  /** Reconcile the active recording with its session, then prune expired entries. */
  async sync() {
    const stopping = [];
    if (this.deps.sessions?.get) {
      for (const [id, value] of [...this.active]) {
        const session = this.deps.sessions.get(value.session_id);
        if (!this.isControlledTab(session, value.tab_id)) stopping.push(this.stop(id, 'session_ended').catch(() => {}));
      }
    }
    await Promise.all(stopping);
    return this.pruneExpired();
  }

  async pruneExpired() {
    const values = await this.store.list();
    let removed = 0;
    for (const value of values) {
      if (this.active.has(value.recording_id)) continue;
      if (value.expires_at > this.now()) continue;
      await this.store.remove(value.recording_id);
      removed += 1;
    }
    if (removed) this.deps.changed?.();
    return removed;
  }

  async tasks() {
    if (this.deps.tasks) return this.deps.tasks();
    if (!this.deps.sessions?.list || !this.deps.tabs?.query) return [];
    return Promise.all(this.deps.sessions.list().map(async (session) => ({
      session_id: session.sessionId,
      tabs: (await this.deps.tabs.query({ windowId: session.agentWindowId }))
        .filter((tab) => tab.id !== undefined && this.isControlledTab(session, tab.id))
        .map((tab) => ({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '', active: !!tab.active })),
    })));
  }

  async queryOverlay(tabId, documentId) {
    const active = this.findActiveByTab(tabId);
    if (!active) return (await this.deps.overlay?.(tabId, null))?.recording_id ?? null;
    if (active.stopReason) return null;
    // Initial content-script discovery may overlap start's own paint handshake.
    if (active.state === 'starting') {
      if (documentId) active.documentId = documentId;
      return active.recording_id;
    }
    // Discovery retries for the current document are reads, not another navigation.
    if (documentId && active.documentId === documentId) return active.recording_id;
    return this.suspend(tabId, 'navigation', documentId);
  }

  /** Block intake before an overlay paints or a navigation commits. */
  async suspend(tabId, mode, documentId) {
    const active = this.findActiveByTab(tabId);
    if (!active || active.stopReason) return null;
    if (
      documentId &&
      mode === 'clean' &&
      ((active.documentId && active.documentId !== documentId) || active.navigation?.previousDocument === documentId)
    )
      return null;
    if (mode === 'navigation' && !active.navigation) this.markNavigation(active, this.now());
    if (documentId) active.documentId = documentId;
    const epoch = (active.epoch = (active.epoch ?? 0) + 1);
    active.suspended = true;
    try {
      if (this.deps.host?.request) {
        await this.deps.host.request({
          action: 'suspend',
          recording_id: active.recording_id,
          mode,
          label: mode === 'interactive' ? '等待用户操作' : '',
        });
      }
      if (epoch !== active.epoch || active.stopReason) return null;
      if (mode === 'clean') active.suspended = false;
      if (mode !== 'navigation' && epoch === active.epoch) this.clearNavigation(active);
      return active.recording_id;
    } catch (error) {
      if (epoch === active.epoch) await this.stop(active.recording_id, 'capture_failed').catch(() => {});
      throw error;
    }
  }

  /** Navigation keeps the last clean canvas instead of painting a user-help slate. */
  async navigationStarted(tabId, startedAt = this.now()) {
    const active = this.findActiveByTab(tabId);
    if (!active || active.stopReason) return;
    this.markNavigation(active, startedAt);
    await this.suspend(tabId, 'navigation');
  }

  /** Completed/error events also cover documents that leave the old page without a script. */
  async navigationSettled(tabId, settledAt = this.now()) {
    const active = this.findActiveByTab(tabId);
    if (!active || active.stopReason || settledAt < (active.navigation?.startedAt ?? 0)) return;
    const epoch = active.epoch;
    try {
      const overlay = await this.deps.overlay?.(tabId, active.recording_id);
      if (this.active.get(active.recording_id) !== active || epoch !== active.epoch || active.stopReason) return;
      await this.suspend(tabId, overlay?.interactive === true ? 'interactive' : 'clean');
    } catch {
      if (this.active.get(active.recording_id) === active && epoch === active.epoch) {
        await this.stop(active.recording_id, 'capture_failed').catch(() => {});
      }
    }
  }

  /** Derive live duration for the active recording without persisting a heartbeat. */
  progress(value) {
    if (value.state !== 'recording' || !this.active.has(value.recording_id)) return this.recordingValue(value);
    return {
      ...this.recordingValue(value),
      duration_ms: Math.max(0, Math.min(value.max_duration_ms, this.now() - (value.started_at ?? this.now()))),
    };
  }

  /**
   * List recordings for an owner, filtering expired inactive entries and
   * deriving live duration for the active recording.
   */
  async list(owner) {
    await this.ready;
    const values = await this.store.list();
    return values
      .filter((value) => this.active.has(value.recording_id) || value.expires_at > this.now())
      .filter((value) => owner === undefined || value.owner === owner)
      .map((value) => this.progress(value))
      .sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Read one recording, enforcing capability/owner and retention; live
   * duration is derived for the active recording.
   */
  async get(id, auth) {
    await this.ready;
    if (!isVideoId(id)) throw new VideoError({ code: 'invalid_params', message: 'invalid recording id' });
    const stored = await this.store.get(id);
    if (!stored || stored.expires_at <= this.now()) throw new VideoError({ code: 'permission_denied', message: 'recording not found or expired' });
    if (auth && (stored.owner !== auth.owner || stored.capability !== auth.capability))
      throw new VideoError({ code: 'permission_denied', message: 'recording access denied' });
    return this.progress(stored);
  }

  /** Delete a finished recording and its artifact. */
  async discard(id) {
    const value = await this.get(id);
    if (!['ready', 'failed'].includes(value.state)) throw new Error('Stop the recording before deleting it');
    await this.store.remove(id);
    this.clearNavigation(this.active.get(id));
    this.active.delete(id);
    this.deps.changed?.();
  }

  /** Mark a recording as exported after the browser reports a completed download. */
  async exported(id) {
    const stored = await this.get(id);
    if (stored.state !== 'ready') throw new Error('Video is not ready to save');
    await this.store.put({ ...stored, exported: true });
    this.deps.changed?.();
  }

  isRecording(sessionId) {
    if (sessionId === undefined) return this.active.size > 0;
    return [...this.active.values()].some((value) => value.session_id === sessionId);
  }

  qualityPresets() {
    return VIDEO_PRESETS;
  }

  /**
   * Dispatch one public video RPC action with owner/capability checks.
   */
  async rpc(params, signal) {
    const owner = this.createOwner();
    if (params.action === 'capabilities') return { version: VIDEO_VERSION, format: 'mp4', audio: false, max_duration_ms: 600_000 };
    if (params.action === 'start') return this.start(params, signal);
    if (params.action === 'list') {
      return { recordings: (await this.list(owner)).map((value) => ({ recording: publicVideo(value), capability: value.capability })) };
    }
    const value = await this.get(params.recording_id, { owner, capability: params.capability });
    if (params.action === 'status') return { recording: publicVideo(value) };
    if (params.action === 'stop') return { recording: publicVideo(await this.stop(value.recording_id)) };
    if (params.action === 'discard') { await this.discard(value.recording_id); return { discarded: true }; }
    if (params.action === 'exported') { await this.exported(value.recording_id); return { exported: true }; }
    if (params.action !== 'read') throw new VideoError({ code: 'invalid_params', message: 'Unsupported video action' });
    if (value.state !== 'ready') throw new Error('Video is not ready to save');
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.byte_size)
      throw new VideoError({ code: 'invalid_params', message: 'Invalid video offset' });
    const file = await this.store.file(value.recording_id);
    if (file.size !== value.byte_size) throw new Error('Video artifact size changed');
    const bytes = new Uint8Array(await file.slice(offset, offset + VIDEO_CHUNK_BYTES).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return { recording_id: value.recording_id, offset, byte_size: file.size, data_base64: btoa(binary), next_offset: offset + bytes.length };
  }
}
