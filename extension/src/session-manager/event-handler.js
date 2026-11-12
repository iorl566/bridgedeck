import { OVERLAY_AGENT_OVERLAY_RESET } from '../lib/overlay-bridge.js';
import { nextOverlayVersion } from '../lib/overlay-version.js';
import { isAgentControlledTab } from './manager.js';
import { expectedTabMoves as defaultExpectedTabMoves } from './tab-moves.js';

/**
 * Observers that let the session manager react to user-driven window changes.
 *
 * The handler owns three decisions: a tab the user moved out of a task window
 * ends that task, a window the browser removed for a normal stop is dropped
 * without a duplicate close event, and a window the user closed is published as
 * such with any borrowed tabs that could no longer be returned.
 *
 * @typedef {object} AgentOverlayResetApi
 * @property {(tabId: number, sessionId: string) => Promise<void> | void} resetAgentOverlays Clear task decorations from one tab.
 *
 * @typedef {object} WindowRemovedListener
 * @property {(cb: (windowId: number) => void) => void} addListener
 * @property {(cb: (windowId: number) => void) => void} removeListener
 *
 * @typedef {object} SessionEventHandlerOptions
 * @property {object} manager Session registry.
 * @property {{ send: (frame: object) => void }} transport Daemon event channel.
 * @property {WindowRemovedListener} [windowEvents] Window-removal surface.
 * @property {object} [tabEvents] Detach/attach/removal tab surface.
 * @property {AgentOverlayResetApi | ((tabId: number, sessionId: string) => Promise<void> | void)} [agentOverlayReset] Overlay teardown for released tabs.
 * @property {object} [expectedTabMoves] Tracker for extension-issued moves.
 * @property {(session: object) => void} [onSessionReleased] Runs after ownership is removed and before tab cleanup.
 * @property {object} [cdp] Session detach and per-tab release surface.
 * @property {() => void} [onSessionsChanged] Refresh side caches after a release.
 */

function chromeWindowEvents() {
  return {
    addListener: (cb) => globalThis.chrome?.windows?.onRemoved?.addListener(cb),
    removeListener: (cb) => globalThis.chrome?.windows?.onRemoved?.removeListener(cb),
  };
}

/**
 * Best-effort overlay reset used when the caller does not inject one. Teardown
 * also runs where no extension runtime is available, so a missing messaging
 * API is treated as a no-op.
 */
const defaultAgentOverlayReset = {
  async resetAgentOverlays(tabId, sessionId) {
    if (typeof globalThis.chrome?.tabs?.sendMessage !== 'function') return;
    await globalThis.chrome.tabs.sendMessage(tabId, {
      type: OVERLAY_AGENT_OVERLAY_RESET,
      sessionId,
      ...nextOverlayVersion(),
    });
  },
};

/** Accept both the reset-object contract and a plain callback. */
function resetOverlaysFor(options) {
  return (tabId, sessionId) => {
    const reset = options.agentOverlayReset ?? defaultAgentOverlayReset;
    return Promise.resolve().then(() =>
      typeof reset === 'function' ? reset(tabId, sessionId) : reset.resetAgentOverlays(tabId, sessionId));
  };
}

/**
 * Handle returned to the caller that owns the browser listeners.
 * @typedef {object} SessionEventHandlerHandle
 * @property {() => void} dispose Remove every registered listener.
 */

/**
 * Wire user-driven tab and window events to the session lifecycle.
 *
 * The returned handle must be disposed with the owning browser context:
 * listeners are added immediately, and a window closed before disposal would
 * otherwise keep the handler alive. Cleanup work started by the handler is
 * best-effort and never rejects into the event loop.
 *
 * @param {SessionEventHandlerOptions} options Injected dependencies.
 * @returns {SessionEventHandlerHandle} Disposable listener registration.
 */
export function attachSessionEventHandler(options) {
  const { manager, transport, onSessionsChanged } = options;
  const events = options.windowEvents ?? chromeWindowEvents();
  const tabs = options.tabEvents ?? globalThis.chrome?.tabs;
  const expected = options.expectedTabMoves ?? defaultExpectedTabMoves;
  const resetOverlays = resetOverlaysFor(options);
  const cdp = options.cdp;

  const onDetached = (tabId, info) => {
    const expectation = expected.onDetached(tabId, info.oldWindowId);
    const ctx = manager.findByWindowId(info.oldWindowId);
    if (!ctx || !isAgentControlledTab(ctx, tabId)) return;
    const ownedTabs = new Set([...ctx.agentCreatedTabs, ...ctx.borrowedTabs.keys(), ...(ctx.observedTabs ?? [])]);
    const end = () => {
      if (manager.get(ctx.sessionId) !== ctx) return;
      manager.release(ctx.sessionId);
      ctx.refStore.clear();
      try {
        transport.send({ event: 'session.ended', payload: { session_id: ctx.sessionId, reason: 'user_moved_tab', tab_id: tabId } });
      } catch (error) {
        console.debug('[bb] could not report moved task tab', error);
      }
      try {
        options.onSessionReleased?.(ctx);
      } catch (error) {
        console.debug('[bb] session release callback failed', error);
      }
      try {
        onSessionsChanged?.();
      } catch (error) {
        console.debug('[bb] released session display refresh failed', error);
      }
      // A user move releases the whole task. Never close or return its pages:
      // more tabs from the same group may still be crossing windows.
      for (const id of ownedTabs) {
        void resetOverlays(id, ctx.sessionId).catch((error) => {
          console.debug('[bb] released tab overlay reset failed', error);
        });
        void Promise.resolve().then(() => cdp?.releaseSessionTab?.(ctx.sessionId, id)).catch((error) => {
          console.debug('[bb] released tab CDP cleanup failed', error);
        });
      }
      void Promise.resolve().then(() => cdp?.detachSession(ctx.sessionId)).catch((error) => {
        console.debug('[bb] released session CDP cleanup failed', error);
      });
    };
    if (typeof expectation === 'boolean') {
      if (!expectation) end();
    } else {
      void expectation.then((movedByUs) => { if (!movedByUs) end(); });
    }
  };

  const onAttached = (tabId, info) => expected.onAttached(tabId, info.newWindowId);
  const onTabRemoved = (tabId) => expected.forget(tabId);

  const onRemoved = (windowId) => {
    const ctx = manager.findByWindowId(windowId);
    if (!ctx) return;
    const expectedClose = manager.isWindowCloseExpected(ctx);
    if (expectedClose) {
      const detach = cdp
        ? Promise.resolve().then(() => cdp.detachSession(ctx.sessionId)).catch((error) => {
            console.debug('[bb] session-event CDP detach failed', error);
          })
        : Promise.resolve();
      void detach
        .then(() => manager.stop(ctx.sessionId, { dropOnly: true }))
        .then(() => { onSessionsChanged?.(); })
        .catch((error) => {
          console.warn('[bb] session-event handler failed', error);
        });
      return;
    }
    const ownedTabs = new Set([...ctx.agentCreatedTabs, ...ctx.borrowedTabs.keys(), ...(ctx.observedTabs ?? [])]);
    const returnFailures = Array.from(ctx.borrowedTabs.keys()).map((tabId) => ({ tab_id: tabId, code: 'cdp_failed', message: 'Agent Window was closed before borrowed tab could be returned' }));
    if (returnFailures.length > 0) {
      console.warn(`[bb] Agent Window ${windowId} closed with borrowed tabs that could not be returned`, returnFailures);
    }
    manager.release(ctx.sessionId);
    ctx.refStore.clear();
    const event = { event: 'session.window_closed', payload: { session_id: ctx.sessionId, reason: 'user_closed_window', ...(returnFailures.length ? { return_failures: returnFailures } : {}) } };
    try {
      transport.send(event);
    } catch (error) {
      console.warn('[bb] could not push session.window_closed event', error);
    }
    try {
      options.onSessionReleased?.(ctx);
    } catch (error) {
      console.debug('[bb] session release callback failed', error);
    }
    try {
      onSessionsChanged?.();
    } catch (error) {
      console.debug('[bb] released session display refresh failed', error);
    }
    for (const id of ownedTabs) {
      void Promise.resolve().then(() => cdp?.releaseSessionTab?.(ctx.sessionId, id)).catch((error) => {
        console.debug('[bb] session-event tab CDP release failed', error);
      });
    }
    void Promise.resolve().then(() => cdp?.detachSession(ctx.sessionId)).catch((error) => {
      console.debug('[bb] session-event CDP detach failed', error);
    });
  };

  events.addListener(onRemoved);
  tabs?.onDetached.addListener(onDetached);
  tabs?.onAttached.addListener(onAttached);
  tabs?.onRemoved.addListener(onTabRemoved);
  return {
    dispose: () => {
      events.removeListener(onRemoved);
      tabs?.onDetached.removeListener(onDetached);
      tabs?.onAttached.removeListener(onAttached);
      tabs?.onRemoved.removeListener(onTabRemoved);
    },
  };
}
