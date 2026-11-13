import { AUTH_DOMAIN, LEGACY_AUTH_DOMAIN, prove, randomBytes, transcript, verify } from './local-auth-crypto.js';
import { MAX_AUTH_CREDENTIALS, parseAuthJson, parseAuthMessage, parseChallenge } from './local-auth-protocol.js';
import { readLocalState } from './local-credentials.js';

export class LocalAuthError extends Error {
  constructor(status) {
    super(status.state);
    this.status = status;
  }
}

class AuthChannel {
  constructor(socket, signal) {
    this.socket = socket;
    this.signal = signal;
    this.queue = [];
    this.waiting = undefined;
    this.failure = undefined;
    this.message = (event) => {
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 4096 || this.queue.length >= 4) {
        this.fail(new LocalAuthError({ state: 'server_unverified' }));
        return;
      }
      if (this.waiting) {
        this.waiting.resolve(event.data);
        this.waiting = undefined;
      } else this.queue.push(event.data);
    };
    this.closed = () => this.fail(new LocalAuthError({ state: 'server_unverified' }));
    this.aborted = () => this.fail(new LocalAuthError({ state: 'server_unverified' }));
    socket.addEventListener('message', this.message);
    socket.addEventListener('close', this.closed);
    signal.addEventListener('abort', this.aborted, { once: true });
    if (signal.aborted) this.aborted();
  }

  fail(error) {
    this.failure ??= error;
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
  }

  next() {
    if (this.failure) return Promise.reject(this.failure);
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  send(value) {
    if (this.failure) throw this.failure;
    if (this.signal.aborted || this.socket.readyState !== 1) throw new LocalAuthError({ state: 'server_unverified' });
    this.socket.send(JSON.stringify(value));
  }

  finish() {
    if (this.failure) throw this.failure;
    if (this.queue.length) throw new LocalAuthError({ state: 'server_unverified' });
  }

  dispose() {
    this.socket.removeEventListener('message', this.message);
    this.socket.removeEventListener('close', this.closed);
    this.signal.removeEventListener('abort', this.aborted);
  }
}

export async function authenticateLocal(socket, signal, credentials, instanceId, origin, ops = {}) {
  const channel = new AuthChannel(socket, signal);
  try {
    const nonce = randomBytes(32);
    const id = crypto.randomUUID();
    channel.send({
      id,
      method: 'system.ping',
      params: {
        local_auth: {
          v: 1,
          client_nonce: nonce,
          instance_id: instanceId,
          credentials: credentials.map((c) => ({
            role: c.role,
            device_id: c.deviceId,
            gen: c.gen,
            pending: c.pending ? { txn: c.pending.txn, gen: c.pending.gen } : null,
          })),
        },
      },
    });
    const reply = parseAuthJson(await channel.next());
    if (!reply || reply.id !== id || !reply.result?.local_auth) throw new LocalAuthError({ state: 'daemon_too_old' });
    if (Object.keys(reply).some((key) => key !== 'id' && key !== 'result') || Object.keys(reply.result).some((key) => key !== 'local_auth')) {
      throw new LocalAuthError({ state: 'server_unverified' });
    }
    const challenge = parseChallenge(reply.result.local_auth);
    if (challenge.type === 'pairing_required') throw new LocalAuthError({ state: 'pairing_required', daemonId: challenge.daemon_id });
    if (challenge.type === 'busy') throw new LocalAuthError({ state: 'busy' });
    let credential = credentials.find((c) => c.daemonId === challenge.daemon_id && c.deviceId === challenge.device_id && (c.gen === challenge.gen || c.pending?.gen === challenge.gen));
    if (!credential) throw new LocalAuthError({ state: 'server_unverified' });
    const key = credential.pending?.gen === challenge.gen ? credential.pending.key : credential.key;
    // 协议域兼容：新配对默认新域名；旧配对（无 authDomain 字段）或老服务端回退旧域名。
    const primaryDomain = credential.authDomain === 'bridgedeck' ? AUTH_DOMAIN : LEGACY_AUTH_DOMAIN;
    const domains = primaryDomain === AUTH_DOMAIN ? [AUTH_DOMAIN, LEGACY_AUTH_DOMAIN] : [LEGACY_AUTH_DOMAIN, AUTH_DOMAIN];
    let t = null;
    for (const domain of domains) {
      const candidate = transcript({ ...challenge, instance_id: instanceId, origin, client_nonce: nonce }, domain);
      if (await verify(key, 'server', candidate, challenge.server_proof)) { t = candidate; break; }
    }
    if (!t) throw new LocalAuthError({ state: 'server_unverified' });
    channel.send({ type: 'local.auth.prove', v: 1, client_proof: await prove(key, 'client', t) });
    const ready = parseAuthMessage(await channel.next());
    if (ready.type === 'local.auth.rejected') throw new LocalAuthError({ state: ready.reason, browserId: ready.browser_id });
    if (ready.type !== 'local.auth.ready') throw new LocalAuthError({ state: 'server_unverified' });
    if (ready.commit) {
      const pending = credential.pending;
      if (!pending || challenge.gen !== pending.gen || ready.commit.gen !== pending.gen || ready.commit.txn !== pending.txn || !(await verify(pending.key, 'committed', t, ready.commit.proof, pending.txn))) {
        throw new LocalAuthError({ state: 'server_unverified' });
      }
      if (typeof ops.promoteCandidate !== 'function') throw new LocalAuthError({ state: 'server_unverified' });
      credential = await ops.promoteCandidate(credential, pending);
    } else if (ready.rotation) {
      if (challenge.gen !== credential.gen || ready.rotation.gen !== credential.gen + 1) throw new LocalAuthError({ state: 'server_unverified' });
      const rotation = ready.rotation;
      const candidate = await prove(key, 'rotate', t, rotation.txn);
      if (typeof ops.saveCandidate !== 'function' || typeof ops.promoteCandidate !== 'function') throw new LocalAuthError({ state: 'server_unverified' });
      credential = await ops.saveCandidate(credential, { ...rotation, key: candidate });
      channel.send({ type: 'local.auth.rotate_confirm', v: 1, txn: rotation.txn, proof: await prove(candidate, 'confirm', t, rotation.txn) });
      const committed = parseAuthMessage(await channel.next());
      if (committed.type !== 'local.auth.committed' || committed.gen !== rotation.gen || !(await verify(candidate, 'committed', t, committed.proof, rotation.txn))) {
        throw new LocalAuthError({ state: 'server_unverified' });
      }
      credential = await ops.promoteCandidate(credential, rotation);
    } else if (credential.role !== 'active' || challenge.gen !== credential.gen) {
      throw new LocalAuthError({ state: 'server_unverified' });
    }
    channel.finish();
    return { state: 'verified', daemonId: credential.daemonId, deviceId: credential.deviceId };
  } catch (error) {
    if (error instanceof LocalAuthError) throw error;
    throw new LocalAuthError({ state: 'server_unverified' });
  } finally {
    channel.dispose();
  }
}

/** Build a socket authenticator from persisted local credentials. */
export function createLocalAuthenticator(options) {
  return async (socket, signal) => {
    const { credentials, policy } = await readLocalState();
    if (signal.aborted) throw new LocalAuthError({ state: 'server_unverified' });
    const offers = credentials.filter((credential) => credential.role === 'active' || credential.pending);
    if (policy.skip || !offers.length) {
      options.status({ state: 'unverified_local', reason: policy.skip ? 'skip' : 'unpaired' });
      return;
    }
    options.status({ state: 'verifying' });
    try {
      const priority = (credential) => Number(credential.endpoint === socket.url) * 2 + Number(credential.role === 'active');
      offers.reverse().sort((a, b) => priority(b) - priority(a));
      const status = await authenticateLocal(socket, signal, offers.slice(0, MAX_AUTH_CREDENTIALS), await options.instanceId(), options.origin);
      options.status(status);
    } catch (error) {
      if (signal.aborted) throw error;
      options.status(error instanceof LocalAuthError ? error.status : { state: 'server_unverified' });
      throw error;
    }
  };
}
