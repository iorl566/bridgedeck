/**
 * Worker keepalive and idle transport reconnect supervisor.
 *
 * An extension worker is evicted after roughly 30 seconds without events.
 * Socket traffic alone does not keep it alive, and a plain reconnect timer does
 * not survive eviction, so an idle connection would eventually lose both the
 * worker and the socket. This module owns both halves of the mitigation:
 *
 * - a repeating alarm whose callback counts as activity and revives the worker;
 * - a reconnect attempt on every tick when the transport is not connected, so
 *   a lost timer cannot strand the connection in a stale state.
 *
 * The alarm period is the smallest the platform accepts, which lines up with
 * the idle threshold.
 *
 * @typedef {object} AlarmsApi
 * @property {(name: string, info: { periodInMinutes: number }) => void} create  Create or replace an alarm.
 * @property {(name: string, cb?: (wasCleared: boolean) => void) => void} clear  Cancel an alarm.
 * @property {{
 *   addListener: (cb: (alarm: { name: string }) => void) => void,
 *   removeListener: (cb: (alarm: { name: string }) => void) => void
 * }} onAlarm  Alarm event source.
 *
 * @typedef {object} KeepaliveOptions
 * @property {{ state: string, connect: () => Promise<void> }} transport  Transport to reconnect.
 * @property {() => boolean} [shouldConnect]  Return false to skip reconnect attempts.
 * @property {() => void | Promise<void>} [requestConnect]
 *   Let the connection owner coordinate cleanup and retry; preferred over `connect`.
 * @property {AlarmsApi | null} [alarms]  Alarm API override for tests.
 * @property {string} [alarmName]  Alarm name override for tests.
 * @property {number} [periodMin]  Alarm period override in minutes; tests use this.
 *
 * @typedef {object} KeepaliveHandle
 * @property {() => void} dispose  Detach the alarm listener and cancel the alarm.
 * @property {() => Promise<void>} tickForTest  Simulate one alarm tick.
 */
export const KEEPALIVE_ALARM_NAME = 'bh-keepalive';
export const KEEPALIVE_PERIOD_MIN = 0.5; // 30s, the smallest the browser accepts.

/**
 * Resolve the alarm API, or null when the runtime does not expose it.
 *
 * @returns {AlarmsApi | null} Alarm binding, or null outside an extension runtime.
 */
function defaultAlarms() {
  if (typeof chrome === 'undefined') return null;
  if (!chrome.alarms?.create || !chrome.alarms?.onAlarm) return null;
  return {
    create: (name, info) => chrome.alarms.create(name, info),
    clear: (name, cb) => { void chrome.alarms.clear(name).then((wasCleared) => cb?.(wasCleared)); },
    onAlarm: {
      addListener: (cb) => chrome.alarms.onAlarm.addListener(cb),
      removeListener: (cb) => chrome.alarms.onAlarm.removeListener(cb),
    },
  };
}

/**
 * Install a keepalive heartbeat that also forces an idle reconnect on every
 * tick.
 *
 * The heartbeat is the alarm callback itself, which counts as activity. A tick
 * skips work when `shouldConnect` vetoes it or the transport is already
 * connected. Reconnect failures are swallowed because the next tick retries;
 * surfacing them would only add noise while the peer is down.
 *
 * Environments without an alarm API get a handle whose `dispose` is a no-op but
 * whose tick still works, which keeps tests able to drive the supervisor
 * directly.
 *
 * @param {KeepaliveOptions} options  Transport, gating callbacks and overrides.
 * @returns {KeepaliveHandle} Handle that tears the alarm down when disposed.
 */
export function startKeepalive(options) {
  const alarms = options.alarms ?? defaultAlarms();
  const name = options.alarmName ?? KEEPALIVE_ALARM_NAME;
  const period = options.periodMin ?? KEEPALIVE_PERIOD_MIN;

  const tick = async () => {
    if (options.shouldConnect && !options.shouldConnect()) return;
    if (options.transport.state === 'connected') return;
    try {
      if (options.requestConnect) await options.requestConnect();
      else await options.transport.connect();
    } catch { /* reconnect is retried on the next alarm */ }
  };

  if (!alarms) return { dispose: () => {}, tickForTest: tick };

  const handler = (alarm) => {
    if (alarm.name !== name) return;
    void tick();
  };
  alarms.onAlarm.addListener(handler);
  alarms.create(name, { periodInMinutes: period });

  return {
    dispose: () => {
      alarms.onAlarm.removeListener(handler);
      alarms.clear(name);
    },
    tickForTest: tick,
  };
}
