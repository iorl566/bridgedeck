import { parseRemoteEndpoint, readRemoteEndpoint, remoteAuthorizationStatus } from './remote-endpoint.js';
import { initializeRemoteStorage, readRemoteConnection, readSavedRemoteConnection, writeRemoteConnection } from './remote-storage.js';

class AuthorizationRejected extends Error {}
const RENEWAL_RETRY_MS = 60_000;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function authorize(endpoint, action, nextToken, fetchImpl, label) {
  const url = new URL(endpoint.url);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/$/, '') + '/authorize';
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, next_token: nextToken, label }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) throw new AuthorizationRejected('The server rejected browser authorization');
  if (!response.ok) throw new Error('Browser authorization is temporarily unavailable');
  const data = await response.json();
  if (typeof data.device_id !== 'string' || !data.device_id || !Number.isFinite(Date.parse(data.expires_at)) || !Number.isFinite(Date.parse(data.renew_after))) throw new Error('Invalid browser authorization response');
  const updated = readRemoteEndpoint({ url: endpoint.url, token: nextToken, deviceId: data.device_id, expiresAt: data.expires_at, renewAfter: data.renew_after });
  if (!updated || (action === 'renew' && updated.deviceId !== endpoint.deviceId)) throw new Error('Authorization device changed');
  return updated;
}

export function createRemoteAuthorization({ storage, fetchImpl = (...args) => fetch(...args), now = Date.now, label = 'BridgeDeck Browser Extension' }) {
  let writes = Promise.resolve();
  const serialized = (action) => {
    const result = writes.then(action, action);
    writes = result.catch(() => undefined);
    return result;
  };
  const activateRemoteEndpoint = (endpoint) => authorize(endpoint, 'pair', newToken(), fetchImpl, label);
  const updateRemoteConnection = (pairing) => serialized(async () => {
    if (pairing !== null) await storage.initializeRemoteStorage();
    const endpoint = pairing === null ? null : await activateRemoteEndpoint(parseRemoteEndpoint(pairing));
    await storage.writeRemoteConnection(endpoint);
    return endpoint?.url ?? null;
  });
  const resumeRemoteConnection = () => serialized(async () => {
    const endpoint = await storage.readSavedRemoteConnection();
    if (!endpoint || ['expired', 'rejected'].includes(remoteAuthorizationStatus(endpoint, now()))) throw new Error('Remote authorization has expired; pair again');
    await storage.writeRemoteConnection(endpoint);
    return endpoint.url;
  });
  let renewing = false;
  const renewRemoteAuthorization = async () => {
    if (renewing) return;
    renewing = true;
    try { await serialized(renewRemote); } finally { renewing = false; }
  };
  async function renewRemote() {
    const endpoint = await storage.readRemoteConnection();
    if (!endpoint?.deviceId || !endpoint.renewAfter || (!endpoint.pendingToken && now() < Date.parse(endpoint.renewAfter))) return;
    if (!endpoint.pendingToken && endpoint.expiresAt && now() >= Date.parse(endpoint.expiresAt)) return;
    if (endpoint.renewalAttemptAt && now() < Date.parse(endpoint.renewalAttemptAt) + RENEWAL_RETRY_MS) return;
    const nextToken = endpoint.pendingToken ?? newToken();
    const pending = { ...endpoint, pendingToken: nextToken, renewalAttemptAt: new Date(now()).toISOString() };
    await storage.writeRemoteConnection(pending);
    const stillSelected = async () => {
      const latest = await storage.readRemoteConnection();
      return latest?.url === endpoint.url && latest.token === endpoint.token && latest.deviceId === endpoint.deviceId && latest.pendingToken === nextToken;
    };
    let updated;
    try {
      updated = await authorize(endpoint, 'renew', nextToken, fetchImpl, label);
    } catch (error) {
      if (await stillSelected()) await storage.writeRemoteConnection({ ...pending, renewalFailure: error instanceof AuthorizationRejected ? 'rejected' : 'unavailable' });
      throw error;
    }
    if (await stillSelected()) await storage.writeRemoteConnection(updated);
  }
  return { activateRemoteEndpoint, updateRemoteConnection, resumeRemoteConnection, renewRemoteAuthorization };
}

const defaultAuthorization = createRemoteAuthorization({
  storage: { initializeRemoteStorage, readRemoteConnection, writeRemoteConnection, readSavedRemoteConnection },
});

export const activateRemoteEndpoint = (endpoint) => defaultAuthorization.activateRemoteEndpoint(endpoint);
export const updateRemoteConnection = (pairing) => defaultAuthorization.updateRemoteConnection(pairing);
export const resumeRemoteConnection = () => defaultAuthorization.resumeRemoteConnection();
export const renewRemoteAuthorization = () => defaultAuthorization.renewRemoteAuthorization();

const AUTHORIZATION_ALARM = 'bb-remote-authorization';

/** Keep a paired remote connection renewed while the extension is running. */
export function watchRemoteAuthorization(runtime = globalThis.chrome?.runtime, alarms = globalThis.chrome?.alarms, local = globalThis.chrome?.storage?.local) {
  if (!runtime?.onMessage) return () => {};
  let disposed = false;
  let running;
  let dirty = false;
  const run = () => {
    dirty = true;
    if (running || disposed) return;
    running = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        try {
          const endpoint = await readRemoteConnection();
          if (!endpoint) await alarms?.clear?.(AUTHORIZATION_ALARM);
          else {
            if (alarms && !(await alarms.get?.(AUTHORIZATION_ALARM))) await alarms.create?.(AUTHORIZATION_ALARM, { periodInMinutes: 1 });
            await renewRemoteAuthorization();
          }
        } catch { /* failures remain persisted for the popup */ }
      }
    })().finally(() => { running = undefined; if (dirty && !disposed) run(); });
  };
  const onMessage = (message, sender, reply) => {
    if (message?.kind !== AUTHORIZATION_ALARM) return false;
    if (sender.url !== runtime.getURL('popup.html') || sender.id !== runtime.id || sender.tab !== undefined || (message.resume !== true && message.pairing !== null && typeof message.pairing !== 'string')) {
      reply({ error: 'Invalid authorization request' });
      return false;
    }
    void (message.resume === true ? resumeRemoteConnection() : updateRemoteConnection(message.pairing)).then((url) => reply({ url }), () => reply({ error: 'Unable to pair; copy a new pairing link and try again' }));
    return true;
  };
  runtime.onMessage.addListener(onMessage);
  const onAlarm = (alarm) => { if (alarm.name === AUTHORIZATION_ALARM) run(); };
  alarms?.onAlarm?.addListener?.(onAlarm);
  run();
  return () => {
    disposed = true;
    runtime.onMessage.removeListener(onMessage);
    alarms?.onAlarm?.removeListener?.(onAlarm);
  };
}
