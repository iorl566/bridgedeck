import { decodeBytes } from './local-auth-crypto.js';

export const STAGED_TTL_MS = 10 * 60_000;

/** No asynchronous work inside an IDB transaction. Resolve only on complete,
 * including strict persistence of candidates, promotion, and explicit skip preferences. */
export class MemoryLocalCredentials {
  constructor({ credentials = [], skip = false, now = Date.now } = {}) {
    this.credentials = structuredClone(credentials);
    this.skip = skip;
    this.now = now;
  }

  state() {
    this.credentials = this.credentials.filter((c) => c.role === 'active' || c.pending || c.createdAt + STAGED_TTL_MS > this.now());
    return { credentials: structuredClone(this.credentials), policy: { skip: this.skip } };
  }

  read() { return this.state(); }

  stage(credential) {
    const state = this.state();
    const same = state.credentials.filter((c) => c.daemonId === credential.daemonId);
    const existing = same.find((c) => c.deviceId === credential.deviceId);
    if (existing?.role === 'active') throw new Error('Pairing link already stored');
    if (existing) return existing;
    if (!same.length && new Set(state.credentials.map((c) => c.daemonId)).size >= 8) throw new Error('Local pairing limit reached');
    this.credentials = state.credentials.filter((c) => c.daemonId !== credential.daemonId || c.role !== 'staged' || c.pending);
    this.credentials.push(structuredClone(credential));
    return credential;
  }

  current(expected) {
    const record = this.credentials.find((c) => c.daemonId === expected.daemonId && c.deviceId === expected.deviceId && c.role === expected.role);
    if (!record || record.gen !== expected.gen || record.pending?.txn !== expected.pending?.txn) throw new Error('Local credential changed');
    return record;
  }

  saveCandidate(expected, pending) {
    const record = this.current(expected);
    if (pending.gen !== record.gen + 1) throw new Error('Invalid key generation');
    record.pending = structuredClone(pending);
    return structuredClone(record);
  }

  promoteCandidate(expected, rotation) {
    const record = this.current(expected);
    if (!record.pending || record.pending.txn !== rotation.txn || record.pending.gen !== rotation.gen) throw new Error('Local candidate changed');
    record.gen = record.pending.gen;
    record.key = record.pending.key;
    delete record.pending;
    record.role = 'active';
    const promoted = this.credentials.indexOf(record);
    this.credentials = this.credentials.filter((c, index) => c.daemonId !== record.daemonId || index >= promoted);
    return structuredClone(record);
  }

  discardStaged(expected) {
    this.credentials = this.credentials.filter((c) => !(c.daemonId === expected.daemonId && c.deviceId === expected.deviceId && c.role === 'staged' && !c.pending));
  }

  setSkip(skip) { this.skip = skip; }
}

export function parseLocalPairing(input, now = Date.now) {
  try {
    const raw = input.trim();
    const authority = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/#/.exec(raw);
    if (!authority || Number(authority[1]) < 1 || Number(authority[1]) > 65535) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.pathname !== '/') throw new Error();
    const parts = url.hash.slice(1).split('.');
    if (parts.length !== 5 || parts[0] !== 'bb-local' || parts[1] !== 'v1') throw new Error();
    const [, , daemonId, deviceId, key] = parts;
    decodeBytes(daemonId, 16);
    decodeBytes(deviceId, 16);
    decodeBytes(key, 32);
    url.hash = '';
    return {
      daemonId,
      deviceId,
      key,
      gen: 0,
      role: 'staged',
      endpoint: `ws://127.0.0.1:${Number(authority[1])}/`,
      createdAt: now(),
    };
  } catch {
    throw new Error('Invalid local pairing link');
  }
}

const defaultStore = new MemoryLocalCredentials();
export const readLocalState = () => defaultStore.read();
export const stageCredential = (credential) => defaultStore.stage(credential);
export const saveCandidate = (expected, pending) => defaultStore.saveCandidate(expected, pending);
export const promoteCandidate = (expected, rotation) => defaultStore.promoteCandidate(expected, rotation);
export const discardStaged = (expected) => defaultStore.discardStaged(expected);
export const setSkipLocalVerification = (skip) => defaultStore.setSkip(skip);
