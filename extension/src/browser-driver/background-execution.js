/** Desired control is independent of a debugger attachment (which the browser can drop).
 * Serialize toggles per tab so a late enable cannot outlive its last owner. */
export class BackgroundExecution {
  /**
   * @param {(tabId: number) => string | undefined} attachment Current attachment id.
   * @param {(tabId: number, enabled: boolean) => Promise<void>} toggle Apply the desired state.
   */
  constructor(attachment, toggle) {
    this.attachment = attachment;
    this.toggle = toggle;
    this.owners = new Map();
    this.applied = new Map();
    this.pending = new Map();
  }

  /**
   * Add one owner for a tab; enabling is deferred to `synchronize`.
   * @param {string} sessionId
   * @param {number} tabId
   */
  retain(sessionId, tabId) {
    const owners = this.owners.get(tabId) ?? new Set();
    owners.add(sessionId);
    this.owners.set(tabId, owners);
  }

  /** Whether the session currently owns background execution. */
  has(sessionId, tabId) { return this.owners.get(tabId)?.has(sessionId) ?? false; }

  /**
   * Drop one owner, deleting the tab entry when no owner remains.
   * @param {string} sessionId
   * @param {number} tabId
   */
  release(sessionId, tabId) {
    const owners = this.owners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.owners.delete(tabId);
  }

  /** Drop all ownership and applied state for a closed tab. */
  forget(tabId) { this.owners.delete(tabId); this.applied.delete(tabId); }
  /** Force a new attachment to reapply the desired state. */
  invalidate(tabId) { this.applied.delete(tabId); }
  /** Drop every tab's ownership and applied state. */
  clear() { this.owners.clear(); this.applied.clear(); }
  /** Reapply even when the cached applied state already matches. */
  reapply(tabId) { return this.synchronize(tabId, true); }

  /**
   * Serialize and converge background execution for one tab.
   *
   * @param {number} tabId
   * @param {boolean} [reapply] Force a toggle even when the cache matches.
   * @returns {Promise<void>}
   *
   * A changed attachment aborts the stale pass; the next call starts over.
   * Toggles are serialized per tab.
   */
  async synchronize(tabId, reapply = false) {
    // Keep raw commands serialized across detach/reattach as well.
    const previous = this.pending.get(tabId);
    const initialAttachment = this.attachment(tabId);
    const next = (async () => {
      await previous?.catch(() => {});
      if (this.attachment(tabId) !== initialAttachment) return;
      let force = reapply;
      for (;;) {
        const attachment = this.attachment(tabId);
        if (!attachment) return;
        const enabled = this.owners.has(tabId);
        const applied = this.applied.get(tabId);
        if (applied?.attachment === attachment && applied.enabled === enabled && !(force && enabled)) return;
        if (!enabled && applied?.attachment !== attachment) return;
        force = false;
        await this.toggle(tabId, enabled);
        if (this.attachment(tabId) !== attachment) throw new Error('Background execution attachment changed during setup');
        this.applied.set(tabId, { attachment, enabled });
      }
    })();
    this.pending.set(tabId, next);
    try {
      await next;
    } finally {
      if (this.pending.get(tabId) === next) this.pending.delete(tabId);
    }
  }
}
