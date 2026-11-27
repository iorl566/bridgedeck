/**
 * Advertised debug contract for transport clients and the extension UI.
 *
 * A capabilities reply is static for one runtime: it lists the actions the
 * debug transport accepts, the numeric bounds applied to paging and output
 * projections, and the semantics a caller must respect when reading retained
 * evidence. It describes limits, never current data, so a client can cache it
 * for the lifetime of a connection.
 *
 * Persistent installs add the pin actions; transient runtimes omit them because
 * evidence cannot be pinned without durable storage.
 */
import { HISTORY_AGE_MS, HISTORY_BYTES, HISTORY_LIMIT } from './archive.js';
import { JOURNAL_BYTES, JOURNAL_PINS, JOURNAL_REQUESTS } from './journal.js';
import { DEBUG_FIELDS, QUERY_LIMITS } from './query.js';

export { DEBUG_FIELDS, QUERY_LIMITS };

/**
 * Document returned by the `capabilities` action.
 *
 * Every member is static for one runtime, so a client may cache the document for
 * the lifetime of a connection. It reports accepted actions and the limits
 * applied to them, never current runs or retained requests. Integers are
 * inclusive bounds unless a nested description says otherwise.
 *
 * @typedef {object} DebugCapabilities
 * @property {1} schema_version Version of this document's shape.
 * @property {{ version: string, build: string }} extension Identity of the
 *   runtime that produced the document.
 * @property {string[]} actions Accepted action names, in advertised order;
 *   persistent runtimes include the pin actions, transient ones omit them.
 * @property {object} parameters Accepted paging, filtering and projection
 *   options, shared by every read action.
 * @property {{ limit: { min: number, max: number, default: number },
 *   max_chars: { min: number, max: number, default: number },
 *   offset: { min: number, max: number },
 *   budget: { min: number, max: number, default: number },
 *   since: { min: number, semantics: string } }} parameters.paging Paging and
 *   byte-budget bounds; `since` is an incremental sequence, not a timestamp.
 * @property {{ actions: string[], url: string, method: string,
 *   resource_type: string, status: string, state: string[], kind: string[] }} parameters.filters
 *   Accepted filter names and their matching semantics.
 * @property {{ actions: string[], optional: string[], always: string[],
 *   detail: string }} parameters.fields Per-field projection rules; large
 *   fields are read through `part`.
 * @property {{ budget_unit: string, export_exempt: boolean, omissions: string,
 *   inline_urls: string }} output Output budget, whether exports are exempt
 *   from it, and how omissions and inline data are reported.
 * @property {{ persistent: boolean, request_limit: number, request_bytes: number,
 *   pin_limit: number, history_count: number, history_bytes: number,
 *   history_age_ms: number, scope: string, overflow: string }} storage Retention
 *   bounds for one capture and for finished history.
 * @property {{ default_kind: string, default_include_controlled: boolean,
 *   slow_ms: { default: number, min: number, max: number },
 *   window_ms: { default: number, min: number, max: number },
 *   reference_limit: number, scope: string, pagination: string }} analysis
 *   Analysis defaults and the meaning of its pagination.
 * @property {{ metrics: string[], scope: string, record_limit: number,
 *   long_task_limit: number, visibility_limit: number, validity: string }} performance
 *   Captured performance metrics and their retention limits.
 * @property {{ capture_required: boolean, rule_limit: number, replay_limit: number,
 *   replay_same_origin: boolean, replay_requires_key: boolean,
 *   url_max_chars: number, retained_url_max_chars: number, replay_fidelity: string }} network_controls
 *   Request control limits and the evidence required for a faithful replay.
 * @property {string[]} unsupported Capabilities this runtime deliberately omits.
 */

/** Every action the debug transport accepts, in advertised order. */
export const DEBUG_ACTIONS = [
  'performance', 'aggregate', 'duplicates', 'start', 'stop', 'status', 'requests', 'request',
  'operations', 'operation', 'console', 'pages', 'export', 'rules', 'rule_add', 'rule_enable',
  'rule_disable', 'rule_remove', 'replay', 'capabilities', 'pin', 'unpin',
];

/**
 * Build the capability document for one runtime.
 *
 * @param {boolean} [persistent] Whether evidence survives a worker restart.
 * @param {{ version?: string, build?: string }} [identity] Extension identity.
 * @returns {DebugCapabilities} Capability document with stable top-level keys.
 */
export function debugCapabilities(persistent = true, { version = 'unknown', build = 'unknown' } = {}) {
  return {
    schema_version: 1,
    extension: { version, build },
    actions: DEBUG_ACTIONS.filter((action) => persistent || !['pin', 'unpin'].includes(action)),
    parameters: {
      ...QUERY_LIMITS,
      since: { min: 0, semantics: 'incremental sequence; merge updates by id' },
      filters: {
        actions: ['requests', 'aggregate', 'duplicates'],
        url: 'case-sensitive substring of retained URL',
        method: 'exact HTTP method',
        resource_type: 'exact CDP resource type',
        status: 'exact HTTP status (100..599)',
        state: ['pending', 'complete', 'failed', 'redirected', 'interrupted'],
        kind: ['all', 'business', 'resource', 'extension'],
      },
      fields: {
        actions: ['requests', 'request'],
        optional: DEBUG_FIELDS,
        always: [
          'id', 'run_id', 'sequence', 'started_at', 'method', 'url', 'integrity', 'state',
          'request_body', 'response_body', 'truncated', 'intervention', 'replay_from', 'replay_id', 'pinned',
        ],
        detail: 'Use part=request/response/headers/timing for large fields',
      },
    },
    output: {
      budget_unit: 'UTF-8 JSON bytes',
      export_exempt: true,
      omissions: 'output.omitted lists omitted sections; stored evidence is unchanged',
      inline_urls: 'data URLs use a compact descriptor',
    },
    storage: {
      persistent,
      request_limit: JOURNAL_REQUESTS,
      request_bytes: JOURNAL_BYTES,
      pin_limit: JOURNAL_PINS,
      history_count: HISTORY_LIMIT,
      history_bytes: HISTORY_BYTES,
      history_age_ms: HISTORY_AGE_MS,
      scope: 'owning task only; browser history is available through extension UI',
      overflow: 'old low-priority unpinned requests evicted first; reported by run.storage.dropped',
    },
    analysis: {
      default_kind: 'business',
      default_include_controlled: false,
      slow_ms: { default: 1000, min: 0, max: 60000 },
      window_ms: { default: 1000, min: 100, max: 10000 },
      reference_limit: 50,
      scope: 'retained requests only; suspected duplicates are not defects',
      pagination: 'offset/next_offset; restart pagination when recording changes',
    },
    performance: {
      metrics: ['ttfb_ms', 'dom_content_loaded_ms', 'load_ms', 'fcp_ms', 'lcp_ms', 'cls', 'long_task_count', 'long_task_total_ms', 'long_task_max_ms'],
      scope: 'main frame; per document/visit',
      record_limit: 20,
      long_task_limit: 50,
      visibility_limit: 64,
      validity: 'inspect metric.state and reasons; provisional/partial values are not final Core Web Vitals',
    },
    network_controls: {
      capture_required: true,
      rule_limit: 32,
      replay_limit: 20,
      replay_same_origin: true,
      replay_requires_key: true,
      url_max_chars: 16384,
      retained_url_max_chars: 2048,
      replay_fidelity: 'Reuse requires integrity.url=complete, complete metadata and request_body.replay_safe=true. Replace changed, missing or legacy URL/body explicitly; redacted placeholders are rejected.',
    },
    unsupported: [
      'cpu_profiling', 'inp', 'iframe_vitals', 'soft_navigation_vitals', 'cross_origin_replay',
      'binary_request_editing', 'response_rewriting',
    ],
  };
}
