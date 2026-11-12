/**
 * Audit-log client: switch, background RPC and viewer.
 * @typedef {object} AuditRun
 * @property {string} id
 * @property {string} status
 * @typedef {'state' | 'configure' | 'list' | 'get' | 'delete' | 'open_directory'} AuditAction
 * @typedef {object} AuditRpcEnvelope
 * @property {boolean} ok
 */

export const AUDIT_ENABLED_KEY = 'bb_audit_enabled';
export const AUDIT_MESSAGE = 'bb_audit';

/**
 * Read the persisted audit switch.
 *
 * A missing or non-boolean value means "off"; only an explicit `true` enables
 * recording, so a corrupt stored value can never turn auditing on.
 *
 * @param {AuditStorage} [storage]  Storage override for tests.
 * @returns {Promise<boolean>} True when audit recording is enabled.
 */
export async function getAuditEnabled(storage = globalThis.chrome?.storage?.local) {
  const items = await storage.get(AUDIT_ENABLED_KEY);
  return items[AUDIT_ENABLED_KEY] === true;
}

/**
 * Call the background audit RPC and unwrap its data payload.
 *
 * The background answers with an envelope: `{ ok: true, data }` on success and
 * `{ ok: false, error }` otherwise. A missing response is treated as
 * `unavailable` because it usually means the background worker was torn down
 * mid-request.
 *
 * @param {AuditAction} action  Operation to perform.
 * @param {Record<string, unknown>} [params]  Action-specific fields merged into the message.
 * @param {object} [runtime]  Runtime API override for tests.
 * @returns {Promise<unknown>} The unwrapped `data` payload.
 * @throws {Error} With the envelope's error code when the request fails.
 */
export async function auditRequest(action, params = {}, runtime = globalThis.chrome?.runtime) {
  const response = await runtime.sendMessage({ kind: AUDIT_MESSAGE, action, ...params });
  if (!response || !response.ok) throw new Error(response?.error ?? 'unavailable');
  return response.data;
}

/**
 * Open the audit viewer, optionally focused on one run.
 *
 * The viewer is a normal extension page; opening it in a new tab keeps the
 * popup usable and lets the user keep several runs side by side. The returned
 * promise from tab creation is intentionally not awaited or surfaced — the tab
 * either opens or the browser reports the failure itself.
 *
 * @param {string} [id]  Run to focus in the viewer.
 * @param {{ runtime?: object, tabs?: object }} [deps]  API overrides for tests.
 * @returns {void}
 */
export function openAuditPage(id, deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  const tabs = deps.tabs ?? globalThis.chrome?.tabs;
  const url = new URL(runtime.getURL('audit.html'));
  if (id) url.searchParams.set('id', id);
  void tabs.create({ url: url.href });
}
