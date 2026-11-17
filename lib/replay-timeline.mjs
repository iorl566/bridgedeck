/**
 * Replay-safe timeline: an event is only replayable inside the same document
 * and revision window. Navigation/frame rebuild/ref replacement are hard
 * boundaries; do not guess a replacement target.
 */
export function makeBoundary(identity = {}) {
  return Object.freeze({
    documentId: identity.documentId || null,
    frameId: Number.isInteger(identity.frameId) ? identity.frameId : 0,
    revision: Number.isInteger(identity.revision) ? identity.revision : null,
  });
}

export function canReplay(event, current) {
  if (!event || !current) return { ok: false, reason: 'missing-boundary' };
  const before = event.boundary || event;
  if (!before.documentId || !current.documentId || before.documentId !== current.documentId) {
    return { ok: false, reason: 'document-changed' };
  }
  if (Number(before.frameId || 0) !== Number(current.frameId || 0)) {
    return { ok: false, reason: 'frame-changed' };
  }
  if (Number.isInteger(before.revision) && Number.isInteger(current.revision) && before.revision !== current.revision) {
    return { ok: false, reason: 'revision-changed' };
  }
  return { ok: true, reason: 'same-window' };
}
