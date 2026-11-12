import React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';
import { useTranslation } from '../vendor/i18n-lite.js';

const h = React.createElement;
const logoUrl = new URL('../assets/logo.png', import.meta.url).href;
const PANEL_GAP = 12;
const VIEWPORT_MARGIN = 16;
const PANEL_WIDTH = 420;
const FALLBACK_PANEL_H = 180;
const FALLBACK_PANEL_H_COLLAPSED = 44;
const EMPTY_SELECTORS = [];
const EMPTY_RECTS = [];

/**
 * @typedef {Object} HelpHighlightRect
 * @property {number} top
 * @property {number} left
 * @property {number} width
 * @property {number} height
 */

/**
 * Content-side view of one help request message.
 *
 * The overlay renders a full task card on the subject tab and a compact status
 * affordance on related tabs; compact mode ignores `selectors` and `rects`.
 *
 * @typedef {Object} HelpRequestData
 * @property {string} id
 * @property {string} prompt
 * @property {string} [title] Custom overlay title; falls back to i18n.
 * @property {'full' | 'compact'} [displayMode] Full task UI on the subject tab; compact status UI on related tabs.
 * @property {string[]} selectors CSS selectors to scroll to and flash-highlight.
 * @property {HelpHighlightRect[]} [rects] Pre-resolved top-viewport rectangles for cross-frame targets.
 * @property {() => Promise<HelpHighlightRect[] | undefined>} [refreshRects] Re-resolve rectangles after scroll, resize, or layout changes.
 * @property {(note: string) => void} onContinue
 * @property {() => void} onCancel
 */

/**
 * Viewport rectangle shared by highlight rendering and panel placement.
 *
 * @typedef {object} HelpBox
 * @property {number} top
 * @property {number} left
 * @property {number} width
 * @property {number} height
 */

/**
 * Side of the anchor the panel prefers to occupy.
 *
 * @typedef {'above' | 'below'} HelpPanelPlacement
 */

/**
 * Anchored panel position in viewport coordinates.
 *
 * @typedef {object} HelpPanelPos
 * @property {number} [top] Top offset when the panel sits below the anchor.
 * @property {number} [bottom] Bottom offset when the panel sits above the anchor.
 * @property {number} left Left offset, centered on the anchor where space allows.
 * @property {HelpPanelPlacement} placement Side chosen for the current request.
 */

/**
 * Geometry captured when a banner drag starts.
 *
 * @typedef {object} HelpDragStart
 * @property {number} pointerX Pointer X at drag start, in client coordinates.
 * @property {number} pointerY Pointer Y at drag start, in client coordinates.
 * @property {number} originLeft Banner left offset at drag start.
 * @property {number} originTop Banner top offset at drag start.
 * @property {number} panelW Measured banner width used for clamping.
 * @property {number} panelH Measured banner height used for clamping.
 */

/**
 * Banner position produced by a human drag, in viewport coordinates.
 *
 * @typedef {object} HelpDragPosition
 * @property {number} top
 * @property {number} left
 */

/**
 * Change event of the note input.
 *
 * @typedef {object} HelpNoteChangeEvent
 * @property {{ value: string }} target Input element carrying the new text.
 */

/**
 * Placement remembered for one request so the panel does not flip sides while open.
 *
 * @typedef {object} HelpPlacementMemo
 * @property {string} requestId Request the placement was chosen for.
 * @property {HelpPanelPlacement} placement Chosen side.
 */

/**
 * Props for the help request overlay.
 *
 * @typedef {object} HelpRequestOverlayProps
 * @property {HelpRequestData | null} request Content-side view of a help request
 * message; null hides the overlay.
 */

/**
 * Clamp `value` into the inclusive `[min, max]` range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/**
 * Keep a dragged panel inside the viewport margin.
 *
 * @param {number} top Desired top offset.
 * @param {number} left Desired left offset.
 * @param {number} panelW Measured panel width.
 * @param {number} panelH Measured panel height.
 * @returns {{ top: number, left: number }}
 */
function clampDragPos(top, left, panelW, panelH) {
  const maxLeft = window.innerWidth - panelW - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - panelH - VIEWPORT_MARGIN;
  return { top: clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop)), left: clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft)) };
}
/**
 * Shallow-compare two box lists so an unchanged layout keeps its previous array.
 *
 * @param {HelpBox[]} a
 * @param {HelpBox[]} b
 * @returns {boolean}
 */
function boxesEqual(a, b) {
  return a.length === b.length && a.every((box, i) => box.top === b[i]?.top && box.left === b[i]?.left && box.width === b[i]?.width && box.height === b[i]?.height);
}
/**
 * Shallow-compare two panel positions; both sides may be null.
 *
 * @param {HelpPanelPos | null} a
 * @param {HelpPanelPos | null} b
 * @returns {boolean}
 */
function panelPosEqual(a, b) {
  return a?.top === b?.top && a?.bottom === b?.bottom && a?.left === b?.left && a?.placement === b?.placement;
}
/**
 * Union of multiple viewport boxes into one anchor rect.
 *
 * @param {HelpBox[]} boxes
 * @returns {HelpBox | null} Null when no box is available.
 */
function unionBox(boxes) {
  if (boxes.length === 0) return null;
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
  for (const box of boxes) {
    top = Math.min(top, box.top);
    left = Math.min(left, box.left);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  return { top, left, width: right - left, height: bottom - top };
}
/**
 * Choose the side with enough room for the panel, falling back to the roomier one.
 *
 * @param {HelpBox} anchor
 * @param {number} panelH Measured panel height.
 * @returns {HelpPanelPlacement}
 */
function choosePlacement(anchor, panelH) {
  const viewportH = window.innerHeight;
  const anchorBottom = anchor.top + anchor.height;
  const spaceBelow = viewportH - anchorBottom;
  const spaceAbove = anchor.top;
  const minSpace = panelH + PANEL_GAP + VIEWPORT_MARGIN;
  if (spaceBelow >= minSpace) return 'below';
  if (spaceAbove >= minSpace) return 'above';
  return spaceBelow >= spaceAbove ? 'below' : 'above';
}
/**
 * Place the panel near the anchor on a stable side, clamped to the viewport.
 *
 * @param {HelpBox} anchor
 * @param {number} panelW Measured panel width.
 * @param {number} panelH Measured panel height.
 * @param {HelpPanelPlacement} placement
 * @returns {HelpPanelPos}
 */
function placePanel(anchor, panelW, panelH, placement) {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const anchorCenterX = anchor.left + anchor.width / 2;
  const minCenterX = VIEWPORT_MARGIN + panelW / 2;
  const maxCenterX = viewportW - VIEWPORT_MARGIN - panelW / 2;
  const left = minCenterX <= maxCenterX ? clamp(anchorCenterX, minCenterX, maxCenterX) : viewportW / 2;
  if (placement === 'below') {
    const top = clamp(anchor.top + anchor.height + PANEL_GAP, VIEWPORT_MARGIN, viewportH - panelH - VIEWPORT_MARGIN);
    return { top, left, placement };
  }
  let bottom = viewportH - anchor.top + PANEL_GAP;
  const maxBottom = Math.max(VIEWPORT_MARGIN, viewportH - panelH - VIEWPORT_MARGIN);
  bottom = clamp(bottom, VIEWPORT_MARGIN, maxBottom);
  return { bottom, left, placement };
}
/**
 * Returns null for invalid selectors instead of throwing.
 *
 * @param {string} selector
 * @returns {Element | null}
 */
function querySelectorSafe(selector) {
  try { return document.querySelector(selector); } catch { return null; }
}
/**
 * Resolve selectors to their first matching element's viewport rect.
 *
 * @param {string[]} selectors
 * @returns {HelpBox[]}
 */
function measure(selectors) {
  const boxes = [];
  for (const selector of selectors) {
    const element = querySelectorSafe(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    boxes.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  }
  return boxes;
}

const CSS = `
  @keyframes bb-help-flash {
    0%, 100% { box-shadow: 0 0 0 2px rgba(249,115,22,0.9), 0 0 12px 2px rgba(249,115,22,0.5); }
    50% { box-shadow: 0 0 0 3px rgba(249,115,22,1), 0 0 22px 6px rgba(249,115,22,0.8); }
  }
  .bb-help-banner {
    --bb-help-ease: cubic-bezier(0.32, 0.72, 0, 1);
    --bb-help-duration: 320ms;
    --bb-help-width: ${PANEL_WIDTH}px;
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    min-height: 0;
    gap: 10px;
    width: var(--bb-help-width);
    max-width: calc(100vw - ${VIEWPORT_MARGIN * 2}px);
    background: #fff;
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 12px 40px rgba(124,45,18,0.18), 0 2px 8px rgba(0,0,0,0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    transition: padding var(--bb-help-duration) var(--bb-help-ease), gap var(--bb-help-duration) var(--bb-help-ease), width var(--bb-help-duration) var(--bb-help-ease);
  }
  .bb-help-banner[data-collapsed="true"] { gap: 0; width: var(--bb-help-width); padding: 12px; }
  .bb-help-banner[data-display-mode="compact"] { width: min(360px, calc(100vw - ${VIEWPORT_MARGIN * 2}px)); padding: 12px 14px; gap: 0; border-radius: 12px; }
  .bb-help-drag-strip { position: absolute; top: 6px; left: 0; right: 0; display: flex; align-items: center; justify-content: center; height: 12px; cursor: grab; user-select: none; touch-action: none; }
  .bb-help-drag-pill { width: 32px; height: 4px; border-radius: 999px; background: #d1d5db; transition: background-color 160ms var(--bb-help-ease); }
  .bb-help-drag-strip:hover .bb-help-drag-pill { background: #9ca3af; }
  .bb-help-banner[data-dragging="true"] .bb-help-drag-strip { cursor: grabbing; }
  .bb-help-banner[data-dragging="true"] .bb-help-drag-pill { background: #6b7280; }
  .bb-help-banner[data-collapsed="true"] .bb-help-drag-strip { top: 4px; }
  .bb-help-header { flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
  .bb-help-banner[data-display-mode="compact"] .bb-help-header { gap: 8px; }
  .bb-help-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 15px; font-weight: 600; color: #111; }
  .bb-help-compact-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; color: #374151; }
  .bb-help-banner[data-collapsed="true"] .bb-help-title { white-space: nowrap; }
  .bb-help-banner[data-collapsed="true"] .bb-help-header { flex-wrap: wrap; }
  .bb-help-header-actions { flex-shrink: 0; display: none; align-items: center; gap: 10px; margin-left: auto; overflow: hidden; }
  .bb-help-banner[data-collapsed="true"] .bb-help-header-actions { display: flex; order: 1; flex-basis: 100%; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; opacity: 1; pointer-events: auto; }
  .bb-help-collapse-toggle { display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; border: none; background: transparent; padding: 4px; line-height: 1; color: #6b7280; margin-left: auto; transition: margin-left var(--bb-help-duration) var(--bb-help-ease); }
  .bb-help-banner[data-collapsed="true"] .bb-help-collapse-toggle { margin-left: 0; }
  .bb-help-collapse-icon { display: flex; transition: transform var(--bb-help-duration) var(--bb-help-ease); }
  .bb-help-banner[data-collapsed="true"] .bb-help-collapse-icon { transform: rotate(180deg); }
  .bb-help-body { display: block; flex-shrink: 0; min-width: 0; }
  .bb-help-banner[data-collapsed="true"] .bb-help-body { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }
  .bb-help-body-inner { overflow: hidden; min-height: 0; min-width: 0; }
  .bb-help-body-content { display: flex; flex-direction: column; gap: 10px; opacity: 1; transform: translateY(0); transition: opacity 220ms var(--bb-help-ease), transform var(--bb-help-duration) var(--bb-help-ease); }
  .bb-help-banner[data-collapsed="true"] .bb-help-body-content { opacity: 0; transform: translateY(6px); }
  .bb-help-prompt { margin: 0; font-size: 14px; line-height: 1.5; color: #444; }
  .bb-help-note-input { width: 100%; box-sizing: border-box; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
  .bb-help-footer-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
  .bb-help-btn-cancel { cursor: pointer; border: 1px solid #e5e7eb; background: transparent; border-radius: 8px; font-size: 13px; font-weight: 500; color: #4b5563; min-width: 0; white-space: normal; }
  .bb-help-btn-continue { cursor: pointer; border: none; background: #f97316; border-radius: 8px; font-size: 13px; font-weight: 600; color: #fff; min-width: 0; white-space: normal; }
  .bb-help-header-actions .bb-help-btn-cancel, .bb-help-header-actions .bb-help-btn-continue { padding: 6px 12px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .bb-help-header-actions .bb-help-btn-continue { padding: 6px 14px; }
  .bb-help-banner[data-display-mode="compact"] .bb-help-header-actions { display: flex; max-width: none; }
  .bb-help-banner[data-display-mode="compact"] .bb-help-header-actions .bb-help-btn-cancel, .bb-help-banner[data-display-mode="compact"] .bb-help-header-actions .bb-help-btn-continue { padding: 6px 10px; font-size: 12px; }
  .bb-help-footer-actions .bb-help-btn-cancel { padding: 8px 16px; }
  .bb-help-footer-actions .bb-help-btn-continue { padding: 8px 18px; }
  @media (prefers-reduced-motion: reduce) {
    .bb-help-banner, .bb-help-header-actions, .bb-help-collapse-toggle, .bb-help-collapse-icon, .bb-help-body, .bb-help-body-content, .bb-help-drag-strip, .bb-help-drag-pill { transition-duration: 0.01ms !important; }
  }
`;

/**
 * @param {HelpRequestOverlayProps} props
 * @returns {object | null} Banner plus highlight overlays, or null without a request.
 */
export function HelpRequestOverlay({ request }) {
  const { t } = useTranslation('extension');
  const isCompact = request?.displayMode === 'compact';
  const effectiveSelectors = isCompact ? EMPTY_SELECTORS : (request?.selectors ?? EMPTY_SELECTORS);
  /** Latest rectangles resolved by `request.refreshRects` (`HelpHighlightRect[] | null`). */
  const [liveRects, setLiveRects] = React.useState(null);
  const effectiveRects = isCompact ? EMPTY_RECTS : (liveRects ?? request?.rects ?? EMPTY_RECTS);
  /** Note text typed by the human (`string`); reset whenever the request id changes. */
  const [note, setNote] = React.useState('');
  /** Whether the full card body is collapsed to its header (`boolean`). */
  const [collapsed, setCollapsed] = React.useState(false);
  /** Highlighted viewport boxes for this request (`HelpBox[]`). */
  const [boxes, setBoxes] = React.useState([]);
  /** Anchored panel position (`HelpPanelPos | null`); null while compact or unanchored. */
  const [panelPos, setPanelPos] = React.useState(null);
  /** @type {HelpDragPosition | null} Panel position after a human drag. */
  const [dragPos, setDragPos] = React.useState(null);
  /** True while a banner drag is in progress (`boolean`). */
  const [dragging, setDragging] = React.useState(false);
  /** Banner element used for measurement and pointer capture. */
  const bannerRef = React.useRef(null);
  /** Request id whose first selector was already scrolled into view. */
  const lastScrolledIdRef = React.useRef(null);
  /** Placement memo for the open request (`HelpPlacementMemo | null`). */
  const placementRef = React.useRef(null);
  /** True once the human drags the banner (`boolean`); disables automatic anchoring. */
  const userMovedRef = React.useRef(false);
  /** Pointer and geometry captured at drag start (`HelpDragStart | null`). */
  const dragStartRef = React.useRef(null);

  // Reset the note and collapse state whenever a new request appears.
  React.useEffect(() => {
    setNote('');
    setLiveRects(null);
    setCollapsed(false);
    placementRef.current = null;
    setDragPos(null);
    setDragging(false);
    userMovedRef.current = false;
    dragStartRef.current = null;
  }, [request?.id]);

  React.useEffect(() => {
    if (!request || isCompact || !request.refreshRects) return undefined;
    /** True after cleanup, so late refresh responses are ignored. */
    let disposed = false;
    /** True while a refresh is in flight, so ticks coalesce. */
    let resolving = false;
    /**
     * Resolve fresh rectangles through the request callback, skipping overlap.
     *
     * @returns {Promise<void>}
     */
    const refresh = async () => {
      if (resolving) return;
      resolving = true;
      try {
        const rects = await request.refreshRects?.();
        if (!disposed && rects) setLiveRects(rects);
      } finally {
        resolving = false;
      }
    };
    /** Refresh on scroll, resize and a slow interval. @returns {void} */
    const onChange = () => void refresh();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    const interval = window.setInterval(onChange, 500);
    return () => {
      disposed = true;
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
      window.clearInterval(interval);
    };
  }, [request, isCompact]);

  /**
   * Scroll the first matched target into view once per distinct request id.
   *
   * @returns {void}
   */
  React.useLayoutEffect(() => {
    if (!request || isCompact || lastScrolledIdRef.current === request.id) return;
    for (const selector of effectiveSelectors) {
      const element = querySelectorSafe(selector);
      if (element) {
        lastScrolledIdRef.current = request.id;
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
      }
    }
  }, [request, isCompact, effectiveSelectors]);

  /**
   * Keep highlight boxes aligned with the page as it scrolls or resizes; the
   * timer covers layout shifts that emit no scroll or resize event.
   *
   * @returns {void}
   */
  React.useEffect(() => {
    if (!request) {
      setBoxes((previous) => (previous.length === 0 ? previous : []));
      return undefined;
    }
    /**
     * Re-measure selectors and merge pre-resolved rectangles, reusing the
     * previous array when nothing changed.
     *
     * @returns {void}
     */
    const update = () => {
      const next = [...measure(effectiveSelectors), ...effectiveRects];
      setBoxes((previous) => (boxesEqual(previous, next) ? previous : next));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const interval = window.setInterval(update, 500);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.clearInterval(interval);
    };
  }, [request, effectiveSelectors, effectiveRects]);

  /**
   * Start a banner drag on primary-button presses outside interactive children.
   *
   * @param {PointerEvent} event
   * @returns {void}
   */
  const onHeaderPointerDown = React.useCallback((event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, input, textarea, a, select')) return;
    const banner = bannerRef.current;
    if (!banner) return;
    const rect = banner.getBoundingClientRect();
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      panelW: banner.offsetWidth || PANEL_WIDTH,
      panelH: banner.offsetHeight || (collapsed ? FALLBACK_PANEL_H_COLLAPSED : FALLBACK_PANEL_H),
    };
    userMovedRef.current = true;
    setDragPos({ top: rect.top, left: rect.left });
    setDragging(true);
    event.preventDefault();
  }, [collapsed]);

  React.useEffect(() => {
    if (!dragging) return undefined;
    /**
     * Move the dragged banner, clamped to the viewport.
     *
     * @param {PointerEvent} event
     * @returns {void}
     */
    const onMove = (event) => {
      const start = dragStartRef.current;
      if (!start) return;
      setDragPos(clampDragPos(start.originTop + (event.clientY - start.pointerY), start.originLeft + (event.clientX - start.pointerX), start.panelW, start.panelH));
    };
    /** Finish the drag and release the captured geometry. @returns {void} */
    const onUp = () => { setDragging(false); dragStartRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  /**
   * Anchor the panel near matched targets; re-run when highlights or collapse
   * change. A human drag wins over automatic placement.
   *
   * @returns {void}
   */
  React.useLayoutEffect(() => {
    if (!request || isCompact) { setPanelPos(null); return; }
    if (userMovedRef.current) return;
    const anchor = unionBox(boxes.length > 0 ? boxes : [...measure(effectiveSelectors), ...effectiveRects]);
    const banner = bannerRef.current;
    if (!anchor || !banner) { setPanelPos(null); return; }
    const rect = banner.getBoundingClientRect();
    let panelW = banner.offsetWidth || rect.width;
    let panelH = banner.offsetHeight || rect.height;
    if (panelW === 0) panelW = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    if (panelH === 0) panelH = collapsed ? FALLBACK_PANEL_H_COLLAPSED : FALLBACK_PANEL_H;
    if (placementRef.current?.requestId !== request.id) {
      placementRef.current = { requestId: request.id, placement: choosePlacement(anchor, panelH) };
    }
    const next = placePanel(anchor, panelW, panelH, placementRef.current.placement);
    setPanelPos((previous) => (panelPosEqual(previous, next) ? previous : next));
  }, [request, boxes, collapsed, isCompact, effectiveSelectors, effectiveRects]);

  if (!request) return null;

  /** Drag strip; compact cards stay anchored and render no handle. */
  const dragHandle = !isCompact
    ? h('div', { 'data-slot': 'help-drag-handle', className: 'bb-help-drag-strip', role: 'img', 'aria-label': t('helpRequest.dragHandle'), onPointerDown: onHeaderPointerDown },
      h('span', { className: 'bb-help-drag-pill', 'aria-hidden': true }))
    : null;

  /** Brand row, title, collapsed actions and collapse toggle. */
  const header = h('div', { className: 'bb-help-header' },
    h('img', { src: logoUrl, alt: 'BridgeDeck', style: { width: 22, height: 22, borderRadius: 4 } }),
    isCompact
      ? h('span', { className: 'bb-help-compact-title' }, t('helpRequest.compactStatus'))
      : h('span', { className: 'bb-help-title' }, request.title ?? t('helpRequest.title')),
    !isCompact
      ? h('div', { className: 'bb-help-header-actions', 'aria-hidden': !collapsed },
        h('button', { type: 'button', 'data-slot': collapsed ? 'help-cancel-button' : undefined, className: 'bb-help-btn-cancel', tabIndex: collapsed ? 0 : -1, onClick: () => request.onCancel() }, t('helpRequest.cancel')),
        h('button', { type: 'button', 'data-slot': collapsed ? 'help-continue-button' : undefined, className: 'bb-help-btn-continue', tabIndex: collapsed ? 0 : -1, onClick: () => request.onContinue(note) }, t('helpRequest.continue')))
      : null,
    !isCompact
      ? h('button', { type: 'button', 'data-slot': 'help-collapse-toggle', className: 'bb-help-collapse-toggle', 'aria-label': collapsed ? t('helpRequest.expand') : t('helpRequest.collapse'), 'aria-expanded': !collapsed, onClick: () => setCollapsed((value) => !value) },
        h('span', { className: 'bb-help-collapse-icon' }, h(RiArrowDownSLine, { size: 20, 'aria-hidden': true })))
      : null);

  /** Prompt, note input and footer actions; hidden from assistive tech while collapsed. */
  const body = !isCompact
    ? h('div', { className: 'bb-help-body', 'aria-hidden': collapsed },
      h('div', { className: 'bb-help-body-inner' },
        h('div', { className: 'bb-help-body-content' },
          h('p', { className: 'bb-help-prompt' }, request.prompt),
          h('input', { type: 'text', className: 'bb-help-note-input', 'aria-label': t('helpRequest.noteLabel'), placeholder: t('helpRequest.notePlaceholder'), value: note, tabIndex: collapsed ? -1 : 0, onChange: (event) => setNote(event.target.value) }),
          h('div', { className: 'bb-help-footer-actions' },
            h('button', { type: 'button', 'data-slot': collapsed ? undefined : 'help-cancel-button', className: 'bb-help-btn-cancel', tabIndex: collapsed ? -1 : 0, onClick: () => request.onCancel() }, t('helpRequest.cancel')),
            h('button', { type: 'button', 'data-slot': collapsed ? undefined : 'help-continue-button', className: 'bb-help-btn-continue', tabIndex: collapsed ? -1 : 0, onClick: () => request.onContinue(note) }, t('helpRequest.continue'))))))
    : null;

  /** Banner root; `data-*` attributes expose display mode, drag and anchor state to CSS. */
  const banner = h('div', {
    ref: bannerRef,
    'data-slot': 'help-request-banner',
    'data-collapsed': collapsed ? 'true' : 'false',
    'data-display-mode': isCompact ? 'compact' : 'full',
    'data-anchored': panelPos ? 'true' : 'false',
    'data-dragging': dragging ? 'true' : 'false',
    'data-placement': panelPos?.placement,
    className: 'bb-help-banner',
    style: dragPos
      ? { top: dragPos.top, left: dragPos.left, bottom: 'auto', transform: 'none' }
      : panelPos
        ? { top: panelPos.top ?? 'auto', left: panelPos.left, bottom: panelPos.bottom ?? 'auto', transform: 'translateX(-50%)' }
        : undefined,
  }, dragHandle, header, body);

  return h(React.Fragment, null,
    h('style', null, CSS),
    !isCompact ? boxes.map((box, index) => h('div', { key: index, 'data-slot': 'help-highlight', style: { position: 'fixed', top: box.top, left: box.left, width: box.width, height: box.height, borderRadius: 6, zIndex: 2147483646, pointerEvents: 'none', animation: 'bb-help-flash 1.2s ease-in-out infinite' } })) : null,
    banner);
}
