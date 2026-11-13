/**
 * Dedicated Agent Window contract for one live session.
 *
 * Every session owns exactly one normal browser window. This module hides the
 * window and tab calls behind a small injectable surface so the session manager
 * can run against a fake in unit tests: the wrapper only reports resource
 * identities and never decides lifecycle policy itself.
 *
 * @typedef {object} AgentWindowApi
 * @property {(url: string, opts?: AgentWindowCreateOptions) => Promise<AgentWindowCreation>} create Open a normal window with one initial tab and report its identity.
 * @property {(windowId: number) => Promise<void>} remove Close a window; callers decide whether a missing window is benign.
 * @property {(windowId: number, url: string, ownedTabIds: ReadonlySet<number>) => Promise<number>} ensureActiveTab Guarantee an owned, navigable active tab and return its id.
 *
 * @typedef {object} AgentWindowCreation
 * @property {number} windowId Browser window identity returned by creation.
 * @property {number[]} initialTabIds Tabs the browser created together with the window.
 * @property {boolean} [incognito] Set when the browser opened a private window.
 *
 * @typedef {object} AgentWindowCreateOptions
 * @property {{ width: number, height: number }} [size] Optional outer size in CSS pixels.
 * @property {boolean} [focused] Background by default; explicit viewing and human help may take focus.
 * @property {boolean} [incognito] Use the browser's shared private browsing session.
 */

/** Initial tab URL shared by every new session's Agent Window. */
export const AGENT_WINDOW_HOME = 'about:blank';

/**
 * Wrapper around browser window APIs for creating and closing a dedicated
 * Agent Window.
 *
 * Creation is intentionally limited to a normal window with one initial tab.
 * The returned identities are captured before initialization runs so tab
 * events that arrive first can still be attributed to this operation rather
 * than to the user.
 *
 * @param {object} chromeApi Browser window/tab surface.
 * @param {() => Promise<boolean>} [isAllowedIncognito] Capability probe for private windows.
 * @returns {AgentWindowApi} Window operations bound to `chromeApi`.
 * @throws {Error} When the browser window API is unavailable, or when a
 *   creation call reports no window or tab identity.
 */
export function createAgentWindowApi(chromeApi, isAllowedIncognito) {
  if (!chromeApi) throw new Error('browser window API is unavailable');
  return {
    async create(url, opts = {}) {
      if (opts.incognito && isAllowedIncognito && !(await isAllowedIncognito())) {
        throw new Error('Incognito access is disabled. Allow the extension in InPrivate, then retry.');
      }
      const win = await chromeApi.windows.create({
        type: 'normal', focused: opts.focused ?? false, incognito: opts.incognito ?? false, url,
        ...(opts.size ? { width: opts.size.width, height: opts.size.height } : {}),
      });
      if (typeof win?.id !== 'number') throw new Error('browser window creation returned no window id');
      return { windowId: win.id, incognito: win.incognito, initialTabIds: (win.tabs ?? []).flatMap((tab) => (typeof tab.id === 'number' ? [tab.id] : [])) };
    },
    async remove(windowId) {
      await chromeApi.windows.remove(windowId);
    },
    async ensureActiveTab(windowId, url, ownedTabIds) {
      const tabs = await chromeApi.tabs.query({ windowId });
      const first = tabs.find((tab) => tab.id !== undefined && ownedTabIds.has(tab.id));
      if (first?.id !== undefined) {
        if (!first.active) await chromeApi.tabs.update(first.id, { active: true });
        return first.id;
      }
      const created = await chromeApi.tabs.create({ windowId, url, active: true });
      if (typeof created?.id !== 'number') throw new Error('browser tab creation returned no tab id');
      return created.id;
    },
  };
}

/**
 * Create the window API bound to the extension's global browser runtime.
 *
 * The private-window capability probe defaults to the extension runtime and
 * treats an absent probe as permission, because non-private creation must keep
 * working in runtimes that expose no incognito capability surface.
 *
 * @param {object} [chromeApi] Defaults to the extension global.
 * @param {() => Promise<boolean>} [isAllowedIncognito] Defaults to the extension capability probe.
 * @returns {AgentWindowApi} Window operations bound to the global runtime.
 */
export function chromeAgentWindowApi(chromeApi = globalThis.chrome, isAllowedIncognito) {
  return createAgentWindowApi(chromeApi, isAllowedIncognito ?? (() => chromeApi.extension?.isAllowedIncognitoAccess?.() ?? true));
}
