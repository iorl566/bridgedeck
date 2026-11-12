import { ScreenshotError } from './types.js';

/**
 * Page-side work bound to one prepared document.
 * @typedef {object} PageCaptureTask
 * @property {string} id Capture identity.
 * @property {() => void} finish Restore the page and stop the watchdog.
 * @property {(y: number, capture: boolean, final?: boolean) => Promise<import('./types.js').PageMetrics>} move Scroll, settle and optionally validate one exposure.
 * @property {() => import('./types.js').PageMetrics} measure Current geometry, limited by capture scope.
 * @property {() => import('./types.js').PageMetrics} inspect Bottom readiness of the current viewport.
 * @property {() => void} touch Extend the inactivity watchdog.
 * @property {AbortSignal} signal Aborted when the task is cancelled.
 * @property {(value: boolean) => void} pause Toggle pause state.
 * @property {number} bottomOverlayHeight Height painted by fixed bottom overlays.
 */

/**
 * Page-side handler invoked through the content-script message bridge.
 * @typedef {object} PageCaptureHandle
 * @property {(request: import('./types.js').PageRequest) => Promise<import('./types.js').PageMetrics>} handle Run one command.
 * @property {() => void} dispose Restore the page and drop the task.
 */

function ariaToken(element, name) {
  return (element.getAttribute(name) ?? '').trim().toLowerCase();
}

/**
 * Page-side capture task: normalize layout, scroll, measure, clean up.
 *
 * The task owns every page mutation it makes, in reverse order, so finishing
 * restores scroll position, styles, and fixed elements even after a failure.
 * Only the visual viewport is captured; a hidden document cannot repaint, so it
 * is rejected up front.
 *
 * @param {(id: string, reason: import('./types.js').CaptureCancelReason) => void} onCancel Reports a user or page cancellation.
 * @returns {PageCaptureHandle}
 */
export function createPageCapture(onCancel) {
  let task;

  /** Prepare one document for capture and install the cancel affordance.
   *
   * The scope limit is measured before any style changes, so a current-viewport
   * capture cannot expand after the layout is normalized.
   *
   * @param {string} id Capture identity.
   * @param {string} label Progress label.
   * @param {string} cancelLabel Cancel button label.
   * @param {import('./types.js').CaptureScope} [scope] Capture extent.
   * @returns {PageCaptureTask} Bound page task.
   */
  function prepare(id, label, cancelLabel, scope = 'follow') {
    if (document.hidden) throw new ScreenshotError('interrupted', 'page_hidden');
    const limit = scope === 'current' ? measure().height : Infinity;
    const controller = new AbortController();
    const original = { x: window.scrollX, y: window.scrollY };
    const changes = [];
    const originallyUnstyled = new Set();
    const seen = new WeakSet();
    const fixed = [];
    const root = document.documentElement;
    if (root.clientWidth === window.innerWidth && root.clientHeight === window.innerHeight) setStyle(root, 'scrollbar-width', 'none');
    const style = document.createElement('style');
    style.textContent = `
      html, body, * { scroll-behavior: auto !important; scroll-snap-type: none !important;
        overflow-anchor: none !important; }
      *, *::before, *::after { animation-play-state: paused !important;
        transition: none !important; caret-color: transparent !important; }
      [data-bb-overlay] { visibility: hidden !important; }
    `;
    document.documentElement.append(style);
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;bottom:20px!important;left:20px!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const panel = document.createElement('div');
    panel.style.cssText = 'display:flex;align-items:center;gap:16px;padding:12px 16px;background:#18181b;color:#fff;border:1px solid #52525b;border-radius:12px;box-shadow:0 6px 24px #0003;font:13px/1.5 system-ui,sans-serif;';
    const text = document.createElement('span');
    text.textContent = label;
    text.setAttribute('role', 'status');
    const button = document.createElement('button');
    button.textContent = `${cancelLabel} · Esc`;
    button.style.cssText = 'border:1px solid #71717a;border-radius:7px;padding:5px 10px;background:transparent;color:#fff;font:inherit;cursor:pointer;';
    panel.append(text, button);
    shadow.append(panel);
    document.documentElement.append(host);
    let watchdog;
    let finished = false;
    let paused = false;
    let bottomOverlayHeight = 0;
    let bottomSince = performance.now();
    let lastMutation = bottomSince;
    let lastHeight = 0;
    let wasBusy = false;
    const loading = new Set();
    const footers = new Set();
    const loadingText = /^(?:loading|加载中|正在加载|载入中|loading\s+(?:more|content|items|results))[\s.。…，,]*$/i;
    const trackLoading = (element) => {
      const role = ariaToken(element, 'role');
      if (ariaToken(element, 'aria-busy') === 'true' || role === 'progressbar' || role === 'status' || (element.childElementCount === 0 && !element.closest('pre, code') && loadingText.test(element.textContent?.trim() ?? ''))) loading.add(element);
    };
    const pendingRoots = new Set([document.documentElement]);
    const observer = new MutationObserver((records) => {
      const targets = new Set();
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) pendingRoots.add(node);
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        if (element) targets.add(element);
      }
      for (const element of targets) {
        if (element === host || element.matches('script, style') || !element.isConnected) continue;
        trackLoading(element);
        const rect = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        if (rect.bottom > 0 && rect.top < window.innerHeight && computed.position !== 'fixed' && computed.visibility !== 'hidden') lastMutation = performance.now();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'hidden', 'class', 'src'] });

    /** Apply an important style and remember how to undo exactly this change.
     * @param {HTMLElement | SVGElement} element Target element.
     * @param {string} property CSS property name.
     * @param {string} value Replacement value.
     */
    function setStyle(element, property, value) {
      if (!element.hasAttribute('style')) originallyUnstyled.add(element);
      const old = element.style.getPropertyValue(property);
      const priority = element.style.getPropertyPriority(property);
      element.style.setProperty(property, value, 'important');
      changes.push(() => {
        if (element.style.getPropertyValue(property) !== value) return;
        if (old) element.style.setProperty(property, old, priority);
        else element.style.removeProperty(property);
      });
    }

    /** Walk every subtree added since the last pass and normalize its elements. */
    function normalize() {
      const roots = [...pendingRoots];
      pendingRoots.clear();
      for (const root of roots) {
        if (!root.isConnected) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let element = root;
        do {
          normalizeElement(element);
          element = walker.nextNode();
        } while (element);
      }
    }
    /** Remove one element's scroll-affecting position without changing its place
     * in flow: sticky becomes relative, fixed becomes temporarily hidden.
     * @param {Element} element Element to normalize.
     */
    function normalizeElement(element) {
      if (element === host || seen.has(element) || !(element instanceof HTMLElement || element instanceof SVGElement)) return;
      seen.add(element);
      trackLoading(element);
      if (ariaToken(element, 'role') === 'contentinfo' || (element.tagName === 'FOOTER' && !element.closest('article, aside, section'))) footers.add(element);
      const computed = getComputedStyle(element);
      if (computed.position === 'sticky') {
        setStyle(element, 'position', 'relative');
        for (const edge of ['top', 'right', 'bottom', 'left']) setStyle(element, edge, 'auto');
      } else if (computed.position === 'fixed' && !element.hasAttribute('data-bb-overlay')) {
        if (!element.hasAttribute('style')) originallyUnstyled.add(element);
        const visibility = element.style.getPropertyValue('visibility');
        const priority = element.style.getPropertyPriority('visibility');
        fixed.push({ element, atTop: element.getBoundingClientRect().top < window.innerHeight / 2, visibility, priority });
        changes.push(() => {
          if (element.style.getPropertyValue('visibility') !== 'hidden') return;
          if (visibility) element.style.setProperty('visibility', visibility, priority);
          else element.style.removeProperty('visibility');
        });
      }
    }

    /** Restore every page mutation and stop the watchdog.
     *
     * Safe to call more than once; the first call wins and later callers only
     * observe the restored page.
     */
    function finish() {
      if (finished) return;
      finished = true;
      observer.disconnect();
      pendingRoots.clear();
      loading.clear();
      footers.clear();
      controller.abort();
      clearTimeout(watchdog);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('wheel', interaction, true);
      window.removeEventListener('touchstart', interaction, true);
      window.removeEventListener('pagehide', navigated);
      document.removeEventListener('visibilitychange', visibilityChanged);
      host.remove();
      for (const restore of changes.reverse()) restore();
      for (const element of originallyUnstyled) if (element.getAttribute('style') === '') element.removeAttribute('style');
      window.scrollTo({ left: original.x, top: original.y, behavior: 'instant' });
      style.remove();
    }

    /** Abort the task, restore the page, and report why the capture ended.
     * @param {import('./types.js').CaptureCancelReason} [reason] Cancellation cause.
     */
    function cancel(reason = 'user_cancelled') {
      controller.abort(new ScreenshotError('interrupted', reason));
      finish();
      onCancel(id, reason);
    }
    function interaction() { if (!paused) cancel(); }
    /** Cancel on navigation keys unless the user paused on purpose.
     *
     * Escape is consumed so the page cannot also react to it, while the other
     * scroll keys are left untouched after the cancellation is recorded.
     *
     * @param {KeyboardEvent} event Key event during capture.
     */
    function keydown(event) {
      if (paused && event.key !== 'Escape') return;
      if (['Escape', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '].includes(event.key)) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
        cancel();
      }
    }
    /** Abort when the page becomes hidden; pixels cannot be trusted after that. */
    function visibilityChanged() { if (document.hidden) cancel('page_hidden'); }
    const navigated = () => cancel('navigation');
    button.addEventListener('click', () => cancel());
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('wheel', interaction, { capture: true, passive: true });
    window.addEventListener('touchstart', interaction, { capture: true, passive: true });
    window.addEventListener('pagehide', navigated);
    document.addEventListener('visibilitychange', visibilityChanged);

    /** Clear and re-arm the inactivity watchdog after each command. */
    function touch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => cancel('watchdog_timeout'), 15_000);
    }
    touch();

    /** Sleep for a bounded settle window, aborting immediately on cancellation.
     * @param {number} ms Delay in milliseconds.
     * @returns {Promise<void>} Resolves after the delay.
     */
    const wait = (ms) => new Promise((resolve, reject) => {
      controller.signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(controller.signal.reason ?? new ScreenshotError('interrupted')); };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, ms);
      controller.signal.addEventListener('abort', abort, { once: true });
    });

    /** Measure the document, clamped to the capture scope.
     * @returns {import('./types.js').PageMetrics} Scoped geometry.
     */
    function measureRange() {
      const metrics = measure();
      return { ...metrics, height: Math.min(metrics.height, limit) };
    }

    /** Measure the current viewport and judge whether its bottom is settled.
     *
     * The tail start is pushed up to the highest relevant footer or loading row
     * so growth repaints them. `bottomReady` requires a quiet window: a spinner
     * keeps it false, while a clock that mutates forever is bounded by a longer
     * deadline that does not depend on activity.
     *
     * @returns {import('./types.js').PageMetrics} Geometry with readiness flags.
     */
    function inspect() {
      const metrics = measureRange();
      const atBottom = metrics.y + metrics.viewportHeight >= metrics.height - 0.5;
      const now = performance.now();
      if (!atBottom || metrics.height !== lastHeight) bottomSince = now;
      lastHeight = metrics.height;
      let tailStart = Math.max(0, metrics.height - metrics.viewportHeight);
      for (const element of footers) {
        if (!element.isConnected) { footers.delete(element); continue; }
        const rect = element.getBoundingClientRect();
        if (rect.height && getComputedStyle(element).position !== 'fixed') tailStart = Math.min(tailStart, Math.max(0, metrics.y + rect.top));
      }
      let busy = false;
      const loadingStart = tailStart - metrics.viewportHeight;
      for (const element of loading) {
        if (!element.isConnected) { loading.delete(element); continue; }
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || metrics.y + rect.bottom <= loadingStart) continue;
        const computed = getComputedStyle(element);
        if (computed.visibility === 'hidden' || computed.display === 'none') continue;
        if (ariaToken(element, 'aria-busy') === 'true' || (ariaToken(element, 'role') === 'progressbar' && !element.hasAttribute('aria-valuenow')) || (!element.closest('pre, code') && loadingText.test(element.textContent?.trim() ?? ''))) {
          busy = true;
          if (rect.height <= metrics.viewportHeight) tailStart = Math.min(tailStart, Math.max(0, metrics.y + rect.top));
        }
      }
      if (busy !== wasBusy) lastMutation = now;
      wasBusy = busy;
      return {
        ...metrics,
        tailStart,
        loading: busy,
        bottomReady: atBottom && (scope === 'current' || !busy) && now - bottomSince >= 1500 && (now - lastMutation >= 600 || now - bottomSince >= 5000),
      };
    }

    /** Scroll to a target and settle before one exposure.
     *
     * Scrolling is followed by a bounded wait for visible images, then by a
     * stability loop on document height and offset. Fixed elements are shown or
     * hidden according to their position and to whether this is the final
     * bottom exposure, and the resulting overlay height is recorded for tiling.
     *
     * @param {number} y Target scroll offset.
     * @param {boolean} capture Whether this move produces an exposure.
     * @param {boolean} [final] Last stable bottom exposure.
     * @returns {Promise<import('./types.js').PageMetrics>} Settled geometry.
     */
    async function move(y, capture, final = false) {
      controller.signal.throwIfAborted();
      touch();
      host.style.setProperty('visibility', 'visible', 'important');
      normalize();
      window.scrollTo({ left: 0, top: y, behavior: 'instant' });
      await wait(capture ? 160 : 300);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const pending = Array.from(document.images).some((img) => {
          const rect = img.getBoundingClientRect();
          return !img.complete && rect.bottom >= 0 && rect.top <= window.innerHeight;
        });
        if (!pending) break;
        await wait(100);
      }
      let before = measure();
      let stable = 0;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await wait(80);
        const after = measure();
        stable = before.height === after.height && before.y === after.y ? stable + 1 : 0;
        before = after;
        if (stable >= 2) break;
      }
      controller.signal.throwIfAborted();
      let paintedReady = false;
      if (capture) {
        normalize();
        const metrics = inspect();
        paintedReady = metrics.bottomReady === true;
        bottomOverlayHeight = 0;
        for (const item of fixed) {
          const show = item.atTop ? metrics.y < 0.5 : final && metrics.bottomReady;
          if (!show) item.element.style.setProperty('visibility', 'hidden', 'important');
          else if (item.visibility) item.element.style.setProperty('visibility', item.visibility, item.priority);
          else item.element.style.removeProperty('visibility');
          if (show && !item.atTop && getComputedStyle(item.element).visibility !== 'hidden') bottomOverlayHeight = Math.max(bottomOverlayHeight, metrics.viewportHeight - item.element.getBoundingClientRect().top);
        }
        host.style.setProperty('visibility', 'hidden', 'important');
        await wait(80);
      }
      const metrics = inspect();
      return { ...metrics, bottomReady: metrics.bottomReady && (!capture || paintedReady) };
    }

    return {
      id,
      finish,
      move,
      measure: measureRange,
      inspect,
      touch,
      signal: controller.signal,
      pause(value) {
        paused = value;
        touch();
        host.style.setProperty('visibility', 'visible', 'important');
      },
      get bottomOverlayHeight() { return bottomOverlayHeight; },
    };
  }

  /** Measure the scrolling document and visual viewport.
   *
   * The unpinched visual viewport keeps fractional CSS precision that integer
   * client dimensions lose at non-unit zoom. A toolbar overlay height from the
   * active task is included so tiling can reserve room for it.
   *
   * @returns {import('./types.js').PageMetrics} Current geometry.
   */
  function measure() {
    const root = document.documentElement;
    const scrolling = document.scrollingElement ?? root;
    const visual = window.visualViewport;
    const viewportWidth = visual?.scale === 1 ? visual.width : root.clientWidth;
    const viewportHeight = visual?.scale === 1 ? visual.height : root.clientHeight;
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: scrolling.scrollWidth,
      height: Math.max(scrolling.scrollHeight, viewportHeight),
      viewportWidth,
      viewportHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      bottomOverlayHeight: task?.bottomOverlayHeight ?? 0,
    };
  }

  return {
    async handle(request) {
      if (request.action === 'probe') return measure();
      if (request.action === 'begin') {
        if (task && !task.signal.aborted) throw new ScreenshotError('busy');
        task = prepare(request.id, request.label, request.cancelLabel, request.scope);
        return task.measure();
      }
      if (!task || task.id !== request.id) throw new ScreenshotError('interrupted');
      if (request.action === 'finish') {
        task.finish();
        task = undefined;
        return measure();
      }
      task.signal.throwIfAborted();
      task.touch();
      if (request.action === 'pause') task.pause(request.paused);
      if (request.action === 'move') return task.move(request.y, request.capture, request.final);
      return task.inspect();
    },
    dispose() {
      task?.finish();
      task = undefined;
    },
  };
}

/**
 * @param {unknown} error
 * @returns {import('./types.js').CaptureError} Stable failure code.
 */
export function pageError(error) {
  return error instanceof ScreenshotError ? error.code : 'interrupted';
}
