import { resolveDraftStartUrl } from './draft-policy.js';
import { reduceTraceStepsV3 } from './trace-reducer-v3.js';
import { formatTraceStateBody } from './trace-state-body.js';

/** Version of the trace envelope produced here. */
export const TRACE_VERSION_V3 = 3;
/** Version of the rendered observation format. */
export const VOM_FORMAT_VERSION = 1;

/**
 * @param {object} registry
 * @param {object[]} steps
 * @returns {object[]}
 */
function publishedEntries(registry, steps) {
  const entries = registry.values();
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set(steps.flatMap((step) => [step.state, step.result.state]));
  return entries.filter((entry) => referenced.has(entry.id));
}

/**
 * @param {number[]} draftIds
 * @param {Map<number, number>} stepIdByDraftId
 * @returns {number[]}
 */
function remapDraftIds(draftIds, stepIdByDraftId) {
  return [...new Set(draftIds.flatMap((id) => {
    const stepId = stepIdByDraftId.get(id);
    return stepId === undefined ? [] : [stepId];
  }))].sort((a, b) => a - b);
}

/**
 * @param {{ registry: object, drafts: object[], annotations?: object[], startedAt: string, purpose?: string, startUrl?: string, stoppedBy: string, bskVersion: string, redactValues?: boolean, includeTabSwitches?: boolean }} input
 * @returns {object}
 */
export function buildTraceV3(input) {
  const reduced = reduceTraceStepsV3(input.drafts, { includeTabSwitches: input.includeTabSwitches, redactValues: input.redactValues });
  const entries = publishedEntries(input.registry, reduced.steps);
  const publishedId = new Map(entries.map((entry, index) => [entry.id, `s${index + 1}`]));
  const annotationsByState = new Map();
  for (const annotation of input.annotations ?? []) {
    const bucket = annotationsByState.get(annotation.stateId) ?? [];
    bucket.push(annotation);
    annotationsByState.set(annotation.stateId, bucket);
  }
  const steps = reduced.steps.map((step) => ({
    ...step,
    state: publishedId.get(step.state) ?? step.state,
    result: { state: publishedId.get(step.result.state) ?? step.result.state },
  }));
  const states = entries.map((entry) => {
    const id = publishedId.get(entry.id) ?? entry.id;
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body: formatTraceStateBody({
        stateId: id,
        url: entry.url,
        title: entry.title,
        stepIds: remapDraftIds(entry.stepsHere, reduced.stepIdByDraftId),
        vomText: entry.vomText,
        annotations: annotationsByState.get(entry.id) ?? [],
        stepIdByDraftId: reduced.stepIdByDraftId,
      }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  });
  return {
    version: TRACE_VERSION_V3,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    stopped_by: input.stoppedBy,
    entry: { start_url: resolveDraftStartUrl(input.drafts, input.startUrl, states[0]?.url) },
    recorder: { bsk: input.bskVersion, vom: VOM_FORMAT_VERSION },
    states,
    steps,
  };
}
