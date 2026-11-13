import { LONG_SCREENSHOT_PAGE, ScreenshotError } from './types.js';
import { waitForReply } from './wait.js';

/**
 * Page-side client bound to one document.
 * @typedef {object} PageClient
 * @property {(command: import('./types.js').PageCommand) => Promise<import('./types.js').PageMetrics>} page Send one command to the page task.
 * @property {string | undefined} documentId Document the client is bound to.
 * @property {() => Promise<void>} prepare Resolve the top document and inject the page task when missing.
 */

/** Bind every command (including cleanup and reinjection) to one document.
 * @param {number} tabId Captured tab.
 * @param {string} id Capture identity.
 * @param {AbortSignal} signal Cancels in-flight commands.
 * @param {() => Promise<void>} checkTab Revalidates tab ownership before each command.
 * @param {{ tabs?: object, webNavigation?: object, scripting?: object }} [api] Browser API overrides.
 * @returns {PageClient}
 */
export function createPageClient(tabId, id, signal, checkTab, api = {}) {
  const tabs = api.tabs ?? globalThis.chrome?.tabs;
  const webNavigation = api.webNavigation ?? globalThis.chrome?.webNavigation;
  const scripting = api.scripting ?? globalThis.chrome?.scripting;
  let documentId;
  const page = async (command) => {
    if (command.action !== 'finish') await checkTab();
    let response;
    try {
      response = await waitForReply(
        tabs.sendMessage(tabId, { type: LONG_SCREENSHOT_PAGE, id, ...command }, documentId ? { documentId } : { frameId: 0 }),
        command.action === 'finish' ? undefined : signal,
        command.action === 'finish' ? 2000 : 8000,
      );
    } catch (error) {
      if (error instanceof ScreenshotError || signal.aborted) throw error;
      throw new ScreenshotError('unavailable');
    }
    if (!response?.ok) throw new ScreenshotError(response?.error ?? 'unavailable', response?.ok === false ? response.reason : undefined);
    return response.metrics;
  };
  return {
    page,
    get documentId() { return documentId; },
    async prepare() {
      const frame = await waitForReply(webNavigation.getFrame({ tabId, frameId: 0 }), signal);
      documentId = frame?.documentId;
      if (!documentId) throw new ScreenshotError('autoUnavailable');
      try {
        await page({ action: 'probe' });
      } catch (error) {
        // Tabs opened before an extension reload may lack this content script.
        if (!(error instanceof ScreenshotError) || error.code !== 'unavailable') throw error;
        await checkTab();
        try {
          await waitForReply(scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: ['content-scripts/long-screenshot-page.js'] }), signal);
          await page({ action: 'probe' });
        } catch (error) {
          await checkTab();
          if (error instanceof ScreenshotError && error.code !== 'unavailable') throw error;
          throw new ScreenshotError('autoUnavailable');
        }
      }
    },
  };
}
