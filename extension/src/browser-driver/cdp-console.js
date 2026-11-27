// src/browser-driver/cdp-console.js —— console/异常/log 缓冲与投影（ChromiumCdp mixin）。
import { parseConsoleApiCalled, parseExceptionThrown, parseLogEntry } from './console-parsers.js';
import { CdpReadTimeoutError, READ_TIMEOUT_MS } from './command-deadline.js';
import { appendBounded, readBufferedEntries, truncateText } from './cdp-buffer-utils.js';

const MAX_CONSOLE_BUFFER = 200;

export class CdpConsoleMethods {
  /**
   * Track console, exception and log entries for a tab.
   * @returns {void}
   */
  bindConsoleHandler() {
    if (this.consoleSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      switch (method) {
        case 'Runtime.consoleAPICalled':
          this.appendConsole(tabId, parseConsoleApiCalled(params));
          break;
        case 'Runtime.exceptionThrown':
          this.appendConsole(tabId, parseExceptionThrown(params));
          break;
        case 'Log.entryAdded':
          this.appendConsole(tabId, parseLogEntry(params));
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.consoleSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }

  /**
   * Enable console capture for this tab on first use. Attach leaves the
   * runtime domain off: while it is on, every console call builds argument
   * previews, which anti-debugging pages time to detect a debugger.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async ensureConsoleCapture(tabId, signal) {
    signal?.throwIfAborted();
    if (!this.attachedTabs.has(tabId)) await this.ensureAttached(tabId);
    signal?.throwIfAborted();
    await this.enableConsoleDomains(tabId, signal);
  }
  /**
   * Enable the runtime and log domains on the current attachment. The runtime
   * domain is required, the log domain stays best effort, and the tab is
   * marked enabled only when both settle on the same attachment.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async enableConsoleDomains(tabId, signal) {
    const attachmentId = this.getAttachmentId(tabId);
    if (attachmentId === undefined) throw new Error('debugger detached');
    const check = () => {
      signal?.throwIfAborted();
      if (this.getAttachmentId(tabId) !== attachmentId) throw new Error('Debugger attachment changed during console capture');
    };
    check();
    if (this.consoleDomainsEnabledTabs.get(tabId) === attachmentId) return;
    // The runtime domain carries page console calls and exceptions, so its
    // failure is the caller's error. The log domain only adds
    // browser-generated entries and stays best effort. Any failure leaves the
    // tab unmarked so the next read retries.
    await this.command({ tabId }, 'Runtime.enable', {}, READ_TIMEOUT_MS, check, signal);
    check();
    let logEnabled = true;
    try {
      await this.command({ tabId }, 'Log.enable', {}, READ_TIMEOUT_MS, check, signal);
    } catch (err) {
      check();
      if (err instanceof CdpReadTimeoutError) throw err;
      logEnabled = false;
      console.debug('[bb cdp] console domain enable failed', { tabId, method: 'Log.enable', err });
    }
    check();
    // Enabling the runtime domain replays stored console messages as events,
    // which are not ordered with its command reply. One more renderer round
    // trip lets them reach the buffer before the first read.
    await this.command(
      { tabId },
      'Runtime.evaluate',
      { expression: '0', returnByValue: true, silent: true },
      READ_TIMEOUT_MS,
      check,
      signal,
    );
    check();
    if (logEnabled) this.consoleDomainsEnabledTabs.set(tabId, attachmentId);
  }
  /**
   * Console entries observed on `tabId`, bounded for agent context safety.
   * @param {number} tabId
   * @param {number} [since] Cursor from the previous read; omit for the newest entries.
   * @param {number} limit Maximum entries to return.
   * @param {number} maxTextChars Budget for each text field.
   * @param {boolean} includeStack Include the captured stack trace when present.
   * @returns {ConsoleResult}
   */
  consoleEntriesSince(tabId, since, limit, maxTextChars, includeStack) {
    const buffer = this.consoleBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(buffer, this.consoleSequences.get(tabId) ?? 0, since, limit, (entry) => projectConsoleEntry(entry, maxTextChars, includeStack));
    return { tab_id: tabId, entries, next_since: nextSince, truncated };
  }
  /**
   * Append one parsed event to the bounded per-tab console buffer.
   * @param {number} tabId
   * @param {ParsedConsoleEntry | null} entry Ignored when null.
   */
  appendConsole(tabId, entry) {
    if (!entry) return;
    const sequence = (this.consoleSequences.get(tabId) ?? 0) + 1;
    this.consoleSequences.set(tabId, sequence);
    appendBounded(this.consoleBuffers, tabId, { ...entry, sequence }, MAX_CONSOLE_BUFFER);
  }
  /**
   * Drop buffered console entries and the enabled-domain mark for a tab.
   * @param {number} tabId
   */
  clearConsoleState(tabId) {
    this.consoleBuffers.delete(tabId);
    this.consoleSequences.delete(tabId);
    this.consoleDomainsEnabledTabs.delete(tabId);
  }
}

/**
 * Project a stored console entry for the agent, omitting the stack unless it
 * was requested.
 * @param {ConsoleEntry} entry
 * @param {number} maxTextChars
 * @param {boolean} includeStack
 * @returns {ConsoleEntry}
 */
function projectConsoleEntry(entry, maxTextChars, includeStack) {
  const projected = truncateText(entry.text, maxTextChars);
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    level: entry.level,
    text: projected.text,
    url: entry.url,
    line: entry.line,
    column: entry.column,
    timestamp: entry.timestamp,
    ...(includeStack && entry.stack_trace && entry.stack_trace.length > 0 ? { stack_trace: entry.stack_trace } : {}),
    truncated: entry.truncated || projected.truncated,
  };
}
