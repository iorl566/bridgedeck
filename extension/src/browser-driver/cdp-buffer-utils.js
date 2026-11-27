// src/browser-driver/cdp-buffer-utils.js —— CDP console/network 缓冲区与文本截断（纯函数）。
/**
 * Push one entry into a per-tab buffer, dropping the oldest past the cap.
 * @param {Map<number, Array<object>>} buffers
 * @param {number} tabId
 * @param {object} entry
 * @param {number} maxEntries
 */
export function appendBounded(buffers, tabId, entry, maxEntries) {
  const buffer = buffers.get(tabId) ?? [];
  buffer.push(entry);
  while (buffer.length > maxEntries) buffer.shift();
  buffers.set(tabId, buffer);
}

/**
 * Select and project buffered entries for one read. Without a cursor the
 * newest entries are returned; with one the read advances from that sequence.
 * `truncated` reports dropped buffered entries, a clipped page, or a shortened
 * projection.
 * @param {Array<{ sequence: number, truncated?: boolean }>} buffer Oldest first.
 * @param {number} currentSequence Latest sequence assigned to this buffer.
 * @param {number} [since]
 * @param {number} limit
 * @param {(entry: any) => any} project
 * @returns {{ entries: any[], nextSince: number, truncated: boolean }}
 */
export function readBufferedEntries(buffer, currentSequence, since, limit, project) {
  const hasCursor = typeof since === 'number';
  const candidates = hasCursor ? buffer.filter((entry) => entry.sequence > since) : buffer;
  const limited = hasCursor ? candidates.slice(0, limit) : candidates.slice(-limit);
  const entries = limited.map(project);
  const oldestSequence = buffer[0]?.sequence ?? currentSequence + 1;
  const droppedEntries = currentSequence > buffer.length && (!hasCursor || (since ?? 0) < oldestSequence - 1);
  return {
    entries,
    nextSince: entries.at(-1)?.sequence ?? currentSequence,
    truncated: droppedEntries || candidates.length > limited.length || entries.some((entry) => entry.truncated),
  };
}

/**
 * Bound one string and report whether it was shortened.
 * @param {string} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(value, maxChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Bound an optional string, preserving `undefined`.
 * @param {string | undefined} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean } | undefined}
 */
export function truncateOptional(value, maxChars) {
  return value === undefined ? undefined : truncateText(value, maxChars);
}
