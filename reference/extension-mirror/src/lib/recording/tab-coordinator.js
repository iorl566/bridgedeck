/**
 * Tracks the active tab and each tab's navigation cursor.
 *
 * @typedef {object} TabActivation
 * @property {number} tabId
 * @property {number} revision
 *
 * @typedef {object} RecordingNavigationCursor
 * @property {string} [currentUrl]
 * @property {boolean} pendingNavigation
 */

export class RecordingTabCoordinator {
  /**
   * @param {number} initialTabId
   * @param {string} [initialUrl]
   */
  constructor(initialTabId, initialUrl) {
    this.navigationByTab = new Map();
    this.activeTabIdValue = initialTabId;
    this.currentTabIdValue = initialTabId;
    this.activationRevision = 0;
    this.navigationByTab.set(initialTabId, { currentUrl: initialUrl, pendingNavigation: false });
  }

  /** @returns {number} */
  get activeTabId() { return this.activeTabIdValue; }
  /** @returns {number} */
  get currentTabId() { return this.currentTabIdValue; }

  /**
   * @param {number} tabId
   * @returns {TabActivation}
   */
  noteActivation(tabId) {
    this.activeTabIdValue = tabId;
    this.activationRevision += 1;
    return { tabId, revision: this.activationRevision };
  }

  /**
   * @param {TabActivation} activation
   * @returns {boolean}
   */
  isLatest(activation) {
    return activation.tabId === this.activeTabIdValue && activation.revision === this.activationRevision;
  }

  /**
   * @param {number} tabId
   * @param {string} [currentUrl]
   * @returns {void}
   */
  commit(tabId, currentUrl) {
    if (currentUrl !== undefined) this.navigation(tabId).currentUrl = currentUrl;
    this.currentTabIdValue = tabId;
  }

  /**
   * @param {number} tabId
   * @param {string} [fallbackUrl]
   * @returns {RecordingNavigationCursor}
   */
  navigation(tabId, fallbackUrl) {
    const existing = this.navigationByTab.get(tabId);
    if (existing) {
      if (!existing.currentUrl && fallbackUrl) existing.currentUrl = fallbackUrl;
      return existing;
    }
    const created = { currentUrl: fallbackUrl, pendingNavigation: false };
    this.navigationByTab.set(tabId, created);
    return created;
  }
}
