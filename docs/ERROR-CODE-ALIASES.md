# 错误码兼容别名（外部线名 → 我方 canonical）

> 只做解析/恢复建议映射，不新增 canonical 错误码；未知输入仍落 `E_INTERNAL`。
> 用途：旧客户端或兼容调用方传入外部错误名时，`normalizeErrorCode`/`recoveryHint` 能稳定映射到可处理的我方错误码。

| 外部线名 | 我方 canonical |
| --- | --- |
| `cdp_failed` | `E_PAGE_ERROR` |
| `user_aborted` | `E_CANCELLED` |
| `agent_window_scope` | `E_UNSUPPORTED_FEATURE` |
| `download_path_mismatch` | `E_DOWNLOAD_FAILED` |
| `extract_field_ambiguous` | `E_OPTION_AMBIGUOUS` |
| `extract_structure_invalid` | `E_PAGE_ERROR` |
| `extract_target_ambiguous` | `E_OPTION_AMBIGUOUS` |
| `file_drop_failed` | `E_TRANSFER_STATE` |
| `file_drop_target_unavailable` | `E_TARGET_NOT_FILLABLE` |
| `file_input_not_activated` | `E_NO_FILE_CHOOSER` |
| `frame_unobservable` | `E_OBSERVE_FAILED` |
| `input_clock_unavailable` | `E_INTERNAL` |
| `input_paint_unconfirmed` | `E_EXEC_FAILED` |
| `loading_stalled` | `E_TIMEOUT` |
| `observe_identity_reload_loop` | `E_OBSERVE_FAILED` |
| `operation_settling` | `E_INPUT_BUSY` |
| `page_hidden` | `E_PAGE_ERROR` |
| `read_field_ambiguous` | `E_OPTION_AMBIGUOUS` |
| `ref_kind_unsupported` | `E_UNSUPPORTED_FEATURE` |
| `set_file_input_failed` | `E_NO_FILE_CHOOSER` |
| `tab_not_active` | `E_NO_TAB` |
| `ui_lookup_failed` | `E_OBSERVE_FAILED` |
| `user_moved_tab` | `E_TARGET_DETACHED` |
| `window_resize_constrained` | `E_ARG_RANGE` |
| `window_resize_inactive_tab` | `E_NO_TAB` |
| `window_resize_unconfirmed` | `E_EXEC_FAILED` |
| `window_resize_viewport_unchanged` | `E_EXEC_FAILED` |

入口：`lib/error-codes.mjs` 的 `ERROR_CODE_ALIASES` / `resolveErrorCode`；单测：`tests/unit/error-code-aliases.test.mjs`。
