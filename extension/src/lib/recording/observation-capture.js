function nodeKey(frameId, backendNodeId) { return `${frameId}:${backendNodeId}`; }
function frameTagKey(frameId, tag) { return `${frameId}:${tag.toLowerCase()}`; }

/**
 * Observation index and capture used by recording.
 *
 * @typedef {object} IndexedObservationNode
 * @property {string} frameId
 * @property {object} geometry
 * @property {object} [ref]
 *
 * @typedef {object} RecordingDocumentScope
 * @property {string} frameId
 * @property {object} target
 *
 * @typedef {object} CapturedRecordingObservation
 * @property {string} rootFrameId
 * @property {ObservationNodeIndex} index
 * @property {string} url
 * @property {string} [title]
 * @property {string} vomText
 * @property {boolean} truncated
 */

export class ObservationNodeIndex {
  /** @param {object} input */
  constructor(input) {
    this.nodesByFrameTag = new Map();
    this.refById = new Map();
    this.refsByFrame = new Map();
    this.scopeByProducer = new Map();
    const refByNode = new Map();
    for (const ref of input.refs) {
      const frameId = ref.frameId ?? input.rootFrameId;
      refByNode.set(nodeKey(frameId, ref.backendNodeId), ref);
      this.refById.set(ref.ref, ref);
      const frameRefs = this.refsByFrame.get(frameId) ?? [];
      frameRefs.push(ref);
      this.refsByFrame.set(frameId, frameRefs);
    }
    for (const frame of input.frames ?? []) {
      const documentId = frame.recordingDocumentId;
      if (!documentId) continue;
      this.scopeByProducer.set(documentId, this.scopeByProducer.has(documentId) ? null : { frameId: frame.frameId, target: frame.target });
    }
    for (const geometry of input.matchNodes) {
      const { frameId } = geometry;
      const entry = { frameId, geometry, ref: refByNode.get(nodeKey(frameId, geometry.backendNodeId)) };
      const key = frameTagKey(frameId, geometry.tag);
      const bucket = this.nodesByFrameTag.get(key) ?? [];
      bucket.push(entry);
      this.nodesByFrameTag.set(key, bucket);
    }
  }

  /**
   * @param {string} frameId
   * @param {string} tag
   * @returns {readonly IndexedObservationNode[]}
   */
  candidates(frameId, tag) { return this.nodesByFrameTag.get(frameTagKey(frameId, tag)) ?? []; }
  /**
   * @param {string} refId
   * @returns {object | undefined}
   */
  ref(refId) { return this.refById.get(refId); }
  /**
   * @param {string} frameId
   * @returns {readonly object[]}
   */
  refs(frameId) { return this.refsByFrame.get(frameId) ?? []; }
  /**
   * @param {string} producerId
   * @returns {RecordingDocumentScope | undefined}
   */
  documentScope(producerId) { return this.scopeByProducer.get(producerId) ?? undefined; }
}

/**
 * @param {object} tabsApi
 * @param {number} tabId
 * @returns {Promise<{ url: string, title?: string }>}
 */
async function readTabMeta(tabsApi, tabId) {
  try {
    const tab = await tabsApi.get(tabId);
    return { url: tab.url ?? 'about:blank', title: tab.title };
  } catch {
    return { url: 'about:blank' };
  }
}

/**
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<CapturedRecordingObservation>}
 */
export async function captureRecordingObservation(input, deps = {}) {
  const { url, title } = await readTabMeta(input.tabsApi, input.tabId);
  const captured = await deps.captureVom(input.cdp, input.tabId, url, {
    maxTokens: input.maxTokens,
    redactValues: input.redactValues,
    conditionalSurfaceProbe: false,
    signal: input.signal,
  });
  return {
    rootFrameId: captured.rootFrameId,
    index: new ObservationNodeIndex(captured),
    url,
    title,
    vomText: captured.text,
    truncated: captured.truncated,
  };
}
