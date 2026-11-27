export const REMOTE_ENDPOINT_KEY = 'bb_remote_endpoint';
export const REMOTE_AUTH_PROTOCOL_PREFIX = 'bb-auth.';

/** A gateway issues a pairing URL; the fragment never becomes part of the request URL. */
export function parseRemoteEndpoint(input) {
  const url = new URL(input.trim());
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) throw new Error('Remote connections require WSS (WS is allowed only on loopback)');
  if (url.username || url.password || url.search) throw new Error('Credentials and query parameters are not allowed in the server URL');
  const token = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('A pairing credential of 32–256 base64url characters is required');
  url.hash = '';
  return { url: url.toString(), token };
}

export function readRemoteEndpoint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error('Invalid stored remote connection');
  const { url, token } = value;
  if (typeof url !== 'string' || typeof token !== 'string') throw new Error('Invalid stored remote connection');
  const endpoint = parseRemoteEndpoint(`${url}#${token}`);
  if (value.deviceId !== undefined) {
    if (typeof value.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(value.deviceId) || typeof value.expiresAt !== 'string' || typeof value.renewAfter !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.renewAfter))) throw new Error('Invalid stored device authorization');
    endpoint.deviceId = value.deviceId;
    endpoint.expiresAt = value.expiresAt;
    endpoint.renewAfter = value.renewAfter;
  }
  if (value.pendingToken !== undefined) {
    if (typeof value.pendingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.pendingToken)) throw new Error('Invalid pending device credential');
    endpoint.pendingToken = value.pendingToken;
  }
  if (typeof value.renewalAttemptAt === 'string' && Number.isFinite(Date.parse(value.renewalAttemptAt))) endpoint.renewalAttemptAt = value.renewalAttemptAt;
  if (value.renewalFailure === 'unavailable' || value.renewalFailure === 'rejected') endpoint.renewalFailure = value.renewalFailure;
  return endpoint;
}

export function remoteAuthorizationStatus(endpoint, now = Date.now()) {
  if (endpoint.renewalFailure === 'rejected') return 'rejected';
  if (endpoint.expiresAt && Date.parse(endpoint.expiresAt) <= now) return endpoint.pendingToken ? 'unconfirmed' : 'expired';
  if (endpoint.renewalFailure) return 'unavailable';
  return endpoint.pendingToken ? 'renewing' : 'active';
}

export function remoteSocket(url, endpoint, factory = (target, protocols) => new WebSocket(target, protocols)) {
  if (endpoint && endpoint.url !== url) throw new Error('Remote endpoint changed');
  if (endpoint && remoteAuthorizationStatus(endpoint) === 'expired') throw new Error('Browser authorization has expired; pair again');
  return endpoint ? factory(url, [REMOTE_AUTH_PROTOCOL_PREFIX + endpoint.token]) : factory(url);
}
