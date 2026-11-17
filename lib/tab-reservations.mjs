/**
 * Per-tab ownership reservations for session starts.
 *
 * The reservation is taken before any awaited browser mutation, so two
 * concurrent `session.start --tab` calls cannot both pass the "is this tab
 * free?" check before either session record exists. The owner is a short-lived
 * request token until the session record is created, then transferred to the
 * session id and released on stop/tab close.
 */
export class TabReservations {
  constructor() {
    this.byTab = new Map();
  }

  reserve(tabId, owner) {
    const id = Number(tabId);
    if (!Number.isInteger(id)) return { ok: false, reason: 'bad_tab' };
    const existing = this.byTab.get(id);
    if (existing !== undefined && existing !== owner) return { ok: false, reason: 'busy', owner: existing };
    this.byTab.set(id, owner);
    return { ok: true, owner };
  }

  transfer(tabId, from, to) {
    const id = Number(tabId);
    if (this.byTab.get(id) !== from) return false;
    this.byTab.set(id, to);
    return true;
  }

  release(tabId, owner) {
    const id = Number(tabId);
    if (owner !== undefined && this.byTab.get(id) !== owner) return false;
    return this.byTab.delete(id);
  }

  owner(tabId) {
    return this.byTab.get(Number(tabId));
  }

  snapshot() {
    return [...this.byTab.entries()].map(([tabId, owner]) => ({ tabId, owner }));
  }

  clear() {
    this.byTab.clear();
  }
}
