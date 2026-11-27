// src/browser-driver/cdp-dialogs.js —— 原生对话框生命周期（ChromiumCdp mixin）。
import { parseDialogOpeningParams, truncateDialogField } from './dialog-parser.js';
import { appendBounded } from './cdp-buffer-utils.js';

const MAX_DIALOG_BUFFER = 32;
const DIALOG_DECISION_TIMEOUT_MS = 60_000;
const DIALOG_CLOSE_CONFIRM_MS = 2_000;

export class CdpDialogMethods {
  /**
   * Track native dialog opening/closing for a tab.
   * @returns {void}
   */
  bindDialogHandler() {
    if (this.dialogSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      if (method === 'Page.javascriptDialogOpening') this.onDialogOpened(source, params);
      else if (method === 'Page.javascriptDialogClosed') this.onDialogClosed(tabId, params);
    };
    this.api.onEvent.addListener(listener);
    this.dialogSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }
  dialogCursor(tabId) { return this.dialogSequences.get(tabId) ?? 0; }
  /**
   * Dialogs observed on `tabId` with sequence strictly greater than `cursor`.
   * @param {number} tabId
   * @param {DialogCursor} cursor
   * @returns {JavaScriptDialogInfo[]}
   */
  dialogsSince(tabId, cursor) { return (this.dialogBuffers.get(tabId) ?? []).filter((dialog) => dialog.sequence > cursor); }
  /**
   * Dialogs still waiting for a decision, optionally limited to one tab.
   * @param {number} [tabId]
   * @returns {PendingJavaScriptDialog[]}
   */
  pendingDialogs(tabId) {
    return [...this.pendingDialogEntries.values()]
      .filter((entry) => tabId === undefined || entry.dialog.tab_id === tabId)
      .map((entry) => ({ ...entry.dialog }));
  }
  /**
   * Subscribe to dialog state changes.
   * @param {DialogChangedListener} handler
   * @returns {{ dispose: () => void }}
   */
  onDialogChanged(handler) {
    this.dialogListeners.add(handler);
    return { dispose: () => this.dialogListeners.delete(handler) };
  }
  /**
   * Notify listeners; `dialog` is null when a pending dialog goes away.
   * @param {number} tabId
   * @param {PendingJavaScriptDialog | null} dialog
   * @param {'decision_timeout'} [reason]
   */
  emitDialogChanged(tabId, dialog, reason) {
    for (const handler of this.dialogListeners) handler(tabId, dialog, reason);
  }
  /**
   * A native modal blocks command processing until it is dismissed. The
   * opening event only records state when the tab is still agent controlled
   * on the same attachment; a refusal leaves the modal for the user.
   * @param {CdpDebuggee} source
   * @param {object} params Raw `Page.javascriptDialogOpening` payload.
   */
  onDialogOpened(source, params) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const generation = (this.dialogGenerations.get(tabId) ?? 0) + 1;
    this.dialogGenerations.set(tabId, generation);
    void this.onJavaScriptDialogOpening(source, params, generation);
  }
  /**
   * Record a freshly opened dialog for this attachment and generation. A
   * dialog that arrives after the attachment was released is ignored, and the
   * scope check may still refuse to retain it.
   * @param {CdpDebuggee} source
   * @param {object} params Raw `Page.javascriptDialogOpening` payload.
   * @param {number} generation Dialog generation at the time of the event.
   * @returns {Promise<void>}
   */
  async onJavaScriptDialogOpening(source, params, generation) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const attachmentId = this.getAttachmentId(tabId);
    // A dialog that arrives after an attachment was released is stale: the tab
    // is no longer under agent control and its decision must not reconnect.
    // An event observed before any attachment is still recorded so a modal
    // that appeared early does not vanish from the transcript.
    if (!attachmentId && (this.attachmentVersions.get(tabId) ?? 0) > 0) return;
    const parsed = parseDialogOpeningParams(params);
    try {
      if (this.options.canControlDialog && !(await this.options.canControlDialog(tabId))) return;
      if (this.getAttachmentId(tabId) !== attachmentId || this.dialogGenerations.get(tabId) !== generation) return;
      const sequence = (this.dialogSequences.get(tabId) ?? 0) + 1;
      this.dialogSequences.set(tabId, sequence);
      const dialog = {
        id: crypto.randomUUID(),
        tab_id: tabId,
        type: parsed.type,
        message: parsed.message,
        url: parsed.url,
        default_prompt: parsed.defaultPrompt === undefined ? undefined : truncateDialogField(parsed.defaultPrompt),
        sequence,
        decision_deadline: Date.now() + DIALOG_DECISION_TIMEOUT_MS,
      };
      const timer = setTimeout(() => {
        // A bounded fallback rejects; never confirms on behalf of an absent agent.
        if (this.pendingDialogEntries.get(tabId)?.dialog.id !== dialog.id) return;
        this.emitDialogChanged(tabId, dialog, 'decision_timeout');
        void this.resolveDialog(dialog.id, false).catch(() => {});
      }, DIALOG_DECISION_TIMEOUT_MS);
      timer?.unref?.();
      this.pendingDialogEntries.set(tabId, {
        dialog,
        source,
        attachmentId,
        defaultPrompt: parsed.defaultPrompt,
        hasBrowserHandler: parsed.hasBrowserHandler,
        resolving: false,
        timer,
        closed: new Set(),
      });
      this.emitDialogChanged(tabId, dialog);
    } catch (error) {
      console.debug('[bb cdp] dialog state unavailable', error);
    }
  }
  /**
   * Record the browser's own closing event; it wins over a decision still in flight.
   * @param {number} tabId
   * @param {object} params Raw `Page.javascriptDialogClosed` payload.
   */
  onDialogClosed(tabId, params) {
    this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
    const pending = this.pendingDialogEntries.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDialogEntries.delete(tabId);
    const { dialog } = pending;
    const info = {
      tab_id: tabId,
      type: dialog.type,
      message: dialog.message,
      url: dialog.url,
      default_prompt: dialog.default_prompt,
      has_browser_handler: pending.hasBrowserHandler,
      handled: params?.result ? 'accepted' : 'dismissed',
      sequence: dialog.sequence,
    };
    appendBounded(this.dialogBuffers, tabId, info, MAX_DIALOG_BUFFER);
    for (const close of pending.closed) close(info);
    pending.closed.clear();
    this.emitDialogChanged(tabId, null);
  }
  /**
   * Accept or dismiss one pending dialog and wait for the browser's own
   * closing event. The decision never reopens a released attachment, and a
   * timeout rejects instead of confirming on the agent's behalf.
   * @param {string} dialogId
   * @param {boolean} accept
   * @param {string} [promptText] Only valid when accepting a prompt.
   * @param {Pick<CdpDispatchGuard, 'signal' | 'onDispatch'>} [guard]
   * @returns {Promise<JavaScriptDialogInfo>}
   */
  async resolveDialog(dialogId, accept, promptText, guard = {}) {
    const entry = [...this.pendingDialogEntries.values()].find((item) => item.dialog.id === dialogId);
    if (!entry) throw new Error('Dialog is no longer pending');
    if (entry.resolving) throw new Error('Dialog decision is already in progress');
    if (promptText !== undefined && (!accept || entry.dialog.type !== 'prompt')) throw new Error('text is only valid when accepting a prompt');
    guard.signal?.throwIfAborted();
    if (this.options.canControlDialog && !(await this.options.canControlDialog(entry.dialog.tab_id))) throw new Error('Tab is no longer agent controlled');
    // Scope checks can await tab metadata; repeat identity checks at native dispatch.
    if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry) throw new Error('Dialog is no longer pending');
    if (entry.resolving) throw new Error('Dialog decision is already in progress');
    entry.resolving = true;
    let timeout;
    let closeListener;
    const closed = new Promise((resolve, reject) => {
      closeListener = (result) => (result instanceof Error ? reject(result) : resolve(result));
      entry.closed.add(closeListener);
      timeout = setTimeout(() => reject(new Error('Browser did not confirm dialog closure')), DIALOG_CLOSE_CONFIRM_MS);
      timeout?.unref?.();
    });
    // Attach a rejection handler immediately, including when native dispatch fails first.
    void closed.catch(() => {});
    try {
      await this.sendGuarded(
        { ...entry.source, tabId: entry.dialog.tab_id },
        'Page.handleJavaScriptDialog',
        {
          accept,
          // Omitting the prompt text would submit an empty string, so keep the
          // full native default privately instead of reusing the bounded preview.
          ...(accept && entry.dialog.type === 'prompt' ? { promptText: promptText ?? entry.defaultPrompt ?? '' } : {}),
        },
        {
          signal: guard.signal,
          attachmentId: entry.attachmentId,
          onDispatch: () => {
            if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry) throw new Error('Dialog changed before native dispatch');
            guard.onDispatch?.();
          },
        },
      );
      return await closed;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (closeListener) entry.closed.delete(closeListener);
      entry.resolving = false;
    }
  }
  /**
   * Forget a tab's pending dialog state, rejecting waiters because the native
   * outcome is now unknown.
   * @param {number} tabId
   */
  clearDialogState(tabId) {
    const pending = this.pendingDialogEntries.get(tabId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingDialogEntries.delete(tabId);
      for (const close of pending.closed) close(new Error('Debugger attachment changed; dialog outcome is unknown'));
      pending.closed.clear();
      this.emitDialogChanged(tabId, null);
    }
    this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
    this.dialogBuffers.delete(tabId);
    this.dialogSequences.delete(tabId);
  }
}
