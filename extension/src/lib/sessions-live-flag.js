/**
 * Boolean flag mirroring "is at least one session live?" into session storage.
 *
 * The all-urls content script reads it as a cheap pre-flight before asking the
 * background who owns the page, so routine page loads never wake the worker
 * when no session is live. The stored value is a single boolean and carries no
 * user data. Session storage defaults to trusted contexts only, so the area is
 * explicitly opted into untrusted contexts the first time it is touched,
 * otherwise content scripts could not see the flag at all.
 *
 * @typedef {object} SessionStorageApi
 * @property {(options: { accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }) => Promise<void>} [setAccessLevel]
 *   Widen the area's visibility; optional because older runtimes lack it.
 * @property {(items: Record<string, unknown>) => Promise<void>} set  Write flag values.
 * @property {(keys: string | string[]) => Promise<void>} remove  Remove flag keys.
 *
 * @typedef {object} SessionsLiveFlagOptions
 * @property {{ list: () => object[] }} manager  Session manager queried for live sessions.
 * @property {SessionStorageApi | null} [storage]  Storage override for tests.
 * @property {string} [flagKey]  Storage key override for tests.
 *
 * @typedef {object} SessionsLiveFlagHandle
 * @property {() => Promise<void>} refresh  Push the current live state.
 * @property {() => Promise<void>} syncFromManager  Alias used after start/stop.
 */
export const SESSIONS_LIVE_FLAG_KEY = 'bb.sessions_live';

/**
 * Resolve the session storage area, or null when it is unavailable.
 *
 * @returns {SessionStorageApi | null} Storage binding, or null outside an extension runtime.
 */
function defaultSessionStorage() {
  if (typeof chrome === 'undefined') return null;
  if (!chrome.storage?.session?.set || !chrome.storage?.session?.remove) return null;
  return {
    setAccessLevel: chrome.storage.session.setAccessLevel?.bind(chrome.storage.session),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}

/**
 * Bind the session manager to the storage boolean so the content script can
 * short-circuit before sending a runtime message.
 *
 * The manager emits no change events, so the caller invokes `syncFromManager`
 * after every start/stop. Writes are skipped when the value is unchanged, which
 * keeps routine session churn from touching storage. Both the access-level
 * widening and each write are best-effort: a failure only costs the fast path,
 * because the content script falls back to asking the background.
 *
 * @param {SessionsLiveFlagOptions} options  Manager plus storage overrides.
 * @returns {SessionsLiveFlagHandle} Refresh handle; calling either method is equivalent.
 */
export function attachSessionsLiveFlag(options) {
  const storage = options.storage ?? defaultSessionStorage();
  const key = options.flagKey ?? SESSIONS_LIVE_FLAG_KEY;
  let lastWritten = null;

  const ensureAccessLevel = async () => {
    if (!storage?.setAccessLevel) return;
    try {
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    } catch { /* continue without untrusted-context access */ }
  };
  void ensureAccessLevel();

  const write = async (live) => {
    if (!storage) return;
    if (lastWritten === live) return;
    try {
      if (live) await storage.set({ [key]: true });
      else await storage.remove(key);
      lastWritten = live;
    } catch { /* flag is best-effort */ }
  };

  const syncFromManager = async () => {
    const live = options.manager.list().length > 0;
    await write(live);
  };

  return { refresh: syncFromManager, syncFromManager };
}
