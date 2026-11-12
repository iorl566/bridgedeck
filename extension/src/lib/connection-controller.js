import { EXTENSION_VERSION, MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION, performHandshake } from '../transport/handshake.js';
import { getLabel, getOrCreateInstanceId } from './instance-id.js';
import { compareProtocol, parseProtocolMajor } from './semver.js';

/**
 * Background connection lifecycle: owns the transport, the opening handshake
 * and the snapshot the popup renders.
 *
 * @typedef {object} DaemonUpgradeRequired
 * @property {string | null} daemonVersion
 * @property {string} daemonProtocolVersion
 * @property {string} requiredProtocolVersion
 *
 * @typedef {object} SnapshotInfo
 * @property {'disconnected' | 'connecting' | 'connected' | 'version_skew'} state
 * @property {string} instanceId
 * @property {string} label
 * @property {string} extensionVersion
 * @property {object | null} handshake
 * @property {string | null} lastError
 * @property {DaemonUpgradeRequired | null} [daemonUpgradeRequired]
 * @property {boolean} connectionEnabled
 * @property {object | null} [localAuth]
 *
 * @typedef {(snapshot: SnapshotInfo) => void} ConnectionListener
 *
 * @typedef {object} ConnectionLifecycleHooks
 * @property {() => void | Promise<void>} [beforeDisconnect]
 * @property {() => void | Promise<void>} [onDisconnected]
 *
 * @typedef {{ kind: 'connected' } | { kind: 'version_skew' }
 *   | { kind: 'rejected', reason: string }} HandshakeVerdict
 */

const HANDSHAKE_RETRY_DELAY_MS = 1_000;

/**
 * Symmetric extension-side protocol compatibility check, mirroring the daemon
 * handshake rules. Application versions are not compared: both sides ship on
 * independent version lines.
 *
 * @param {object} handshake
 * @param {string} [localMinCompatibleProtocol]
 * @returns {HandshakeVerdict}
 */
export function computeConnectedState(handshake, localMinCompatibleProtocol = MIN_COMPATIBLE_PROTOCOL) {
  const daemonMajor = parseProtocolMajor(handshake.protocol_version);
  const ourMajor = parseProtocolMajor(PROTOCOL_VERSION);
  if (daemonMajor === null || ourMajor === null || daemonMajor !== ourMajor) {
    return { kind: 'rejected', reason: `protocol-major mismatch (daemon protocol v${handshake.protocol_version}, extension protocol v${PROTOCOL_VERSION})` };
  }
  if (compareProtocol(handshake.protocol_version, localMinCompatibleProtocol) === null) {
    return { kind: 'rejected', reason: `daemon protocol v${handshake.protocol_version} is unparseable` };
  }
  if (compareProtocol(handshake.protocol_version, localMinCompatibleProtocol) < 0) {
    return { kind: 'rejected', reason: `daemon protocol v${handshake.protocol_version} below extension min_compatible_protocol ${localMinCompatibleProtocol}` };
  }
  const peerFloor = handshake.min_compatible_protocol;
  if (peerFloor) {
    if (compareProtocol(PROTOCOL_VERSION, peerFloor) === null) return { kind: 'rejected', reason: `daemon min_compatible_protocol ${peerFloor} is unparseable` };
    if (compareProtocol(PROTOCOL_VERSION, peerFloor) < 0) return { kind: 'rejected', reason: `extension protocol v${PROTOCOL_VERSION} below daemon min_compatible_protocol ${peerFloor}` };
  }
  if (handshake.protocol_version === PROTOCOL_VERSION) return { kind: 'connected' };
  return { kind: 'version_skew' };
}

/**
 * Describe the daemon upgrade a protocol floor violation requires.
 *
 * @param {unknown} protocol
 * @param {unknown} version
 * @returns {DaemonUpgradeRequired | null}
 */
function daemonUpgradeFromVersion(protocol, version) {
  if (typeof protocol !== 'string') return null;
  const order = compareProtocol(protocol, MIN_COMPATIBLE_PROTOCOL);
  if (order === null || order >= 0) return null;
  return {
    daemonVersion: typeof version === 'string' && version.trim() ? version : null,
    daemonProtocolVersion: protocol,
    requiredProtocolVersion: MIN_COMPATIBLE_PROTOCOL,
  };
}

/**
 * @param {{ code?: string, data?: { daemon_protocol_version?: unknown, daemon_version?: unknown } }} error
 * @returns {DaemonUpgradeRequired | null}
 */
function daemonUpgradeFromRejection(error) {
  if (error.code !== 'version_too_old') return null;
  return daemonUpgradeFromVersion(error.data?.daemon_protocol_version, error.data?.daemon_version);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) { return typeof error === 'object' && error !== null && error.name === 'AbortError'; }

/**
 * Orchestrates transport + handshake lifecycle for the background worker and
 * caches the canonical connection state that the popup queries.
 */
export class ConnectionController {
  constructor() {
    this.transport = null;
    this.currentState = 'disconnected';
    this.handshake = null;
    this.instanceId = '';
    this.label = '';
    this.auditEnabled = false;
    this.lastError = null;
    this.daemonUpgradeRequired = null;
    this.localAuth = null;
    this.connectionEnabled = true;
    this.listeners = new Set();
    this.lifecycleHooks = {};
    this.ready = false;
    this.preferenceChanged = false;
    this.transition = null;
    this.cleanupNeeded = false;
    this.hasConnected = false;
    this.configurationKey = null;
    this.pendingConfiguration = null;
    this.connectionGeneration = 0;
    this.handshakeAbort = null;
    this.handshakeRetryTimer = null;
    this.intentionalDisconnects = 0;
  }

  /**
   * @param {boolean} enabled
   */
  setAuditEnabled(enabled) { this.auditEnabled = enabled; }
  /**
   * @param {object | null} status
   */
  setLocalAuth(status) { this.localAuth = status; this.fire(); }
  /** Whether the user preference allows connecting. */
  get isConnectionEnabled() { return this.connectionEnabled; }

  /**
   * Retry the connection when it is enabled and already attached.
   *
   * @returns {Promise<void>}
   */
  async retryConnection() {
    if (this.ready && this.connectionEnabled) await this.teardown(false);
  }

  /**
   * Subscribe to snapshot changes. Fires immediately with the current
   * snapshot, then again on every transition.
   *
   * @param {ConnectionListener} listener
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Current connection snapshot rendered by the popup.
   *
   * @returns {SnapshotInfo}
   */
  snapshot() {
    return {
      state: this.currentState,
      instanceId: this.instanceId,
      label: this.label,
      extensionVersion: EXTENSION_VERSION,
      handshake: this.handshake,
      lastError: this.lastError,
      daemonUpgradeRequired: this.daemonUpgradeRequired,
      connectionEnabled: this.connectionEnabled,
      localAuth: this.localAuth,
    };
  }

  /**
   * Attach a transport and start the lifecycle. Lifecycle hooks let the caller
   * release UI before an intentional disconnect.
   *
   * @param {object} transport
   * @param {{ name: string, version: string }} browser
   * @param {boolean} [connectionEnabled]
   * @param {ConnectionLifecycleHooks} [lifecycleHooks]
   * @returns {Promise<void>}
   */
  async attach(transport, browser, connectionEnabled = true, lifecycleHooks = {}) {
    this.transport = transport;
    if (!this.preferenceChanged) this.connectionEnabled = connectionEnabled;
    this.lifecycleHooks = lifecycleHooks;
    this.instanceId = await getOrCreateInstanceId();
    this.label = await getLabel();
    transport.onConnectionStateChange((state) => {
      if (state === 'disconnected') {
        this.cancelHandshake();
        this.handshake = null;
        this.setState('disconnected');
        if (this.intentionalDisconnects > 0) return;
        if (this.transition) {
          void Promise.resolve().then(() => { if (this.transition) return this.disconnectTransport(); }).catch((error) => this.reportError(error));
        } else if (this.connectionEnabled && this.hasConnected) {
          void this.teardown(false);
        }
        return;
      }
      if (!this.connectionEnabled || this.transition) return;
      if (state === 'connected') { this.hasConnected = true; this.startHandshake(browser); }
      else this.setState(state);
    });
    this.applyPendingConfiguration();
    this.ready = true;
    this.fire();
    if (this.connectionEnabled) this.requestConnect();
    else await this.teardown(true);
  }

  /**
   * Apply the user's connection preference.
   *
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async setConnectionEnabled(enabled) {
    this.preferenceChanged = true;
    if (this.connectionEnabled === enabled) return;
    this.connectionEnabled = enabled;
    if (!enabled) { this.daemonUpgradeRequired = null; this.lastError = null; }
    this.fire();
    if (!this.ready) return;
    if (!enabled) await this.teardown(true);
    else this.requestConnect();
  }

  /**
   * Apply only the latest transport configuration, after old sessions are
   * cleaned up.
   *
   * @param {string} key
   * @param {() => void} apply
   * @returns {Promise<void>}
   */
  reconfigureTransport(key, apply) {
    if (key === this.configurationKey) {
      if (this.pendingConfiguration) this.pendingConfiguration = apply;
      return this.transition ?? Promise.resolve();
    }
    this.daemonUpgradeRequired = null;
    this.lastError = null;
    this.configurationKey = key;
    this.pendingConfiguration = apply;
    this.fire();
    if (!this.ready) return Promise.resolve();
    return this.teardown(false);
  }

  /**
   * Shared entry point for startup, wake events, keepalive and handshake
   * retries.
   */
  requestConnect() {
    if (!this.ready || !this.connectionEnabled || this.transition) return;
    if (this.cleanupNeeded) { void this.teardown(false); return; }
    if (this.handshakeRetryTimer || !this.transport || this.transport.state !== 'disconnected') return;
    const generation = this.connectionGeneration;
    const onError = (error) => {
      if (generation !== this.connectionGeneration || !this.connectionEnabled || this.transition) return;
      this.reportError(error);
    };
    try { void this.transport.connect().catch(onError); } catch (error) { onError(error); }
  }

  /**
   * Refresh the browser label and reconnect so the peer registry reflects it.
   *
   * @returns {Promise<void>}
   */
  async refreshLabel() {
    const nextLabel = await getLabel();
    if (nextLabel === this.label) return;
    this.label = nextLabel;
    this.fire();
    if (this.ready && this.connectionEnabled) await this.teardown(false);
  }

  /**
   * @param {{ name: string, version: string }} browser
   */
  startHandshake(browser) {
    this.cancelHandshake();
    const generation = ++this.connectionGeneration;
    const abort = new AbortController();
    this.handshakeAbort = abort;
    void this.runHandshake(browser, generation, abort.signal);
  }

  /**
   * @param {{ name: string, version: string }} browser
   * @param {number} generation
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async runHandshake(browser, generation, signal) {
    if (!this.transport) return;
    if (!this.connectionEnabled || this.transition) return;
    this.setState('connecting');
    try {
      const outcome = await performHandshake(this.transport, { instanceId: this.instanceId, browser, label: this.label, auditEnabled: this.auditEnabled }, {
        signal,
        onRejected: (error) => {
          if (generation !== this.connectionGeneration || signal.aborted) return;
          this.daemonUpgradeRequired = daemonUpgradeFromRejection(error);
          this.lastError = error.message;
          if (error.code === 'pairing_required' && this.localAuth) this.localAuth = { state: 'pairing_required' };
          this.fire();
        },
      });
      if (generation !== this.connectionGeneration || signal.aborted) return;
      this.handshake = outcome.result;
      const verdict = computeConnectedState(outcome.result);
      if (verdict.kind === 'rejected') {
        this.lastError = `version_too_old: ${verdict.reason}`;
        this.daemonUpgradeRequired = daemonUpgradeFromVersion(outcome.result.protocol_version, outcome.result.version);
        this.handshake = null;
        await this.disconnectTransport();
        return;
      }
      this.clearHandshakeRetry();
      this.lastError = null;
      this.daemonUpgradeRequired = null;
      this.setState(verdict.kind);
    } catch (error) {
      if (generation !== this.connectionGeneration || signal.aborted || isAbortError(error)) return;
      this.handshake = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      const disconnect = this.disconnectTransport();
      const disconnectedGeneration = this.connectionGeneration;
      await disconnect;
      if (disconnectedGeneration !== this.connectionGeneration || this.transition || !this.connectionEnabled) return;
      this.scheduleHandshakeRetry();
    } finally {
      if (generation === this.connectionGeneration) this.handshakeAbort = null;
    }
  }

  /**
   * Only finite teardown work is shared; the next connect stays interruptible.
   *
   * @param {boolean} cleanupBeforeDisconnect
   * @returns {Promise<void>}
   */
  teardown(cleanupBeforeDisconnect) {
    if (this.transition) return this.transition;
    this.cleanupNeeded = true;
    this.cancelHandshake();
    this.clearHandshakeRetry();
    this.handshake = null;
    if (!this.daemonUpgradeRequired) this.lastError = null;
    this.setState('disconnected');
    this.fire();
    this.transition = Promise.resolve().then(async () => {
      try {
        if (cleanupBeforeDisconnect) {
          try { await this.lifecycleHooks.beforeDisconnect?.(); } finally { await this.disconnectTransport(); }
        } else {
          await this.disconnectTransport();
          await (this.lifecycleHooks.onDisconnected ?? this.lifecycleHooks.beforeDisconnect)?.();
        }
        this.applyPendingConfiguration();
        this.cleanupNeeded = false;
        this.hasConnected = false;
        this.setState('disconnected');
      } catch (error) {
        this.reportError(error);
      } finally {
        this.transition = null;
        if (!this.cleanupNeeded) this.requestConnect();
      }
    });
    return this.transition;
  }

  /** Apply the latest queued configuration and clear it. */
  applyPendingConfiguration() { this.pendingConfiguration?.(); this.pendingConfiguration = null; }

  /**
   * Disconnect without treating the transport loss as unexpected.
   *
   * @returns {Promise<void>}
   */
  async disconnectTransport() {
    this.intentionalDisconnects += 1;
    try { await this.transport?.disconnect(); } finally { this.intentionalDisconnects -= 1; }
  }

  /**
   * @param {unknown} error
   */
  reportError(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.setState('disconnected');
    this.fire();
  }

  /** Invalidate the in-flight handshake and abort it. */
  cancelHandshake() {
    this.connectionGeneration += 1;
    this.handshakeAbort?.abort();
    this.handshakeAbort = null;
  }

  /** Schedule one retry after a failed handshake. */
  scheduleHandshakeRetry() {
    if (this.handshakeRetryTimer || !this.connectionEnabled) return;
    this.handshakeRetryTimer = setTimeout(() => { this.handshakeRetryTimer = null; this.requestConnect(); }, HANDSHAKE_RETRY_DELAY_MS);
  }

  /** Cancel a scheduled handshake retry. */
  clearHandshakeRetry() {
    if (!this.handshakeRetryTimer) return;
    clearTimeout(this.handshakeRetryTimer);
    this.handshakeRetryTimer = null;
  }

  /**
   * @param {'disconnected' | 'connecting' | 'connected' | 'version_skew'} next
   */
  setState(next) {
    if (this.currentState === next) return;
    this.currentState = next;
    this.fire();
  }

  /** Push the current snapshot to every listener; a throwing listener is isolated. */
  fire() {
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snap); } catch { /* listeners are isolated */ }
    }
  }
}

export const __testing__ = { computeConnectedState };
