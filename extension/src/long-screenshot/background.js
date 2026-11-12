import { LONG_SCREENSHOT, LONG_SCREENSHOT_STATE, ScreenshotError, isCapturing } from './types.js';
import { capturePage } from './capture.js';
import { captureManual } from './manual.js';
import { createPageClient } from './page-client.js';
import { pruneScreenshots } from './retention.js';
import { openScreenshotSource } from './source.js';
import { readTiledScreenshot, removeTiledScreenshot, TileWriter } from './tiles.js';

/**
 * One in-flight capture.
 * @typedef {object} LongScreenshotJob
 * @property {string} id Capture identity.
 * @property {AbortController} controller Cancels the capture and its source.
 * @property {boolean} paused User-requested pause state.
 * @property {boolean} finished Set when the user accepts the current image.
 * @property {(command: import('./types.js').PageCommand) => Promise<unknown>} [page] Page task used to pause.
 */

/**
 * Arguments passed to the concrete capture pipeline.
 * @typedef {object} LongScreenshotCaptureJob
 * @property {string} id Capture identity.
 * @property {number} tabId Captured tab.
 * @property {number} windowId Window owning the tab.
 * @property {string} url Document URL at start.
 * @property {import('./types.js').CaptureMode} mode Requested mode.
 * @property {AbortSignal} signal Cancels the pipeline.
 * @property {() => boolean} paused Reports the pause state.
 * @property {() => boolean} finished Reports whether the user already accepted the image.
 * @property {(value: number, frames: number) => void} progress Publishes progress.
 */

/**
 * Injected command/state dependencies.
 * @typedef {object} LongScreenshotControllerDeps
 * @property {object} storage Session storage surface with `get` and `set`.
 * @property {object} tabs Browser tab query surface.
 * @property {object} runtime Extension runtime surface with `getURL`.
 * @property {(tabId: number) => boolean} isTabBusy True while another feature owns the tab.
 * @property {(job: LongScreenshotCaptureJob) => Promise<{ width: number, height: number }>} capture Capture pipeline.
 * @property {(id: string) => Promise<void>} [preview] Opens the result preview.
 */

/**
 * Command/state surface used by the background entry.
 * @typedef {object} LongScreenshotController
 * @property {() => Promise<void>} restore Recover a stored capture after a worker restart.
 * @property {(requested?: import('./types.js').CaptureMode) => Promise<void>} start Begin a capture.
 * @property {(id?: string) => void} cancel Abort the running capture.
 * @property {(id?: string) => void} finish Accept the current image and stop extending it.
 * @property {(id: string | undefined, paused: boolean) => void} pause Toggle pause for the running capture.
 * @property {(request: import('./types.js').CaptureRequest, sender: object) => Promise<import('./types.js').CaptureReply>} handle Route one popup request.
 * @property {import('./types.js').CaptureState | null} state Last published state.
 * @property {LongScreenshotJob | null} running Job in flight, if any.
 */

/**
 * Command/state core of the long-screenshot controller. Browser event wiring
 * and the concrete capture pipeline are injected by the background entry.
 *
 * The core owns one job at a time. A request is validated, the active tab is
 * bound to the job, and state is published before the pipeline starts so the
 * popup can render progress immediately. State writes are serialized: a later
 * publish never overtakes an earlier one on the storage surface.
 *
 * @param {LongScreenshotControllerDeps} deps Injected dependencies.
 * @returns {LongScreenshotController}
 */
export function createLongScreenshotController(deps) {
  const storage = deps.storage;
  const tabs = deps.tabs;
  let state = null;
  let running = null;
  let writes = Promise.resolve();

  /** Publish a state snapshot and queue its durable copy.
   * @param {import('./types.js').CaptureState | null} next Snapshot to publish.
   */
  const publish = (next) => {
    state = next;
    writes = writes.then(() => storage.set({ [LONG_SCREENSHOT_STATE]: next })).catch(() => {});
  };

  /** Recover a capture stored before the worker restarted.
   * A still-running job is republished as an interrupted error. */
  async function restore() {
    const stored = await storage.get(LONG_SCREENSHOT_STATE);
    const prior = stored[LONG_SCREENSHOT_STATE] ?? null;
    if (prior && isCapturing(prior)) publish({ ...prior, phase: 'error', error: 'interrupted' });
    else state = prior;
  }

  /** Start one capture in the active tab.
   *
   * Validation happens before any browser work: one job at a time, a supported
   * mode, a usable tab URL, and a tab no other feature owns. The pipeline then
   * runs detached from the reply, publishing progress until it completes,
   * fails, or is aborted.
   *
   * @param {import('./types.js').CaptureMode} [requested] Requested mode.
   * @returns {Promise<void>} Resolves once the job is registered and running.
   */
  async function start(requested = 'auto') {
    if (running) throw new ScreenshotError('busy');
    if (!['auto', 'manual', 'visible'].includes(requested)) throw new ScreenshotError('unsupported');
    const [tab] = await tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url) throw new ScreenshotError('unsupported');
    if (deps.isTabBusy(tab.id)) throw new ScreenshotError('busy');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id, controller, paused: false, finished: false };
    running = job;
    publish({ id, tabId: tab.id, pageUrl: tab.url, title: tab.title || '', mode: requested, phase: 'preparing', progress: 0, frames: 0 });
    void (async () => {
      try {
        const result = await deps.capture({
          id,
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          mode: requested,
          signal: controller.signal,
          paused: () => job.paused,
          finished: () => job.finished,
          progress: (value, frames) => {
            if (state?.id === id) publish({ ...state, phase: job.paused ? 'paused' : 'capturing', progress: value, frames });
          },
        });
        if (!result?.height) throw new ScreenshotError('captureFailed');
        if (state?.id === id) publish({ ...state, phase: 'complete', progress: 100, width: result.width, height: result.height });
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        const code = reason instanceof ScreenshotError ? reason.code : 'captureFailed';
        if (state?.id === id) publish({ ...state, phase: 'error', error: code });
      } finally {
        if (running?.id === id) running = null;
      }
    })();
  }

  /** Abort the running capture; an omitted id targets the only job.
   * @param {string} [id] Capture identity.
   */
  function cancel(id) {
    if (running && (!id || running.id === id)) running.controller.abort();
  }
  /** Accept the current image and stop extending it.
   * @param {string} [id] Capture identity.
   */
  function finish(id) {
    if (running && (!id || running.id === id)) {
      running.finished = true;
      running.paused = false;
    }
  }
  /** Toggle pause for the running capture; state is republished immediately.
   * @param {string} [id] Capture identity.
   * @param {boolean} paused Requested pause state.
   */
  function pause(id, paused) {
    if (!running || (id && running.id !== id)) return;
    running.paused = paused;
    if (state) publish({ ...state, phase: paused ? 'paused' : 'capturing' });
  }

  /** Route one popup request to the controller surface.
   *
   * Only extension-owned UI may drive a capture; a page frame is accepted only
   * for cancelling the job it owns. Every failure is folded into the reply
   * shape so a transport caller never sees a rejected promise.
   *
   * @param {import('./types.js').CaptureRequest} request Popup request.
   * @param {object} sender Message sender identity.
   * @returns {Promise<import('./types.js').CaptureReply>} State or failure code.
   */
  async function handle(request, sender) {
    await writes;
    const extensionUi = sender.url?.startsWith(deps.runtime.getURL('/'));
    if (!extensionUi) return { ok: false, error: 'unsupported' };
    try {
      if (request.action === 'start') await start(request.mode);
      else if (request.action === 'cancel') cancel(request.id);
      else if (request.action === 'finish') finish(request.id);
      else if (request.action === 'pause') pause(request.id, true);
      else if (request.action === 'resume') pause(request.id, false);
      else if (request.action === 'preview') {
        if (!state || state.id !== request.id || state.phase !== 'complete') throw new ScreenshotError('unavailable');
        await deps.preview?.(request.id);
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error instanceof ScreenshotError ? error.code : 'captureFailed' };
    }
  }

  return {
    restore,
    start,
    cancel,
    finish,
    pause,
    handle,
    get state() { return state; },
    get running() { return running; },
  };
}


/** Screenshot-only controller. No CLI/Agent transport dependency.
 * @param {{ isTabBusy: (tabId: number) => boolean }} options Tab ownership probe.
 * @returns {void}
 */
export function attachLongScreenshot(options) {
  let state = null;
  let running = null;
  const openingPreviews = new Map();
  let writes = Promise.resolve();
  let pruning = Promise.resolve();
  const ready = chrome.storage.session.get(LONG_SCREENSHOT_STATE).then(async (stored) => {
    state = stored[LONG_SCREENSHOT_STATE] ?? null;
    if (isCapturing(state) && state) {
      const saved = await readTiledScreenshot(state.id).catch(() => undefined);
      publish(saved?.height
        ? { ...state, phase: 'complete', width: saved.width, height: saved.height, partial: true, notice: 'interrupted' }
        : { ...state, phase: 'error', error: 'interrupted' });
    }
  }).catch(() => {}).then(() => prune());

  /** Delete captures no longer referenced by a live job, a published state, or
   * an open preview tab. Runs are serialized so two prunes never overlap.
   * @returns {Promise<void>} Resolves when this sweep finishes.
   */
  function prune() {
    pruning = pruning.then(async () => {
      const previewUrl = chrome.runtime.getURL('/long-screenshot.html');
      const inUse = (id) => id === running?.id || id === state?.id || openingPreviews.has(id);
      await pruneScreenshots(async (id) => {
        if (inUse(id)) return true;
        const tabs = await chrome.tabs.query({});
        return inUse(id) || tabs.some((tab) => [tab.url, tab.pendingUrl].some((url) => url?.startsWith(`${previewUrl}?`) && new URL(url).searchParams.get('id') === id));
      });
    }).catch(() => {});
    return pruning;
  }

  /** Publish the last durable state and order its session-storage write.
   * @param {import('./types.js').CaptureState | null} next Snapshot to publish.
   */
  function publish(next) {
    state = next;
    writes = writes.then(() => chrome.storage.session.set({ [LONG_SCREENSHOT_STATE]: next })).catch(() => {});
  }

  function clearResult() {
    if (state && !running && !openingPreviews.size && !isCapturing(state)) { publish(null); void prune(); }
  }

  /** Drop a finished result when the user moves to a different page.
   *
   * Every awaited step is revalidated, because a new capture or a preview tab
   * can appear while the active tab is being read.
   */
  async function clearResultOnPageChange() {
    await ready;
    const previous = state;
    if (!previous || running || openingPreviews.size || isCapturing(previous)) return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (state !== previous || running || openingPreviews.size || !tab) return;
    const pageUrl = tab.pendingUrl ?? tab.url;
    if (!pageUrl) return;
    if (tab.id === previous.tabId && (!previous.pageUrl || pageUrl === previous.pageUrl)) return;
    const previewUrl = chrome.runtime.getURL('/long-screenshot.html');
    if (pageUrl.startsWith(`${previewUrl}?`) && new URL(pageUrl).searchParams.get('id') === previous.id) return;
    clearResult();
  }

  const pageChanged = () => { void clearResultOnPageChange().catch(() => {}); };
  chrome.tabs.onActivated.addListener(pageChanged);
  chrome.windows.onFocusChanged.addListener((windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) pageChanged(); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    void ready.then(() => {
      if (state?.tabId === tabId && info.url !== state.pageUrl) clearResult();
      else pageChanged();
      void prune();
    });
  });
  chrome.webNavigation.onCommitted.addListener((info) => {
    if (info.frameId !== 0) return;
    void ready.then(() => { if (state?.tabId === info.tabId) clearResult(); else pageChanged(); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void ready.then(() => { if (state?.tabId === tabId) clearResult(); void prune(); });
  });

  /** Open the preview page for one completed capture.
   *
   * Concurrent opens track a reference count so pruning cannot delete the
   * capture before every preview tab has loaded it.
   *
   * @param {string} id Capture identity.
   * @returns {Promise<void>} Resolves after the tab is created.
   */
  async function preview(id) {
    const notice = state?.id === id && state.partial && state.notice ? `&notice=${encodeURIComponent(state.notice)}` : '';
    openingPreviews.set(id, (openingPreviews.get(id) ?? 0) + 1);
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`/long-screenshot.html?id=${encodeURIComponent(id)}${notice}`) });
    } finally {
      const remaining = openingPreviews.get(id) - 1;
      if (remaining) openingPreviews.set(id, remaining);
      else openingPreviews.delete(id);
    }
  }

  /** Start a capture in the active tab with the full browser event wiring.
   *
   * The job aborts as soon as the tab stops being the captured document: a
   * different active tab, a navigation, a window change, or a close. Disk
   * tiles are kept for a partial image and removed for a cancelled one.
   *
   * @param {import('./types.js').CaptureMode} [requested] Requested mode.
   * @returns {Promise<void>} Resolves once the job is registered and running.
   */
  async function start(requested = 'auto') {
    if (running) throw new ScreenshotError('busy');
    if (!['auto', 'manual', 'visible'].includes(requested)) throw new ScreenshotError('unsupported');
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url) throw new ScreenshotError('unsupported');
    if (options.isTabBusy(tab.id)) throw new ScreenshotError('busy');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id, controller, paused: false, finished: false };
    running = job;
    const tabId = tab.id;
    const windowId = tab.windowId;
    const url = tab.url;
    const writer = new TileWriter(id, tab.title || new URL(url).hostname || 'Screenshot');
    publish({ id, tabId, pageUrl: url, title: writer.shot.title, mode: requested, phase: 'preparing', progress: 0, frames: 0 });
    const checkTab = async () => {
      controller.signal.throwIfAborted();
      const current = await chrome.tabs.get(tabId);
      if (!current.active || current.windowId !== windowId || current.url !== url || options.isTabBusy(tabId)) throw new ScreenshotError('changed');
    };
    const client = createPageClient(tabId, id, controller.signal, checkTab);
    const page = client.page;
    const checkpoint = async () => {
      while (job.paused && !job.finished) {
        controller.signal.throwIfAborted();
        if (job.page) await page({ action: 'pause', paused: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      controller.signal.throwIfAborted();
    };
    async function execute() {
      let source;
      let complete = false;
      const changed = () => controller.abort(new ScreenshotError('changed'));
      const activated = (info) => { if (info.windowId === windowId && info.tabId !== tabId) changed(); };
      const updated = (updatedId, info) => { if (updatedId === tabId && info.url && info.url !== url) changed(); };
      const navigated = (info) => { if (info.tabId === tabId && info.frameId === 0) changed(); };
      const removed = (removedId) => { if (removedId === tabId) changed(); };
      chrome.tabs.onActivated.addListener(activated);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.onAttached.addListener(removed);
      chrome.webNavigation.onBeforeNavigate.addListener(navigated);
      chrome.webNavigation.onCommitted.addListener(navigated);
      const heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20_000);
      try {
        await prune();
        controller.signal.throwIfAborted();
        const mode = requested;
        if (mode === 'auto') await client.prepare();
        await checkTab();
        source = await openScreenshotSource(tabId, windowId, controller.signal, checkTab, mode === 'auto');
        const screenshot = async () => {
          const dataUrl = await source.capture();
          await checkTab();
          return createImageBitmap(await (await fetch(dataUrl)).blob());
        };
        const write = (bitmap, width, sourceY, targetY, height) => writer.write(bitmap, width, sourceY, targetY, height, controller.signal);
        const progress = (frames, value, notice) => {
          if (state?.id === id) publish({ ...state, phase: job.paused ? 'paused' : 'capturing', progress: value, frames, width: writer.shot.width, height: writer.shot.height, notice });
        };
        if (mode === 'auto') {
          await capturePage({
            page,
            prepared: () => { job.page = page; },
            screenshot, write,
            signal: controller.signal,
            checkpoint,
            finished: () => job.finished,
            label: '正在截取页面…',
            cancelLabel: '取消',
            progress: (_phase, value, frames) => progress(frames, value),
          });
        } else {
          await captureManual({
            screenshot, write,
            signal: controller.signal,
            checkpoint,
            finished: () => job.finished,
            visible: mode === 'visible',
            progress: (frames, notice) => progress(frames, 0, notice),
          });
        }
        controller.signal.throwIfAborted();
        if (!writer.shot.height) throw new ScreenshotError('captureFailed');
        await writer.finish();
        controller.signal.throwIfAborted();
        complete = true;
        if (state?.id === id) publish({ ...state, phase: 'complete', progress: 100, notice: undefined, width: writer.shot.width, height: writer.shot.height });
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        const cancelled = controller.signal.aborted && !(reason instanceof ScreenshotError);
        const code = reason instanceof ScreenshotError ? reason.code : reason instanceof DOMException && reason.name === 'QuotaExceededError' ? 'storageFull' : 'captureFailed';
        if (cancelled) {
          await removeTiledScreenshot(id).catch(() => {});
          if (state?.id === id) publish({ ...state, phase: 'cancelled', notice: undefined });
        } else if (writer.shot.height) {
          await writer.finish(code).catch(() => {});
          complete = true;
          if (state?.id === id) publish({ ...state, phase: 'complete', partial: true, notice: code, width: writer.shot.width, height: writer.shot.height });
        } else {
          await removeTiledScreenshot(id).catch(() => {});
          if (state?.id === id) publish({ ...state, phase: 'error', error: code });
        }
      } finally {
        clearInterval(heartbeat);
        await source?.close();
        chrome.tabs.onActivated.removeListener(activated);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        chrome.tabs.onAttached.removeListener(removed);
        chrome.webNavigation.onBeforeNavigate.removeListener(navigated);
        chrome.webNavigation.onCommitted.removeListener(navigated);
        if (running?.id === id) running = null;
        void prune();
      }
      if (complete) await preview(id).catch(() => {});
    }
    void execute();
  }

  async function handle(request, sender) {
    await ready;
    const extensionUi = sender.url?.startsWith(chrome.runtime.getURL('/'));
    if (!extensionUi && sender.tab) {
      if (request.action !== 'cancel' || sender.tab.id !== state?.tabId || sender.frameId !== 0 || request.id !== running?.id) return { ok: false, error: 'unsupported' };
    } else if (!extensionUi) return { ok: false, error: 'unsupported' };
    try {
      if (request.action === 'status' || request.action === 'preview') await clearResultOnPageChange();
      if (request.action === 'start') await start(request.mode);
      else if (request.action === 'preview') {
        if (!state || state.id !== request.id || state.phase !== 'complete') throw new ScreenshotError('unavailable');
        await preview(request.id);
      } else if (request.action !== 'status' && running && request.id === running.id) {
        if (request.action === 'cancel') running.controller.abort();
        else if (request.action === 'finish') { running.finished = true; running.paused = false; }
        else if (request.action === 'pause' || request.action === 'resume') {
          running.paused = request.action === 'pause';
          await running.page?.({ action: 'pause', paused: running.paused });
          if (state) publish({ ...state, phase: running.paused ? 'paused' : 'capturing' });
        }
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error instanceof ScreenshotError ? error.code : 'captureFailed' };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    if (message.type !== LONG_SCREENSHOT) return;
    void handle(message, sender).then(respond);
    return true;
  });
}
