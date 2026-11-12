/**
 * Incremental evidence journal: request metadata and bodies are retained as they
 * are captured, in bounded pending batches.
 *
 * Evidence shapes (`DebugRequest`, `DebugRun`, `DebugArchive`) are declared in
 * ./types.js and ./archive.js; the bare names below refer to those declarations.
 *
 * @typedef {object} PendingEntry
 * @property {DebugRequest} entry Cloned evidence awaiting a write.
 * @property {number} bytes Serialized size counted against the pending budget.
 */

/** Retained request limits; overflow evicts old, unpinned, low-priority entries. */
export const JOURNAL_REQUESTS = 2000;
export const JOURNAL_BYTES = 8 * 1024 * 1024;
export const JOURNAL_PINS = 20;
const PENDING_BYTES = 4 * 1024 * 1024;
const PENDING_COUNT = 256;

/**
 * @param {unknown} value Any JSON-serializable value.
 * @returns {number} UTF-8 byte length of its JSON encoding.
 */
export const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Shared by persisted indexes and detail projections; no browser dependencies.
 *
 * @param {DebugRequest} entry
 * @returns {DebugRequest} Copy without body text, headers and timing.
 */
export function requestMetadata(entry) {
  const { text: _request, ...requestBody } = entry.request_body || {};
  const { text: _response, ...responseBody } = entry.response_body || {};
  const {
    request_headers: _headers,
    response_headers: _responseHeaders,
    timing: _timing,
    ...rest
  } = entry;
  return { ...rest, request_body: requestBody, response_body: responseBody };
}

/**
 * Memory eviction must not erase evidence already captured or saved.
 *
 * @param {DebugRequest | undefined} previous Entry already retained, if any.
 * @param {DebugRequest} current Newest version of the same request.
 * @returns {DebugRequest} Merged entry that keeps the most complete body and
 *   headers.
 */
export function mergeRequest(previous, current) {
  if (!previous) return current;
  const merged = { ...previous, ...current, pinned: previous.pinned ?? current.pinned };
  for (const key of ['request_body', 'response_body']) {
    const currentBody = current[key] || { state: 'empty' };
    const previousBody = previous[key] || { state: 'empty' };
    if (
      (currentBody.state === 'evicted' && previousBody.state !== 'pending') ||
      (currentBody.state === previousBody.state && currentBody.text === undefined && previousBody.text !== undefined)
    ) merged[key] = previousBody;
  }
  merged.request_headers = current.request_headers ?? previous.request_headers;
  merged.response_headers = current.response_headers ?? previous.response_headers;
  return merged;
}

/**
 * @param {DebugRequest} entry
 * @returns {number} Eviction priority from 0 (oldest first) to 9 (pinned).
 */
export function retentionPriority(entry) {
  if (entry.pinned) return 9;
  if (entry.state === 'failed' || (entry.status ?? 0) >= 400 || entry.intervention || entry.replay_id) return 4;
  return ['Fetch', 'XHR'].includes(entry.resource_type ?? '') || /json/i.test(entry.mime_type ?? '') ? 2 : 0;
}

/** One bounded pending batch and one transaction in flight; never blocks the
 * browser event stream. */
export class DebugJournal {
  /**
   * Batches hold `PendingEntry` values keyed by request id.
   *
   * @param {DebugArchive} archive Destination archive; only `retain` is used.
   * @param {() => DebugRun} run Current run summary for each batch.
   * @param {(reason: string) => void} failed Receives a coverage reason when a
   *   batch is dropped or a write fails.
   */
  constructor(archive, run, failed) {
    this.archive = archive;
    this.run = run;
    this.failed = failed;
    this.pending = new Map();
    this.bytes = 0;
    this.timer = undefined;
    this.writing = undefined;
  }

  /**
   * Queue the newest version of one request. A full backlog reports a coverage
   * reason instead of growing without bound.
   *
   * @param {DebugRequest} value
   * @returns {void}
   */
  retain = (value) => {
    const entry = structuredClone(mergeRequest(this.pending.get(value.id)?.entry, value));
    const bytes = jsonBytes(entry);
    const previous = this.pending.get(entry.id);
    if (
      (!previous && this.pending.size >= PENDING_COUNT) ||
      this.bytes - (previous?.bytes ?? 0) + bytes > PENDING_BYTES
    ) {
      this.failed('evidence_write_backlog');
      if (!this.writing) void this.flush();
      return;
    }
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.pending.set(entry.id, { entry, bytes });
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 100);
    }
    if (this.pending.size >= 32 && !this.writing) void this.flush();
  };

  /**
   * Write the pending batch and re-run until nothing is left; concurrent callers
   * wait for the in-flight write instead of starting a second one.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) {
      await this.writing;
      return this.flush();
    }
    if (!this.pending.size) return;
    const entries = [...this.pending.values()].map(({ entry }) => entry);
    this.pending.clear();
    this.bytes = 0;
    const writing = this.archive.retain(this.run(), entries).catch(() => this.failed('evidence_write_failed'));
    this.writing = writing;
    await writing;
    if (this.writing === writing) this.writing = undefined;
    if (this.pending.size) await this.flush();
  }
}
