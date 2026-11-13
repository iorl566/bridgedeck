/**
 * Recording pill.
 *
 * A fixed, draggable pill that shows the recording message for the first ten
 * seconds and the elapsed session time afterwards, with an icon-only finish
 * button. Dragging starts only after the pointer leaves a small dead zone, is
 * ignored while the press starts on an interactive child control, and is clamped
 * so the pill stays inside the viewport.
 */
import React from 'react';
import { useTranslation } from '../vendor/i18n-lite.js';

const h = React.createElement;
const recordIconUrl = new URL('../../assets/record-icon.png', import.meta.url).href;
const VIEWPORT_MARGIN = 16;
const DRAG_THRESHOLD_PX = 8;
const INTRO_DURATION_MS = 10_000;
const TIMER_REFRESH_MS = 250;

/**
 * One recording session shown by the pill.
 *
 * `startedAtMs` comes from the background so a remount after navigation resumes
 * the same phase instead of restarting the intro.
 *
 * @typedef {object} RecordRequestData
 * @property {string} id Recording id; changing it resets the intro and timer.
 * @property {number} [startedAtMs] Epoch ms when the recording began, supplied by
 * the background so the timer keeps counting across navigations. Falls back to
 * mount time when unavailable.
 * @property {() => void} onFinish Finish request from the pill button.
 */

/**
 * Props for the recording pill.
 *
 * @typedef {object} RecordOverlayProps
 * @property {RecordRequestData | null} request Active recording, or null when hidden.
 */

/**
 * Pill position in viewport coordinates.
 *
 * @typedef {object} RecordDragPosition
 * @property {number} top
 * @property {number} left
 */

/**
 * Geometry captured when a pill drag starts.
 *
 * @typedef {object} RecordDragStart
 * @property {number} pointerX Pointer X at press, in client coordinates.
 * @property {number} pointerY Pointer Y at press, in client coordinates.
 * @property {number} originLeft Pill left offset at press.
 * @property {number} originTop Pill top offset at press.
 * @property {number} panelW Measured pill width used for clamping.
 * @property {number} panelH Measured pill height used for clamping.
 * @property {boolean} armed True once the pointer leaves the dead zone.
 */

/**
 * Format elapsed whole seconds as zero-padded `MM:SS`.
 *
 * Exported for unit tests; the component is its only runtime caller.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
/**
 * Clamp `value` into the inclusive `[min, max]` range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

/**
 * Clamp a dragged pill position inside the viewport, keeping the margin.
 *
 * Exported for unit tests; the component is its only runtime caller.
 *
 * @param {number} top
 * @param {number} left
 * @param {number} panelW
 * @param {number} panelH
 * @returns {{ top: number, left: number }}
 */
export function clampDragPos(top, left, panelW, panelH) {
  const maxLeft = window.innerWidth - panelW - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - panelH - VIEWPORT_MARGIN;
  return {
    top: clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop)),
    left: clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft)),
  };
}

/**
 * Render the recording pill.
 *
 * The intro/timer phase is derived from elapsed time (not from a one-shot flag),
 * so a remount with `startedAtMs` resumes the same phase and elapsed value.
 *
 * @param {RecordOverlayProps} props
 * @returns {object | null}
 */
export function RecordOverlay({ request }) {
  const { t } = useTranslation('extension');
  /** True once the enter transition starts (`boolean`); drives opacity and transform. */
  const [show, setShow] = React.useState(false);
  /** Whole seconds since the recording began (`number`); refreshed every TIMER_REFRESH_MS. */
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  /** Pill position after a drag (`RecordDragPosition | null`). */
  const [dragPos, setDragPos] = React.useState(null);
  /** True while a drag is active (`boolean`). */
  const [dragging, setDragging] = React.useState(false);
  /** Pill element used for measurement. */
  const pillRef = React.useRef(null);
  /** Pointer and geometry captured at press (`RecordDragStart | null`). */
  const dragStartRef = React.useRef(null);

  /** Enter one frame after mount so the opacity/transform transition runs. */
  React.useEffect(() => {
    if (request) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
    return undefined;
  }, [request]);

  /** Background-supplied start time (`number | undefined`); mount time is the fallback. */
  const requestStartedAtMs = request?.startedAtMs;
  /**
   * Reset drag state per request and refresh elapsed seconds from the
   * background-supplied start time.
   *
   * @returns {void}
   */
  React.useEffect(() => {
    setDragPos(null);
    setDragging(false);
    dragStartRef.current = null;
    if (!request) { setElapsedSeconds(0); return undefined; }
    const startedAt = requestStartedAtMs ?? Date.now();
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, TIMER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [request?.id, requestStartedAtMs]);

  /**
   * Capture press geometry; dragging arms only after the pointer leaves the
   * dead zone, and presses on interactive children are ignored.
   *
   * @param {PointerEvent} event
   * @returns {void}
   */
  const onPillPointerDown = React.useCallback((event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select')) return;
    const pill = pillRef.current;
    if (!pill) return;
    const rect = pill.getBoundingClientRect();
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      panelW: pill.offsetWidth || rect.width,
      panelH: pill.offsetHeight || rect.height,
      armed: false,
    };
  }, []);

  React.useEffect(() => {
    /**
     * Arm the drag once the pointer leaves the dead zone, then clamp the pill
     * to the viewport.
     *
     * @param {PointerEvent} event
     * @returns {void}
     */
    const onMove = (event) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.pointerX;
      const dy = event.clientY - start.pointerY;
      if (!start.armed) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        start.armed = true;
        setDragging(true);
        setDragPos({ top: start.originTop, left: start.originLeft });
      }
      setDragPos(clampDragPos(start.originTop + dy, start.originLeft + dx, start.panelW, start.panelH));
    };
    /** End the drag; a press that never armed leaves the position unchanged. @returns {void} */
    const onUp = () => {
      const start = dragStartRef.current;
      if (!start) return;
      if (start.armed) setDragging(false);
      dragStartRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  if (!request) return null;
  /** True during the fixed intro window, when the pill shows the recording message (`boolean`). */
  const introVisible = elapsedSeconds * 1000 < INTRO_DURATION_MS;
  /** True once a drag produced an explicit position (`boolean`). */
  const positioned = dragPos !== null;
  /** Resting transform; the enter transition lifts the pill into place (`string`). */
  const defaultTransform = show ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(8px)';

  return h(React.Fragment, null,
    h('style', null, `
      @keyframes bb-rec-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.82); }
      }
    `),
    h('div', {
      ref: pillRef,
      'data-slot': 'record-overlay-pill',
      'data-phase': introVisible ? 'intro' : 'timer',
      'data-dragging': dragging ? 'true' : 'false',
      onPointerDown: onPillPointerDown,
      style: {
        position: 'fixed',
        ...(positioned ? { top: dragPos.top, left: dragPos.left, bottom: 'auto' } : { bottom: 32, left: '50%' }),
        zIndex: 2147483647,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        backgroundColor: '#fff',
        borderRadius: 9999,
        height: 50,
        boxSizing: 'border-box',
        padding: '6px 8px 6px 16px',
        boxShadow: dragging ? '0 12px 40px rgba(15,23,42,0.22), 0 2px 8px rgba(0,0,0,0.12)' : '0 8px 32px rgba(15,23,42,0.16), 0 2px 8px rgba(0,0,0,0.1)',
        opacity: show ? 1 : 0,
        transform: positioned ? 'none' : defaultTransform,
        transition: dragging ? 'box-shadow 150ms ease-out' : 'opacity 300ms ease-out, transform 300ms ease-out, box-shadow 150ms ease-out',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        maxWidth: 'min(420px, calc(100vw - 32px))',
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        touchAction: 'none',
      },
    },
    h('div', { 'data-slot': 'record-overlay-status', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, borderRadius: 9999, outline: 'none', minHeight: 32, paddingRight: 4 } },
      h('span', { 'data-slot': 'record-overlay-indicator', style: { width: 9, height: 9, borderRadius: '50%', backgroundColor: '#ef4444', flexShrink: 0, animation: 'bb-rec-pulse 1.4s ease-in-out infinite' } }),
      h('span', { 'data-slot': 'record-overlay-label', style: { display: 'block', flex: '0 1 auto', fontSize: 16, fontWeight: 500, color: '#333', whiteSpace: 'nowrap', userSelect: 'none', overflow: 'hidden', textOverflow: 'ellipsis', width: introVisible ? 'auto' : 48, maxWidth: introVisible ? 280 : 48, fontVariantNumeric: introVisible ? undefined : 'tabular-nums', textAlign: introVisible ? 'left' : 'center', margin: 0, padding: 0, minWidth: 0, transition: 'max-width 180ms ease-out' } },
        introVisible ? t('recordOverlay.recording') : formatElapsed(elapsedSeconds))),
    h('button', { type: 'button', 'data-slot': 'record-overlay-finish', 'aria-label': t('recordOverlay.finish'), onClick: request.onFinish, style: { pointerEvents: 'auto', display: 'block', width: 32, height: 32, border: 'none', borderRadius: 9999, padding: 0, backgroundColor: 'transparent', cursor: 'pointer', flexShrink: 0 } },
      h('img', { src: recordIconUrl, alt: '', width: 24, height: 24, draggable: false, style: { display: 'block', margin: 'auto' } }))));
}
