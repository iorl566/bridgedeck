/** Interaction preference helpers shared by the popup and background worker. */

export const INTERACTION_STORAGE_KEY = 'bb_interaction_preferences';
export const DEFAULT_INTERACTION_PREFERENCES = { confirmTabBorrow: true, requestHelpEnabled: true };

/** Coerce a stored record; only explicit false disables a preference. */
export function normalizeInteractionPreferences(value) {
  return {
    confirmTabBorrow: value?.confirmTabBorrow !== false,
    requestHelpEnabled: value?.requestHelpEnabled !== false,
  };
}

/** Translate local preferences into the peer-facing policy fields. */
export function interactionPolicy(preferences) {
  return {
    borrow_confirmation: preferences.confirmTabBorrow ? 'always' : 'never',
    request_help: preferences.requestHelpEnabled ? 'enabled' : 'disabled',
  };
}

/** Lazy, single-flight preference store.
 * Shared by the popup and background worker. */
export class InteractionPreferenceStore {
  /** @param {object} [deps] Storage and change-feed overrides. */
  constructor(deps = {}) {
    this.storage = deps.storage ?? null;
    this.onChanged = deps.onChanged ?? null;
    this.value = { ...DEFAULT_INTERACTION_PREFERENCES };
    this.listeners = new Set();
    this.initialization = undefined;
    this.listening = false;
    this.loaded = false;
    this.revision = 0;
  }

  /** Return a copy of the current preferences. */
  get() { return { ...this.value }; }

  /** Subscribe to changed values; returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Normalize and publish, notifying listeners only when something changed. */
  publish(value) {
    const next = normalizeInteractionPreferences(value);
    this.loaded = true;
    this.revision += 1;
    if (next.confirmTabBorrow === this.value.confirmTabBorrow && next.requestHelpEnabled === this.value.requestHelpEnabled) return;
    this.value = next;
    for (const listener of this.listeners) listener(this.get());
  }

  /** Install the change feed and perform the single initial read. */
  async ready() {
    if (this.loaded) return;
    if (this.initialization) return this.initialization;
    if (!this.listening && this.onChanged) {
      this.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[INTERACTION_STORAGE_KEY]) return;
        this.publish(changes[INTERACTION_STORAGE_KEY].newValue);
      });
      this.listening = true;
    }
    const revision = this.revision;
    this.initialization = this.storage
      .get(INTERACTION_STORAGE_KEY)
      .then(
        (items) => { if (revision === this.revision) this.publish(items[INTERACTION_STORAGE_KEY]); },
        (error) => { if (!this.loaded) throw error; },
      )
      .finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  /**
   * Load preferences, keeping the current policy when storage is unavailable.
   *
   * Runtime callers must not fail a task because preferences could not be read;
   * the popup and explicit writes use {@link InteractionPreferenceStore.ready}
   * and stay strict.
   *
   * @returns {Promise<void>} Always resolves.
   */
  async readyOrFallback() {
    try {
      await this.ready();
    } catch { /* retain current policy */ }
  }

  /**
   * Persist a preference record and publish it locally.
   *
   * The store waits for readiness first, then compares the revision captured
   * before the write with the revision after it: if a change feed event already
   * published this value, the local publish is skipped to avoid a duplicate
   * notification. The storage write itself is never skipped.
   *
   * @param {InteractionPreferences} value  New preferences.
   * @returns {Promise<void>} Resolves after the write completes.
   */
  async set(value) {
    await this.ready();
    const normalized = normalizeInteractionPreferences(value);
    const revision = this.revision;
    await this.storage.set({ [INTERACTION_STORAGE_KEY]: normalized });
    if (revision === this.revision) this.publish(normalized);
  }
}

export const interactionPreferences = new InteractionPreferenceStore();
