import { RecordStepDelivery } from '../record-step-delivery.js';

/**
 * Per-document recording agent.
 *
 * A recording request is owned by exactly one document: this agent registers a
 * runtime port, starts capture, and tears the port, document marker and capture
 * down together on stop, cancel, disconnect or dispose. Concurrent starts are
 * serialized, and a start for the active request is a no-op.
 *
 * @typedef {object} ActiveFrameRecording
 * @property {string} requestId Recording request being served.
 * @property {string} producerId Identity stamped on every delivered step.
 * @property {object} port Runtime port carrying frame commands.
 * @property {RecordStepDelivery} delivery Ordered step delivery for this producer.
 * @property {import('../record-capture.js').RecordCaptureController} capture Active page capture.
 * @property {object} marker Document marker with `ensure` and `restore`.
 *
 * @typedef {{ ok: true } | { ok: false, error: string }} RecordFrameStartResult
 *
 * @typedef {object} RecordFrameAgentDeps
 * @property {(name: string) => object} [connect] Opens the frame port.
 * @property {() => Promise<Element | null | undefined>} [waitForRoot] Resolves the registration root.
 * @property {(producerId: string, root: Element) => object} [mark] Marks the document as recording.
 * @property {(requestId: string, sendStep: import('../record-step-delivery.js').SendRecordStepMessage, options: { captureNavigation: boolean }) => import('../record-capture.js').RecordCaptureController} [startCapture]
 * Starts page capture for the request.
 * @property {() => string} [createUuid] Producer id source.
 * @property {import('../record-step-delivery.js').SendRecordStepMessage} [sendStep] Step transport.
 */

/** Runtime port name used for frame registration and commands. */
export const RECORD_FRAME_PORT = 'bb-record-frame';
/** Registration handshake budget before the document reports failure. */
export const RECORD_FRAME_REGISTER_TIMEOUT_MS = 5000;

/** @returns {string} */
export function createRandomUuid() {
  return crypto.randomUUID();
}

/**
 * Recording lifecycle for one document.
 *
 * A single instance owns at most one active recording; starts are serialized
 * and a repeated start for the active request resolves immediately.
 */
export class RecordFrameAgent {
  /** @param {RecordFrameAgentDeps} [deps] */
  constructor(deps = {}) {
    this.connect = deps.connect;
    this.waitForRoot = deps.waitForRoot ?? (async () => globalThis.document?.documentElement);
    this.mark = deps.mark;
    this.startCapture = deps.startCapture;
    this.createUuid = deps.createUuid ?? createRandomUuid;
    this.sendStep = deps.sendStep;
    /** @type {ActiveFrameRecording | null} Recording this document currently serves. */
    this.active = null;
    /** @type {Promise<RecordFrameStartResult> | null} Serialized start in flight. */
    this.startPromise = null;
    /** True after dispose; every later start fails. */
    this.disposed = false;
  }

  /**
   * Start recording for a request, replacing any other active request.
   *
   * The call is idempotent for the active request and serialized with a start
   * already in flight.
   *
   * @param {{ requestId: string }} message
   * @returns {Promise<RecordFrameStartResult>}
   */
  async start(message) {
    if (this.active?.requestId === message.requestId) return { ok: true };
    if (this.disposed) return { ok: false, error: 'recording document is disposed' };
    if (this.startPromise) {
      await this.startPromise;
      return this.start(message);
    }
    if (this.active) this.cancel(this.active.requestId);
    const starting = this.begin(message);
    this.startPromise = starting;
    try {
      return await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  /**
   * Tear down the recording for `requestId` without delivering a stop ack.
   *
   * @param {string} requestId
   * @returns {void}
   */
  cancel(requestId) {
    const active = this.active;
    if (!active || active.requestId !== requestId) return;
    active.capture.dispose();
    active.marker.restore();
    this.active = null;
    active.port.disconnect();
  }

  /** Permanently retire this document's agent and any active recording. @returns {void} */
  dispose() {
    this.disposed = true;
    if (this.active) this.cancel(this.active.requestId);
  }

  /**
   * Register the port and start capture for the request.
   *
   * Fails with `recording dependencies are unavailable` when the host did not
   * provide a root or the capture/marker/connect hooks, and with
   * `failed to register recording document` when the port handshake fails.
   * Errors raised before capture starts restore the marker and port.
   *
   * @param {{ requestId: string }} message
   * @returns {Promise<RecordFrameStartResult>}
   */
  async begin(message) {
    const producerId = this.createUuid();
    const root = await this.waitForRoot();
    if (this.disposed) return { ok: false, error: 'recording document is disposed' };
    if (!root || typeof this.mark !== 'function' || typeof this.connect !== 'function' || typeof this.startCapture !== 'function') {
      return { ok: false, error: 'recording dependencies are unavailable' };
    }
    const marker = this.mark(producerId, root);
    const port = this.connect(RECORD_FRAME_PORT);
    try {
      await registerPort(port, message.requestId, producerId);
    } catch {
      marker.restore();
      port.disconnect();
      return { ok: false, error: 'failed to register recording document' };
    }
    if (this.disposed) {
      marker.restore();
      port.disconnect();
      return { ok: false, error: 'recording document is disposed' };
    }
    const delivery = new RecordStepDelivery(message.requestId, this.sendStep, producerId);
    /** Re-assert the document marker and enqueue each step in capture order. */
    const capture = this.startCapture(message.requestId, (step) => {
      marker.ensure();
      delivery.enqueue(step);
    }, { captureNavigation: true });
    const active = { requestId: message.requestId, producerId, port, delivery, capture, marker };
    this.active = active;
    /** Route stop/cancel commands only while this recording is still active. */
    port.onMessage.addListener((raw) => {
      if (raw?.type === 'stop' && raw.requestId === active.requestId) void this.stop(active, raw.commandId);
      else if (raw?.type === 'cancel' && raw.requestId === active.requestId) this.cancel(active.requestId);
    });
    /** A dropped port tears down the same state without delivering a stop ack. */
    port.onDisconnect.addListener(() => {
      if (this.active !== active) return;
      active.capture.dispose();
      active.marker.restore();
      this.active = null;
    });
    return { ok: true };
  }

  /**
   * Stop capture, flush pending steps, then acknowledge the stop command.
   *
   * Every step is delivered before `stopped` is posted. If delivery fails, the
   * failure is reported and the recording stays active so nothing is lost
   * silently.
   *
   * @param {ActiveFrameRecording} active
   * @param {string} [commandId]
   * @returns {Promise<void>}
   */
  async stop(active, commandId) {
    if (!commandId || this.active !== active) return;
    active.capture.dispose();
    const succeeded = await active.delivery.flush();
    try {
      active.port.postMessage({ type: 'stopped', requestId: active.requestId, commandId, ok: succeeded, ...(succeeded ? {} : { error: 'failed to deliver one or more recorded steps' }) });
    } catch {
      return;
    }
    if (!succeeded || this.active !== active) return;
    active.marker.restore();
    this.active = null;
    active.port.disconnect();
  }
}

/**
 * Complete the frame-port handshake for one producer.
 *
 * Resolves on the matching `ready_ack`; rejects on timeout or if the port
 * disconnects first.
 *
 * @param {object} port Runtime port to register.
 * @param {string} requestId
 * @param {string} producerId
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function registerPort(port, requestId, producerId, timeoutMs = RECORD_FRAME_REGISTER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('recording document registration timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    const onMessage = (raw) => {
      if (raw?.type !== 'ready_ack' || raw.requestId !== requestId || raw.producerId !== producerId) return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('recording document port disconnected'));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ type: 'ready', requestId, producerId });
  });
}
