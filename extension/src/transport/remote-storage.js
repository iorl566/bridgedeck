import { REMOTE_ENDPOINT_KEY, readRemoteEndpoint } from './remote-endpoint.js';
import { openCredentialDatabase } from './credential-db.js';

/** Only this non-secret revision is exposed through browser preference storage. */
export const REMOTE_CONNECTION_REVISION = 'bb_remote_connection_revision';
export const REMOTE_CONNECTION_MODE = 'bb_connection_mode';
const MIGRATING = 'bb_remote_storage_migrating';

export function createRemoteStorage({ local, endpointStore }) {
  let initialization;

  async function readRemoteConnection() {
    await initializeRemoteStorage();
    const values = await local.get([REMOTE_CONNECTION_MODE, REMOTE_CONNECTION_REVISION]);
    const mode = values[REMOTE_CONNECTION_MODE];
    // Fresh profiles never open the credential store. A legacy revision
    // without a mode may contain a remote grant and must still fail closed.
    if (mode === 'local' || (mode === undefined && values[REMOTE_CONNECTION_REVISION] === undefined)) return null;
    if (mode !== undefined && mode !== 'remote') throw new Error('Invalid connection mode');
    const endpoint = readRemoteEndpoint(await endpointStore.get());
    if (mode === 'remote' && !endpoint) throw new Error('Remote authorization is missing');
    return endpoint;
  }

  async function writeRemoteConnection(endpoint) {
    const validated = readRemoteEndpoint(endpoint);
    if (validated) {
      // Publish a switch only after its credential is durable.
      await endpointStore.put(validated);
      await local.set({ [REMOTE_CONNECTION_MODE]: 'remote', [REMOTE_CONNECTION_REVISION]: crypto.randomUUID() });
    } else {
      const legacy = await local.get([REMOTE_ENDPOINT_KEY, MIGRATING]);
      if (legacy[REMOTE_ENDPOINT_KEY] !== undefined || legacy[MIGRATING]) {
        await local.remove(REMOTE_ENDPOINT_KEY);
        await local.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
        await local.remove(MIGRATING);
      }
      await local.set({ [REMOTE_CONNECTION_MODE]: 'local', [REMOTE_CONNECTION_REVISION]: crypto.randomUUID() });
    }
  }

  function initializeRemoteStorage() {
    initialization ??= (async () => {
      const values = await local.get([REMOTE_ENDPOINT_KEY, MIGRATING]);
      if (values[REMOTE_ENDPOINT_KEY] === undefined && !values[MIGRATING]) return;
      await local.set({ [MIGRATING]: true });
      if (values[REMOTE_ENDPOINT_KEY] !== undefined && (await endpointStore.get()) === undefined) {
        await endpointStore.put(readRemoteEndpoint(values[REMOTE_ENDPOINT_KEY]));
      }
      await local.remove(REMOTE_ENDPOINT_KEY);
      await local.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
      await local.set({ [REMOTE_CONNECTION_REVISION]: crypto.randomUUID() });
      await local.remove(MIGRATING);
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }

  /** Read inactive remote authorization without selecting it or renewing it. */
  async function readSavedRemoteConnection() {
    await initializeRemoteStorage();
    return readRemoteEndpoint(await endpointStore.get());
  }

  return { readRemoteConnection, writeRemoteConnection, initializeRemoteStorage, readSavedRemoteConnection };
}

function databaseRequest(mode, action, value) {
  return openCredentialDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction('connection', mode);
    const store = transaction.objectStore('connection');
    const request = action(store);
    transaction.oncomplete = () => { database.close(); resolve(value !== undefined ? value : request.result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Authorization storage failed')); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  }));
}

const defaultEndpointStore = {
  get: () => databaseRequest('readonly', (store) => store.get('endpoint')),
  put: (value) => databaseRequest('readwrite', (store) => store.put(value, 'endpoint'), value),
};

const defaultStorage = createRemoteStorage({
  local: globalThis.chrome?.storage?.local,
  endpointStore: defaultEndpointStore,
});

export const readRemoteConnection = () => defaultStorage.readRemoteConnection();
export const writeRemoteConnection = (endpoint) => defaultStorage.writeRemoteConnection(endpoint);
export const initializeRemoteStorage = () => defaultStorage.initializeRemoteStorage();
export const readSavedRemoteConnection = () => defaultStorage.readSavedRemoteConnection();
