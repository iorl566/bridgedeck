// src/browser-driver/cdp-network.js —— network 缓冲、请求元数据与投影（ChromiumCdp mixin）。
import { appendBounded, readBufferedEntries, truncateOptional, truncateText } from './cdp-buffer-utils.js';

const MAX_NETWORK_BUFFER = 200;
const MAX_NETWORK_FIELD_LENGTH = 4096;
const MAX_NETWORK_REQUEST_META = 1024;

export class CdpNetworkMethods {
  /**
   * Track the network request lifecycle for a tab.
   * @returns {void}
   */
  bindNetworkHandler() {
    if (this.networkSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      switch (method) {
        case 'Network.requestWillBeSent':
          this.rememberNetworkRequest(tabId, params);
          break;
        case 'Network.responseReceived':
          this.appendNetwork(tabId, parseNetworkResponse(this.getNetworkRequest(tabId, params), params));
          break;
        case 'Network.loadingFailed':
          this.appendNetwork(tabId, parseNetworkFailure(this.getNetworkRequest(tabId, params, true), params));
          break;
        case 'Network.loadingFinished':
          this.getNetworkRequest(tabId, params, true);
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.networkSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }

  /**
   * Ensure the network capture domains are enabled for this tab.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async ensureNetworkCapture(tabId) {
    if (!this.attachedTabs.has(tabId)) await this.ensureAttached(tabId);
    await this.enableNetworkDomain(tabId);
  }
  /**
   * Enable network events once per tab on the current attachment.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async enableNetworkDomain(tabId) {
    if (this.networkDomainsEnabledTabs.has(tabId)) return;
    await this.command({ tabId }, 'Network.enable', {});
    this.networkDomainsEnabledTabs.add(tabId);
  }
  /**
   * Network entries observed on `tabId`, bounded for agent context safety.
   * @param {number} tabId
   * @param {number} [since] Cursor from the previous read; omit for the newest entries.
   * @param {number} limit Maximum entries to return.
   * @param {number} maxTextChars Budget for each text field.
   * @returns {NetworkResult}
   */
  networkEntriesSince(tabId, since, limit, maxTextChars) {
    const buffer = this.networkBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(buffer, this.networkSequences.get(tabId) ?? 0, since, limit, (entry) => projectNetworkEntry(entry, maxTextChars));
    return { tab_id: tabId, entries, next_since: nextSince, truncated };
  }
  /**
   * Append one parsed outcome to the bounded per-tab network buffer.
   * @param {number} tabId
   * @param {ParsedNetworkEntry | null} entry Ignored when null.
   */
  appendNetwork(tabId, entry) {
    if (!entry) return;
    const sequence = (this.networkSequences.get(tabId) ?? 0) + 1;
    this.networkSequences.set(tabId, sequence);
    appendBounded(this.networkBuffers, tabId, { ...entry, sequence }, MAX_NETWORK_BUFFER);
  }
  /**
   * Remember request metadata so responses and failures can be attributed.
   * @param {number} tabId
   * @param {object} params Raw `Network.requestWillBeSent` payload.
   */
  rememberNetworkRequest(tabId, params) {
    const raw = params ?? {};
    const id = typeof raw.requestId === 'string' ? raw.requestId : undefined;
    const request = raw.request ?? {};
    if (!id || typeof request.url !== 'string') return;
    const url = truncateText(request.url, MAX_NETWORK_FIELD_LENGTH);
    const method = truncateOptional(request.method, MAX_NETWORK_FIELD_LENGTH);
    const resourceType = truncateOptional(raw.type, MAX_NETWORK_FIELD_LENGTH);
    const meta = this.networkRequestMeta.get(tabId) ?? new Map();
    meta.delete(id);
    meta.set(id, { url: url.text, method: method?.text, resourceType: resourceType?.text, truncated: url.truncated || (method?.truncated ?? false) || (resourceType?.truncated ?? false) });
    while (meta.size > MAX_NETWORK_REQUEST_META) {
      const oldest = meta.keys().next().value;
      if (oldest === undefined) break;
      meta.delete(oldest);
    }
    this.networkRequestMeta.set(tabId, meta);
  }
  /**
   * Keep metadata through response headers; consume it only when loading ends.
   * @param {number} tabId
   * @param {object} params Raw `Network.responseReceived` or `Network.loadingFailed` payload.
   * @param {boolean} [finished] Drop the entry once loading is over.
   * @returns {NetworkRequestMeta | undefined}
   */
  getNetworkRequest(tabId, params, finished = false) {
    const id = typeof (params ?? {}).requestId === 'string' ? params.requestId : undefined;
    if (!id) return undefined;
    const meta = this.networkRequestMeta.get(tabId);
    const info = meta?.get(id);
    if (finished) meta?.delete(id);
    if (meta?.size === 0) this.networkRequestMeta.delete(tabId);
    return info;
  }
  /**
   * Drop buffered network entries, request metadata and the enabled-domain
   * mark for a tab.
   * @param {number} tabId
   */
  clearNetworkState(tabId) {
    this.networkBuffers.delete(tabId);
    this.networkSequences.delete(tabId);
    this.networkDomainsEnabledTabs.delete(tabId);
    this.networkRequestMeta.delete(tabId);
  }
}

/**
 * Build one network entry, bounding every optional text field.
 * @param {ParsedNetworkEntry} input
 * @returns {NetworkEntry}
 */
function makeNetworkEntry(input) {
  const projectedMethod = truncateOptional(input.method, MAX_NETWORK_FIELD_LENGTH);
  const projectedUrl = truncateOptional(input.url, MAX_NETWORK_FIELD_LENGTH);
  const projectedStatusText = truncateOptional(input.status_text, MAX_NETWORK_FIELD_LENGTH);
  const projectedMimeType = truncateOptional(input.mime_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedResourceType = truncateOptional(input.resource_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedError = input.error_text !== undefined ? truncateText(input.error_text, MAX_NETWORK_FIELD_LENGTH) : undefined;
  return {
    kind: input.kind,
    method: projectedMethod?.text,
    url: projectedUrl?.text,
    status: input.status,
    status_text: projectedStatusText?.text,
    mime_type: projectedMimeType?.text,
    resource_type: projectedResourceType?.text,
    error_text: projectedError?.text,
    timestamp: input.timestamp,
    truncated: input.truncated === true || (projectedMethod?.truncated ?? false) || (projectedUrl?.truncated ?? false) || (projectedStatusText?.truncated ?? false) || (projectedMimeType?.truncated ?? false) || (projectedResourceType?.truncated ?? false) || (projectedError?.truncated ?? false),
  };
}
/**
 * Turn a `Network.responseReceived` payload into a stored entry, attributing
 * it with the metadata remembered for the same request id.
 * @param {NetworkRequestMeta | undefined} info
 * @param {object} params
 * @returns {ParsedNetworkEntry | null} Null when no URL is known.
 */
function parseNetworkResponse(info, params) {
  const raw = params ?? {};
  const response = raw.response ?? {};
  const url = typeof response.url === 'string' ? response.url : info?.url;
  if (!url) return null;
  return makeNetworkEntry({
    kind: 'response',
    method: info?.method,
    url,
    status: typeof response.status === 'number' ? response.status : undefined,
    status_text: typeof response.statusText === 'string' ? response.statusText : undefined,
    mime_type: typeof response.mimeType === 'string' ? response.mimeType : undefined,
    resource_type: typeof raw.type === 'string' ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}
/**
 * Turn a `Network.loadingFailed` payload into a stored entry.
 * @param {NetworkRequestMeta | undefined} info
 * @param {object} params
 * @returns {ParsedNetworkEntry}
 */
function parseNetworkFailure(info, params) {
  const raw = params ?? {};
  return makeNetworkEntry({
    kind: 'failure',
    method: info?.method,
    url: info?.url,
    error_text: typeof raw.errorText === 'string' ? raw.errorText : undefined,
    resource_type: typeof raw.type === 'string' ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}
/**
 * Project a stored network entry against the read's text budget.
 * @param {NetworkEntry} entry
 * @param {number} maxTextChars
 * @returns {NetworkEntry}
 */
function projectNetworkEntry(entry, maxTextChars) {
  const projectedUrl = truncateOptional(entry.url, maxTextChars);
  const projectedError = entry.error_text !== undefined ? truncateText(entry.error_text, maxTextChars) : undefined;
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    method: entry.method,
    url: projectedUrl?.text,
    status: entry.status,
    status_text: entry.status_text,
    mime_type: entry.mime_type,
    resource_type: entry.resource_type,
    error_text: projectedError?.text,
    timestamp: entry.timestamp,
    truncated: entry.truncated || (projectedUrl?.truncated ?? false) || (projectedError?.truncated ?? false),
  };
}
