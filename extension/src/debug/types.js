/**
 * Type-only module mirroring the debug evidence contract: opt-in, task-owned
 * evidence whose timestamps are epoch milliseconds. Runtime code uses these
 * shapes structurally without importing this file.
 *
 * @typedef {'performance' | 'aggregate' | 'duplicates' | 'capabilities'
 *   | 'activity' | 'wait' | 'pin' | 'unpin' | 'start' | 'stop' | 'status'
 *   | 'requests' | 'request' | 'operations' | 'operation' | 'console'
 *   | 'pages' | 'export' | 'rules' | 'rule_add' | 'rule_enable'
 *   | 'rule_disable' | 'rule_remove' | 'replay'} DebugAction
 *
 * Action names are wire values, not display labels. A runtime advertises the
 * subset it accepts in its capability document; a caller must not assume that a
 * name declared here is available in every build.
 *
 *
 * @typedef {object} DebugRequestEdit
 * @property {string} [url]
 * @property {string} [method]
 * @property {Record<string, string | null>} [headers]
 * @property {string} [body]
 * @property {{ set?: Record<string, unknown>, remove?: string[], rename?: Record<string, string> }} [json]
 *
 * @typedef {object} DebugRuleSpec
 * @property {string} [name]
 * @property {{ url: string, method?: string, resource_type?: 'Fetch' | 'XHR' | 'Document' }} match
 * @property {{ type: 'block' }
 *   | ({ type: 'modify' } & DebugRequestEdit)
 *   | { type: 'mock', status: number, headers?: Record<string, string>, body: string, delay_ms?: number }} effect
 * @property {number} [times]
 *
 * @typedef {object} DebugRule
 * @property {string} id
 * @property {'enabled' | 'disabled' | 'exhausted' | 'removed' | 'stopped'} state
 * @property {number} hits
 * @property {number} failures
 * @property {number} created_at
 * @property {string} [last_error]
 *
 * @typedef {object} DebugReplaySpec
 * @property {string} url
 * @property {string} [method]
 * @property {Record<string, string | null>} [headers]
 * @property {string} [body]
 * @property {string} key
 *
 * @typedef {object} DebugReplay
 * @property {string} id
 * @property {string} key
 * @property {string} source_request_id
 * @property {string} [request_id]
 * @property {'running' | 'complete' | 'failed' | 'interrupted'} state
 * @property {string} [error]
 *
 * @typedef {object} DebugIntervention
 * @property {string} rule_id
 * @property {'block' | 'modify' | 'mock'} type
 * @property {'pending' | 'applied' | 'failed' | 'cancelled'} state
 * @property {string} [error]
 * @property {string[]} [changes]
 *
 * Request parameters share one envelope: `action` selects the read and the
 * remaining fields narrow or page it. Filters apply only where the action
 * documents them; unknown fields are rejected by the transport rather than
 * ignored, so a caller cannot silently read broader data than intended.
 *
 * @typedef {object} DebugParams
 * @property {string} session_id
 * @property {DebugAction} action
 * @property {number} [tab_id]
 * @property {string} [run_id]
 * @property {string} [id]
 * @property {string} [name]
 * @property {number} [since]
 * @property {number} [limit]
 * @property {'metadata' | 'request' | 'response' | 'headers' | 'timing'} [part]
 * @property {number} [offset]
 * @property {number} [max_chars]
 * @property {string} [pointer]
 * @property {DebugRuleSpec} [rule]
 * @property {DebugReplaySpec} [replay]
 * @property {number} [budget]
 * @property {number} [slow_ms]
 * @property {number} [window_ms]
 * @property {boolean} [include_controlled]
 * @property {string} [url]
 * @property {string} [method]
 * @property {string} [resource_type]
 * @property {number} [status]
 * @property {string} [state]
 * @property {'business' | 'resource' | 'extension' | 'all'} [kind]
 * @property {string[]} [fields]
 * @property {number} [wait_ms]
 * @property {string} [command_id]
 *
 * @typedef {object} DebugBody
 * @property {'pending' | 'available' | 'empty' | 'truncated' | 'unavailable' | 'omitted' | 'evicted'} state
 * @property {string} [reason]
 * @property {string} [text]
 * @property {number} [chars]
 * @property {number} [offset]
 * @property {number} [next_offset]
 * @property {boolean} [redacted]
 * @property {boolean} [replay_safe]
 *
 * A retained request is immutable after it settles. `sequence` orders it within
 * the run and is the cursor used by incremental reads; `id` is stable across
 * checkpoints. `integrity` states how much of the URL, metadata and header
 * evidence was actually captured, so a consumer can tell a complete request from
 * one that was truncated, redacted or rebuilt from partial events.
 *
 * @typedef {object} DebugRequest
 * @property {string} id
 * @property {string} run_id
 * @property {number} sequence
 * @property {number} started_at
 * @property {number} [finished_at]
 * @property {string} method
 * @property {string} url
 * @property {{ url: 'complete' | 'redacted' | 'truncated',
 *   metadata: 'complete' | 'truncated',
 *   response_headers?: 'complete' | 'truncated' }} [integrity]
 * @property {string} [resource_type]
 * @property {string} [frame_id]
 * @property {string} [loader_id]
 * @property {'pending' | 'complete' | 'failed' | 'redirected' | 'interrupted'} state
 * @property {number} [status]
 * @property {string} [error]
 * @property {string} [mime_type]
 * @property {number} [duration_ms]
 * @property {number} [transfer_bytes]
 * @property {number} [decoded_bytes]
 * @property {boolean} [from_cache]
 * @property {boolean} [from_service_worker]
 * @property {string} [redirect_from]
 * @property {string} [initiator]
 * @property {Record<string, string>} [request_headers]
 * @property {Record<string, string>} [response_headers]
 * @property {Record<string, number>} [timing]
 * @property {DebugBody} request_body
 * @property {DebugBody} response_body
 * @property {boolean} [truncated]
 * @property {DebugIntervention} [intervention]
 * @property {string} [replay_from]
 * @property {string} [replay_id]
 * @property {boolean} [pinned]
 *
 * Console entries are deduplicated: `count` and `last_at` describe repeats of the
 * same message, while `relation` tags association with an operation window.
 *
 * @typedef {object} DebugConsole
 * @property {string} id
 * @property {number} at
 * @property {string} level
 * @property {string} text
 * @property {number} count
 * @property {number} last_at
 * @property {string} [stack]
 * @property {'website' | 'extension' | 'browser' | 'unknown'} [source]
 * @property {string} [source_url]
 * @property {'window' | 'delayed'} [relation]
 *
 * @typedef {object} DebugField
 * @property {string} key
 * @property {string} [name]
 * @property {string} label
 * @property {string} [value]
 * @property {'available' | 'redacted' | 'truncated'} state
 *
 * A page record is one snapshot of captured fields at `at`; later navigation can
 * replace it, so the record is evidence of a moment, not of the live page.
 *
 * @typedef {object} DebugPage
 * @property {number} at
 * @property {string} [url]
 * @property {string} [title]
 * @property {string} [text]
 * @property {'available' | 'unavailable'} state
 * @property {boolean} [truncated]
 * @property {DebugField[]} [fields]
 * @property {boolean} [fields_partial]
 * @property {string} [navigation]
 *
 * An operation is one observed action and its association window. `window_end`
 * bounds the window when the action itself finished early, and
 * `observation_limited` states that the window was cut short by a capture limit.
 *
 * @typedef {object} DebugOperation
 * @property {string} id
 * @property {string} run_id
 * @property {number} sequence
 * @property {string} method
 * @property {string} [target]
 * @property {'human' | 'agent'} [source]
 * @property {number} started_at
 * @property {number} [finished_at]
 * @property {number} [window_end]
 * @property {'running' | 'completed' | 'error' | 'interrupted'} state
 * @property {string} [error]
 * @property {DebugPage} [before]
 * @property {DebugPage} [after]
 * @property {DebugPage[]} [observations]
 * @property {number} [observation_end]
 * @property {boolean} [observation_limited]
 * @property {string[]} request_ids
 * @property {string[]} console_ids
 * @property {boolean} truncated
 *
 * A run summary is stored separately from its recording so listings stay small.
 * `requests`, `operations` and `errors` are counts at the time of the checkpoint;
 * `dropped_*` and `coverage` explain what the capture could not retain.
 *
 * @typedef {object} DebugRun
 * @property {string} id
 * @property {string} session_id
 * @property {number} tab_id
 * @property {string} name
 * @property {string} url
 * @property {number} started_at
 * @property {number} [stopped_at]
 * @property {'capturing' | 'stopped'} state
 * @property {string} [stop_reason]
 * @property {number} requests
 * @property {number} operations
 * @property {number} errors
 * @property {number} dropped_requests
 * @property {number} dropped_operations
 * @property {number} dropped_console
 * @property {string[]} coverage
 * @property {number} next_since
 * @property {number} [active_rules]
 * @property {number} [saved_at]
 * @property {string} [storage_error]
 * @property {{ requests: number, bytes: number, dropped: number, pins: number }} [storage]
 * @property {{ extension_version?: string, user_agent?: string }} [environment]
 *
 * A value read from a page carries its provenance: `source` names the capture
 * that produced it and `at` places it in time. Producers use `not_recorded`
 * rather than an empty string when the field was never observed.
 *
 * @typedef {object} DebugValue
 * @property {string} state
 * @property {string} [value]
 * @property {string} [source]
 * @property {number} [at]
 *
 * @typedef {object} DebugFieldTrace
 * @property {string} key
 * @property {string} label
 * @property {DebugValue} before
 * @property {DebugValue} input
 * @property {DebugValue[]} submitted
 * @property {DebugValue[]} response
 * @property {DebugValue} later
 *
 * Evidence is a conservative projection of retained facts. `gaps` names what
 * could not be observed, and an empty list is the only signal that the
 * projection is complete; `changes` is a line-level diff, not a semantic one.
 *
 * @typedef {object} DebugEvidence
 * @property {DebugFieldTrace[]} fields
 * @property {{ request_id: string, part: string, path: string, value: string, truncated?: boolean }[]} payloads
 * @property {{ request_id: string, relation: 'window' | 'delayed' }[]} links
 * @property {string[]} gaps
 * @property {{ added: string[], removed: string[], truncated: boolean }} changes
 * @property {DebugPage[]} observations
 *
 * One recording is a checkpoint, not a live view. `run.state` says whether it is
 * still capturing, and a checkpoint always carries the run, requests and
 * operations as they stood at `saved_at`. Optional collections appear only when
 * that capture enabled the corresponding feature, so readers must not treat a
 * missing collection as an empty one.
 *
 * @typedef {object} DebugRecording
 * @property {1} version
 * @property {number} saved_at
 * @property {DebugRun} run
 * @property {DebugRequest[]} requests
 * @property {DebugOperation[]} operations
 * @property {DebugConsole[]} console
 * @property {DebugPage[]} pages
 * @property {DebugRule[]} [rules]
 * @property {DebugReplay[]} [replays]
 * @property {DebugPerformance[]} [performance]
 *
 * Read replies reuse this shape: only the members relevant to the requested
 * action are present. `next_since` and `next_offset` resume an incremental or
 * offset-paged read and are absent when the read reached its end. `output`
 * describes any budget-driven omission, while the stored evidence stays intact.
 *
 * @typedef {object} DebugResult
 * @property {string} session_id
 * @property {DebugRun} [run]
 * @property {DebugRun[]} [runs]
 * @property {DebugRequest[]} [requests]
 * @property {DebugRequest} [request]
 * @property {DebugOperation[]} [operations]
 * @property {DebugOperation} [operation]
 * @property {DebugConsole[]} [console]
 * @property {DebugPage[]} [pages]
 * @property {DebugRecording} [recording]
 * @property {DebugEvidence} [evidence]
 * @property {DebugRule[]} [rules]
 * @property {DebugReplay[]} [replays]
 * @property {DebugPerformance[]} [performance]
 * @property {DebugReplay} [replay]
 * @property {DebugEndpoint[]} [aggregates]
 * @property {DebugDuplicate[]} [duplicates]
 * @property {DebugAnalysis} [analysis]
 * @property {number} [next_offset]
 * @property {number} [next_since]
 * @property {boolean} [truncated]
 * @property {Record<string, unknown>} [capabilities]
 * @property {{ budget: number, truncated: boolean, omitted: string[] }} [output]
 * @property {{ state: string, command_id?: string, method?: string, started_at?: number,
 *   elapsed_ms?: number, wait_complete?: boolean, wait_timed_out?: boolean }} [activity]
 *
 * @typedef {object} DebugTask
 * @property {string} session_id
 * @property {number} created_at
 * @property {number} [tab_id]
 * @property {string} [title]
 * @property {string} [url]
 * @property {DebugRun} [run]
 *
 * @typedef {object} DebugMetric
 * @property {number} [value]
 * @property {'available' | 'provisional' | 'partial' | 'unavailable' | 'unsupported'} state
 * @property {string[]} reasons
 *
 * A performance record covers one main-frame document visit. Metric states are
 * part of the contract: `provisional` may still change, `partial` was cut short,
 * and `unavailable`/`unsupported` carry reasons rather than a number. A finished
 * record is never upgraded from provisional after the visit ends.
 *
 * @typedef {object} DebugPerformance
 * @property {string} id
 * @property {string} document_key
 * @property {number} sequence
 * @property {number} time_origin
 * @property {number} started_at
 * @property {number} observed_at
 * @property {string} url
 * @property {string} navigation
 * @property {'capturing' | 'completed' | 'interrupted'} state
 * @property {boolean} early
 * @property {'main_frame'} scope
 * @property {{ at: number, state: string }[]} visibility
 * @property {boolean} visibility_truncated
 * @property {Record<string, DebugMetric>} metrics
 * @property {{ at: number, duration_ms: number }[]} long_tasks
 * @property {boolean} long_tasks_truncated
 * @property {string[]} coverage
 *
 * An endpoint group is keyed by method plus exact origin and path. Query values
 * are not part of the key and are not retained in `endpoint`. Timing statistics
 * use captured samples only, so `timing_samples` can be smaller than `count`.
 *
 * @typedef {object} DebugEndpoint
 * @property {string} id
 * @property {string} method
 * @property {string} endpoint
 * @property {number} count
 * @property {number} failed
 * @property {number} http_errors
 * @property {number} pending
 * @property {number} interrupted
 * @property {Record<string, number>} statuses
 * @property {number} slow
 * @property {number} timing_samples
 * @property {{ min: number, mean: number, p50: number, p95: number, max: number, total: number }} [duration_ms]
 * @property {number} transfer_bytes
 * @property {number} transfer_samples
 * @property {number} cached
 * @property {number} service_worker
 * @property {number} controlled
 * @property {number} replayed
 * @property {string[]} request_ids
 * @property {boolean} refs_truncated
 *
 * A duplicate group is a suspicion, never a proven defect. Members share method,
 * retained URL, request body and document identity inside one start-time window;
 * headers are not compared. Retries or deliberate repeated calls can produce a
 * valid group, so `possible_retry` is only a hint.
 *
 * @typedef {object} DebugDuplicate
 * @property {string} id
 * @property {string} method
 * @property {string} url
 * @property {number} count
 * @property {number} extra_requests
 * @property {number} started_at
 * @property {number} ended_at
 * @property {number} overlap_count
 * @property {boolean} possible_retry
 * @property {string[]} request_ids
 * @property {string[]} operation_ids
 * @property {boolean} refs_truncated
 *
 * Counters describe one explicit analysis read and are recomputed from retained
 * evidence each time; nothing is cached between reads. `coverage` lists the
 * limitations that apply to the numbers, and `semantics` states the exact
 * matching rule used for the selected action.
 *
 * @typedef {object} DebugAnalysis
 * @property {number} retained
 * @property {number} matched
 * @property {number} included
 * @property {number} excluded_controlled
 * @property {number} uncomparable
 * @property {number} groups
 * @property {number} suspected_extra_requests
 * @property {number} window_ms
 * @property {number} slow_ms
 * @property {string[]} coverage
 * @property {string} semantics
 */
export {};
