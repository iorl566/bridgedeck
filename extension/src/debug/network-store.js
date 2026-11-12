import { jsonPointer } from './json-source.js';
import { requestMetadata } from './journal.js';
import { BODY_CHARS, redactBody, redactHeaderEvidence, redactRequestUrl, redactText, redactUrl } from './redact.js';

/**
 * Live request tracking for one capture: browser protocol events fold into
 * retained request entries, bodies are fetched with bounded concurrency, and
 * local control annotations are merged in when a request is first seen.
 *
 * Evidence shapes (`DebugRequest`, `DebugBody`, `DebugIntervention`) are declared
 * in ./types.js; the bare names below refer to those declarations.
 *
 * @typedef {object} ProtocolResponse
 * @property {number} [status]
 * @property {string} [mimeType]
 * @property {Record<string, string>} [headers]
 * @property {boolean} [fromDiskCache]
 * @property {boolean} [fromServiceWorker]
 * @property {Record<string, number>} [timing]
 *
 * @typedef {object} ProtocolEvent
 * @property {string} [requestId]
 * @property {{ url: string, method?: string, headers?: Record<string, string>,
 *   postData?: string, hasPostData?: boolean }} [request]
 * @property {ProtocolResponse} [response]
 * @property {ProtocolResponse} [redirectResponse]
 * @property {number} [timestamp]
 * @property {string} [type]
 * @property {string} [frameId]
 * @property {string} [loaderId]
 * @property {string} [errorText]
 * @property {number} [encodedDataLength]
 * @property {number} [dataLength]
 * @property {Record<string, string>} [headers]
 * @property {boolean} [hasExtraInfo]
 * @property {boolean} [redirectHasExtraInfo]
 * @property {{ type?: string, stack?: { callFrames?: { url?: string, lineNumber?: number, functionName?: string }[] } }} [initiator]
 *
 * @typedef {object} HeaderEvidence
 * @property {Record<string, string>} headers Redacted header map.
 * @property {boolean} truncated Whether a name or value was withheld.
 *
 * @typedef {object} RequestRecord
 * @property {DebugRequest} entry Retained entry; mutated in place.
 * @property {string} rawId Browser request id used for body reads.
 * @property {{ sessionId?: string, tabId?: number }} target Target the event arrived on.
 * @property {number} [timestamp] Protocol timestamp used for duration.
 * @property {boolean} [expectsExtra] Whether header evidence is still expected.
 *
 * @typedef {object} Chain
 * @property {RequestRecord[]} hops Requests of one redirect chain, in order.
 * @property {HeaderEvidence[]} requestHeaders Extra request headers, in arrival order.
 * @property {HeaderEvidence[]} responseHeaders Extra response headers, in arrival order.
 * @property {number} requestIndex Next hop that still expects request headers.
 * @property {number} responseIndex Next hop that still expects response headers.
 * @property {boolean} [partial] True once header evidence was dropped; later
 *   headers are no longer attributed.
 *
 * @typedef {object} ControlAnnotation
 * @property {DebugIntervention} [intervention] Local control applied to the request.
 * @property {string} [replay_from] Source request id that was replayed.
 * @property {string} [replay_id] Replay run that produced the request.
 * @property {{ url: string, method: string, headers: Record<string, string>, postData?: string }} [effective]
 *   Effective request after local edits.
 * @property {{ status: number, headers?: Record<string, string>, body: string }} [mock]
 *   Synthetic response used instead of the network result.
 */

/** Maximum retained requests; further requests are dropped and counted. */
export const MAX_REQUESTS = 200;
/** Maximum concurrently tracked requests, including ones not yet retained. */
export const MAX_INFLIGHT = 200;
const MAX_BODY_CHARS = 512 * 1024;
const MAX_BODY_JOBS = 4;
const MAX_BODY_QUEUE = 32;

/**
 * Mark an entry as built from incomplete metadata.
 *
 * @param {DebugRequest} entry Retained entry, updated in place.
 * @returns {void}
 */
function incompleteMetadata(entry) {
  entry.truncated = true;
  if (entry.integrity) entry.integrity.metadata = 'truncated';
}

/**
 * Attach redacted response headers and record their integrity.
 *
 * @param {DebugRequest} entry Retained entry, updated in place.
 * @param {HeaderEvidence} evidence Redacted headers and their loss flag.
 * @returns {void}
 */
function setResponseHeaders(entry, evidence) {
  entry.response_headers = evidence.headers;
  if (entry.integrity) entry.integrity.response_headers = evidence.truncated ? 'truncated' : 'complete';
  entry.truncated ||= evidence.truncated;
}

/** Tracks one capture's requests and retains them as they settle.
 *
 * Entries move from `inflight` to `entries` once their response body is
 * resolved or abandoned. State transitions are driven by protocol events, not by
 * callers, so a missing terminal event is reported as interrupted rather than
 * fabricated as complete.
 */
export class DebugNetworkStore {
  /**
   * @param {string} runId Capture id used to build request ids.
   * @param {(target: object, method: string, params?: object) => Promise<any>} cdp
   *   Sends a browser command and resolves with its result.
   * @param {() => number} changed Returns a new capture-wide sequence number.
   * @param {() => number} [now] Epoch-millisecond clock.
   * @param {(entry: DebugRequest) => void} [retain] Sink for incremental retention.
   */
  constructor(runId, cdp, changed, now = Date.now, retain) {
    this.runId = runId;
    this.cdp = cdp;
    this.changed = changed;
    this.now = now;
    this.retain = retain;
    this.entries = new Map();
    this.inflight = new Map();
    this.chains = new Map();
    this.queue = [];
    this.annotations = new Map();
    this.jobs = 0;
    this.serial = 0;
    this.retainedChars = 0;
    this.pendingHeaders = 0;
    this.alive = true;
    this.accepting = true;
    this.dropped = 0;
  }

  /**
   * @param {{ sessionId?: string }} source Target that reported the request.
   * @param {string} requestId Browser request id.
   * @returns {string} Chain key scoped to the reporting target.
   */
  key(source, requestId) {
    return `${source.sessionId ?? 'root'}:${requestId}`;
  }
  /**
   * @param {string} id Retained entry id.
   * @returns {boolean} True while the request is still tracked.
   */
  tracked(id) { return this.entries.has(id) || this.inflight.has(id); }
  /**
   * @param {RequestRecord} record
   * @returns {boolean} True while the request or its response body is unfinished.
   */
  unsettled(record) { return record.entry.state === 'pending' || record.entry.response_body.state === 'pending'; }
  /**
   * @returns {IterableIterator<RequestRecord>} Unsettled records first, then
   *   retained entries.
   */
  *records() { yield* this.inflight.values(); yield* this.entries.values(); }
  /** @returns {number} Number of tracked requests. */
  get size() { return this.entries.size + this.inflight.size; }

  /**
   * Fold one protocol event into a retained request entry. Ordering follows the
   * browser, so a redirect starts a new entry in the same chain.
   *
   * @param {{ sessionId?: string, tabId?: number }} source Target that reported it.
   * @param {string} method Protocol event name.
   * @param {unknown} raw Untrusted event payload.
   * @returns {void}
   */
  onEvent(source, method, raw) {
    if (!this.accepting || !method.startsWith('Network.')) return;
    const event = raw || {};
    if (!event.requestId) return;
    const key = this.key(source, event.requestId);
    let chain = this.chains.get(key);
    if (!chain) {
      if (!['Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo'].includes(method)) return;
      chain = { hops: [], requestHeaders: [], responseHeaders: [], requestIndex: 0, responseIndex: 0 };
      this.chains.set(key, chain);
      while (this.chains.size > MAX_REQUESTS * 2 + MAX_INFLIGHT) {
        const oldestKey = [...this.chains].find(([, value]) => !value.hops.some((hop) => this.unsettled(hop)))[0];
        if (oldestKey === undefined) break;
        const oldest = this.chains.get(oldestKey);
        this.pendingHeaders -= oldest.requestHeaders.length + oldest.responseHeaders.length;
        this.chains.delete(oldestKey);
      }
    }
    if (method === 'Network.requestWillBeSent' && event.request) {
      const previous = chain.hops[chain.hops.length - 1];
      if (previous && event.redirectResponse) {
        previous.expectsExtra = event.redirectHasExtraInfo === true;
        this.response(previous, event.redirectResponse);
        this.finish(previous, event, 'redirected');
        previous.entry.response_body = { state: 'unavailable', reason: 'redirect' };
        this.retain?.(previous.entry);
      }
      const { headers, truncated: headersTruncated } = redactHeaderEvidence(event.request.headers);
      const url = redactRequestUrl(event.request.url);
      const metadataTruncated = chain.partial === true || headersTruncated;
      const id = `${this.runId}:n${++this.serial}`;
      const entry = {
        id,
        run_id: this.runId,
        sequence: this.changed(),
        started_at: this.now(),
        method: redactText(event.request.method ?? 'GET', 24),
        url: url.text,
        integrity: { url: url.state, metadata: metadataTruncated ? 'truncated' : 'complete' },
        resource_type: event.type,
        frame_id: event.frameId,
        loader_id: event.loaderId,
        state: 'pending',
        truncated: metadataTruncated || url.state === 'truncated',
        request_headers: headers,
        request_body: {
          state: event.request.hasPostData ? 'unavailable' : 'empty',
          replay_safe: !event.request.hasPostData,
          ...(event.request.hasPostData ? { reason: 'not_in_event' } : {}),
        },
        response_body: { state: 'pending' },
        ...(previous && event.redirectResponse ? { redirect_from: previous.entry.id } : {}),
      };
      const frame = event.initiator && event.initiator.stack && event.initiator.stack.callFrames && event.initiator.stack.callFrames[0];
      if (frame) {
        entry.initiator = redactText(`${frame.functionName ?? ''} ${redactUrl(frame.url ?? '')}:${(frame.lineNumber ?? 0) + 1}`, 1024);
      } else if (event.initiator && event.initiator.type) entry.initiator = event.initiator.type;
      const record = { entry, rawId: event.requestId, target: { ...source }, timestamp: event.timestamp };
      this.entries.set(id, record);
      chain.hops.push(record);
      if (typeof event.request.postData === 'string') {
        this.saveBody(record, 'request_body', event.request.postData, headers['content-type'] ?? '');
      }
      this.applyExtra(chain);
      this.applyAnnotation(key, record);
      this.retain?.(entry);
      if (previous) this.releaseFinished(previous);
      while (this.entries.size > MAX_REQUESTS) {
        const oldest = this.entries.values().next().value;
        if (this.unsettled(oldest)) {
          this.entries.delete(oldest.entry.id);
          this.inflight.set(oldest.entry.id, oldest);
          if (this.inflight.size > MAX_INFLIGHT) {
            const lost = this.inflight.values().next().value;
            if (lost.entry.state === 'pending') {
              lost.entry.state = 'interrupted';
              lost.entry.finished_at = this.now();
              lost.entry.error = 'tracking_limit';
            }
            incompleteMetadata(lost.entry);
            if (lost.entry.response_body.state === 'pending') lost.entry.response_body = { state: 'unavailable', reason: 'tracking_limit' };
            lost.entry.sequence = this.changed();
            this.evict(lost);
          }
        } else this.evict(oldest);
      }
      return;
    }
    if (method === 'Network.requestWillBeSentExtraInfo' || method === 'Network.responseReceivedExtraInfo') {
      if (chain.partial) return;
      const queue = method === 'Network.requestWillBeSentExtraInfo' ? chain.requestHeaders : chain.responseHeaders;
      if (queue.length < 8 && this.pendingHeaders < 64) {
        queue.push(redactHeaderEvidence(event.headers));
        this.pendingHeaders += 1;
      } else {
        chain.partial = true;
        const latest = chain.hops[chain.hops.length - 1];
        if (latest) incompleteMetadata(latest.entry);
      }
      this.applyExtra(chain);
      return;
    }
    const record = chain.hops[chain.hops.length - 1];
    if (!record || !this.tracked(record.entry.id)) return;
    const entry = record.entry;
    switch (method) {
      case 'Network.responseReceived':
        record.expectsExtra = event.hasExtraInfo === true;
        if (event.response) this.response(record, event.response);
        this.applyExtra(chain);
        break;
      case 'Network.dataReceived':
        if (typeof event.dataLength === 'number') entry.decoded_bytes = (entry.decoded_bytes ?? 0) + Math.max(0, event.dataLength);
        return;
      case 'Network.loadingFinished':
        this.finish(record, event, 'complete');
        if (entry.method === 'HEAD' || entry.status === 204 || entry.status === 304) entry.response_body = { state: 'empty', chars: 0 };
        else if (entry.intervention?.type === 'mock' && entry.response_body.state !== 'pending') { /* retained */ }
        else if (!/^(?:text\/|application\/(?:[\w.+-]*json|javascript|xml|x-www-form-urlencoded))/i.test(entry.mime_type ?? '')) entry.response_body = { state: 'omitted', reason: 'non_text' };
        else if ((entry.decoded_bytes ?? 0) > BODY_CHARS * 4) entry.response_body = { state: 'omitted', reason: 'body_limit' };
        else if (this.queue.length >= MAX_BODY_QUEUE) entry.response_body = { state: 'omitted', reason: 'capture_busy' };
        else { this.queue.push(record); this.pump(); }
        break;
      case 'Network.loadingFailed':
        this.finish(record, event, 'failed');
        entry.error = redactText(event.errorText ?? 'network failed');
        entry.response_body = { state: 'unavailable', reason: 'request_failed' };
        break;
      case 'Network.requestServedFromCache':
        entry.from_cache = true;
        break;
      default:
        return;
    }
    entry.sequence = this.changed();
    this.retain?.(entry);
    this.releaseFinished(record);
  }

  /**
   * Attach queued header evidence to the hops that still expect it. Evidence is
   * consumed in arrival order and never attributed to a later hop.
   *
   * @param {Chain} chain
   * @returns {void}
   */
  applyExtra(chain) {
    for (const side of ['request', 'response']) {
      const indexKey = side === 'request' ? 'requestIndex' : 'responseIndex';
      const headersQueue = side === 'request' ? chain.requestHeaders : chain.responseHeaders;
      while (chain[indexKey] < chain.hops.length) {
        const record = chain.hops[chain[indexKey]];
        if (record.expectsExtra === undefined) break;
        if (!record.expectsExtra) { chain[indexKey] += 1; continue; }
        if (!headersQueue.length) break;
        chain[indexKey] += 1;
        const evidence = headersQueue.shift();
        this.pendingHeaders -= 1;
        if (!this.tracked(record.entry.id)) continue;
        if (side === 'request') {
          record.entry.request_headers = evidence.headers;
          if (evidence.truncated) incompleteMetadata(record.entry);
        } else setResponseHeaders(record.entry, evidence);
        record.entry.sequence = this.changed();
        this.retain?.(record.entry);
      }
    }
  }

  /**
   * Apply response metadata: status, mime type, cache/service-worker flags,
   * headers and bounded timings.
   *
   * @param {RequestRecord} record
   * @param {ProtocolResponse} response
   * @returns {void}
   */
  response(record, response) {
    const entry = record.entry;
    entry.status = response.status;
    entry.mime_type = response.mimeType;
    if (!entry.response_headers) setResponseHeaders(entry, redactHeaderEvidence(response.headers));
    entry.from_cache = response.fromDiskCache === true || entry.from_cache;
    entry.from_service_worker = response.fromServiceWorker === true;
    if (response.timing) {
      entry.timing = Object.fromEntries(Object.entries(response.timing)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)).slice(0, 30));
    }
    entry.sequence = this.changed();
    this.retain?.(entry);
  }

  /**
   * @param {RequestRecord} record
   * @param {ProtocolEvent} event Terminal event carrying timestamp and size.
   * @param {'complete' | 'failed' | 'redirected'} state Final request state.
   * @returns {void}
   */
  finish(record, event, state) {
    record.entry.state = state;
    record.entry.finished_at = this.now();
    if (event.timestamp !== undefined && record.timestamp !== undefined) {
      record.entry.duration_ms = Math.max(0, Math.round((event.timestamp - record.timestamp) * 1000 * 100) / 100);
    }
    if (typeof event.encodedDataLength === 'number') record.entry.transfer_bytes = Math.max(0, event.encodedDataLength);
  }

  /**
   * Start queued body reads up to the concurrency limit; each job re-checks
   * liveness before mutating an entry.
   *
   * @returns {void}
   */
  pump() {
    while (this.alive && this.jobs < MAX_BODY_JOBS && this.queue.length) {
      const record = this.queue.shift();
      if (!this.tracked(record.entry.id)) continue;
      if (typeof this.cdp !== 'function') continue;
      this.jobs += 1;
      Promise.resolve(this.cdp(record.target, 'Network.getResponseBody', { requestId: record.rawId }))
        .then((result) => {
          if (!this.alive || !this.tracked(record.entry.id)) return;
          let body = result.body;
          if (result.base64Encoded) {
            if (body.length > BODY_CHARS * 6) { record.entry.response_body = { state: 'omitted', reason: 'body_limit' }; return; }
            body = new TextDecoder().decode(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)));
          }
          this.saveBody(record, 'response_body', body, record.entry.mime_type ?? '');
        })
        .catch(() => {
          if (this.alive && this.tracked(record.entry.id)) record.entry.response_body = { state: 'unavailable', reason: 'browser_buffer_unavailable' };
        })
        .finally(() => {
          this.jobs -= 1;
          if (this.alive && this.tracked(record.entry.id)) {
            record.entry.sequence = this.changed();
            this.retain?.(record.entry);
            this.releaseFinished(record);
          }
          this.pump();
        });
    }
  }

  /**
   * Store one redacted body and evict the oldest retained text once the memory
   * budget is exceeded.
   *
   * @param {RequestRecord} record
   * @param {'request_body' | 'response_body'} key Body slot to replace.
   * @param {string} text Already decoded body text.
   * @param {string} mime Content type used to choose the redaction rules.
   * @param {{ text: string, redacted: boolean, truncated: boolean, reason?: string,
   *   replay_safe: boolean }} [retained] Pre-computed redaction result.
   * @returns {void}
   */
  saveBody(record, key, text, mime, retained) {
    if (/multipart\/form-data/i.test(mime)) { record.entry[key] = { state: 'omitted', reason: 'multipart' }; return; }
    const body = retained ?? redactBody(text, mime);
    this.retainedChars -= (record.entry[key].text && record.entry[key].text.length) || 0;
    record.entry[key] = {
      state: body.reason ? 'omitted' : body.truncated ? 'truncated' : body.text.length ? 'available' : 'empty',
      text: body.text,
      chars: body.text.length,
      redacted: body.redacted,
      replay_safe: body.replay_safe,
      ...(body.reason ? { reason: body.reason } : body.truncated ? { reason: 'body_limit' } : {}),
    };
    this.retainedChars += body.text.length;
    this.retain?.(record.entry);
    for (const item of this.records()) {
      if (this.retainedChars <= MAX_BODY_CHARS) break;
      for (const part of ['request_body', 'response_body']) {
        const length = (item.entry[part].text && item.entry[part].text.length) || 0;
        if (!length) continue;
        this.retainedChars -= length;
        item.entry[part] = { state: 'evicted', reason: 'memory_limit' };
        item.entry.sequence = this.changed();
      }
    }
  }

  /**
   * Drop a request from tracking while keeping its evidence: bodies become
   * `evicted`, headers are removed and the chain is marked partial if needed.
   *
   * @param {RequestRecord} record
   * @returns {void}
   */
  evict(record) {
    this.retain?.(record.entry);
    this.dropped += 1;
    this.retainedChars -= ((record.entry.request_body.text && record.entry.request_body.text.length) || 0) + ((record.entry.response_body.text && record.entry.response_body.text.length) || 0);
    record.entry.request_body = { state: 'evicted' };
    record.entry.response_body = { state: 'evicted' };
    record.entry.request_headers = undefined;
    record.entry.response_headers = undefined;
    this.entries.delete(record.entry.id);
    this.inflight.delete(record.entry.id);
    const key = this.key(record.target, record.rawId);
    this.annotations.delete(key);
    const chain = this.chains.get(key);
    if (chain) {
      const index = chain.hops.indexOf(record);
      if (index >= 0) {
        chain.hops.splice(index, 1);
        if (chain.requestIndex <= index || chain.responseIndex <= index) {
          chain.partial = true;
          this.pendingHeaders -= chain.requestHeaders.length + chain.responseHeaders.length;
          chain.requestHeaders.length = 0;
          chain.responseHeaders.length = 0;
          for (const hop of chain.hops) incompleteMetadata(hop.entry);
        }
        if (chain.requestIndex > index) chain.requestIndex -= 1;
        if (chain.responseIndex > index) chain.responseIndex -= 1;
      }
      if (!chain.hops.length) {
        this.pendingHeaders -= chain.requestHeaders.length + chain.responseHeaders.length;
        this.chains.delete(key);
      }
    }
  }

  /**
   * @param {RequestRecord} record
   * @returns {void} Releases an inflight record once it no longer needs tracking.
   */
  releaseFinished(record) {
    if (this.inflight.has(record.entry.id) && !this.unsettled(record)) this.evict(record);
  }

  /**
   * Record a pre-declared control decision for a request that may not have been
   * reported yet; annotations are applied when the request is first seen.
   *
   * @param {{ sessionId?: string }} source
   * @param {string} rawId Browser request id.
   * @param {ControlAnnotation} annotation
   * @returns {void}
   */
  annotate(source, rawId, annotation) {
    const key = this.key(source, rawId);
    let requestBody;
    let responseBody;
    let responseHeaders;
    let urlState;
    const headers = redactHeaderEvidence(annotation.effective && annotation.effective.headers);
    if (annotation.effective) {
      const value = annotation.effective;
      const url = redactRequestUrl(value.url);
      urlState = url.state;
      if (value.postData !== undefined) requestBody = redactBody(value.postData, value.headers['content-type'] ?? '');
      annotation = { ...annotation, effective: { ...value, url: url.text, headers: headers.headers, ...(value.postData === undefined ? {} : { postData: requestBody.text }) } };
    }
    if (annotation.mock) {
      const value = annotation.mock;
      responseHeaders = redactHeaderEvidence(value.headers);
      responseBody = redactBody(value.body, (value.headers && value.headers['content-type']) ?? '');
      annotation = { ...annotation, mock: { ...value, headers: responseHeaders.headers, body: responseBody.text } };
    }
    this.annotations.set(key, { value: annotation, requestBody, responseBody, responseHeaders, headersTruncated: headers.truncated, urlState });
    while (this.annotations.size > 64) this.annotations.delete(this.annotations.keys().next().value);
    const record = this.chains.get(key)?.hops[this.chains.get(key).hops.length - 1];
    if (record) this.applyAnnotation(key, record);
  }

  /**
   * Merge a stored annotation into the given hop and recompute its truncation
   * flags from the redacted URL and header evidence.
   *
   * @param {string} key Chain key.
   * @param {RequestRecord} record Hop that received the annotation.
   * @returns {void}
   */
  applyAnnotation(key, record) {
    const retained = this.annotations.get(key);
    if (!retained) return;
    this.annotations.delete(key);
    const { effective, mock, ...metadata } = retained.value;
    Object.assign(record.entry, metadata);
    if (effective) {
      if (retained.headersTruncated) incompleteMetadata(record.entry);
      record.entry.url = effective.url;
      record.entry.integrity.url = retained.urlState;
      record.entry.truncated = record.entry.integrity.metadata === 'truncated' || record.entry.integrity.response_headers === 'truncated' || retained.urlState === 'truncated';
      record.entry.method = effective.method;
      record.entry.request_headers = effective.headers;
      if (effective.postData !== undefined) this.saveBody(record, 'request_body', effective.postData, effective.headers['content-type'] ?? '', retained.requestBody);
    }
    if (mock) {
      record.entry.status = mock.status;
      setResponseHeaders(record.entry, retained.responseHeaders);
      record.entry.mime_type = (mock.headers && mock.headers['content-type']) ?? 'text/plain';
      this.saveBody(record, 'response_body', mock.body, record.entry.mime_type, retained.responseBody);
    }
    record.entry.sequence = this.changed();
    this.retain?.(record.entry);
  }

  /**
   * Retention checkpoint: offer every tracked entry to the retention sink again.
   * @returns {void}
   */
  checkpoint() { for (const { entry } of this.records()) this.retain?.(entry); }
  /** @returns {DebugRequest[]} Every tracked entry, unsettled requests first. */
  list() { return Array.from(this.records(), (record) => record.entry); }
  /**
   * @param {string} id Retained entry id.
   * @returns {DebugRequest | undefined} Entry, or undefined when not tracked.
   */
  get(id) { return (this.entries.get(id) ?? this.inflight.get(id))?.entry; }

  /**
   * Mark still-pending requests of a detached target as interrupted; their
   * response bodies can no longer be read.
   *
   * @param {string} sessionId
   * @returns {void}
   */
  detachTarget(sessionId) {
    for (const record of this.records()) {
      const { entry, target } = record;
      if (target.sessionId !== sessionId || entry.state !== 'pending') continue;
      entry.state = 'interrupted';
      entry.error = 'frame_detached';
      entry.finished_at = this.now();
      entry.response_body = { state: 'unavailable', reason: 'frame_detached' };
      entry.sequence = this.changed();
      this.retain?.(entry);
      this.releaseFinished(record);
    }
  }

  /**
   * Stop accepting events, discard queued work and finalize unfinished entries so
   * nothing is reported as still in flight.
   *
   * @param {string} reason Stop reason recorded on interrupted requests.
   * @returns {void}
   */
  stop(reason) {
    this.accepting = false;
    this.alive = false;
    this.queue.length = 0;
    this.chains.clear();
    this.annotations.clear();
    this.pendingHeaders = 0;
    for (const record of this.records()) {
      const { entry } = record;
      if (entry.state === 'pending') {
        entry.state = 'interrupted';
        entry.error = reason;
        entry.finished_at = this.now();
      }
      if (entry.response_body.state === 'pending') entry.response_body = { state: 'unavailable', reason: 'capture_stopped' };
      entry.sequence = this.changed();
      this.retain?.(entry);
      this.releaseFinished(record);
    }
  }
}

/**
 * Slice retained body text without splitting a Unicode character.
 *
 * @param {DebugBody} body Retained body.
 * @param {number} offset UTF-16 offset to start at.
 * @param {number} maxChars Maximum characters to return.
 * @param {string} [pointer] JSON pointer applied to a complete body first.
 * @returns {DebugBody} Body copy with the slice, its original length and a
 *   continuation offset when more text remains.
 * Throws when the offset splits a character, the slice cannot hold one complete
 * character, or the pointer is used on an incomplete body.
 */
export function bodySlice(body, offset, maxChars, pointer) {
  if (body.text === undefined) return { ...body };
  let text = body.text;
  if (pointer !== undefined) {
    if (body.state !== 'available' && body.state !== 'empty') throw new Error('JSON pointer requires a complete body');
    text = jsonPointer(text, pointer);
  }
  const splits = (at) => /[\uD800-\uDBFF]/.test(text.charAt(at - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(at));
  if (splits(offset)) throw new Error('offset splits a Unicode character; use next_offset');
  let end = Math.min(text.length, offset + maxChars);
  if (splits(end)) end -= 1;
  if (end === offset && offset < text.length) throw new Error('max_chars too small for a complete Unicode character');
  return { ...body, text: text.slice(offset, end), chars: text.length, offset, ...(end < text.length ? { next_offset: end } : {}) };
}

/**
 * Build the detail projection for one request: metadata never carries body text,
 * and body parts are added only for the requested part.
 *
 * @param {DebugRequest} entry
 * @param {'metadata' | 'request' | 'response' | 'headers' | 'timing'} [part]
 * @param {number} [offset] Body offset for `request`/`response`.
 * @param {number} [maxChars] Body slice size for `request`/`response`.
 * @param {string} [pointer] JSON pointer applied to a complete body.
 * @returns {DebugRequest} Projected request.
 */
export function requestProjection(entry, part = 'metadata', offset = 0, maxChars = 4096, pointer) {
  return {
    ...requestMetadata(entry),
    ...(part === 'request' ? { request_body: bodySlice(entry.request_body, offset, maxChars, pointer) } : {}),
    ...(part === 'response' ? { response_body: bodySlice(entry.response_body, offset, maxChars, pointer) } : {}),
    ...(part === 'headers' ? { request_headers: entry.request_headers, response_headers: entry.response_headers } : {}),
    ...(part === 'timing' ? { timing: entry.timing } : {}),
  };
}
