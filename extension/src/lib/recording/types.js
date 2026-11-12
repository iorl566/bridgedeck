/**
 * Type-only module in the reference implementation. Runtime code consumes the
 * same object shapes without importing this file, so the mirror stays empty by
 * design. Draft, target, annotation and navigation shapes are documented in
 * CODE-LEARNINGS.md.
 */
/**
 * @typedef {object} TargetGeometry
 * @property {{ x: number, y: number, w: number, h: number }} rect
 * @property {string} tag
 *
 * @typedef {object} TargetMatchHint
 * @property {TargetGeometry} [geometry]
 * @property {string | null} [frameId]
 * @property {'top' | 'local'} [geometrySpace]
 *
 * @typedef {object} StepAnnotation
 * @property {number} draftId
 * @property {string} op
 * @property {number} line
 * @property {string} stateId
 * @property {string} [detail]
 *
 * @typedef {object} RecordingDraftStep
 * @property {string} op
 * @property {string} [pageUrl]
 * @property {string} [preStateId]
 * @property {string} [postStateId]
 * @property {object} [captureTarget]
 * @property {TargetMatchHint} [targetHint]
 * @property {object} [matchedTarget]
 * @property {string} [navigatedTo]
 * @property {string} [value]
 * @property {string} [key]
 * @property {Array<'alt' | 'ctrl' | 'meta' | 'shift'>} [modifiers]
 * @property {string[]} [values]
 * @property {string[]} [labels]
 * @property {string} [url]
 * @property {string} [cause]
 * @property {string} [transitionType]
 * @property {string[]} [transitionQualifiers]
 *
 * @typedef {RecordingDraftStep} TargetedRecordingDraft
 */

export {};
