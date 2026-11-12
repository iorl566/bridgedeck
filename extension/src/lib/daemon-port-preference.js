/**
 * Watch the locally configured daemon port.
 * The change feed is observed before the initial read.
 * @typedef {object} DaemonPortWatcher
 * @property {Promise<void>} ready
 * @property {() => void} dispose
 *
 * @typedef {object} DaemonPortDeps
 * @property {object} storage
 * @property {string} key
 * @property {(value: unknown) => number} normalizePort
 * @property {() => Promise<number>} getPort
 */

/**
 * Change events for the watched key call `onPort` with the normalized new value.
 * The initial read calls `onPort` only when no change has been observed yet; a
 * failure propagates through `ready` unless a change has already superseded it.
 * After `dispose` no further callbacks fire.
 *
 * @param {(port: number) => void} onPort  Receives the current port.
 * @param {DaemonPortDeps} deps  Injected storage and normalization helpers.
 * @returns {DaemonPortWatcher} Handle exposing readiness and disposal.
 */
export function watchDaemonPort(onPort, deps) {
  const storage = deps.storage;
  const key = deps.key;
  let disposed = false;
  let changed = false;
  const onChanged = (changes, areaName) => {
    if (disposed || areaName !== 'local' || !changes[key]) return;
    changed = true;
    onPort(deps.normalizePort(changes[key].newValue));
  };
  storage.onChanged.addListener(onChanged);
  const ready = deps.getPort().then(
    (port) => {
      if (!disposed && !changed) onPort(port);
    },
    (error) => {
      if (!disposed && !changed) throw error;
    },
  );
  return {
    ready,
    dispose: () => {
      disposed = true;
      storage.onChanged.removeListener(onChanged);
    },
  };
}
