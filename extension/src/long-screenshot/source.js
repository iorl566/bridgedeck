import { ScreenshotError } from './types.js';
import { waitForReply } from './wait.js';

/**
 * Backend that exposes viewport exposures as data URLs.
 * @typedef {object} ScreenshotSource
 * @property {() => Promise<string>} capture Capture the current viewport.
 * @property {() => Promise<void>} close Release the backend.
 * @property {boolean} [checkFreshness] Validate exposures for the desktop renderer workaround.
 */

/** Select a capture backend before measuring the page: attaching a debugger can
 * change the viewport through the browser's infobar. Never switch midway through a PNG.
 * @param {number} tabId Captured tab.
 * @param {number} windowId Window owning the tab.
 * @param {AbortSignal} signal Cancels probing and attachment.
 * @param {() => Promise<void>} checkTab Revalidates tab ownership.
 * @param {boolean} [allowDebugger] Permit a debugger-backed fallback.
 * @param {() => Promise<ScreenshotSource>} [ownedSource] Reuse an already attached source.
 * @param {object} [api] Browser API overrides.
 * @returns {Promise<ScreenshotSource>}
 */
export async function openScreenshotSource(tabId, windowId, signal, checkTab, allowDebugger = true, ownedSource, api = globalThis.chrome) {
  if (!api) throw new ScreenshotError('unavailable');
  if (allowDebugger && ownedSource) {
    const platform = await waitForReply(api.runtime.getPlatformInfo(), signal);
    if (platform.os === 'win') {
      await checkTab();
      return { ...(await ownedSource()), checkFreshness: true };
    }
  }
  let lastShot = Date.now();
  try {
    await waitForReply(api.tabs.captureVisibleTab(windowId, { format: 'png' }), signal, 2000);
    return {
      async capture() {
        const delay = Math.max(0, 600 - (Date.now() - lastShot));
        if (delay) await waitForReply(new Promise((resolve) => setTimeout(resolve, delay)), signal);
        await checkTab();
        lastShot = Date.now();
        return waitForReply(api.tabs.captureVisibleTab(windowId, { format: 'png' }), signal);
      },
      async close() {},
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (!allowDebugger) throw new ScreenshotError('unavailable');
  }
  await checkTab();
  if (ownedSource) return ownedSource();
  const target = { tabId };
  const attaching = api.debugger.attach(target, '1.3');
  try {
    await waitForReply(attaching, signal);
  } catch (error) {
    void attaching.then(() => api.debugger.detach(target)).catch(() => {});
    if (signal.aborted || error instanceof ScreenshotError) throw error;
    throw new ScreenshotError('busy');
  }
  return {
    async capture() {
      await checkTab();
      const result = await waitForReply(api.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }), signal);
      if (!result?.data) throw new ScreenshotError('captureFailed');
      return `data:image/png;base64,${result.data}`;
    },
    async close() {
      await waitForReply(api.debugger.detach(target), undefined, 2000).catch(() => {});
    },
  };
}
