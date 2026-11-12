import { authenticateLocal as defaultAuthenticate, LocalAuthError } from './local-auth.js';
import { parseLocalPairing as defaultParse, readLocalState as defaultRead, stageCredential as defaultStage, discardStaged as defaultDiscard } from './local-credentials.js';

let running = false;

/** A verifier owns no business transport and cannot disturb an active session. */
export async function verifyLocalPairing(link, instanceId, origin, factory = (url) => new WebSocket(url), deps = {}) {
  if (running) throw new LocalAuthError({ state: 'busy' });
  const parse = deps.parseLocalPairing ?? defaultParse;
  const stage = deps.stageCredential ?? defaultStage;
  const discard = deps.discardStaged ?? defaultDiscard;
  const read = deps.readLocalState ?? defaultRead;
  const authenticate = deps.authenticateLocal ?? defaultAuthenticate;
  let credential = parse(link);
  running = true;
  let socket;
  let staged = false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    credential = await stage(credential);
    staged = true;
    for (let attempt = 0; ; attempt += 1) {
      if (abort.signal.aborted) throw new LocalAuthError({ state: 'server_unverified' });
      socket = factory(credential.endpoint);
      const connection = socket;
      await new Promise((resolve, reject) => {
        const dispose = () => {
          connection.removeEventListener('open', opened);
          connection.removeEventListener('close', failed);
          abort.signal.removeEventListener('abort', failed);
        };
        const opened = () => { dispose(); resolve(); };
        const failed = () => { dispose(); reject(new LocalAuthError({ state: 'server_unverified' })); };
        connection.addEventListener('open', opened);
        connection.addEventListener('close', failed);
        abort.signal.addEventListener('abort', failed, { once: true });
      });
      try {
        const status = await authenticate(connection, abort.signal, [credential], instanceId, origin, deps.authOps);
        return { ...status, endpoint: credential.endpoint };
      } catch (error) {
        const latest = (await read()).credentials.find((c) => c.deviceId === credential.deviceId && c.daemonId === credential.daemonId);
        // The main connection may activate or recover this same staged record
        // while the verifier opens. Verify its advanced key on a fresh socket.
        if (attempt === 0 && latest && (latest.gen > credential.gen || (latest.pending && latest.pending.txn !== credential.pending?.txn))) {
          credential = latest;
          socket.close();
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    // Once confirmation may have reached the daemon, retain the candidate for
    // recovery. Deleting it on a lost commit reply would strand a replacement.
    if (staged) await discard(credential);
    throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
    socket?.close();
    running = false;
  }
}
