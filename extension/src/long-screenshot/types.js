/**
 * How far a capture may extend.
 * @typedef {'follow' | 'current'} CaptureScope
 *
 * @typedef {'auto' | 'manual' | 'visible'} CaptureMode
 *
 * @typedef {'user_cancelled' | 'page_hidden' | 'navigation' | 'watchdog_timeout'} CaptureCancelReason
 *
 * @typedef {CaptureCancelReason | 'stale_frame' | 'loading_stalled'} CaptureFailureReason
 *
 * @typedef {'preparing' | 'capturing' | 'paused' | 'saving' | 'complete' | 'cancelled' | 'error'} CapturePhase
 *
 * @typedef {'unsupported' | 'unavailable' | 'autoUnavailable' | 'busy' | 'changed' | 'tooLarge' | 'storageFull' | 'alignment' | 'timeout' | 'captureFailed' | 'saveFailed' | 'interrupted'} CaptureError
 */

/**
 * Published capture status; the popup renders it and the preview page reloads it.
 * @typedef {object} CaptureState
 * @property {string} id Capture identity.
 * @property {number} tabId Captured tab.
 * @property {string} [pageUrl] Document URL at start.
 * @property {string} title Document title.
 * @property {CapturePhase} phase Current lifecycle phase.
 * @property {number} progress Percentage for display.
 * @property {number} frames Accepted exposures so far.
 * @property {CaptureError} [error] Terminal failure code.
 * @property {CaptureMode} [mode] Requested capture mode.
 * @property {CaptureError} [notice] Non-fatal warning, such as a partial result.
 * @property {boolean} [partial] True when the saved image omits page content.
 * @property {number} [width] Saved pixel width.
 * @property {number} [height] Saved pixel height.
 */

/**
 * Page geometry observed by the capture task.
 * @typedef {object} PageMetrics
 * @property {number} x Horizontal scroll offset.
 * @property {number} y Vertical scroll offset.
 * @property {number} width Scrollable document width.
 * @property {number} height Scrollable document height.
 * @property {number} viewportWidth Viewport width used for tiling.
 * @property {number} viewportHeight Viewport height used for tiling.
 * @property {number} innerWidth Layout viewport width.
 * @property {number} innerHeight Layout viewport height.
 * @property {number} dpr Device pixel ratio.
 * @property {number} [bottomOverlayHeight] Overlap painted by fixed bottom browser UI.
 * @property {number} [tailStart] Document tail that must be redrawn on growth.
 * @property {boolean} [bottomReady] False while the current bottom is still settling.
 * @property {boolean} [loading] True while a loading indicator is visible.
 */

/**
 * One page-side command. `begin`, `move` and `pause` use the extra fields.
 * @typedef {object} PageCommand
 * @property {'probe' | 'begin' | 'move' | 'inspect' | 'pause' | 'finish'} action
 * @property {string} [label] Progress label, for `begin`.
 * @property {string} [cancelLabel] Cancel button label, for `begin`.
 * @property {CaptureScope} [scope] Capture extent, for `begin`.
 * @property {number} [y] Scroll target, for `move`.
 * @property {boolean} [capture] Capture this exposure, for `move`.
 * @property {boolean} [final] Last stable bottom exposure, for `move`.
 * @property {boolean} [paused] Pause state, for `pause`.
 */

/**
 * @typedef {PageCommand & { type: string, id: string }} PageRequest
 *
 * @typedef {{ ok: true, metrics: PageMetrics } | { ok: false, error: CaptureError, reason?: CaptureFailureReason }} PageReply
 *
 * @typedef {object} CaptureRequest
 * @property {string} type Message type marker.
 * @property {'start' | 'status' | 'pause' | 'resume' | 'finish' | 'cancel' | 'preview'} action
 * @property {CaptureMode} [mode] Requested mode, for `start`.
 * @property {string} [id] Capture identity, for all actions except `start` and `status`.
 *
 * @typedef {{ ok: true, state: CaptureState | null } | { ok: false, error: CaptureError }} CaptureReply
 */

export const LONG_SCREENSHOT = 'bb/long-screenshot';
export const LONG_SCREENSHOT_PAGE = 'bb/long-screenshot-page';
export const LONG_SCREENSHOT_STATE = 'longScreenshotState';

/**
 * True while the capture still owns a job that may publish progress.
 * @param {CaptureState | null | undefined} state
 * @returns {boolean}
 */
export const isCapturing = (state) => state?.phase === 'preparing' || state?.phase === 'capturing' || state?.phase === 'paused' || state?.phase === 'saving';

/** Capture failure with a transport-facing code and an optional diagnostic reason. */
export class ScreenshotError extends Error {
  /**
   * @param {CaptureError} code Stable failure code.
   * @param {CaptureFailureReason} [reason] Diagnostic detail.
   */
  constructor(code, reason) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}
