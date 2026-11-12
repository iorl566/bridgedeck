import { isAgentControlledTab } from '../session-manager/manager.js';
import { checkedUiTab, runTaskUi, UiTaskError, withUiTeardown } from '../session-manager/ui-activity.js';

/**
 * Downscaled preview capture and tab focus for one agent task.
 *
 * Both operations are UI actions: they may run while the task's tool queue is
 * busy, they must respect the task's own deadline, and they must never touch a
 * tab the task does not own. The preview is captured through the same
 * debugging attachment the tools use, reduced to a bounded JPEG, and stamped
 * with the tab identity and capture time so a gateway can tell how fresh it is.
 *
 * @typedef {object} TaskPreview
 * @property {string} image_base64  Base64-encoded JPEG, width bounded by {@link PREVIEW_WIDTH}.
 * @property {'jpeg'} format  Image format; always JPEG.
 * @property {number} tab_id  Tab the image was captured from.
 * @property {string} title  Tab title at capture time, empty when unknown.
 * @property {string} captured_at  ISO timestamp of the capture.
 *
 * @typedef {object} TaskUiOperation
 * @property {number} [tabId]  Tab the operation currently holds, when known.
 * @property {AbortSignal} [signal]  Aborted when the task's UI deadline expires.
 * @property {() => void} [check]  Throws when the operation is no longer allowed to continue.
 * @property {(tabId: number, run: () => Promise<unknown>) => Promise<unknown>} [mutate]
 *   Run a mutating tab/window call under the UI gate.
 *
 * @typedef {object} TaskPreviewDeps
 * @property {object} [tabs]  Tabs API override for tests.
 * @property {object} [windows]  Windows API override for tests.
 * @property {(manager: object, sessionId: string, work: (op: TaskUiOperation, task: object) => Promise<unknown>) => Promise<unknown>} [runTaskUi]
 *   UI gate override for tests.
 * @property {(task: object, op: TaskUiOperation, tabId: number) => Promise<object>} [checkedUiTab]
 *   Tab authorization override for tests.
 */

/** Maximum preview width in CSS pixels; taller images are scaled proportionally. */
const PREVIEW_WIDTH = 640;
/** In-flight preview per task; concurrent requests share one capture. */
const previews = new WeakMap();
/** In-flight viewport captures per driver, keyed by tab id. */
const capturesInFlight = new WeakMap();

/**
 * Capture one downscaled preview of the task's owned tab.
 *
 * Concurrent calls for the same task share one in-flight capture, so a polling
 * gateway cannot pile up screenshots. Before capture the tab must pass the UI
 * gate; afterwards the attachment id and document revision must still match, so
 * an image from a navigated or re-attached tab is rejected as stale.
 *
 * A failed or aborted capture releases a tab that is no longer authorized for
 * the task, but never releases a claim the task still owns: release is the
 * responsibility of the tool or stop path that acquired it.
 *
 * @param {object} manager  Session manager.
 * @param {object} cdp  Browser driver.
 * @param {string} sessionId  Task to preview.
 * @returns {Promise<TaskPreview>} Preview image and metadata.
 * @throws {UiTaskError} `task_unavailable`, `target_unavailable`, `preview_busy`,
 *   `stale_frame`, or the underlying capture error.
 */
export function captureTaskPreview(manager, cdp, sessionId) {
  const task = manager.get(sessionId);
  if (!task?.remote) return Promise.reject(new UiTaskError('not_found', 'Task unavailable', 'task_unavailable'));
  const pending = previews.get(task);
  if (pending) return pending;
  const work = runTaskUi(manager, sessionId, async (op, current) => {
    /**
     * Release control of a tab that moved out of the task window while the
     * capture was running. The claim is read before the tab lookup so a late
     * lookup cannot release a newer acquisition.
     */
    const releaseIfUnauthorized = async () => {
      const tabId = op.tabId;
      if (tabId === undefined || manager.get(sessionId) !== current) return;
      const claim = cdp.getSessionClaimId(sessionId, tabId);
      if (!claim) return;
      const tab = await (globalThis.chrome?.tabs?.get?.(tabId) ?? Promise.resolve(undefined)).catch(() => undefined);
      if (manager.get(sessionId) !== current) return;
      if (!isAgentControlledTab(current, tabId) || (tab && tab.windowId !== current.agentWindowId)) await cdp.releaseSessionTab(sessionId, tabId, { ifClaim: claim });
    };
    const onAbort = () => { void releaseIfUnauthorized().catch(() => {}); };
    op.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await capture(manager, cdp, sessionId, op, current);
    } catch (error) {
      await releaseIfUnauthorized().catch(() => {});
      throw error;
    } finally {
      op.signal?.removeEventListener('abort', onAbort);
    }
  }).finally(() => {
    if (previews.get(task) === work) previews.delete(task);
  });
  previews.set(task, work);
  return work;
}

/**
 * Run teardown under the task UI gate, or directly when no task owns the tab.
 *
 * Stop paths share the gate so teardown cannot interleave with an in-flight
 * preview or focus action on the same task.
 *
 * @param {object} manager  Session manager.
 * @param {string} [sessionId]  Task being stopped, when known.
 * @param {() => Promise<unknown>} stop  Teardown to run.
 * @returns {Promise<unknown>} Whatever `stop` resolves with.
 */
export async function withTaskPreviewStop(manager, sessionId, stop) {
  const task = sessionId ? manager.get(sessionId) : undefined;
  return task?.remote ? withUiTeardown(task, undefined, stop) : stop();
}

/**
 * Capture the viewport and reduce it, re-validating the frame at each edge.
 *
 * The sequence is: authorize the tab, take the session-lifetime background
 * claim, re-authorize, snapshot the attachment and document revision, capture,
 * verify the frame, downscale, and verify once more before returning. The
 * repeated checks mean a navigation or re-attach during any await surfaces as
 * `stale_frame` instead of returning an image of the wrong page.
 *
 * @param {object} manager  Session manager.
 * @param {object} cdp  Browser driver.
 * @param {string} sessionId  Task being previewed.
 * @param {TaskUiOperation} op  UI operation context.
 * @param {object} task  Task snapshot captured at entry.
 * @returns {Promise<TaskPreview>} Preview of the verified frame.
 */
async function capture(manager, cdp, sessionId, op, task) {
  const tabId = await taskTarget(manager, sessionId);
  await checkedUiTab(task, op, tabId);
  // This is a session-lifetime claim, shared with tools. A stale image must
  // never release the session's claim; return/stop own that responsibility.
  if (cdp.acquireBackgroundExecution) await cdp.acquireBackgroundExecution(sessionId, tabId);
  await checkedUiTab(task, op, tabId);
  const attachment = cdp.getAttachmentId(tabId);
  const revision = task.refStore?.documentRevision?.(tabId);
  const checkFrame = async () => {
    const tab = await checkedUiTab(task, op, tabId);
    if (cdp.getAttachmentId(tabId) !== attachment || (task.refStore?.documentRevision?.(tabId) !== revision)) throw new UiTaskError('cancelled', 'Task ended during capture', 'stale_frame');
    return tab;
  };
  const shot = await captureViewport(cdp, tabId, op.signal);
  await checkFrame();
  const data = await downscale(shot.data, op);
  const tab = await checkFrame();
  return { image_base64: data, format: 'jpeg', tab_id: tabId, title: tab.title ?? '', captured_at: new Date().toISOString() };
}

/**
 * Capture one viewport screenshot, rejecting overlapping captures of a tab.
 *
 * A second capture is only allowed when the tab was re-attached since the first
 * one started, because the old request can no longer report into the new
 * attachment. The in-flight entry is released by settling, success or failure.
 *
 * @param {object} cdp  Browser driver.
 * @param {number} tabId  Tab to capture.
 * @param {AbortSignal} signal  Aborts the capture.
 * @returns {Promise<{ data: string }>} Raw JPEG payload.
 * @throws {UiTaskError} `preview_busy` when a capture is already running.
 */
async function captureViewport(cdp, tabId, signal) {
  let inFlight = capturesInFlight.get(cdp);
  if (!inFlight) {
    inFlight = new Map();
    capturesInFlight.set(cdp, inFlight);
  }
  const attachment = cdp.getAttachmentId(tabId);
  const previous = inFlight.get(tabId);
  if (previous && previous.attachment === attachment) throw new UiTaskError('timeout', `Previous preview capture is still running in Chrome (tab ${tabId})`, 'preview_busy');
  const shot = cdp.send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 50, fromSurface: true, captureBeyondViewport: false }, signal);
  const entry = { attachment, shot };
  inFlight.set(tabId, entry);
  const release = () => { if (inFlight.get(tabId) === entry) inFlight.delete(tabId); };
  void shot.then(release, release);
  return shot;
}

/**
 * Bound the encoded image itself rather than leaving it to the caller.
 *
 * Viewport captures come back in physical display pixels, so a high-density
 * screen can produce an image several times wider than a preview needs.
 * Downscaling is skipped when the platform cannot decode images (the original
 * payload is still valid), when the image is already narrow enough, or when the
 * operation check throws.
 *
 * @param {string} jpegBase64  Base64 JPEG from the screenshot.
 * @param {TaskUiOperation} op  UI operation context; `check` is consulted before and after.
 * @returns {Promise<string>} Base64 JPEG no wider than {@link PREVIEW_WIDTH} when possible.
 */
async function downscale(jpegBase64, op) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return jpegBase64;
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }));
  try {
    op.check?.();
    if (bitmap.width <= PREVIEW_WIDTH) return jpegBase64;
    const canvas = new OffscreenCanvas(PREVIEW_WIDTH, Math.max(1, Math.round((bitmap.height * PREVIEW_WIDTH) / bitmap.width)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Preview canvas unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
    op.check?.();
    return btoa(Array.from(new Uint8Array(await jpeg.arrayBuffer()), (byte) => String.fromCharCode(byte)).join(''));
  } finally {
    bitmap.close();
  }
}

/**
 * The task's active owned tab; window membership alone never grants access.
 *
 * Ownership is decided by the task, not by the window: a tab the user opened in
 * the agent window is not owned and is never captured or focused. The active
 * owned tab wins, otherwise the first owned tab in query order. The task is
 * re-read after the query so a task that was replaced mid-flight fails instead
 * of returning a tab that belongs to the old instance.
 *
 * @param {object} manager  Session manager.
 * @param {string} sessionId  Task to resolve.
 * @param {TaskPreviewDeps} [deps]  Tab API override for tests.
 * @returns {Promise<number>} Owned tab id.
 * @throws {UiTaskError} `task_unavailable` or `target_unavailable`.
 */
export async function taskTarget(manager, sessionId, deps) {
  const task = manager.get(sessionId);
  if (!task?.remote) throw new UiTaskError('not_found', 'Task unavailable', 'task_unavailable');
  const tabs = await (deps.tabs ?? globalThis.chrome.tabs).query({ windowId: task.agentWindowId });
  if (manager.get(sessionId) !== task) throw new UiTaskError('not_found', 'Task unavailable', 'task_unavailable');
  const owned = tabs.filter((tab) => typeof tab.id === 'number' && isAgentControlledTab(task, tab.id));
  const tabId = (owned.find((tab) => tab.active) ?? owned[0])?.id;
  if (tabId === undefined) throw new UiTaskError('not_found', 'Task tab unavailable', 'target_unavailable');
  return tabId;
}

/**
 * Focus the task's owned tab and its agent window.
 *
 * Each mutation is preceded and followed by an authorization check, so a tab
 * that stops being owned between the two calls cannot be focused by the second.
 * The window is raised after the tab is activated, because activating a tab in
 * a background window does not bring that window forward.
 *
 * @param {object} manager  Session manager.
 * @param {string} sessionId  Task whose tab should be focused.
 * @param {TaskPreviewDeps} deps  Tab/window/gate dependencies.
 * @returns {Promise<{ focused: true }>} Resolves once the window is focused.
 * @throws {UiTaskError} When the task or its tab is unavailable or unauthorized.
 */
export function focusTask(manager, sessionId, deps) {
  return deps.runTaskUi(manager, sessionId, async (op, task) => {
    const tabId = await taskTarget(manager, sessionId, deps);
    await deps.checkedUiTab(task, op, tabId);
    await op.mutate(tabId, () => deps.tabs.update(tabId, { active: true }));
    await deps.checkedUiTab(task, op, tabId);
    await op.mutate(tabId, () => deps.windows.update(task.agentWindowId, { focused: true }));
    await deps.checkedUiTab(task, op, tabId);
    return { focused: true };
  });
}
