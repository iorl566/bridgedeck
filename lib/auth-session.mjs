// lib/auth-session.mjs —— 本地认证握手的显式状态机。
import { verifyAuthProof } from './auth-challenge.mjs';

export const AUTH_IDLE = 'idle';
export const AUTH_CHALLENGING = 'challenging';
export const AUTH_AUTHENTICATED = 'authenticated';
export const AUTH_FAILED = 'failed';

export function createAuthSession({ ttlMs = 5000, now = Date.now } = {}) {
  let phase = AUTH_IDLE;
  let pending = null;
  let error = null;
  return {
    get state() { return phase; },
    get error() { return error; },
    begin(hello, secret, challenge) {
      if (phase === AUTH_CHALLENGING || phase === AUTH_AUTHENTICATED) return false;
      phase = AUTH_CHALLENGING;
      error = null;
      pending = { hello, secret, challenge: String(challenge || ''), at: now() };
      return true;
    },
    verify(challenge, proof) {
      if (phase !== AUTH_CHALLENGING || !pending) {
        error = 'E_AUTH_STATE';
        return { ok: false, code: error };
      }
      if (now() - pending.at > ttlMs) {
        phase = AUTH_FAILED;
        error = 'E_AUTH_EXPIRED';
        pending = null;
        return { ok: false, code: error };
      }
      if (String(challenge || '') !== pending.challenge) {
        phase = AUTH_FAILED;
        error = 'E_AUTH_CHALLENGE';
        pending = null;
        return { ok: false, code: error };
      }
      if (!verifyAuthProof(pending.secret, pending.challenge, proof)) {
        phase = AUTH_FAILED;
        error = 'E_AUTH_PROOF';
        pending = null;
        return { ok: false, code: error };
      }
      const hello = pending.hello;
      pending = null;
      phase = AUTH_AUTHENTICATED;
      return { ok: true, hello };
    },
    fail(code = 'E_AUTH_FAILED') {
      phase = AUTH_FAILED;
      error = code;
      pending = null;
    },
    reset() {
      phase = AUTH_IDLE;
      pending = null;
      error = null;
    },
  };
}
