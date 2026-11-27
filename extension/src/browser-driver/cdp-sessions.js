// src/browser-driver/cdp-sessions.js —— 会话占用/后台执行/关闭清理（ChromiumCdp mixin）。
import { cleanupWait } from './cdp-timing.js';

export class CdpSessionMethods {
  /**
   * Remember that `sessionId` used CDP on `tabId` so stop can detach it.
   * @param {string} sessionId
   * @param {number} tabId
   */
  trackSessionTab(sessionId, tabId) {
    const owners = this.tabOwners.get(tabId) ?? new Set();
    owners.add(sessionId);
    this.tabOwners.set(tabId, owners);
    // Local extension: a tracked session also gets a stable claim so a caller
    // can guard a release with `{ ifClaim }` without an explicit acquisition.
    // An existing claim always wins; acquisitions keep their own identity.
    const claims = this.claimAttempts.get(tabId) ?? new Map();
    if (!claims.has(sessionId)) claims.set(sessionId, { sessionId, tabId });
    this.claimAttempts.set(tabId, claims);
  }
  /**
   * Identity of the latest acquisition, including repeated use on one attachment.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {SessionClaim | undefined}
   */
  getSessionClaimId(sessionId, tabId) {
    return this.claimAttempts.get(tabId)?.get(sessionId);
  }
  /**
   * Release one session's claim, preserving attachments still used by another.
   * @param {string} sessionId
   * @param {number} tabId
   * @param {ReleaseSessionGuard} [guard] Release only while the claim still matches.
   * @returns {Promise<void>}
   */
  async releaseSessionTab(sessionId, tabId, guard) {
    if (guard && this.getSessionClaimId(sessionId, tabId) !== guard.ifClaim) return;
    this.claimAttempts.get(tabId)?.delete(sessionId);
    this.backgroundExecution.release(sessionId, tabId);
    const owners = this.tabOwners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.tabOwners.delete(tabId);
    // Remove the old claim before yielding: a new acquisition must survive
    // this cleanup, including when it reuses the same session id.
    const attaching = this.attachInFlight.get(tabId);
    if (attaching && !(await cleanupWait(attaching.catch(() => {})))) {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
      return;
    }
    try {
      if (!(await cleanupWait(this.backgroundExecution.synchronize(tabId)))) {
        throw new Error('Background execution cleanup timed out');
      }
    } catch (error) {
      // A failed disable must not leave a returned user page emulated just
      // because a passive reader still owns the debugger. Readers can reattach.
      await this.detach(tabId);
      throw error;
    } finally {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
    }
  }
  /**
   * Debug body reads must never resurrect a detached or returned tab.
   * @template T
   * @param {CdpDebuggee} target
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<T>}
   */
  async sendAttached(target, method, params) {
    if (!this.attachedTabs.has(target.tabId)) throw new Error('debugger detached');
    return this.api.sendCommand(target, method, params);
  }
  /**
   * Detach tabs only when no other live session has claimed them.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async detachSession(sessionId) {
    const owned = new Set([...this.tabOwners.keys(), ...this.claimAttempts.keys()]);
    await Promise.all([...owned].map((tabId) => this.releaseSessionTab(sessionId, tabId)));
  }
  /**
   * Clean up ownership and fence any in-flight attachment when a tab closes.
   * @param {number} tabId
   */
  forgetClosedTab(tabId) {
    this.claimAttempts.delete(tabId);
    this.tabOwners.delete(tabId);
    this.backgroundExecution.forget(tabId);
    void this.detach(tabId);
  }
  /**
   * Reconcile debugger attachments with the current set of live sessions.
   * @param {ReadonlySet<string>} liveSessionIds
   * @returns {Promise<void>}
   */
  async syncSessions(liveSessionIds) {
    const generation = ++this.syncGeneration;
    const releases = [];
    const seen = new Set();
    const queueRelease = (sessionId, tabId) => {
      const key = `${sessionId}:${tabId}`;
      if (seen.has(key)) return;
      seen.add(key);
      releases.push(this.releaseSessionTab(sessionId, tabId));
    };
    for (const [tabId, owners] of this.tabOwners) {
      for (const sessionId of owners) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    for (const [tabId, claims] of this.claimAttempts) {
      for (const sessionId of claims.keys()) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    await Promise.all(releases);
    if (generation !== this.syncGeneration) return;
    const unowned = [];
    for (const tabId of new Set([...this.attachedTabs, ...this.attachInFlight.keys()])) {
      if (!this.tabOwners.get(tabId)?.size && !this.claimAttempts.get(tabId)?.size) {
        unowned.push(this.detach(tabId));
      }
    }
    await Promise.all(unowned);
  }
}
