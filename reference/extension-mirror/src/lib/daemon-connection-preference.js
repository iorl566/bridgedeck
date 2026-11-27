/**
 * Connection preference watcher shared by the popup and the background worker.
 *
 * The effective endpoint is either the stored remote credential or, when no
 * valid remote credential exists, the locally configured daemon port. The two
 * inputs are read together so a snapshot can never pair an old port with a new
 * remote credential. Any invalid remote state is reported through `onError`
 * instead of silently falling back to the local daemon, because a wrong
 * fallback would connect the wrong browser instance.
 *
 * @typedef {object} StorageChangeSource
 * @property {(listener: (changes: Record<string, unknown>, area: string) => void) => void} addListener
 * @property {(listener: (changes: Record<string, unknown>, area: string) => void) => void} removeListener
 *
 * @typedef {object} DaemonConnectionDeps
 * @property {{
 *   get: (key: string) => Promise<Record<string, unknown>>,
 *   onChanged: StorageChangeSource
 * }} storage  Storage area holding the port plus its change feed.
 * @property {string} key  Storage key holding the local daemon port.
 * @property {(value: unknown) => number} normalizePort  Coerce a stored value to a valid port.
 * @property {(port: number) => string} resolveWsUrl  Build the local endpoint URL for a port.
 * @property {() => Promise<{ url?: string } | null>} readRemoteConnection
 *   Read the persisted remote credential; `null` means "use the local daemon".
 *
 * @typedef {object} DaemonConnectionWatcher
 * @property {Promise<void>} ready  Settles after the first read, success or failure.
 * @property {() => void} dispose  Stops watching; safe to call more than once.
 */

/**
 * Keep the port and the remote credential in one snapshot. Invalid remote
 * state never falls back locally.
 *
 * `onChange` runs once the initial read completes and again whenever the local
 * port, the remote credential revision, or the connection mode changes. Failed
 * reads call `onError` and retry after 30 seconds. Because a write can race the
 * initial read, each read carries a revision number and stale results are
 * discarded before `onChange` fires.
 *
 * @param {(url: string, remote: { url?: string } | null) => void} onChange
 *   Receives the effective endpoint and the remote credential, if any.
 * @param {() => void} [onError]  Called when a preference read fails.
 * @param {DaemonConnectionDeps} deps  Injected storage and endpoint helpers.
 * @returns {DaemonConnectionWatcher} Handle exposing readiness and disposal.
 */
export function watchDaemonConnection(onChange, onError = () => {}, deps) {
  const { storage, key, normalizePort, resolveWsUrl, readRemoteConnection } = deps;
  let disposed = false;
  let revision = 0;
  let retry;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const read = async () => {
    clearTimeout(retry);
    const current = ++revision;
    try {
      const [values, remote] = await Promise.all([storage.get(key), readRemoteConnection()]);
      if (disposed || revision !== current) return;
      onChange(remote?.url ?? resolveWsUrl(normalizePort(values[key])), remote);
      resolveReady();
    } catch {
      if (!disposed && revision === current) {
        onError();
        retry = setTimeout(() => void read(), 30_000);
        resolveReady();
      }
    }
  };
  const changed = (changes, area) => {
    if (disposed || area !== 'local') return;
    if (changes[key] || changes.bb_remote_connection_revision || changes.bb_connection_mode) void read();
  };
  storage.onChanged.addListener(changed);
  void read();
  return {
    ready,
    dispose: () => {
      disposed = true;
      clearTimeout(retry);
      storage.onChanged.removeListener(changed);
    },
  };
}
