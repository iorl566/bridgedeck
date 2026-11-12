import { normalizeDaemonPort } from '../transport/daemon-endpoint.js';

/** Promise-based storage backend used by the popup, worker and content scripts. */
const STORAGE_KEY = 'bb_instance_id';
/** User-visible instance label. */
const LABEL_STORAGE_KEY = 'bb_label';
/** Master switch for establishing any connection. */
const CONNECTION_ENABLED_KEY = 'bb_connection_enabled';
/** Whether the in-page control hints are hidden. */
const CONTROL_HINTS_HIDDEN_KEY = 'bb_control_hints_hidden';
/** Locally configured daemon port. */
const DAEMON_PORT_KEY = 'bb_daemon_port';

/** Wrap callback-style local storage into promises, normalizing lastError. */
export function defaultStorage() {
  return {
    get: (keys) => new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (items) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(items);
        });
      } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
    }),
    set: (items) => new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
    }),
  };
}

/** Length of newly generated instance ids (8 hex chars, 32 bits). */
export const INSTANCE_ID_LENGTH = 8;
/** Matches ids produced by {@link generateShortInstanceId}. */
export const SHORT_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Generate eight lowercase hex characters from crypto or Math.random. */
function generateShortInstanceId() {
  const buf = new Uint8Array(INSTANCE_ID_LENGTH / 2);
  if (typeof crypto !== 'undefined') crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True only for the short hexadecimal id format this module writes. */
function isPersistedInstanceId(value) {
  return typeof value === 'string' && SHORT_INSTANCE_ID_PATTERN.test(value);
}

/** Read the stable instance id, replacing missing or legacy values. */
export async function getOrCreateInstanceId(storage = defaultStorage()) {
  const items = await storage.get(STORAGE_KEY);
  const existing = items[STORAGE_KEY];
  if (isPersistedInstanceId(existing)) return existing;
  const fresh = generateShortInstanceId();
  await storage.set({ [STORAGE_KEY]: fresh });
  return fresh;
}

/** Read the user-visible label, defaulting to an empty string. */
export async function getLabel(storage = defaultStorage()) {
  const items = await storage.get(LABEL_STORAGE_KEY);
  return typeof items[LABEL_STORAGE_KEY] === 'string' ? items[LABEL_STORAGE_KEY] : '';
}

/** Persist the user-visible label verbatim. */
export async function setLabel(label, storage = defaultStorage()) {
  await storage.set({ [LABEL_STORAGE_KEY]: label });
}

/** Read the connection switch, defaulting to enabled. */
export async function getConnectionEnabled(storage = defaultStorage()) {
  const items = await storage.get(CONNECTION_ENABLED_KEY);
  return typeof items[CONNECTION_ENABLED_KEY] === 'boolean' ? items[CONNECTION_ENABLED_KEY] : true;
}

/** Persist the connection master switch. */
export async function setConnectionEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [CONNECTION_ENABLED_KEY]: enabled });
}

/**
 * User preference for the in-page control hints. Defaults to shown when unset
 * or non-boolean; when hidden the whole control overlay is skipped.
 *
 * The control overlay includes its input blocker, so hiding the hints must also
 * make the page behave normally; the caller must not apply the blocker when
 * this returns true.
 *
 * @param {StorageBackend} [storage]  Storage override for tests.
 * @returns {Promise<boolean>} True when the control hints should be hidden.
 */
export async function getControlHintsHidden(storage = defaultStorage()) {
  const items = await storage.get(CONTROL_HINTS_HIDDEN_KEY);
  return typeof items[CONTROL_HINTS_HIDDEN_KEY] === 'boolean' ? items[CONTROL_HINTS_HIDDEN_KEY] : false;
}

/**
 * Persist the control-hint visibility preference.
 *
 * @param {boolean} hidden  Whether the hints should be hidden.
 * @param {StorageBackend} [storage]  Storage override for tests.
 * @returns {Promise<void>} Resolves after the write.
 */
export async function setControlHintsHidden(hidden, storage = defaultStorage()) {
  await storage.set({ [CONTROL_HINTS_HIDDEN_KEY]: hidden });
}

/**
 * Read the locally configured daemon port.
 *
 * The stored value is normalized, so an unset, non-numeric or out-of-range
 * value yields the standard port instead of an invalid endpoint.
 *
 * @param {StorageBackend} [storage]  Storage override for tests.
 * @returns {Promise<number>} Valid daemon port.
 */
export async function getDaemonPort(storage = defaultStorage()) {
  const items = await storage.get(DAEMON_PORT_KEY);
  return normalizeDaemonPort(items[DAEMON_PORT_KEY]);
}

/** Persist the daemon port preference; it is normalized again on read. */
export async function setDaemonPort(port, storage = defaultStorage()) {
  await storage.set({ [DAEMON_PORT_KEY]: port });
}

/**
 * Stable storage keys for callers that cannot import the private constants.
 *
 * @typedef {object} StorageKeys
 * @property {string} INSTANCE_ID  Persistent instance id.
 * @property {string} LABEL  User-visible label.
 * @property {string} CONNECTION_ENABLED  Connection master switch.
 * @property {string} CONTROL_HINTS_HIDDEN  Control-hint visibility.
 * @property {string} DAEMON_PORT  Local daemon port.
 */

/** Frozen key map shared with the popup, background worker and content scripts. */
export const STORAGE_KEYS = {
  INSTANCE_ID: STORAGE_KEY,
  LABEL: LABEL_STORAGE_KEY,
  CONNECTION_ENABLED: CONNECTION_ENABLED_KEY,
  CONTROL_HINTS_HIDDEN: CONTROL_HINTS_HIDDEN_KEY,
  DAEMON_PORT: DAEMON_PORT_KEY,
};
