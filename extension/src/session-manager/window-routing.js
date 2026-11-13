import { isAgentControlledTab } from './manager.js';
import { waitForTabCreation } from './tab-creation.js';

const SOURCE_SETTLE_MS = 100;
const RETRY_DELAYS = [250, 1000, 3000];

/**
 * A tab seen inside a task window and awaiting routing back out.
 * @typedef {object} RoutingCandidate
 * @property {import('./manager.js').SessionContext} task Session owning the window.
 * @property {number} attempt Retry index into the delay schedule.
 * @property {ReturnType<typeof setTimeout>} [timer] Pending routing attempt.
 */

/**
 * Keep unrelated tabs out of live task windows without recreating their pages.
 *
 * A page the browser opened from a user window can land in a task window: the
 * opener decides placement, not intent. Routing moves such tabs back to an
 * existing user window, or creates one when none qualifies, and never reloads
 * the page. Tabs claimed by the task, borrowed by another session, or opened
 * from a task page are protected and stay where they are.
 *
 * Candidates are retried on a fixed delay schedule. A tab that never routes is
 * kept out of default tool targets rather than being force-moved.
 */
export class AgentWindowRouting {
  /**
   * @param {import('./manager.js').SessionManager} manager Session registry.
   * @param {object} [api] Browser tab/window/navigation event surface.
   * @param {(sessionId: string) => boolean} [userControlled] Suppresses routing during human help.
   */
  constructor(manager, api = globalThis.chrome, userControlled = () => false) {
    this.manager = manager;
    this.api = api;
    this.userControlled = userControlled;
    this.candidates = new Map();
    this.tabWindows = new Map();
    this.pageSourceWindows = new Map();
    this.userWindows = [];
    this.scanned = new WeakSet();
    this.focusedWindow = -1;
    this.focusRevision = 0;
    this.disposed = false;
    this.mutations = Promise.resolve();
    /** Record a created tab and start routing when it looks unrelated.
     * @param {object} tab Created or updated tab.
     */
    this.created = (tab) => {
      if (this.disposed || tab.id === undefined) return;
      this.tabWindows.set(tab.id, tab.windowId);
      if (this.candidates.has(tab.id)) return;
      const task = this.manager.findByWindowId(tab.windowId);
      if (!task || !this.live(task) || this.protected(task, tab.id)) return;
      const candidate = { task, attempt: 0 };
      this.candidates.set(tab.id, candidate);
      (task.pendingRoutingTabs ??= new Set()).add(tab.id);
      this.schedule(tab.id, candidate, SOURCE_SETTLE_MS);
    };
    /** Track a tab attached to another window, then re-evaluate it there.
     * @param {number} id Attached tab.
     * @param {{ newWindowId: number }} info Attachment target.
     */
    this.attached = (id, info) => {
      this.tabWindows.set(id, info.newWindowId);
      void this.api.tabs.get(id).then((tab) => {
        if (this.tabWindows.get(id) === info.newWindowId) this.created(tab);
      }).catch(() => {});
    };
    /** Re-evaluate a tab after a navigation or load-state update.
     * @param {number} _id Updated tab identity.
     * @param {object} _change Change descriptor, unused.
     * @param {object} tab Fresh tab snapshot.
     */
    this.updated = (_id, _change, tab) => this.created(tab);
    /** Drop all routing state for a tab that closed or was detached.
     * @param {number} id Closed or detached tab.
     */
    this.forget = (id) => {
      const task = this.candidates.get(id)?.task ?? this.manager.findByWindowId(this.tabWindows.get(id) ?? -1);
      task?.pendingRoutingTabs?.delete(id);
      this.clearCandidate(id);
      this.tabWindows.delete(id);
      this.pageSourceWindows.delete(id);
    };
    /** Snapshot page provenance as soon as the browser reports it.
     *
     * The opening tab can close or move before routing runs, so the source
     * window is recorded now. Provenance only protects the page from routing;
     * it grants no control or cleanup rights.
     *
     * @param {{ sourceTabId: number, tabId: number }} details Navigation target pair.
     */
    this.navigationTarget = (details) => {
      const windowId = this.tabWindows.get(details.sourceTabId);
      if (windowId !== undefined) {
        this.pageSourceWindows.set(details.tabId, windowId);
        this.manager.findByWindowId(windowId)?.pendingRoutingTabs?.delete(details.tabId);
      }
    };
    /** Track which normal window the user is currently viewing.
     *
     * A live focus event is newer than the asynchronous startup snapshot, so
     * the revision check discards a stale query result. Non-task windows are
     * remembered as routing destinations, most recent first.
     *
     * @param {number} id Focused window, or a negative value for none.
     */
    this.focusChanged = (id) => {
      this.focusedWindow = id;
      const revision = ++this.focusRevision;
      if (id < 0 || this.manager.findByWindowId(id)) return;
      void this.api.windows.get(id).then((window) => {
        if (this.disposed || revision !== this.focusRevision || window.type !== 'normal' || this.manager.findByWindowId(id)) return;
        this.windowRemoved(id);
        this.userWindows.unshift(id);
      }).catch(() => {});
    };
    /** Remove a closed window from the remembered destination list.
     * @param {number} id Removed window.
     */
    this.windowRemoved = (id) => {
      for (let index = this.userWindows.indexOf(id); index !== -1; index = this.userWindows.indexOf(id)) this.userWindows.splice(index, 1);
    };
    api.tabs.onCreated.addListener(this.created);
    api.tabs.onAttached.addListener(this.attached);
    api.tabs.onUpdated.addListener(this.updated);
    api.tabs.onRemoved.addListener(this.forget);
    api.tabs.onDetached.addListener(this.forget);
    api.webNavigation.onCreatedNavigationTarget.addListener(this.navigationTarget);
    api.windows.onFocusChanged.addListener(this.focusChanged);
    api.windows.onRemoved.addListener(this.windowRemoved);
    const revision = this.focusRevision;
    void api.windows.getAll({ windowTypes: ['normal'] }).then((windows) => {
      if (this.disposed) return;
      for (const window of windows) if (window.id !== undefined && !this.manager.findByWindowId(window.id)) this.userWindows.push(window.id);
      if (revision === this.focusRevision) {
        const focused = windows.find((window) => window.focused);
        if (focused?.id !== undefined) this.focusChanged(focused.id);
      }
    }).catch((error) => console.debug('[bb] window routing initialization failed', error));
  }

  /** Startup events can precede registration of the new session's window.
   *
   * Scanning once per context catches windows that already hold unrelated tabs
   * when the session starts.
   */
  sync() {
    for (const task of this.manager.list()) {
      if (this.scanned.has(task)) continue;
      this.scanned.add(task);
      void this.api.tabs.query({ windowId: task.agentWindowId }).then((tabs) => { for (const tab of tabs) this.created(tab); }).catch(() => {});
    }
    for (const [id, candidate] of this.candidates) if (!this.live(candidate.task)) this.forget(id);
  }

  /** Detach every browser listener and drop pending routing state.
   *
   * Pending timers are cleared through `forget`, and pending routing markers are
   * removed from every live context so a disposed router cannot keep a tab out
   * of tool targeting.
   */
  dispose() {
    this.disposed = true;
    const { tabs, windows, webNavigation } = this.api;
    tabs.onCreated.removeListener(this.created);
    tabs.onAttached.removeListener(this.attached);
    tabs.onUpdated.removeListener(this.updated);
    tabs.onRemoved.removeListener(this.forget);
    tabs.onDetached.removeListener(this.forget);
    webNavigation.onCreatedNavigationTarget.removeListener(this.navigationTarget);
    windows.onFocusChanged.removeListener(this.focusChanged);
    windows.onRemoved.removeListener(this.windowRemoved);
    for (const id of this.candidates.keys()) this.forget(id);
    for (const task of this.manager.list()) task.pendingRoutingTabs?.clear();
    this.tabWindows.clear();
    this.pageSourceWindows.clear();
  }

  /** Whether routing work is still allowed for a context.
   * @param {import('./manager.js').SessionContext} task Context to test.
   * @returns {boolean} False after dispose, release, or a committed close.
   */
  live(task) {
    return !this.disposed && this.manager.get(task.sessionId) === task && !this.manager.isWindowCloseExpected(task);
  }

  /** Whether a tab must stay where it is.
   *
   * Protected tabs cover four cases: claimed by the task, opened from one of
   * its pages, borrowed by another session, or excluded because human help is
   * in progress. None of them may be moved by the router.
   *
   * @param {import('./manager.js').SessionContext} task Context owning the window.
   * @param {number} tabId Tab in question.
   * @returns {boolean} True when the tab must not be routed.
   */
  protected(task, tabId) {
    return isAgentControlledTab(task, tabId) || this.pageSourceWindows.get(tabId) === task.agentWindowId || this.manager.findBorrowingSession(tabId, null) !== null || this.userControlled(task.sessionId);
  }

  /** Cancel a pending routing attempt for one tab.
   * @param {number} id Tab whose candidate is dropped.
   */
  clearCandidate(id) {
    clearTimeout(this.candidates.get(id)?.timer);
    this.candidates.delete(id);
  }

  /** Schedule one routing attempt, serialized with every other mutation.
   *
   * Creation barriers run first so a tab the agent is still creating is not
   * routed. Destination selection and moves then run through one promise chain,
   * which keeps concurrent external links sharing a single replacement window.
   *
   * @param {number} id Tab to route.
   * @param {RoutingCandidate} candidate Routing state for the tab.
   * @param {number} delay Milliseconds until the attempt.
   */
  schedule(id, candidate, delay) {
    candidate.timer = setTimeout(() => {
      void waitForTabCreation(candidate.task).then(() => {
        this.mutations = this.mutations.then(async () => {
          if (this.candidates.get(id) !== candidate) return;
          if (!this.live(candidate.task)) { this.forget(id); return; }
          try {
            await this.route(id, candidate.task);
            if (this.candidates.get(id) === candidate) {
              this.clearCandidate(id);
              candidate.task.pendingRoutingTabs?.delete(id);
            }
          } catch (error) {
            if (this.candidates.get(id) !== candidate) return;
            if (!this.live(candidate.task)) { this.forget(id); return; }
            const retry = RETRY_DELAYS[candidate.attempt++];
            if (retry !== undefined) this.schedule(id, candidate, retry);
            else {
              // Keep the unresolved tab excluded from default tool targeting
              // until it moves, closes, is claimed, or gets page provenance.
              this.clearCandidate(id);
              console.warn('[bb] could not return unrelated tab to a user window', id, error);
            }
          }
        });
      });
    }, delay);
  }

  /** Move one unrelated tab back to a user window.
   *
   * State is rechecked after each awaited lookup because the user can move the
   * tab, start a borrow, or close the window during routing. A background tab
   * is moved without activating it; a tab the user is watching follows into the
   * destination unless focus moved elsewhere during the operation.
   *
   * @param {number} id Tab to move.
   * @param {import('./manager.js').SessionContext} task Context owning the window.
   * @returns {Promise<void>} Resolves when the attempt finishes or is skipped.
   */
  async route(id, task) {
    const tab = await this.api.tabs.get(id).catch(() => undefined);
    if (!tab || tab.windowId !== task.agentWindowId || !this.live(task) || this.protected(task, id)) return;
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    const available = windows.filter((window) => window.id !== undefined && window.incognito === tab.incognito && !this.manager.findByWindowId(window.id));
    const destination = this.userWindows.map((windowId) => available.find((window) => window.id === windowId)).find((window) => window !== undefined) ?? available.find((window) => window.focused) ?? available[0];
    const current = await this.api.tabs.get(id).catch(() => undefined);
    if (!current || current.windowId !== task.agentWindowId || !this.live(task) || this.protected(task, id)) return;
    const focusRevision = this.focusRevision;
    const show = current.active && this.focusedWindow === task.agentWindowId;
    let destinationId = destination?.id;
    if (destinationId !== undefined) await this.api.tabs.move(id, { windowId: destinationId, index: -1 });
    else {
      const created = await this.api.windows.create({ tabId: id, type: 'normal', focused: false, ...(current.incognito ? { incognito: true } : {}) });
      destinationId = created?.id;
      if (destinationId !== undefined) this.userWindows.push(destinationId);
    }
    if (show && destinationId !== undefined && !this.disposed && focusRevision === this.focusRevision) {
      await this.api.tabs.update(id, { active: true });
      if (focusRevision === this.focusRevision) await this.api.windows.update(destinationId, { focused: true });
    }
  }
}
