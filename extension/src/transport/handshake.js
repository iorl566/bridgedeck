export const PROTOCOL_VERSION = '1.9';
export const EXTENSION_VERSION = '0.0.0-unset';
export const MIN_COMPATIBLE_PROTOCOL = '1.6';
export const MIN_COMPATIBLE_PEER = '0.0.0';
export const CLIENT_ID = 'bridge-deck-extension';

/** A daemon rejection retains its structured compatibility diagnostics. */
export class HandshakeRejectedError extends Error {
  constructor(error) {
    super(`[handshake] daemon rejected handshake: ${error.code} — ${error.message}`);
    this.name = 'HandshakeRejectedError';
    this.code = error.code;
    this.data = error.data;
  }
}

function ridToString() {
  return `hs-${Math.random().toString(36).slice(2, 10)}`;
}

/** Send the mandatory first frame on a fresh connection: `system.handshake`. */
export function performHandshake(transport, input, options = {}) {
  const id = input.rpcId ?? ridToString();
  const params = {
    ...(input.auditEnabled !== undefined ? { audit_enabled: input.auditEnabled } : {}),
    client: CLIENT_ID,
    version: input.version ?? EXTENSION_VERSION,
    protocol_version: PROTOCOL_VERSION,
    instance_id: input.instanceId,
    browser: input.browser,
    label: input.label,
    min_compatible_peer: MIN_COMPATIBLE_PEER,
    min_compatible_protocol: MIN_COMPATIBLE_PROTOCOL,
  };
  const req = { id, method: 'system.handshake', params };
  const timeoutMs = options.timeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error('[handshake] aborted because the connection changed');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('[handshake] timed out waiting for daemon response'));
    }, timeoutMs);
    const sub = transport.onMessage((msg) => {
      if (!isResponseFor(msg, id)) return;
      cleanup();
      if ('error' in msg) {
        const error = new HandshakeRejectedError(msg.error);
        options.onRejected?.(error);
        reject(error);
        return;
      }
      resolve({ params, result: msg.result });
    });
    function cleanup() {
      clearTimeout(timer);
      sub.dispose();
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      transport.send(req);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isResponseFor(msg, id) {
  return typeof msg?.id === 'string' && msg.id === id && ('result' in msg || 'error' in msg);
}

/** Best-effort browser meta detection from the user agent. */
export function detectBrowserMeta(ua = globalThis.navigator?.userAgent ?? '') {
  const probes = [
    [/YaBrowser\/([0-9.]+)/, 'yandex'],
    [/Edg\/([0-9.]+)/, 'edge'],
    [/OPR\/([0-9.]+)/, 'opera'],
    [/Brave\/([0-9.]+)/, 'brave'],
    [/Arc\/([0-9.]+)/, 'arc'],
    [/Chrome\/([0-9.]+)/, 'chrome'],
  ];
  for (const [re, name] of probes) {
    const match = re.exec(ua);
    if (match) return { name, version: match[1] };
  }
  return { name: 'chromium', version: 'unknown' };
}
