import { LocalAuthError } from '../transport/local-auth.js';

/**
 * Popup-driven local pairing bridge.
 *
 * The popup renders pairing state and lets the user paste a pairing link, skip
 * local verification, or retry. Those actions must run in the background
 * because they touch credentials, the transport backoff and the connection
 * controller, so the popup sends one message kind ({@link LOCAL_PAIRING_MESSAGE})
 * and the background performs the work. Only the extension's own popup is
 * trusted: the sender id, URL and absence of a tab are all checked so a page
 * cannot drive pairing.
 *
 * @typedef {object} LocalPairingCredential
 * @property {string} daemonId  Peer that issued the credential.
 * @property {string} deviceId  This device's id for that peer.
 * @property {string} endpoint  Peer endpoint the credential is valid for.
 * @property {string} role  Credential role; only `active` credentials are listed.
 *
 * @typedef {object} LocalPairingDeps
 * @property {object} [runtime]  Runtime override for tests.
 * @property {() => Promise<{ policy: object, credentials: LocalPairingCredential[] }>} readLocalState
 *   Read the local policy and stored credentials.
 * @property {(link: string, instanceId: string, origin: string) => Promise<{ endpoint: string }>} verifyLocalPairing
 *   Verify a pasted pairing link and return its endpoint.
 * @property {() => Promise<string>} getOrCreateInstanceId  Stable instance id for pairing.
 * @property {() => string} getURL  Extension base URL.
 * @property {(port: number) => Promise<void>} setDaemonPort  Persist the daemon port.
 * @property {(value: object | null) => Promise<void>} writeRemoteConnection  Clear or set the remote credential.
 * @property {(value: boolean) => Promise<void>} setSkipLocalVerification  Persist the skip switch.
 *
 * @typedef {object} LocalPairingSender
 * @property {string} [id]  Sender extension id.
 * @property {string} [url]  Sender page URL.
 * @property {object} [tab]  Present when the sender is a tab rather than an extension page.
 *
 * @typedef {object} LocalPairingReply
 * @property {boolean} [ok]  Present on success.
 * @property {string} [error]  Machine-readable failure code.
 * @property {string} [browserId]  Peer id reported by a failed local auth attempt.
 */

export const LOCAL_PAIRING_MESSAGE = 'bb-local-pairing';

/**
 * Whether the sender is this extension's own popup, not a tab or another page.
 *
 * All three checks matter: the id limits senders to this extension, the URL
 * limits them to the popup page, and the missing tab excludes extension pages
 * that were embedded in a tab.
 *
 * @param {LocalPairingSender} sender  Message sender from the runtime.
 * @param {object} [runtime]  Runtime override for tests.
 * @returns {boolean} True when the sender is the trusted popup.
 */
export function trustedPopup(sender, runtime = globalThis.chrome?.runtime) {
  return sender.id === runtime.id && sender.url === runtime.getURL('popup.html') && !sender.tab;
}

/**
 * Answer pairing requests from the popup and retry the connection afterwards.
 *
 * Supported actions:
 * - `info`: current policy plus the active credentials, without secrets.
 * - `pair`: verify a pasted link, switch to the local endpoint it names, clear
 *   any remote credential, reset the auth backoff and retry the connection.
 * - `skip`: persist the skip switch, then reset backoff and retry.
 * - `retry`: reset backoff and retry without changing anything.
 *
 * Unknown actions and malformed fields are rejected with the same error as an
 * untrusted sender so the popup shows one message. A local-auth failure keeps
 * its structured state and peer id so the popup can offer the matching next
 * step; any other failure is reported as `pairing_failed`.
 *
 * @param {object} controller  Connection controller exposing `retryConnection`.
 * @param {object} transport  Transport exposing `resetAuthenticationBackoff`.
 * @param {LocalPairingDeps} deps  Injected storage and pairing helpers.
 * @returns {void}
 */
export function attachLocalPairing(controller, transport, deps) {
  const runtime = deps.runtime ?? globalThis.chrome.runtime;
  runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.kind !== LOCAL_PAIRING_MESSAGE) return false;
    if (!trustedPopup(sender, runtime)) {
      reply({ error: 'Invalid pairing request' });
      return false;
    }
    /** Run the requested action; throwing produces one structured error reply. */
    const action = async () => {
      switch (message.action) {
        case 'info': {
          const state = await deps.readLocalState();
          // Secrets never leave the background: only identity fields are listed.
          return {
            policy: state.policy,
            devices: state.credentials.filter((c) => c.role === 'active').map((c) => ({ daemonId: c.daemonId, deviceId: c.deviceId, endpoint: c.endpoint })),
          };
        }
        case 'pair': {
          if (typeof message.link !== 'string') throw new Error('Invalid pairing request');
          const result = await deps.verifyLocalPairing(message.link, await deps.getOrCreateInstanceId(), deps.getURL().replace(/\/$/, ''));
          await deps.setDaemonPort(Number(new URL(result.endpoint).port || '80'));
          await deps.writeRemoteConnection(null);
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        }
        case 'skip':
          if (typeof message.value !== 'boolean') throw new Error('Invalid pairing request');
          await deps.setSkipLocalVerification(message.value);
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        case 'retry':
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        default:
          throw new Error('Invalid pairing request');
      }
    };
    // Always answer asynchronously: the popup keeps the message channel open
    // until this reply lands, and a thrown action must still produce one.
    void action().then(reply, (error) => reply({
      error: error instanceof LocalAuthError ? error.status.state : 'pairing_failed',
      ...(error instanceof LocalAuthError ? { browserId: error.status.browserId } : {}),
    }));
    return true;
  });
}
