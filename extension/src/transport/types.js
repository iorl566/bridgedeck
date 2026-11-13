/**
 * Type-only module for wire frames, connection state, handshake and trace
 * shapes. For compatibility the frame guards below are also provided as
 * runtime helpers because transports may classify incoming frames.
 *
 * @typedef {string} RpcId
 * @typedef {'unknown_method' | 'unsupported' | 'invalid_params' | 'not_found'
 *   | 'permission_denied' | 'timeout' | 'dialog_pending' | 'cdp_failed'
 *   | 'protocol_error' | 'cancelled' | 'user_aborted' | 'version_too_old'
 *   | 'pairing_required' | 'multiple_browsers_online' | 'no_browser_connected'} ErrorCode
 *
 * Stable `RpcError.data.reason` values used for hint selection.
 *
 * @typedef {'user_moved_tab' | 'cooperation_sync_required' | 'frame_unobservable'
 *   | 'page_load_failed' | 'control_authority_required' | 'control_context_invalid'
 *   | 'human_intervention' | 'control_held' | 'document_changed'
 *   | 'observation_required' | 'observation_changed' | 'precondition_invalid'
 *   | 'precondition_failed' | 'target_detached' | 'target_hidden' | 'target_disabled'
 *   | 'target_readonly' | 'target_focus_lost' | 'target_moved' | 'target_covered'
 *   | 'read_params_invalid' | 'read_target_stale' | 'read_selector_invalid'
 *   | 'read_field_ambiguous' | 'read_limit' | 'extract_params_invalid'
 *   | 'extract_target_stale' | 'extract_target_ambiguous' | 'extract_target_hidden'
 *   | 'extract_selector_invalid' | 'extract_structure_invalid'
 *   | 'extract_field_ambiguous' | 'extract_limit' | 'ui_lookup_failed'
 *   | 'task_unavailable' | 'target_unavailable' | 'task_stopping' | 'ui_deadline'
 *   | 'preview_busy' | 'agent_window_scope' | 'element_not_visible' | 'input_not_ready'
 *   | 'input_outcome_unknown' | 'input_paint_unconfirmed' | 'input_cleanup_failed'
 *   | 'ref_not_found' | 'ref_kind_unsupported' | 'visual_capture_stale'
 *   | 'visual_capture_invalid' | 'visual_coordinate_invalid' | 'visual_target_changed'
 *   | 'visual_pixel_budget_exceeded' | 'selector_not_found' | 'target_not_fillable'
 *   | 'fill_value_invalid' | 'fill_target_changed' | 'fill_focus_lost'
 *   | 'fill_value_mismatch' | 'fill_failed' | 'target_not_select' | 'option_not_found'
 *   | 'single_select_value_count' | 'tab_not_active' | 'window_resize_inactive_tab'
 *   | 'window_resize_constrained' | 'window_resize_unconfirmed'
 *   | 'window_resize_viewport_unchanged' | 'restricted_tab_url'
 *   | 'cdp_extension_access_denied' | 'observe_identity_reload_loop'
 *   | 'borrow_agent_window_tab' | 'borrow_conflict' | 'incognito_borrow_disabled'
 *   | 'borrow_in_progress' | 'user_denied' | 'confirmation_timeout'
 *   | 'confirmation_ui_unavailable' | 'borrow_outcome_unknown'
 *   | 'screenshot_capture_failed' | 'renderer_read_timeout' | 'operation_settling'
 *   | 'user_cancelled' | 'page_hidden' | 'navigation' | 'watchdog_timeout'
 *   | 'stale_frame' | 'loading_stalled' | 'file_input_probe_failed'
 *   | 'file_input_not_activated' | 'set_file_input_failed'
 *   | 'upload_mechanism_unsupported' | 'file_drop_target_unavailable'
 *   | 'file_drop_failed' | 'download_capture_failed' | 'download_path_mismatch'
 *   | 'transfer_outcome_unknown' | 'transfer_timeout' | 'cleanup_failed'} RpcErrorReason
 * @typedef {'none' | 'committed' | 'unknown'} TransferEffectState
 * @typedef {'complete' | 'failed'} TransferCleanupState
 *
 * @typedef {object} RpcErrorData
 * @property {RpcErrorReason} [reason]
 * @property {TransferEffectState} [effect_state]
 * @property {string} [phase]
 * @property {TransferCleanupState} [cleanup_state]
 *
 * @typedef {object} RpcError
 * @property {ErrorCode} code
 * @property {string} message
 * @property {RpcErrorData} [data]
 *
 * @typedef {object} RequestFrame
 * @property {RpcId} id
 * @property {string} method
 * @property {unknown} [params]
 *
 * @typedef {object} OkResponseFrame
 * @property {RpcId} id
 * @property {unknown} result
 *
 * @typedef {object} ErrResponseFrame
 * @property {RpcId} id
 * @property {RpcError} error
 *
 * @typedef {OkResponseFrame | ErrResponseFrame} ResponseFrame
 *
 * @typedef {object} EventFrame
 * @property {string} event
 * @property {unknown} [payload]
 *
 * @typedef {object} SessionEndedEvent
 * @property {'session.ended'} event
 * @property {{ session_id: string, reason: 'user_moved_tab', tab_id: number }} payload
 *
 * @typedef {RequestFrame | ResponseFrame | EventFrame} ProtocolFrame
 *
 * @typedef {object} InteractionPolicy
 * @property {'always' | 'never'} borrow_confirmation
 * @property {'enabled' | 'disabled'} request_help
 *
 * @typedef {object} BrowserPeerInfo
 * @property {string} name
 * @property {string} version
 *
 * @typedef {object} HandshakeParams
 * @property {boolean} [audit_enabled]
 * @property {string} client
 * @property {string} version
 * @property {string} protocol_version
 * @property {string} instance_id
 * @property {BrowserPeerInfo} browser
 * @property {string} label
 * @property {string} [min_compatible_peer]
 * @property {string} [min_compatible_protocol]
 *
 * @typedef {object} HandshakeResult
 * @property {number} [audit_version]
 * @property {boolean} [audit_ready]
 * @property {string} server
 * @property {string} version
 * @property {string} protocol_version
 * @property {string} [min_compatible_peer]
 * @property {string} [min_compatible_protocol]
 *
 * @typedef {'disconnected' | 'connecting' | 'connected' | 'version_skew'} ConnectionState
 *
 * @typedef {'alert' | 'confirm' | 'prompt' | 'beforeunload'} JavaScriptDialogType
 * @typedef {'accepted' | 'dismissed'} JavaScriptDialogHandledAction
 *
 * @typedef {object} PendingJavaScriptDialog
 * @property {string} id
 * @property {number} tab_id
 * @property {JavaScriptDialogType} type
 * @property {string} message
 * @property {string} [url]
 * @property {string} [default_prompt]
 * @property {number} sequence
 * @property {number} decision_deadline
 *
 * @typedef {object} DialogStatusParams
 * @property {string} session_id
 * @property {number} [tab_id]
 *
 * @typedef {object} DialogHandleParams
 * @property {string} session_id
 * @property {string} dialog_id
 * @property {string} [text]
 *
 * @typedef {object} JavaScriptDialogInfo
 * @property {number} tab_id
 * @property {JavaScriptDialogType} type
 * @property {string} message
 * @property {string} [url]
 * @property {string} [default_prompt]
 * @property {boolean} [has_browser_handler]
 * @property {JavaScriptDialogHandledAction} handled
 * @property {number} sequence
 *
 * @typedef {'console' | 'exception' | 'log'} ConsoleEntryKind
 *
 * @typedef {object} ConsoleStackFrame
 * @property {string} [function_name]
 * @property {string} [url]
 * @property {number} [line]
 * @property {number} [column]
 *
 * @typedef {object} ConsoleEntry
 * @property {number} sequence
 * @property {ConsoleEntryKind} kind
 * @property {string} level
 * @property {string} text
 * @property {string} [url]
 * @property {number} [line]
 * @property {number} [column]
 * @property {number} [timestamp]
 * @property {ConsoleStackFrame[]} [stack_trace]
 * @property {boolean} truncated
 *
 * @typedef {object} ConsoleParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [since]
 * @property {number} [limit]
 * @property {number} [max_text_chars]
 * @property {boolean} [include_stack]
 *
 * @typedef {object} ConsoleResult
 * @property {number} tab_id
 * @property {ConsoleEntry[]} entries
 * @property {number} next_since
 * @property {boolean} truncated
 *
 * @typedef {'response' | 'failure'} NetworkEntryKind
 *
 * @typedef {object} NetworkEntry
 * @property {number} sequence
 * @property {NetworkEntryKind} kind
 * @property {string} [method]
 * @property {string} [url]
 * @property {number} [status]
 * @property {string} [status_text]
 * @property {string} [mime_type]
 * @property {string} [resource_type]
 * @property {string} [error_text]
 * @property {number} [timestamp]
 * @property {boolean} truncated
 *
 * @typedef {object} NetworkParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [since]
 * @property {number} [limit]
 * @property {number} [max_text_chars]
 *
 * @typedef {object} NetworkResult
 * @property {number} tab_id
 * @property {NetworkEntry[]} entries
 * @property {number} next_since
 * @property {boolean} truncated
 *
 * @typedef {'user' | 'agent' | 'all'} TabScopeFilter
 *
 * @typedef {object} TabInfo
 * @property {number} tab_id
 * @property {string} [title]
 * @property {string} [url]
 * @property {number} [window_id]
 * @property {boolean} [active]
 * @property {'user' | 'agent'} [scope]
 *
 * @typedef {object} TabListParams
 * @property {string} session_id
 * @property {TabScopeFilter} [scope]
 *
 * @typedef {object} TabListResult
 * @property {TabInfo[]} tabs
 *
 * @typedef {object} TabCreateParams
 * @property {string} session_id
 * @property {string} [url]
 * @property {boolean} [active]
 * @property {number} [index]
 *
 * @typedef {object} TabCreateResult
 * @property {number} tab_id
 * @property {number} window_id
 * @property {string} url
 *
 * @typedef {object} TabCloseParams
 * @property {string} session_id
 * @property {number} tab_id
 *
 * @typedef {object} TabCloseResult
 * @property {number} tab_id
 *
 * @typedef {object} TabSelectParams
 * @property {string} session_id
 * @property {number} tab_id
 *
 * @typedef {object} TabSelectResult
 * @property {number} tab_id
 * @property {number} window_id
 *
 * @typedef {object} TabBorrowParams
 * @property {string} session_id
 * @property {number} tab_id
 * @property {boolean} [confirm]
 *
 * @typedef {object} TabBorrowResult
 * @property {number} tab_id
 * @property {number} original_window_id
 * @property {number} original_index
 * @property {number} agent_window_id
 *
 * @typedef {object} TabReturnParams
 * @property {string} session_id
 * @property {number} tab_id
 *
 * @typedef {object} TabReturnResult
 * @property {number} tab_id
 * @property {number} returned_to_window_id
 * @property {number} returned_to_index
 * @property {boolean} [fallback]
 *
 * @typedef {object} ScreenshotParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {string} [ref]
 *
 * @typedef {object} ScreenshotResult
 * @property {string} [capture_id]
 * @property {string} [capture_unavailable]
 * @property {string} image_base64
 * @property {number} width
 * @property {number} height
 * @property {string} format
 * @property {number} tab_id
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} ScreenshotFullPageParams
 * @property {'follow' | 'current'} [scope]
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} ScreenshotFullPageResult
 * @property {'follow' | 'current'} [scope]
 * @property {string} capture_id
 * @property {number} width
 * @property {number} height
 * @property {'png'} format
 * @property {number} tab_id
 * @property {number} byte_size
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} ScreenshotReadParams
 * @property {string} session_id
 * @property {string} capture_id
 * @property {number} offset
 *
 * @typedef {object} ScreenshotReadResult
 * @property {string} data_base64
 * @property {number} next_offset
 * @property {boolean} eof
 *
 * @typedef {object} ScreenshotReleaseParams
 * @property {string} session_id
 * @property {string} capture_id
 *
 * @typedef {object} ScreenshotReleaseResult
 * @property {boolean} released
 */

/**
 * Page observation payloads: reading the visible page, observing changes and
 * fetching raw markup. `observe` extends `snapshot` with a resumable cursor and
 * optional disclosure probes.
 *
 * @typedef {object} SnapshotParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [max_depth]
 * @property {number} [max_tokens]
 *
 * @typedef {object} SnapshotResult
 * @property {string} [observation_id]
 * @property {string} text
 * @property {number} ref_count
 * @property {number} tab_id
 * @property {boolean} [truncated]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} HoverProbeInfo
 * @property {boolean} performed
 * @property {boolean} revealed_content
 *
 * @typedef {object} SurfaceProbeInfo
 * @property {number} trigger_backend_node_id
 * @property {{ x: number, y: number }} [trigger_point]
 * @property {string} trigger_action
 * @property {string[]} sub_items
 * @property {string} [confidence]
 *
 * @typedef {object} ObserveDebugInfo
 * @property {SurfaceProbeInfo[]} [surface_probes]
 *
 * @typedef {object} ObserveParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [max_depth]
 * @property {number} [max_tokens]
 * @property {string} [cursor]
 * @property {boolean} [debug_surfaces]
 * @property {boolean} [probe_hover]
 *
 * @typedef {object} ObserveResult
 * @property {string} [observation_id]
 * @property {string} text
 * @property {number} ref_count
 * @property {number} tab_id
 * @property {boolean} [truncated]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 * @property {string} [next_cursor]
 * @property {HoverProbeInfo} [hover_probe]
 * @property {ObserveDebugInfo} [debug]
 *
 * @typedef {object} GetHtmlParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {string} [ref]
 * @property {number} [max_bytes]
 *
 * @typedef {object} GetHtmlResult
 * @property {string} html
 * @property {boolean} [truncated]
 * @property {number} byte_size
 * @property {number} tab_id
 * @property {JavaScriptDialogInfo[]} [dialogs]
 */

/**
 * Navigation payloads. `reached` reports the load milestone that was actually
 * observed; `wait_until` asks for the earliest acceptable one.
 *
 * @typedef {'load' | 'domcontentloaded' | 'networkidle' | 'commit'} WaitUntil
 *
 * @typedef {object} NavigateParams
 * @property {string} session_id
 * @property {string} url
 * @property {number} [tab_id]
 * @property {WaitUntil} [wait_until]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} NavigateResult
 * @property {number} tab_id
 * @property {string} url
 * @property {string} [final_url]
 * @property {string} reached
 * @property {string} [error_text]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} NavigateBackParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {WaitUntil} [wait_until]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} NavigateForwardParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {WaitUntil} [wait_until]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} NavigateHistoryResult
 * @property {number} tab_id
 * @property {string} [previous_url]
 * @property {string} [final_url]
 * @property {string} reached
 * @property {string} [error_text]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} ReloadParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {WaitUntil} [wait_until]
 * @property {number} [timeout_ms]
 * @property {boolean} [hard]
 *
 * @typedef {NavigateHistoryResult} ReloadResult
 */

/**
 * Interaction payloads: pointer, wheel, scroll, focus, text entry, keyboard,
 * selection, upload and download. Every result echoes the tab it acted on and
 * any dialog raised by the action; results that resolved a target report which
 * of ref/selector was used.
 *
 * @typedef {'left' | 'middle' | 'right'} MouseButton
 * @typedef {'alt' | 'ctrl' | 'meta' | 'shift'} KeyModifier
 *
 * @typedef {object} ClickParams
 * @property {string} [capture_id]
 * @property {number} [image_x]
 * @property {number} [image_y]
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {MouseButton} [button]
 * @property {number} [click_count]
 * @property {KeyModifier[]} [modifiers]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} ClickResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {number} x
 * @property {number} y
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} HoverParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {KeyModifier[]} [modifiers]
 * @property {number} [settle_ms]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} HoverResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {number} x
 * @property {number} y
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} DragPoint
 * @property {number} x
 * @property {number} y
 *
 * @typedef {object} DragTarget
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {DragPoint} [offset]
 *
 * @typedef {'press-move-release' | 'click-move-click'} DragMode
 *
 * @typedef {object} DragParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {DragTarget} source
 * @property {DragMode} [mode]
 * @property {DragTarget} [target]
 * @property {DragPoint} [delta]
 * @property {MouseButton} [button]
 * @property {KeyModifier[]} [modifiers]
 * @property {number} [hold_ms]
 * @property {number} [duration_ms]
 * @property {number} [timeout_ms]
 * @property {string} [observation_id]
 *
 * @typedef {object} DragResult
 * @property {number} tab_id
 * @property {DragPoint} source
 * @property {DragPoint} target
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} WheelParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [delta_x]
 * @property {number} [delta_y]
 * @property {KeyModifier[]} [modifiers]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} WheelResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {number} x
 * @property {number} y
 * @property {number} delta_x
 * @property {number} delta_y
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} ScrollToParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 *
 * The scroll result reports the clipped border-box bounds in top-level
 * viewport CSS pixels; it is not an occlusion test.
 *
 * @typedef {object} ScrollToResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} FocusParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} FocusResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {boolean} focused
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} BlurParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} BlurResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {boolean} was_focused
 * @property {boolean} focused
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} FillParams
 * @property {string} session_id
 * @property {string} value
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {boolean} [clear_before]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} FillResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {number} value_length
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} PressParams
 * @property {string} session_id
 * @property {string} key
 * @property {KeyModifier[]} [modifiers]
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [hold_ms]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} PressResult
 * @property {number} tab_id
 * @property {string} key
 * @property {string} code
 * @property {KeyModifier[]} modifiers
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} SelectParams
 * @property {string} session_id
 * @property {string[]} values
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} SelectResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {boolean} multiple
 * @property {string[]} selected_values
 * @property {string[]} selected_labels
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * @typedef {object} UploadFile
 * @property {string} transfer_id
 * @property {string} name
 * @property {string} [staged_path]
 *
 * @typedef {'input' | 'drop'} UploadMode
 *
 * @typedef {object} UploadParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {UploadFile[]} files
 * @property {UploadMode} [mode]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} UploadResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {string[]} file_names
 *
 * @typedef {object} DownloadParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 * @property {string} [browser_relative_dir]
 * @property {number} [max_byte_size]
 *
 * @typedef {object} DownloadResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {string} suggested_filename
 * @property {number} byte_size
 * @property {string} [mime]
 * @property {string} [danger]
 * @property {string} [browser_path]
 * @property {string} [transfer_id]
 */

/**
 * Script evaluation and wait payloads.
 *
 * `unverified` runs the script without comparing the page against any
 * observation. Control, document identity and tab ownership are still
 * enforced; the caller accepts that the page may differ from what it last saw.
 *
 * @typedef {object} EvaluateParams
 * @property {string} session_id
 * @property {string} expression
 * @property {number} [tab_id]
 * @property {boolean} [await_promise]
 * @property {boolean} [return_by_value]
 * @property {number} [timeout_ms]
 * @property {boolean} [unverified]
 *
 * @typedef {object} EvaluateError
 * @property {string} text
 * @property {number} [line]
 * @property {number} [column]
 *
 * @typedef {object} EvaluateResult
 * @property {boolean} ok
 * @property {number} tab_id
 * @property {unknown} [value]
 * @property {EvaluateError} [error]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 * @property {false} [verified] - Present only for `unverified` runs, where it is false.
 *
 * @typedef {object} WaitForNavigationParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {WaitUntil} [wait_until]
 * @property {number} [timeout_ms]
 *
 * @typedef {'load' | 'domcontentloaded' | 'networkidle' | 'commit' | 'timeout'} WaitForNavigationReached
 *
 * @typedef {object} WaitForNavigationResult
 * @property {number} tab_id
 * @property {WaitForNavigationReached} reached
 * @property {string} [error_text]
 * @property {JavaScriptDialogInfo[]} [dialogs]
 *
 * Element states `wait-for-element` can wait on. `visible` / `hidden` ask about
 * visibility; `attached` / `detached` ask about presence in the document tree.
 * `hidden` is the opposite of `visible`: absent, or attached but not visible.
 * The `attached` probe result distinguishes those two observations.
 *
 * @typedef {'visible' | 'hidden' | 'attached' | 'detached'} ElementState
 *
 * @typedef {object} WaitForElementParams
 * @property {string} session_id
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {ElementState} state
 * @property {number} [tab_id]
 * @property {number} [timeout_ms]
 * @property {number} [poll_ms]
 *
 * @typedef {object} WaitForElementResult
 * @property {number} tab_id
 * @property {string} [used_ref]
 * @property {string} [used_selector]
 * @property {boolean} satisfied
 * @property {boolean | null} attached - Last completed probe; null when no probe completed before the timeout.
 * @property {boolean | null} visible
 * @property {number} elapsed_ms
 * @property {JavaScriptDialogInfo[]} [dialogs]
 */

/**
 * Human-in-the-loop payloads for a request for help: the ask, the optional
 * completion criteria the page is checked against, and the observed outcome.
 *
 * @typedef {object} HelpTarget
 * @property {string} [ref]
 * @property {string} [selector]
 *
 * @typedef {'continued' | 'cancelled' | 'timed_out' | 'completed' | 'navigated' | 'disabled'} HelpOutcome
 *
 * @typedef {object} HelpCompletionCondition
 * @property {string} [url_contains]
 * @property {string | null} [url_matches]
 * @property {string} [selector_exists]
 * @property {string} [selector_missing]
 * @property {string} [text_exists]
 * @property {string} [text_missing]
 *
 * @typedef {object} HelpCompletionCriteria
 * @property {HelpCompletionCondition[]} [any]
 * @property {HelpCompletionCondition[]} [all]
 * @property {number} [stable_for_ms]
 *
 * @typedef {object} ResolvedTarget
 * @property {boolean} matched
 * @property {string} [ref]
 * @property {string} [selector]
 *
 * @typedef {object} RequestHelpParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {string} prompt
 * @property {string} [title]
 * @property {HelpTarget[]} [targets]
 * @property {HelpCompletionCriteria} [completion_criteria]
 * @property {number} [timeout_ms]
 *
 * @typedef {object} RequestHelpResult
 * @property {HelpOutcome} outcome
 * @property {'system'} [completed_by]
 * @property {string} [note]
 * @property {number} tab_id
 * @property {ResolvedTarget[]} [resolved_targets]
 */

/**
 * Device-emulation payloads. Overrides are remembered per tab and merged field
 * by field: a field present in the request overwrites the stored value, an
 * absent field keeps it, and the merged state is applied as a whole. Overrides
 * are per-tab target state, not inherited by new tabs.
 *
 * @typedef {object} UserAgentBrandVersion
 * @property {string} brand
 * @property {string} version
 *
 * @typedef {object} UserAgentMetadata
 * @property {UserAgentBrandVersion[]} [brands]
 * @property {string} [full_version]
 * @property {string} [platform]
 * @property {string} [platform_version]
 * @property {string} [architecture]
 * @property {string} [model]
 * @property {boolean} [mobile]
 *
 * @typedef {object} EmulateOverrides
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [device_scale_factor]
 * @property {boolean} [mobile]
 * @property {string} [user_agent]
 * @property {string} [accept_language]
 * @property {UserAgentMetadata} [user_agent_metadata]
 * @property {boolean} [touch]
 * @property {number} [max_touch_points]
 *
 * @typedef {object} EmulateParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {boolean} [off] - Clear every override on the tab; exclusive with `overrides`.
 * @property {EmulateOverrides} [overrides] - Overrides to apply; required unless `off` is set.
 *
 * @typedef {object} EmulateResult
 * @property {number} tab_id
 * @property {boolean} cleared - True when overrides were cleared (`off`); false when applied.
 * @property {EmulateOverrides} [applied] - Echo of the overrides that were applied; absent when cleared.
 * @property {string} [note] - Scope note: overrides are per-tab state, not inherited by new tabs.
 */

export const TRACE_VERSION_V3 = 3;
/** Logical v2 identifier. Not a wire field; v2 envelopes omit `version`. */
export const TRACE_VERSION_V2 = 2;
export const VOM_FORMAT_VERSION = 1;

/**
 * @typedef {object} TargetDescriptorV3
 * @property {string} [ref]
 * @property {string} [role]
 * @property {string} [name]
 * @property {string} [ctx]
 * @property {boolean} [unmatched]
 *
 * @typedef {object} RecorderInfo
 * @property {string} cli
 * @property {number} vom
 *
 * @typedef {'user_finish' | 'cli_stop'} StopReason
 *
 * @typedef {object} TraceStateV3
 * @property {string} id
 * @property {string} url
 * @property {string} [title]
 * @property {string} body
 * @property {boolean} [truncated]
 *
 * @typedef {object} StepResultV3
 * @property {string} state
 *
 * @typedef {object} StepCommonV3
 * @property {number} id
 * @property {string} state
 * @property {StepResultV3} result
 *
 * @typedef {'user_typed' | 'link' | 'form_submit' | 'reload' | 'history' | 'script' | 'browser'} NavigationCause
 * @typedef {'enter' | 'suggestion' | 'blur'} FillCommit
 *
 * Legacy v2 target shape retained for existing record producers.
 *
 * @typedef {object} TargetDescriptorV2
 * @property {string} [role]
 * @property {string} [name]
 * @property {string} tag
 * @property {string} [name_attr]
 * @property {string} [placeholder]
 * @property {string} [nearby_label]
 *
 * @typedef {object} TraceEntry
 * @property {string} start_url
 *
 * @typedef {object} PageRefV2
 * @property {string} id
 * @property {string} url
 * @property {string} [title]
 *
 * @typedef {object} SelectedOptionV2
 * @property {string} value
 * @property {string} [label]
 *
 * @typedef {object} StepEffectV2
 * @property {string} navigated_to
 *
 * @typedef {object} StepCommonV2
 * @property {number} id
 * @property {string} page
 * @property {StepEffectV2} [effect]
 *
 * Exported record-only step (trace v2).
 *
 * @typedef {({ op: 'navigate' } & StepCommonV2 & { to: string })
 *   | ({ op: 'click' | 'hover' } & StepCommonV2 & { target: TargetDescriptorV2 })
 *   | ({ op: 'fill' } & StepCommonV2 & { target: TargetDescriptorV2, value: string, redacted?: boolean })
 *   | ({ op: 'select' } & StepCommonV2 & { target: TargetDescriptorV2, selection: SelectedOptionV2[] })
 *   | ({ op: 'press' } & StepCommonV2 & { key: string, modifiers?: KeyModifier[], target?: TargetDescriptorV2 })} StepV2
 *
 * @typedef {object} TraceV2
 * @property {string} recorded_at
 * @property {string} [started_at]
 * @property {string} [purpose]
 * @property {TraceEntry} entry
 * @property {PageRefV2[]} pages
 * @property {StepV2[]} steps
 *
 * @typedef {object} SelectedOptionV3
 * @property {string} value
 * @property {string} [label]
 *
 * @typedef {({ op: 'navigate' } & StepCommonV3 & { to: string, cause: NavigationCause })
 *   | ({ op: 'switch_tab' } & StepCommonV3)
 *   | ({ op: 'click' | 'hover' } & StepCommonV3 & { target: TargetDescriptorV3 })
 *   | ({ op: 'fill' } & StepCommonV3 & { target: TargetDescriptorV3, value: string, commit: FillCommit, redacted?: boolean })
 *   | ({ op: 'select' } & StepCommonV3 & { target: TargetDescriptorV3, selection?: SelectedOptionV3[] })
 *   | ({ op: 'press' } & StepCommonV3 & { key: string, modifiers?: KeyModifier[], target?: TargetDescriptorV3 })
 *   | ({ op: 'scroll' } & StepCommonV3)} StepV3
 *
 * @typedef {object} TraceV3
 * @property {3} version
 * @property {string} recorded_at
 * @property {string} [started_at]
 * @property {string} [purpose]
 * @property {StopReason} stopped_by
 * @property {TraceEntry} entry
 * @property {RecorderInfo} recorder
 * @property {TraceStateV3[]} states
 * @property {StepV3[]} steps
 *
 * @typedef {TraceV2 | TraceV3} RecordedTrace
 * @typedef {StepV2 | StepV3} RecordedStep
 *
 * @typedef {object} RecordStartParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {string} [url]
 * @property {string} [purpose]
 * @property {number} [max_page_tokens]
 * @property {boolean} [redact_values]
 * @property {number} [trace_version] - Omitted means v2; `3` requests a state-linked v3 trace.
 * @property {boolean} [supports_tab_switch_steps] - The client can decode the v3 `switch_tab` step variant.
 *
 * @typedef {object} RecordStartResult
 * @property {number} tab_id
 * @property {boolean} recording
 *
 * @typedef {object} RecordStopParams
 * @property {string} session_id
 *
 * @typedef {object} RecordStopResult
 * @property {RecordedTrace} trace
 *
 * @typedef {object} RecordAwaitParams
 * @property {string} session_id
 * @property {number} [timeout_ms]
 *
 * @typedef {object} RecordAwaitResult
 * @property {RecordedTrace} trace
 */

/**
 * Read and extract payloads. The reference wire-type module re-exports these
 * request and result shapes, so they belong to the same public contract even
 * though the collectors that produce them live in their own tool modules.
 *
 * @typedef {'text' | 'attribute' | 'value' | 'checked' | 'exists'} ReadFieldMode
 *
 * @typedef {object} ReadField
 * @property {string} key
 * @property {ReadFieldMode} read
 * @property {string} [selector]
 * @property {string} [attribute]
 *
 * @typedef {object} ReadParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {string} [selector]
 * @property {string} [ref]
 * @property {ReadField[]} [fields]
 * @property {number} [max_nodes]
 * @property {number} [max_bytes]
 * @property {number} [timeout_ms]
 *
 * @typedef {Record<string, string | boolean | null>} ReadValues
 *
 * @typedef {object} ReadResultItem
 * @property {string} ref
 * @property {ReadValues} values
 * @property {string[]} redacted
 *
 * @typedef {object} ReadResult
 * @property {number} tab_id
 * @property {string} page_url
 * @property {string} frame_id
 * @property {'current_dom'} scope
 * @property {string} frame_url
 * @property {string} title
 * @property {string} captured_at
 * @property {ReadResultItem[]} items
 * @property {boolean} truncated
 *
 * @typedef {object} ReadCollectorOptions
 * @property {string} [selector]
 * @property {ReadField[]} fields
 * @property {number} max_nodes
 * @property {number} max_bytes
 * @property {number} timeout_ms
 * @property {string} sensitive
 *
 * @typedef {object} RawReadItem
 * @property {{ backendNodeId: number }} node
 * @property {ReadValues} values
 * @property {string[]} redacted
 *
 * @typedef {'read_limit' | 'read_selector_invalid' | 'read_field_ambiguous'
 *   | 'read_target_stale'} RawReadErrorReason
 *
 * @typedef {object} RawReadError
 * @property {RawReadErrorReason} reason
 * @property {string} message
 *
 * @typedef {object} RawRead
 * @property {string} frame_url
 * @property {string} title
 * @property {string} captured_at
 * @property {RawReadItem[]} items
 * @property {boolean} truncated
 * @property {RawReadError} [error]
 *
 * @typedef {'discover' | 'table' | 'list'} ExtractAction
 *
 * @typedef {'text' | 'href' | 'attribute'} ExtractFieldMode
 *
 * @typedef {object} ExtractField
 * @property {string} key
 * @property {string} [name]
 * @property {string} selector
 * @property {ExtractFieldMode} read
 * @property {string} [attribute]
 *
 * @typedef {object} ExtractParams
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {ExtractAction} action
 * @property {string} [selector]
 * @property {string} [ref]
 * @property {string} [target_id]
 * @property {string} [item_selector]
 * @property {ExtractField[]} [fields]
 * @property {number} [max_rows]
 * @property {number} [max_columns]
 * @property {number} [max_bytes]
 * @property {number} [timeout_ms]
 *
 * @typedef {'header' | 'generated' | 'field'} ExtractColumnNameSource
 *
 * @typedef {object} ExtractColumn
 * @property {string} key
 * @property {string} name
 * @property {string[]} header_path
 * @property {ExtractColumnNameSource} name_source
 *
 * @typedef {object} ExtractSource
 * @property {string} page_url
 * @property {string} frame_url
 * @property {string} frame_id
 * @property {string} title
 * @property {string} captured_at
 * @property {string} [selector]
 * @property {string} [target_id]
 *
 * @typedef {'data' | 'footer'} ExtractRowKind
 *
 * @typedef {object} ExtractRowSource
 * @property {number} row
 * @property {number} source_row - One-based document or accessibility row index, headers included.
 * @property {ExtractRowKind} row_kind
 * @property {string} locator
 *
 * @typedef {object} ExtractSpan
 * @property {number} row
 * @property {string} column
 * @property {number} row_span
 * @property {number} column_span
 *
 * @typedef {object} ExtractCoverage
 * @property {'loaded_dom'} scope
 * @property {number} rows_returned
 * @property {boolean} truncated
 * @property {'unknown' | 'incomplete'} dataset_complete
 * @property {string} [stop_reason]
 * @property {number} [declared_rows] - Page-declared row count; accessibility counts include headers.
 * @property {number} [declared_columns]
 *
 * @typedef {'table' | 'list'} ExtractTargetKind
 *
 * @typedef {object} ExtractTarget
 * @property {string} target_id
 * @property {ExtractTargetKind} kind
 * @property {string} name
 * @property {string} frame_url
 * @property {string} frame_id
 * @property {string[]} columns
 *
 * @typedef {object} ExtractResult
 * @property {1} schema_version
 * @property {ExtractAction} kind
 * @property {number} tab_id
 * @property {ExtractSource} source
 * @property {ExtractColumn[]} columns
 * @property {Record<string, string | null>[]} rows
 * @property {ExtractRowSource[]} row_sources
 * @property {ExtractSpan[]} spans
 * @property {ExtractCoverage} coverage
 * @property {string[]} warnings
 * @property {ExtractTarget[]} [targets]
 *
 * @typedef {object} ExtractCollectorOptions
 * @property {ExtractAction} action
 * @property {string} [selector]
 * @property {string} [item_selector]
 * @property {ExtractField[]} [fields]
 * @property {boolean} anchored
 * @property {number} max_rows
 * @property {number} max_columns
 * @property {number} max_bytes
 * @property {number} timeout_ms
 *
 * @typedef {object} ExtractRawCell
 * @property {string | null} text
 * @property {string} id
 * @property {string[]} headers
 * @property {string} scope
 * @property {boolean} header
 * @property {number} row_span
 * @property {number} column_span
 * @property {number} [column_index]
 *
 * @typedef {'header' | 'data' | 'footer'} ExtractRawRowKind
 *
 * @typedef {object} ExtractRawRow
 * @property {ExtractRawCell[]} cells
 * @property {number} source_row
 * @property {number} group
 * @property {ExtractRawRowKind} kind
 * @property {string} locator
 * @property {boolean} [indexed]
 *
 * @typedef {object} ExtractRawTarget
 * @property {ExtractTargetKind} kind
 * @property {string} name
 * @property {string[]} columns
 * @property {{ backendNodeId: number }} node - Live document node in the renderer; decoded protocol identity in the handler.
 *
 * @typedef {object} ExtractRawCapture
 * @property {string} frame_url
 * @property {string} title
 * @property {string} captured_at
 * @property {ExtractRawRow[]} rows
 * @property {Record<string, string | null>[]} items
 * @property {ExtractRowSource[]} item_sources
 * @property {ExtractRawTarget[]} targets
 * @property {boolean} truncated
 * @property {string} [stop_reason]
 * @property {number} [declared_rows]
 * @property {number} [declared_columns]
 * @property {string[]} warnings
 * @property {number[]} [omitted_rows] - Internal facts for distinguishing hidden rows from missing virtual rows.
 * @property {boolean} [aria_rows]
 * @property {{ reason: string, message: string }} [error]
 */

/**
 * Transport abstraction and connection contracts. A transport is a
 * bidirectional protocol channel; the implementation in this directory is
 * WebSocket-backed, while the interface stays structural so an embedding host
 * can supply another channel.
 *
 * @typedef {object} Disposable
 * @property {() => void} dispose
 *
 * @typedef {(message: ProtocolFrame) => void} FrameHandler
 *
 * @typedef {(state: ConnectionState) => void} ConnectionStateHandler
 *
 * @typedef {object} Transport
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(message: ProtocolFrame) => void} send
 * @property {(handler: FrameHandler) => Disposable} onMessage
 * @property {(handler: ConnectionStateHandler) => Disposable} onConnectionStateChange
 * @property {ConnectionState} state
 */

/**
 * Build-time information surfaced by the reference build. The JavaScript
 * mirror keeps the values in its own build constants, but the contract stays
 * available for status and diagnostics payloads.
 *
 * @typedef {object} BuildInfo
 * @property {string} extension_version - Semantic version injected at build time.
 * @property {string} daemon_ws_url - WebSocket URL used for the local connection.
 */

/**
 * Daemon endpoint helpers. The default port falls back to the build-time URL
 * when it is unset; user input is normalized before it reaches a socket.
 *
 * @typedef {number} DaemonPort
 *
 * @typedef {object} DaemonEndpointApi
 * @property {DaemonPort} defaultPort
 * @property {(port: DaemonPort) => string} resolveDaemonWsUrl
 * @property {(raw: unknown) => DaemonPort} normalizeDaemonPort
 * @property {(text: string) => DaemonPort | null} parseDaemonPortInput
 *
 * @typedef {(baseUrl?: string) => DaemonEndpointApi} CreateDaemonEndpoint
 *
 * @typedef {object} DaemonEndpointInput
 * @property {string} [baseUrl] - Defaults to the loopback build endpoint.
 */

/**
 * Handshake contracts. The extension sends `system.handshake` as the first
 * frame on a fresh connection and retains the daemon rejection diagnostics.
 *
 * @typedef {object} BrowserMeta
 * @property {string} name
 * @property {string} version
 *
 * @typedef {object} HandshakeInput
 * @property {boolean} [auditEnabled]
 * @property {string} instanceId
 * @property {BrowserMeta} browser
 * @property {string} label
 * @property {string} [rpcId] - Stable request id for deterministic tests; defaults to a random short string.
 * @property {string} [version] - Extension version override; defaults to the build constant.
 *
 * @typedef {object} HandshakeTransportOptions
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {(error: HandshakeRejectedError) => void} [onRejected] - Runs synchronously before rejection handlers so an immediate close cannot hide diagnostics.
 *
 * @typedef {object} HandshakeOutcome
 * @property {HandshakeParams} params
 * @property {HandshakeResult} result
 *
 * @typedef {object} HandshakeRejection
 * @property {ErrorCode} code
 * @property {RpcErrorData} [data]
 */

/**
 * Local authentication v1 primitives. Every field is base64url text; keys and
 * proofs stay inside extension-owned storage and are never logged.
 *
 * @typedef {string} AuthField
 * @typedef {string} AuthKey
 * @typedef {number} AuthGeneration
 *
 * @typedef {'server' | 'client' | 'rotate' | 'confirm' | 'committed'} AuthProofPurpose
 *
 * @typedef {object} AuthTranscript
 * @property {AuthField} daemon_id
 * @property {AuthField} device_id
 * @property {AuthGeneration} gen
 * @property {string} instance_id
 * @property {string} origin
 * @property {AuthField} client_nonce
 * @property {AuthField} server_nonce
 *
 * @typedef {(value: string, length: number) => Uint8Array} DecodeAuthField
 * @typedef {(value: number) => Uint8Array} EncodeAuthGeneration
 * @typedef {(parts: Uint8Array[]) => Uint8Array} EncodeAuthBytes
 * @typedef {(key: AuthKey, purpose: AuthProofPurpose, value: Uint8Array, txn?: string) => Promise<string>} ProveAuthValue
 * @typedef {(key: AuthKey, purpose: AuthProofPurpose, value: Uint8Array, proof: string, txn?: string) => Promise<boolean>} VerifyAuthProof
 * @typedef {(length: 16 | 32) => string} RandomAuthBytes
 */

/**
 * Local authentication wire messages. A hello offers every usable credential;
 * the daemon answers with a challenge, a pairing request or a busy signal.
 * Proof and rotation messages are correlated with the saved generation and
 * transaction, so a lost reply can be retried without accepting a new key.
 *
 * @typedef {object} AuthRotation
 * @property {AuthField} txn
 * @property {AuthGeneration} gen
 *
 * @typedef {object} AuthCommit
 * @property {AuthField} txn
 * @property {AuthGeneration} gen
 * @property {AuthField} proof
 *
 * @typedef {object} AuthCredentialOffer
 * @property {'active' | 'staged'} role
 * @property {AuthField} device_id
 * @property {AuthGeneration} gen
 * @property {AuthRotation | null} pending
 *
 * @typedef {object} AuthHello
 * @property {1} v
 * @property {AuthField} client_nonce
 * @property {string} instance_id
 * @property {AuthCredentialOffer[]} credentials
 *
 * @typedef {object} AuthChallenge
 * @property {'challenge'} type
 * @property {AuthField} daemon_id
 * @property {AuthField} device_id
 * @property {AuthGeneration} gen
 * @property {AuthField} server_nonce
 * @property {AuthField} server_proof
 *
 * @typedef {object} AuthPairingRequired
 * @property {'pairing_required'} type
 * @property {AuthField} daemon_id
 * @property {boolean} legacy_accepted
 *
 * @typedef {object} AuthBusy
 * @property {'busy'} type
 * @property {AuthGeneration} retry_after_ms
 *
 * @typedef {AuthChallenge | AuthPairingRequired | AuthBusy} AuthChallengeResponse
 *
 * @typedef {object} AuthProve
 * @property {'local.auth.prove'} type
 * @property {1} v
 * @property {AuthField} client_proof
 *
 * @typedef {object} AuthReady
 * @property {'local.auth.ready'} type
 * @property {1} v
 * @property {AuthCommit | null} commit
 * @property {AuthRotation | null} rotation
 *
 * @typedef {object} AuthRejected
 * @property {'local.auth.rejected'} type
 * @property {1} v
 * @property {'already_paired' | 'replace_mismatch'} reason
 * @property {string} browser_id
 *
 * @typedef {object} AuthRotateConfirm
 * @property {'local.auth.rotate_confirm'} type
 * @property {1} v
 * @property {AuthField} txn
 * @property {AuthField} proof
 *
 * @typedef {object} AuthCommitted
 * @property {'local.auth.committed'} type
 * @property {1} v
 * @property {AuthGeneration} gen
 * @property {AuthField} proof
 *
 * @typedef {AuthProve | AuthReady | AuthRejected | AuthRotateConfirm | AuthCommitted} AuthMessage
 *
 * @typedef {object} AuthRequestEnvelope
 * @property {string} id
 * @property {'system.ping'} method
 * @property {{ local_auth: AuthHello }} params
 *
 * @typedef {object} AuthReplyEnvelope
 * @property {string} id
 * @property {{ local_auth: AuthChallengeResponse }} result
 */

/**
 * Local authentication outcomes. Every rejection is expressed as a stable
 * state code; only a verified state selects the connection for business use.
 *
 * @typedef {'verifying' | 'verified' | 'pairing_required' | 'already_paired'
 *   | 'replace_mismatch' | 'server_unverified' | 'daemon_too_old'
 *   | 'unverified_local' | 'busy'} LocalAuthCode
 *
 * @typedef {'skip' | 'unpaired'} LocalAuthStatusReason
 *
 * @typedef {object} LocalAuthStatus
 * @property {LocalAuthCode} state
 * @property {string} [daemonId]
 * @property {string} [deviceId]
 * @property {string} [browserId]
 * @property {LocalAuthStatusReason} [reason]
 *
 * @typedef {object} LocalAuthFailure
 * @property {LocalAuthStatus} status
 *
 * @typedef {object} LocalAuthErrorContract
 * @property {LocalAuthStatus} status - Rejection status carried by the public error.
 *
 * @typedef {(status: LocalAuthStatus) => void} LocalAuthStatusListener
 *
 * @typedef {object} LocalAuthenticatorOptions
 * @property {() => Promise<string>} instanceId
 * @property {string} origin
 * @property {LocalAuthStatusListener} status
 *
 * @typedef {(socket: TransportSocket, signal: AbortSignal) => Promise<void>} LocalAuthenticator
 *
 * @typedef {object} LocalAuthOperations
 * @property {(credential: LocalCredential, pending: AuthRotation & { key: AuthKey }) => Promise<LocalCredential>} [saveCandidate]
 * @property {(credential: LocalCredential, rotation: AuthRotation) => Promise<LocalCredential>} [promoteCandidate]
 *
 * @typedef {(socket: TransportSocket, signal: AbortSignal, credentials: LocalCredential[],
 *   instanceId: string, origin: string, operations?: LocalAuthOperations) => Promise<LocalAuthStatus>} AuthenticateLocal
 */

/**
 * Persisted local credentials. A staged record becomes active only after the
 * daemon's committed proof; an unused link expires after the staged window.
 *
 * @typedef {AuthRotation & { key: AuthKey }} LocalCredentialCandidate
 *
 * @typedef {object} LocalCredential
 * @property {AuthField} daemonId
 * @property {AuthField} deviceId
 * @property {AuthKey} key
 * @property {AuthGeneration} gen
 * @property {'active' | 'staged'} role
 * @property {string} endpoint
 * @property {number} createdAt
 * @property {LocalCredentialCandidate} [pending]
 *
 * @typedef {object} LocalPolicy
 * @property {boolean} skip
 *
 * @typedef {object} LocalState
 * @property {LocalCredential[]} credentials
 * @property {LocalPolicy} policy
 *
 * @typedef {object} LocalCredentialStoreOptions
 * @property {LocalCredential[]} [credentials]
 * @property {boolean} [skip]
 * @property {() => number} [now]
 *
 * @typedef {object} LocalCredentialStore
 * @property {() => LocalState} read
 * @property {(credential: LocalCredential) => LocalCredential} stage
 * @property {(expected: LocalCredential, pending: AuthRotation & { key: AuthKey }) => LocalCredential} saveCandidate
 * @property {(expected: LocalCredential, rotation: AuthRotation) => LocalCredential} promoteCandidate
 * @property {(expected: LocalCredential) => void} discardStaged
 * @property {(skip: boolean) => void} setSkip
 *
 * @typedef {object} LocalCredentialRepository
 * @property {() => Promise<LocalState>} readLocalState
 * @property {(credential: LocalCredential) => Promise<LocalCredential>} stageCredential
 * @property {(expected: LocalCredential, pending: AuthRotation & { key: AuthKey }) => Promise<LocalCredential>} saveCandidate
 * @property {(expected: LocalCredential, rotation: AuthRotation) => Promise<LocalCredential>} promoteCandidate
 * @property {(expected: LocalCredential) => Promise<void>} discardStaged
 * @property {(skip: boolean) => Promise<void>} setSkipLocalVerification
 */

/**
 * Pairing verification. A verifier owns no business transport; it opens its
 * own socket, stages the link, authenticates once and reports the endpoint it
 * verified. A concurrent commit is re-verified on a fresh socket.
 *
 * @typedef {LocalAuthStatus & { endpoint: string }} PairingVerificationResult
 *
 * @typedef {object} PairingVerifierDependencies
 * @property {(input: string) => LocalCredential} [parseLocalPairing]
 * @property {(credential: LocalCredential) => Promise<LocalCredential>} [stageCredential]
 * @property {(credential: LocalCredential) => Promise<void>} [discardStaged]
 * @property {() => Promise<LocalState>} [readLocalState]
 * @property {AuthenticateLocal} [authenticateLocal]
 * @property {LocalAuthOperations} [authOps]
 *
 * @typedef {(link: string, instanceId: string, origin: string,
 *   factory?: WebSocketFactory, dependencies?: PairingVerifierDependencies) => Promise<PairingVerificationResult>} VerifyLocalPairing
 */

/**
 * Remote endpoint contracts. A gateway issues a pairing URL whose fragment
 * carries the credential; credentials and query parameters never remain in
 * the request URL. Device authorization adds expiry and renewal metadata.
 *
 * @typedef {'rejected' | 'unconfirmed' | 'expired' | 'unavailable'
 *   | 'renewing' | 'active'} RemoteAuthorizationStatus
 *
 * @typedef {object} RemoteEndpoint
 * @property {string} url
 * @property {string} token
 * @property {string} [deviceId]
 * @property {string} [expiresAt]
 * @property {string} [renewAfter]
 * @property {string} [pendingToken]
 * @property {string} [renewalAttemptAt]
 * @property {'unavailable' | 'rejected'} [renewalFailure]
 *
 * @typedef {(input: string) => RemoteEndpoint} ParseRemoteEndpoint
 * @typedef {(value: unknown) => RemoteEndpoint | null} ReadRemoteEndpoint
 * @typedef {(endpoint: RemoteEndpoint, now?: number) => RemoteAuthorizationStatus} ReadRemoteAuthorizationStatus
 * @typedef {(url: string, endpoint: RemoteEndpoint | null, factory?: WebSocketFactory) => TransportSocket} RemoteSocketFactory
 */

/**
 * Remote connection storage. Only a non-secret revision and mode are exposed
 * through extension preferences; the endpoint and its credentials live in the
 * credential database. Selecting a mode is published only after the durable
 * write succeeds.
 *
 * @typedef {'local' | 'remote'} RemoteConnectionMode
 *
 * @typedef {object} RemoteStorageArea
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(values: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string[]) => Promise<void>} remove
 * @property {(options: { accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }) => Promise<void>} [setAccessLevel]
 *
 * @typedef {object} RemoteConnectionMetadata
 * @property {RemoteConnectionMode} mode
 * @property {string} revision
 *
 * @typedef {object} RemoteEndpointStore
 * @property {() => Promise<unknown>} get
 * @property {(endpoint: RemoteEndpoint | null) => Promise<unknown>} put
 *
 * @typedef {object} RemoteStorageOptions
 * @property {RemoteStorageArea} local
 * @property {RemoteEndpointStore} endpointStore
 *
 * @typedef {object} RemoteStorage
 * @property {() => Promise<RemoteEndpoint | null>} readRemoteConnection
 * @property {(endpoint: RemoteEndpoint | null) => Promise<void>} writeRemoteConnection
 * @property {() => Promise<void>} initializeRemoteStorage
 * @property {() => Promise<RemoteEndpoint | null>} readSavedRemoteConnection
 */

/**
 * Remote authorization contracts. Pairing and renewal share one serialized
 * write path; a pending candidate is persisted before the credential rotates
 * so a lost HTTP reply can be retried with the same old/new pair.
 *
 * @typedef {'pair' | 'renew'} RemotePairingAction
 *
 * @typedef {object} RemoteAuthorizationResponse
 * @property {string} device_id
 * @property {string} expires_at
 * @property {string} renew_after
 *
 * @typedef {object} RemoteAuthorizationRequest
 * @property {RemotePairingAction} action
 * @property {string} next_token
 * @property {string} label
 *
 * @typedef {object} RemoteAuthorizationHttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {() => Promise<unknown>} json
 *
 * @typedef {(url: URL, init: object) => Promise<RemoteAuthorizationHttpResponse>} RemoteAuthorizationFetch
 *
 * @typedef {object} RemoteAuthorizationOptions
 * @property {RemoteStorage} storage
 * @property {RemoteAuthorizationFetch} [fetchImpl]
 * @property {() => number} [now]
 * @property {string} [label]
 *
 * @typedef {object} RemoteAuthorization
 * @property {(endpoint: RemoteEndpoint) => Promise<RemoteEndpoint>} activateRemoteEndpoint
 * @property {(pairing: string | null) => Promise<string | null>} updateRemoteConnection
 * @property {() => Promise<string>} resumeRemoteConnection
 * @property {() => Promise<void>} renewRemoteAuthorization
 *
 * @typedef {object} RemoteAuthorizationMessage
 * @property {string} kind
 * @property {boolean} [resume]
 * @property {string | null} [pairing]
 *
 * @typedef {object} RemoteAuthorizationReply
 * @property {string} [url]
 * @property {string} [error]
 *
 * @typedef {object} RemoteAuthorizationWatcher
 * @property {() => void} dispose
 *
 * @typedef {object} ExtensionMessageSender
 * @property {string} [url]
 * @property {string} [id]
 * @property {unknown} [tab]
 *
 * @typedef {(message: RemoteAuthorizationMessage, sender: ExtensionMessageSender,
 *   reply: (response: RemoteAuthorizationReply) => void) => boolean} ExtensionMessageListener
 *
 * @typedef {object} ExtensionMessageApi
 * @property {(listener: ExtensionMessageListener) => void} addListener
 * @property {(listener: ExtensionMessageListener) => void} removeListener
 *
 * @typedef {object} ExtensionRuntimeApi
 * @property {string} id
 * @property {(path: string) => string} getURL
 * @property {ExtensionMessageApi} onMessage
 *
 * @typedef {object} AlarmApi
 * @property {(name: string) => Promise<{ name: string } | undefined>} [get]
 * @property {(name: string, options: { periodInMinutes: number }) => Promise<void>} [create]
 * @property {(name: string) => Promise<boolean>} [clear]
 *
 * @typedef {object} AlarmEventApi
 * @property {(listener: (alarm: { name: string }) => void) => void} [addListener]
 * @property {(listener: (alarm: { name: string }) => void) => void} [removeListener]
 *
 * @typedef {object} AlarmSchedulerApi
 * @property {AlarmApi} [alarms]
 * @property {AlarmEventApi} [onAlarm]
 */

/**
 * WebSocket transport contracts. Inbound text frames are parsed as protocol
 * frames and dispatched to handlers; outbound frames are serialized and sent
 * only after the optional authentication prelude succeeds. Unexpected closes
 * trigger a bounded exponential-backoff reconnect loop.
 *
 * @typedef {object} TransportSocket
 * @property {string} url
 * @property {number} readyState
 * @property {(data: string) => void} send
 * @property {() => void} close
 * @property {(type: string, listener: (event: object) => void) => void} addEventListener
 * @property {(type: string, listener: (event: object) => void) => void} removeEventListener
 *
 * @typedef {(url: string, protocols?: string | string[]) => TransportSocket} WebSocketFactory
 *
 * @typedef {object} ReconnectOptions
 * @property {number} [initialDelayMs]
 * @property {number} [maxDelayMs]
 *
 * @typedef {(socket: TransportSocket, signal: AbortSignal) => Promise<void> | void} SocketAuthenticator
 *
 * @typedef {object} WSTransportOptions
 * @property {string} url
 * @property {ReconnectOptions} [reconnect]
 * @property {WebSocketFactory} [webSocketFactory] - Injection point for tests; defaults to the platform socket.
 * @property {SocketAuthenticator} [authenticate]
 * @property {() => void} [onAuthenticationError]
 *
 * @typedef {object} TransportCloseEvent
 * @property {number} [code]
 * @property {string} [reason]
 *
 * @typedef {object} TransportMessageEvent
 * @property {unknown} data
 *
 * @typedef {object} WSTransportContract
 * @property {ConnectionState} state - Read-only current connection state.
 * @property {(url: string) => boolean} setUrl - Returns whether the URL changed; does not reconnect.
 * @property {() => void} resetAuthenticationBackoff
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(message: ProtocolFrame) => void} send
 * @property {(handler: FrameHandler) => Disposable} onMessage
 * @property {(handler: ConnectionStateHandler) => Disposable} onConnectionStateChange
 */

/**
 * Credential database contract. Extension-origin storage is shared by local
 * and remote credentials, with one object store per credential family and a
 * migration store for policy and legacy records.
 *
 * @typedef {'connection' | 'local' | 'migration'} CredentialStoreName
 *
 * @typedef {object} CredentialStoreMap
 * @property {CredentialObjectStore} connection
 * @property {CredentialObjectStore} local
 * @property {CredentialObjectStore} migration
 *
 * @typedef {object} CredentialTransaction
 * @property {(name: CredentialStoreName) => CredentialObjectStore} objectStore
 * @property {() => void} abort
 *
 * @typedef {object} CredentialObjectStore
 * @property {(key: string) => CredentialRequest} get
 * @property {(value: unknown, key: string) => CredentialRequest} put
 * @property {(key: string) => CredentialRequest} delete
 *
 * @typedef {object} CredentialRequest
 * @property {unknown} result
 * @property {unknown} error
 *
 * @typedef {object} CredentialDatabase
 * @property {(names: CredentialStoreName | CredentialStoreName[], mode?: 'readonly' | 'readwrite') => CredentialTransaction} transaction
 * @property {() => void} close
 *
 * @typedef {object} CredentialDatabaseFactory
 * @property {(name: string, version: number) => CredentialOpenRequest} open
 *
 * @typedef {object} CredentialOpenRequest
 * @property {CredentialDatabase} result
 * @property {unknown} error
 * @property {() => void} [onupgradeneeded]
 * @property {() => void} [onblocked]
 * @property {() => void} [onsuccess]
 * @property {() => void} [onerror]
 */

/**
 * Public function contracts for the transport modules. They are declared
 * together with the payload shapes so consumers can document calls without
 * importing implementation modules.
 *
 * @typedef {(frame: unknown) => boolean} FrameGuard
 * @typedef {(transport: Transport, input: HandshakeInput, options?: HandshakeTransportOptions) => Promise<HandshakeOutcome>} PerformHandshake
 * @typedef {(ua?: string) => BrowserMeta} DetectBrowserMeta
 * @typedef {(options: LocalAuthenticatorOptions) => LocalAuthenticator} CreateLocalAuthenticator
 * @typedef {(link: string, instanceId: string, origin: string) => Promise<PairingVerificationResult>} PairLocalDevice
 * @typedef {(options: RemoteAuthorizationOptions) => RemoteAuthorization} CreateRemoteAuthorization
 * @typedef {(runtime: ExtensionRuntimeApi, alarms?: AlarmSchedulerApi,
 *   local?: RemoteStorageArea) => RemoteAuthorizationWatcher} WatchRemoteAuthorization
 * @typedef {(options: RemoteStorageOptions) => RemoteStorage} CreateRemoteStorage
 * @typedef {new (options: WSTransportOptions) => WSTransportContract} WSTransportConstructor
 * @typedef {(factory?: CredentialDatabaseFactory) => Promise<CredentialDatabase>} OpenCredentialDatabase
 *
 * Daemon endpoint entry points. The module-level helpers expose the same
 * contract as the factory result so a direct import can be documented without
 * constructing the endpoint first. Out-of-range and non-integer values fall
 * back to the build default; only text parsing can report an invalid input.
 *
 * @typedef {(port: DaemonPort) => string} ResolveDaemonWsUrl
 * @typedef {(raw: unknown) => DaemonPort} NormalizeDaemonPort
 * @typedef {(text: string) => DaemonPort | null} ParseDaemonPortInput
 *
 * Local authentication entry points. Parsing and proof helpers reject any
 * field that does not round-trip through the canonical base64url encoding, so
 * schema checks and proof verification consume exactly the same bytes.
 *
 * @typedef {(bytes: Uint8Array) => AuthField} EncodeAuthField
 * @typedef {(value: AuthTranscript) => Uint8Array} BuildAuthTranscript
 * @typedef {(text: string) => unknown} ParseAuthJson
 * @typedef {(value: unknown) => AuthChallengeResponse} ParseAuthChallenge
 * @typedef {(text: string) => AuthMessage} ParseAuthMessage
 *
 * Local credential entry points. The staged record is persisted before the
 * first proof, so an interrupted pairing can be recovered from storage. A
 * candidate is promoted only after the committed proof verifies, and only
 * records that predate that commit are retired.
 *
 * @typedef {(input: string, now?: () => number) => LocalCredential} ParseLocalPairing
 * @typedef {() => Promise<LocalState>} ReadLocalState
 * @typedef {(credential: LocalCredential) => Promise<LocalCredential>} StageLocalCredential
 * @typedef {(expected: LocalCredential, pending: AuthRotation & { key: AuthKey }) => Promise<LocalCredential>} SaveLocalCandidate
 * @typedef {(expected: LocalCredential, rotation: AuthRotation) => Promise<LocalCredential>} PromoteLocalCandidate
 * @typedef {(expected: LocalCredential) => Promise<void>} DiscardStagedCredential
 * @typedef {(skip: boolean) => Promise<void>} SetSkipLocalVerification
 *
 * Remote authorization entry points. Pairing and renewal share one serialized
 * write path; the pending candidate is persisted before the credential
 * rotates so a lost reply can be retried with the same old/new pair. A
 * settings change during a request must not resurrect an older connection.
 *
 * @typedef {(endpoint: RemoteEndpoint) => Promise<RemoteEndpoint>} ActivateRemoteEndpoint
 * @typedef {(pairing: string | null) => Promise<string | null>} UpdateRemoteConnection
 * @typedef {() => Promise<string>} ResumeRemoteConnection
 * @typedef {() => Promise<void>} RenewRemoteAuthorization
 *
 * Remote storage entry points. A fresh local profile never opens the
 * credential database. Selecting local restores ordinary preference access
 * even when the database is unavailable, while a switch to remote is
 * published only after the credential is durable.
 *
 * @typedef {() => Promise<RemoteEndpoint | null>} ReadRemoteConnection
 * @typedef {(endpoint: RemoteEndpoint | null) => Promise<void>} WriteRemoteConnection
 * @typedef {() => Promise<void>} InitializeRemoteStorage
 * @typedef {() => Promise<RemoteEndpoint | null>} ReadSavedRemoteConnection
 *
 * Module surface contracts. Each object mirrors the exported namespace of one
 * transport module, so a consumer can describe a dynamically imported module
 * without listing every function separately. Constants are typed by their
 * literal value where the value is part of the protocol contract.
 *
 * @typedef {object} HandshakeApi
 * @property {string} PROTOCOL_VERSION
 * @property {string} EXTENSION_VERSION
 * @property {string} MIN_COMPATIBLE_PROTOCOL
 * @property {string} MIN_COMPATIBLE_PEER
 * @property {string} CLIENT_ID
 * @property {PerformHandshake} performHandshake
 * @property {DetectBrowserMeta} detectBrowserMeta
 *
 * @typedef {object} LocalAuthCryptoApi
 * @property {EncodeAuthField} encodeBytes
 * @property {DecodeAuthField} decodeBytes
 * @property {EncodeAuthGeneration} uint32
 * @property {EncodeAuthBytes} fields
 * @property {BuildAuthTranscript} transcript
 * @property {ProveAuthValue} prove
 * @property {VerifyAuthProof} verify
 * @property {RandomAuthBytes} randomBytes
 *
 * @typedef {object} LocalAuthProtocolApi
 * @property {number} MAX_AUTH_MESSAGE_BYTES
 * @property {number} MAX_AUTH_CREDENTIALS
 * @property {ParseAuthJson} parseAuthJson
 * @property {ParseAuthChallenge} parseChallenge
 * @property {ParseAuthMessage} parseAuthMessage
 *
 * @typedef {object} LocalAuthApi
 * @property {AuthenticateLocal} authenticateLocal
 * @property {CreateLocalAuthenticator} createLocalAuthenticator
 *
 * @typedef {object} LocalCredentialsApi
 * @property {number} STAGED_TTL_MS
 * @property {ParseLocalPairing} parseLocalPairing
 * @property {ReadLocalState} readLocalState
 * @property {StageLocalCredential} stageCredential
 * @property {SaveLocalCandidate} saveCandidate
 * @property {PromoteLocalCandidate} promoteCandidate
 * @property {DiscardStagedCredential} discardStaged
 * @property {SetSkipLocalVerification} setSkipLocalVerification
 *
 * @typedef {object} PairingVerifierApi
 * @property {VerifyLocalPairing} verifyLocalPairing
 *
 * @typedef {object} RemoteEndpointApi
 * @property {string} REMOTE_ENDPOINT_KEY
 * @property {string} REMOTE_AUTH_PROTOCOL_PREFIX
 * @property {ParseRemoteEndpoint} parseRemoteEndpoint
 * @property {ReadRemoteEndpoint} readRemoteEndpoint
 * @property {ReadRemoteAuthorizationStatus} remoteAuthorizationStatus
 * @property {RemoteSocketFactory} remoteSocket
 *
 * @typedef {object} RemoteStorageApi
 * @property {string} REMOTE_CONNECTION_REVISION
 * @property {string} REMOTE_CONNECTION_MODE
 * @property {CreateRemoteStorage} createRemoteStorage
 * @property {ReadRemoteConnection} readRemoteConnection
 * @property {WriteRemoteConnection} writeRemoteConnection
 * @property {InitializeRemoteStorage} initializeRemoteStorage
 * @property {ReadSavedRemoteConnection} readSavedRemoteConnection
 *
 * @typedef {object} RemoteAuthorizationApi
 * @property {CreateRemoteAuthorization} createRemoteAuthorization
 * @property {ActivateRemoteEndpoint} activateRemoteEndpoint
 * @property {UpdateRemoteConnection} updateRemoteConnection
 * @property {ResumeRemoteConnection} resumeRemoteConnection
 * @property {RenewRemoteAuthorization} renewRemoteAuthorization
 * @property {WatchRemoteAuthorization} watchRemoteAuthorization
 *
 * @typedef {object} DaemonEndpointModuleApi
 * @property {CreateDaemonEndpoint} createDaemonEndpoint
 * @property {DaemonPort} DEFAULT_DAEMON_PORT
 * @property {ResolveDaemonWsUrl} resolveDaemonWsUrl
 * @property {NormalizeDaemonPort} normalizeDaemonPort
 * @property {ParseDaemonPortInput} parseDaemonPortInput
 *
 * @typedef {object} CredentialDatabaseApi
 * @property {OpenCredentialDatabase} openCredentialDatabase
 *
 * @typedef {object} WSTransportApi
 * @property {WSTransportConstructor} WSTransport
 *
 * @typedef {object} FrameGuardApi
 * @property {FrameGuard} isRequestFrame
 * @property {FrameGuard} isResponseFrame
 * @property {FrameGuard} isEventFrame
 *
 * @typedef {object} TraceVersionApi
 * @property {3} TRACE_VERSION_V3
 * @property {2} TRACE_VERSION_V2
 * @property {1} VOM_FORMAT_VERSION
 */

export function isRequestFrame(frame) {
  return typeof frame?.method === 'string';
}

export function isResponseFrame(frame) {
  return typeof frame?.id === 'string' && ('result' in frame || 'error' in frame);
}

export function isEventFrame(frame) {
  return typeof frame?.event === 'string';
}
