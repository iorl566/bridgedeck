const MIN_PORT = 1;
const MAX_PORT = 65535;

export function createDaemonEndpoint(baseUrl = 'ws://127.0.0.1:52800') {
  const base = new URL(baseUrl);
  const defaultPort = Number(base.port) || 52800;
  const isValidPort = (n) => Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;

  /** Compose the daemon WebSocket URL for a loopback port, preserving host/path. */
  const resolveDaemonWsUrl = (port) => {
    const path = base.pathname === '/' ? '' : base.pathname;
    return `${base.protocol}//${base.hostname}:${port}${path}`;
  };
  /** Non-integer / out-of-range / unset → default port. */
  const normalizeDaemonPort = (raw) => {
    if (typeof raw === 'number' && isValidPort(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') return parseDaemonPortInput(raw) ?? defaultPort;
    return defaultPort;
  };
  /** Input semantics: empty string → default port; invalid → null. */
  const parseDaemonPortInput = (text) => {
    const trimmed = text.trim();
    if (trimmed === '') return defaultPort;
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!isValidPort(parsed)) return null;
    return parsed;
  };
  return { defaultPort, resolveDaemonWsUrl, normalizeDaemonPort, parseDaemonPortInput };
}

const defaultEndpoint = createDaemonEndpoint();
export const DEFAULT_DAEMON_PORT = defaultEndpoint.defaultPort;
export const resolveDaemonWsUrl = defaultEndpoint.resolveDaemonWsUrl;
export const normalizeDaemonPort = defaultEndpoint.normalizeDaemonPort;
export const parseDaemonPortInput = defaultEndpoint.parseDaemonPortInput;
