/**
 * Readable audit timeline rows built from the append-only event stream.
 *
 * The audit log stores raw events in append order. The viewer wants one row per
 * operation plus one row per standalone marker, with the context events folded
 * into the operation row they belong to. This module owns that projection so
 * the rendering layer never has to know which event kinds are structural.
 *
 * @typedef {object} AuditStep
 * @property {string} id  Operation id, or a synthetic `event-<index>` for markers.
 * @property {number} at  Epoch milliseconds of the row's first event.
 * @property {string} kind  `operation` for folded calls, otherwise the marker kind.
 * @property {Record<string, unknown>} data  Merged start and context payloads.
 * @property {Record<string, unknown>} [result]  Finish payload, once the operation ended.
 * @property {boolean} [interrupted]  Set when the run paused or ended before the call finished.
 *
 * @typedef {object} AuditEvent
 * @property {number} at
 * @property {string} kind
 * @property {string} [operation_id]
 * @property {Record<string, unknown>} data
 */

/**
 * Fold append-only events into readable steps without losing repeated calls.
 *
 * Every `operation_started` event produces exactly one row, even when the same
 * operation id appears again later; the map only tracks the most recent step so
 * that late context/finish events attach to the newest incarnation. Events that
 * are not part of an operation are appended in stream order, except `named`
 * events, which the viewer renders separately and therefore are skipped here.
 *
 * A `paused`/`ended` marker retroactively flags every unfinished operation row as
 * interrupted, because the run stopped before those calls reported back.
 *
 * @param {AuditEvent[]} events  Events in append order, as returned by the audit API.
 * @returns {AuditStep[]} Render-ready rows in timeline order.
 */
export function auditTimeline(events) {
  const rows = [];
  /** Latest operation row per id, used to attach context and finish events. */
  const operations = new Map();
  for (const [index, event] of events.entries()) {
    if (event.kind === 'operation_started' && event.operation_id) {
      const step = { id: event.operation_id, at: event.at, kind: 'operation', data: { ...event.data } };
      rows.push(step);
      operations.set(event.operation_id, step);
    } else if (event.kind === 'context' && event.operation_id) {
      const step = operations.get(event.operation_id);
      if (step) step.data = { ...step.data, ...event.data };
    } else if (event.kind === 'operation_finished' && event.operation_id) {
      const step = operations.get(event.operation_id);
      if (step) step.result = event.data;
    } else if (event.kind !== 'named') {
      if (['paused', 'ended'].includes(event.kind)) {
        for (const step of operations.values()) if (!step.result) step.interrupted = true;
      }
      rows.push({ id: `event-${index}`, at: event.at, kind: event.kind, data: event.data });
    }
  }
  return rows;
}

/**
 * Derive the display status for one timeline row.
 *
 * A finished operation reports whatever status its result carried. Otherwise the
 * row is only considered running while the whole run is still running, the row
 * was not marked interrupted, and — when a pending-operation list is supplied —
 * the operation is actually in that list. Everything else is `unknown`, which
 * the viewer renders as a neutral badge instead of a live one.
 *
 * @param {AuditStep} step  Row produced by {@link auditTimeline}.
 * @param {{ status: string }} run  Run header the row belongs to.
 * @param {string[]} [pending]  Operations still believed to be in flight.
 * @returns {string} `running`, `unknown`, or the finished operation's own status.
 */
export function auditStepStatus(step, run, pending) {
  if (typeof step.result?.status === 'string') return step.result.status;
  return run.status === 'running' && !step.interrupted && (pending === undefined || pending.includes(step.id)) ? 'running' : 'unknown';
}
