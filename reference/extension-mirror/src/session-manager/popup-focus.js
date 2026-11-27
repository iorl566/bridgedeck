/**
 * Recovery handle for one popup observation interval.
 *
 * The handle is created when an interval starts and finished exactly once when
 * the interval ends. Recovery is deliberately best-effort: it restores focus
 * only after the observed popup was actually claimed by this session, and it
 * never activates the browser when the user has moved to another application.
 *
 * @typedef {object} PopupFocusWatcher
 * @property {() => void} arm Snapshot the current focus before input dispatch.
 * @property {(restore: () => boolean) => Promise<void>} finish Restore focus only while `restore` still authorizes it.
 */

/** Browser can activate a background window when native input opens a page.
 * Restore a previously focused window only for an observed task popup.
 * This is recovery after activation, not a guarantee against transient focus.
 * Never activate the browser when the user was working in another application.
 *
 * A missing window surface disables recovery entirely: input dispatch must not
 * depend on focus bookkeeping.
 *
 * @param {number} windowId Agent Window to stop observing at the end.
 * @param {object} [windows] Browser window event/query surface.
 * @returns {PopupFocusWatcher} Arm/finish pair for this interval.
 */
export function watchPopupFocus(windowId, windows = globalThis.chrome?.windows) {
  if (!windows?.getAll) return { arm() {}, async finish(_restore) {} };
  let focused = -1;
  let revision = 0;
  let state;
  let before;
  let userSwitched = false;
  const onFocus = (id) => {
    // Some window managers emit WINDOW_ID_NONE between browser windows.
    if (before && id >= 0 && id !== windowId && id !== focused) userSwitched = true;
    focused = id;
    revision += 1;
  };
  const onBounds = (window) => { if (window.id === windowId) state = window.state; };
  windows.onFocusChanged.addListener(onFocus);
  windows.onBoundsChanged.addListener(onBounds);
  void windows.getAll().then((all) => {
    if (revision === 0) focused = all.find((window) => window.focused)?.id ?? -1;
    state ??= all.find((window) => window.id === windowId)?.state;
  }).catch(() => {});
  return {
    arm() {
      // Missing focus disables recovery. Reading window state must not delay
      // input dispatch or extend the popup observation interval.
      before ??= { focused, state };
    },
    async finish(restore) {
      try {
        if (!restore() || !before || userSwitched || before.focused < 0 || before.focused === windowId || focused !== windowId) return;
        const expected = revision;
        const previous = await windows.get(before.focused).catch(() => undefined);
        if (!previous || expected !== revision || focused !== windowId || !restore()) return;
        if (before.state === 'minimized') await windows.update(windowId, { state: 'minimized' });
        else await windows.update(before.focused, { focused: true });
      } catch (error) {
        console.debug('[bb] could not restore focus after task popup', error);
      } finally {
        windows.onFocusChanged.removeListener(onFocus);
        windows.onBoundsChanged.removeListener(onBounds);
      }
    },
  };
}
