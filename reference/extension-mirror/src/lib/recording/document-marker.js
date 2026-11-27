import { RECORD_DOCUMENT_ATTRIBUTE, recordingDocumentMarkerValue } from '../../shared/recording-document-identity.js';

/**
 * Document marker that lets frames identify the same recorded page.
 *
 * @typedef {object} RecordingDocumentMarker
 * @property {() => void} ensure
 * @property {() => void} restore
 */

/**
 * @param {Document} [doc]
 * @returns {Promise<HTMLElement>}
 */
export function waitForDocumentElement(doc = globalThis.document) {
  if (doc.documentElement) return Promise.resolve(doc.documentElement);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!doc.documentElement) return;
      observer.disconnect();
      resolve(doc.documentElement);
    });
    observer.observe(doc, { childList: true });
  });
}

/**
 * @param {string} producerId
 * @param {HTMLElement} [root]
 * @returns {RecordingDocumentMarker}
 */
export function markRecordingDocument(producerId, root = globalThis.document?.documentElement) {
  if (!root) throw new TypeError('recording document root is unavailable');
  const previous = root.getAttribute(RECORD_DOCUMENT_ATTRIBUTE);
  const markerValue = recordingDocumentMarkerValue(producerId);
  const ensure = () => root.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, markerValue);
  ensure();
  return {
    ensure,
    restore() {
      if (root.getAttribute(RECORD_DOCUMENT_ATTRIBUTE) !== markerValue) return;
      if (previous === null) root.removeAttribute(RECORD_DOCUMENT_ATTRIBUTE);
      else root.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, previous);
    },
  };
}
