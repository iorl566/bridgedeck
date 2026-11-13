import { AUDIT_ENABLED_KEY, AUDIT_MESSAGE, getAuditEnabled } from './audit.js';
import { defaultStorage } from './instance-id.js';

/**
 * Bridge between the audit viewer page and the background worker.
 *
 * The viewer asks for audit state and data through ordinary one-shot messages,
 * because a long-lived port would be torn down with the viewer and would need a
 * separate reconnect story. The background answers by validating the sender,
 * checking that the negotiated handshake advertises the audit capability, and
 * forwarding the request over the live transport. Configure writes are
 * serialized so a slow first write cannot overwrite a newer one.
 *
 * @typedef {object} AuditTransport
 * @property {(listener: (message: object) => void) => { dispose: () => void }} onMessage
 *   Subscribe to inbound frames; the returned handle must be disposed exactly once.
 * @property {(listener: (state: string) => void) => { dispose: () => void }} onConnectionStateChange
 *   Subscribe to connection state changes; `disconnected` settles pending RPCs.
 * @property {(frame: { id: string, method: string, params: Record<string, unknown> }) => void} send
 *   Send one request frame; throwing means the link is already gone.
 *
 * @typedef {object} AuditRpcDeps
 * @property {number} [timeoutMs]  Soft deadline for one request; defaults to 10s.
 *
 * @typedef {object} AuditRpcResponse
 * @property {unknown} [result]  Present on success.
 * @property {unknown} [error]  Present on failure; the request is rejected.
 *
 * @typedef {object} AuditBridgeSnapshot
 * @property {object | null} handshake  Negotiated capabilities, or null while offline.
 * @property {boolean} connectionEnabled  Whether the user allows the connection.
 */

/**
 * Send one audit RPC over the transport and settle on the matching response,
 * a disconnection or the timeout.
 *
 * The response is matched by request id and must carry either `result` or
 * `error`; unrelated frames are ignored. All three failure paths map to the
 * same rejection codes (`timeout`, `disconnected`, `request_failed`) so the
 * caller can surface one message per cause. Listeners and the timer are
 * released exactly once, including when the send throws synchronously because
 * the socket already closed.
 *
 * @param {AuditTransport} transport  Live transport.
 * @param {Record<string, unknown>} params  Request parameters, including `action`.
 * @param {AuditRpcDeps} [deps]  Timeout override.
 * @returns {Promise<unknown>} The response `result` payload.
 * @throws {Error} `timeout`, `disconnected`, or `request_failed`.
 */
export function auditRpc(transport, params, deps = {}) {
  const id = `audit-${crypto.randomUUID()}`;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let messages;
    let states;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    messages = transport.onMessage((message) => {
      if (!message || message.id !== id || (!('result' in message) && !('error' in message))) return;
      finish('error' in message ? new Error('request_failed') : null, 'result' in message ? message.result : undefined);
    });
    if (settled) messages.dispose();
    states = transport.onConnectionStateChange((state) => {
      if (state === 'disconnected') finish(new Error('disconnected'));
    });
    if (settled) states.dispose();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      messages?.dispose();
      states?.dispose();
      if (error) reject(error);
      else resolve(value);
    }
    if (settled) return;
    try {
      transport.send({ id, method: 'audit.request', params });
    } catch {
      finish(new Error('disconnected'));
    }
  });
}

/**
 * Whether a message sender is one of this extension's own pages.
 *
 * Both the extension id and the URL are checked: the URL's origin must match
 * the extension origin and the path must be one of the two pages allowed to
 * use the audit channel. Pages outside the extension, and pages of other
 * extensions, are rejected. A malformed sender URL is also rejected rather
 * than raising.
 *
 * @param {{ id?: string, url?: string }} sender  Message sender from the runtime.
 * @param {object} [runtime]  Runtime API override for tests.
 * @returns {boolean} True when the sender is the popup or the audit viewer.
 */
export function isAuditPage(sender, runtime = globalThis.chrome?.runtime) {
  if (sender.id !== runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const extension = new URL(runtime.getURL('/'));
    return url.protocol === extension.protocol && url.host === extension.host && ['/popup.html', '/audit.html'].includes(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Wire the audit viewer to the controller and the connected peer.
 *
 * Two things happen here:
 *
 * 1. Whenever a new handshake arrives and the peer advertises audit support,
 *    the persisted local switch is read and pushed to the peer. Writes are
 *    chained so they land in order, and failures are swallowed because the next
 *    handshake retries the whole push.
 * 2. Incoming viewer messages are validated, executed and answered
 *    asynchronously. `configure` is the only mutating action, so it is
 *    serialized with the push chain; read actions may run concurrently.
 *
 * Action routing: `state` answers from local storage; `configure` persists and
 * pushes the switch, answering `pending` when no supported peer is connected;
 * everything else requires a live peer whose handshake advertises audit
 * support. A stale capability produces `unsupported`, and a missing connection
 * produces `disconnected`.
 *
 * @param {object} controller  Connection controller (subscribe/snapshot/setAuditEnabled).
 * @param {AuditTransport} transport  Live transport.
 * @returns {() => void} Removes the message listener.
 */
export function attachAuditBridge(controller, transport) {
  /** Serialized chain for switch writes, so a later configure wins. */
  let writes = Promise.resolve();
  let previousHandshake = null;
  controller.subscribe((snapshot) => {
    if (snapshot.handshake === previousHandshake) return;
    previousHandshake = snapshot.handshake;
    if (snapshot.handshake?.audit_version === 1) {
      writes = writes.then(async () => {
        const enabled = await getAuditEnabled();
        controller.setAuditEnabled(enabled);
        await auditRpc(transport, { action: 'configure', enabled });
      }).catch(() => {});
    }
  });

  /**
   * One-shot message listener. Returns true for every message it owns — even a
   * rejected one — so no other listener also answers the same request.
   */
  const listener = (message, sender, sendResponse) => {
    if (message?.kind !== AUDIT_MESSAGE) return false;
    if (!isAuditPage(sender)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    const action = message.action;
    /**
     * Run the requested action. Throwing produces an `{ ok: false }` reply whose
     * error is the thrown message, so the codes below are the viewer contract.
     */
    const execute = async () => {
      if (action === 'state') return { enabled: await getAuditEnabled() };
      if (action === 'configure') {
        if (typeof message.enabled !== 'boolean') throw new Error('request_failed');
        await defaultStorage().set({ [AUDIT_ENABLED_KEY]: message.enabled });
        controller.setAuditEnabled(message.enabled);
      }
      const snapshot = controller.snapshot();
      // Offline configure is not an error: it is persisted and pushed on connect.
      if (action === 'configure' && (!snapshot.handshake || !snapshot.connectionEnabled || snapshot.handshake.audit_version !== 1)) return { enabled: message.enabled, pending: true };
      if (!snapshot.handshake || !snapshot.connectionEnabled) throw new Error('disconnected');
      if (snapshot.handshake.audit_version !== 1) throw new Error('unsupported');
      if (!['configure', 'list', 'get', 'delete', 'open_directory'].includes(action)) throw new Error('request_failed');
      /** Only these fields are forwarded; anything else a page sends is dropped. */
      const params = { action };
      for (const key of ['id', 'offset', 'limit', 'enabled']) if (message[key] !== undefined) params[key] = message[key];
      return auditRpc(transport, params);
    };
    // Configure writes join the serialized chain; reads run immediately.
    const request = writes.then(execute);
    if (action === 'configure') writes = request.then(() => {}, () => {});
    void request.then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'unavailable' }));
    return true;
  };
  globalThis.chrome?.runtime?.onMessage?.addListener(listener);
  return () => globalThis.chrome?.runtime?.onMessage?.removeListener?.(listener);
}
