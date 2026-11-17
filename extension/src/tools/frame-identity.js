/**
 * Canonical browser frame identity for one tab.
 *
 * `chrome.scripting` returns results keyed by the browser frame id, while some
 * page-side snapshots carry a different id after a frame is recreated. This
 * module is the single place that maps snapshots back to
 * `{ frameId, documentId, parentFrameId, url }` so refs and record events use
 * the same identity. It is intentionally pure except for one chrome lookup.
 */

export function normalizeFrameUrl(value) {
  try {
    return new URL(String(value || '')).href;
  } catch {
    return String(value || '');
  }
}

/**
 * Pick the browser frame that owns a page-side result.
 * URL is the only stable field available from both sides; when several frames
 * share a URL, prefer the one whose parent and document also match.
 * @param {Array<{frameId:number,parentFrameId?:number,url?:string,documentId?:string}>} browserFrames
 * @param {{frameId?:number,parentFrameId?:number,url?:string,documentId?:string}} snapshot
 */
export function matchBrowserFrame(browserFrames, snapshot = {}) {
  const byId = browserFrames.find((frame) => Number(frame.frameId) === Number(snapshot.frameId) && Number.isInteger(Number(snapshot.frameId)));
  if (byId) return byId;
  const url = normalizeFrameUrl(snapshot.url);
  const candidates = browserFrames.filter((frame) => normalizeFrameUrl(frame.url) === url);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const sameDocument = candidates.find((frame) => frame.documentId && frame.documentId === snapshot.documentId);
  if (sameDocument) return sameDocument;
  const sameParent = candidates.find((frame) => Number(frame.parentFrameId) === Number(snapshot.parentFrameId));
  return sameParent || candidates[0];
}

/** @param {number} tabId */
export async function readBrowserFrames(tabId) {
  if (!chrome || !chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== 'function') return [];
  try {
    const list = await chrome.webNavigation.getAllFrames({ tabId: Number(tabId) });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
