/**
 * Content-side help request construction.
 *
 * The same representation is used by live delivery and by recovery after a
 * reload, so it must be derivable from the request message plus the background
 * query alone.
 *
 * @typedef {object} HelpRequestDataDeps
 * @property {(requestId: string, outcome: 'continued' | 'cancelled', note?: string) => void} finish
 * Report the human's decision to the background.
 * @property {() => Promise<import('../lib/help-bridge.js').HelpQueryResponse | undefined>} query
 * Re-read the active request; used to refresh highlight rectangles.
 */

/**
 * Build the content-side representation shared by live delivery and recovery.
 *
 * A refresh only returns rectangles when the queried request is still active
 * and has the same request id, so a stale refresh cannot move highlights onto
 * a newer request.
 *
 * @param {Omit<import('../lib/help-bridge.js').HelpRequestMessage, 'type'>} message
 * @param {HelpRequestDataDeps} deps
 * @returns {import('./HelpRequestOverlay.js').HelpRequestData}
 */
export function createHelpRequestData(message, deps) {
  return {
    id: message.requestId,
    prompt: message.prompt,
    ...(message.title ? { title: message.title } : {}),
    ...(message.displayMode ? { displayMode: message.displayMode } : {}),
    selectors: message.selectors,
    rects: message.rects,
    refreshRects: async () => {
      const response = await deps.query();
      return response?.active && response.request?.requestId === message.requestId ? response.request.rects : undefined;
    },
    onContinue: (note) => deps.finish(message.requestId, 'continued', note.trim() ? note : undefined),
    onCancel: () => deps.finish(message.requestId, 'cancelled'),
  };
}
