# BSK 0.5.0 wire 方法表（0.4 迁移基线）

> 由 `0.4/packages/protocol/scripts/report-methods.mjs` 从 `methods-bsk.js` 生成；
> 源头为 BSK `crates/bsk-protocol/src/method.rs`。

共 **77** 个方法。

| # | 方法 | owner | effect | action metadata | features | params contract | result contract |
| ---: | --- | --- | --- | :---: | --- | --- | --- |
| 1 | `tool.cooperate` | extension | control_plane | — | target_control | CooperateParams | — |
| 2 | `local_auth.pair` | daemon | control_plane | — | — | — | — |
| 3 | `local_auth.devices` | daemon | control_plane | — | — | — | — |
| 4 | `local_auth.revoke` | daemon | control_plane | — | — | — | — |
| 5 | `local_auth.rotate` | daemon | control_plane | — | — | — | — |
| 6 | `local_auth.set_mode` | daemon | control_plane | — | — | — | — |
| 7 | `audit.request` | daemon | control_plane | — | — | — | — |
| 8 | `ledger.request` | daemon | control_plane | — | — | — | — |
| 9 | `system.handshake` | daemon | control_plane | — | — | HandshakeRequest | HandshakeResponse |
| 10 | `system.ping` | daemon | control_plane | — | — | PingParams | PingResult |
| 11 | `system.status` | daemon | control_plane | — | — | StatusParams | StatusResult |
| 12 | `session.start` | daemon | control_plane | — | incognito_sessions | — | — |
| 13 | `session.start_tracked` | daemon | control_plane | — | incognito_sessions | — | — |
| 14 | `session.request` | daemon | control_plane | — | — | — | — |
| 15 | `session.stop` | daemon | control_plane | — | — | — | — |
| 16 | `session.stop_all` | daemon | control_plane | — | — | — | — |
| 17 | `session.list` | daemon | control_plane | — | — | — | — |
| 18 | `session.run_log` | daemon | control_plane | — | — | — | — |
| 19 | `browser.list` | daemon | control_plane | — | — | BrowserListParams | — |
| 20 | `tool.session_start` | extension | control_plane | — | incognito_sessions | SessionStartParams | SessionStartResult |
| 21 | `tool.session_stop` | extension | control_plane | — | — | SessionStopParams | SessionStopOutcome |
| 22 | `tool.window_resize` | extension | browser_mutation | yes | action_conditions | WindowResizeParams | WindowResizeResult |
| 23 | `tool.emulate` | extension | browser_mutation | yes | action_conditions | EmulateParams | EmulateResult |
| 24 | `tool.tab_list` | extension | passive_read | — | — | TabListParams | TabListResult |
| 25 | `tool.tab_create` | extension | browser_mutation | — | — | TabCreateParams | TabCreateResult |
| 26 | `tool.tab_close` | extension | browser_mutation | yes | action_conditions | TabCloseParams | TabCloseResult |
| 27 | `tool.tab_borrow` | extension | browser_mutation | — | borrow_confirmation_timeout | TabBorrowParams | TabBorrowResult |
| 28 | `tool.tab_return` | extension | browser_mutation | — | — | TabReturnParams | TabReturnResult |
| 29 | `tool.tab_select` | extension | browser_mutation | — | — | TabSelectParams | TabSelectResult |
| 30 | `tool.navigate` | extension | browser_mutation | yes | action_conditions | NavigateParams | NavigateResult |
| 31 | `tool.navigate_back` | extension | browser_mutation | yes | action_conditions | NavigateBackParams | NavigateBackResult |
| 32 | `tool.navigate_forward` | extension | browser_mutation | yes | action_conditions | NavigateForwardParams | NavigateForwardResult |
| 33 | `tool.reload` | extension | browser_mutation | yes | action_conditions | ReloadParams | ReloadResult |
| 34 | `tool.click` | extension | browser_mutation | yes | action_conditions | ClickParams | ClickResult |
| 35 | `tool.hover` | extension | transient_input | yes | action_conditions | HoverParams | HoverResult |
| 36 | `tool.drag` | extension | browser_mutation | yes | click_move_click, action_conditions | DragParams | DragResult |
| 37 | `tool.wheel` | extension | browser_mutation | yes | action_conditions | WheelParams | WheelResult |
| 38 | `tool.scroll_to` | extension | browser_mutation | yes | action_conditions | ScrollToParams | ScrollToResult |
| 39 | `tool.focus` | extension | browser_mutation | yes | action_conditions | FocusParams | FocusResult |
| 40 | `tool.blur` | extension | browser_mutation | yes | action_conditions | BlurParams | BlurResult |
| 41 | `tool.fill` | extension | browser_mutation | yes | action_conditions | FillParams | FillResult |
| 42 | `tool.press` | extension | browser_mutation | yes | action_conditions | PressParams | PressResult |
| 43 | `tool.select` | extension | browser_mutation | yes | action_conditions | SelectParams | SelectResult |
| 44 | `tool.upload` | extension | browser_mutation | yes | action_conditions | UploadParams | UploadResult |
| 45 | `tool.download` | extension | browser_mutation | yes | action_conditions | DownloadParams | DownloadResult |
| 46 | `tool.snapshot` | extension | passive_read | — | — | SnapshotParams | SnapshotResult |
| 47 | `tool.observe` | extension | transient_input | yes | action_conditions | ObserveParams | ObserveResult |
| 48 | `tool.get_html` | extension | passive_read | — | — | GetHtmlParams | GetHtmlResult |
| 49 | `tool.read` | extension | passive_read | — | dom_read | ReadParams | ReadResult |
| 50 | `tool.extract` | extension | passive_read | — | — | ExtractParams | ExtractResult |
| 51 | `tool.screenshot` | extension | passive_read | — | — | ScreenshotParams | ScreenshotResult |
| 52 | `tool.screenshot_full_page` | extension | transient_input | yes | action_conditions | ScreenshotFullPageParams | ScreenshotFullPageResult |
| 53 | `tool.screenshot_read` | extension | passive_read | — | — | ScreenshotReadParams | ScreenshotReadResult |
| 54 | `tool.screenshot_release` | extension | control_plane | — | — | ScreenshotReleaseParams | ScreenshotReleaseResult |
| 55 | `tool.console` | extension | passive_read | — | — | ConsoleParams | ConsoleResult |
| 56 | `tool.debug` | extension | control_plane | yes | action_conditions | DebugParams | DebugResult |
| 57 | `tool.network` | extension | passive_read | — | — | NetworkParams | NetworkResult |
| 58 | `tool.evaluate` | extension | browser_mutation | yes | unverified_script, action_conditions | EvaluateParams | EvaluateResult |
| 59 | `tool.dialog_status` | extension | passive_read | — | dialog_control | DialogStatusParams | DialogStatusResult |
| 60 | `tool.dialog_accept` | extension | browser_mutation | — | dialog_control | DialogHandleParams | DialogHandleResult |
| 61 | `tool.dialog_dismiss` | extension | control_plane | — | dialog_control | DialogHandleParams | DialogHandleResult |
| 62 | `tool.operation_await` | daemon | passive_read | — | dialog_control | OperationParams | — |
| 63 | `tool.operation_cancel` | daemon | control_plane | — | dialog_control | OperationParams | CancelResult |
| 64 | `tool.wait_for_navigation` | extension | passive_read | — | — | WaitForNavigationParams | WaitForNavigationResult |
| 65 | `tool.wait_for_element` | extension | passive_read | — | — | WaitForElementParams | WaitForElementResult |
| 66 | `tool.wait_ms` | daemon | passive_read | — | — | WaitMsParams | WaitMsResult |
| 67 | `tool.request_help` | extension | passive_read | — | interaction_policy | RequestHelpParams | RequestHelpResult |
| 68 | `tool.record_start` | extension | browser_mutation | — | — | RecordStartParams | RecordStartResult |
| 69 | `tool.record_stop` | extension | passive_read | — | — | RecordStopParams | RecordStopResult |
| 70 | `tool.record_await` | extension | passive_read | — | — | RecordAwaitParams | RecordAwaitResult |
| 71 | `tool.video` | extension | control_plane | — | — | VideoParams | VideoResult |
| 72 | `transfer.begin` | daemon | control_plane | — | — | — | — |
| 73 | `transfer.chunk` | daemon | control_plane | — | — | — | — |
| 74 | `transfer.finish` | daemon | control_plane | — | — | — | — |
| 75 | `transfer.read` | daemon | control_plane | — | — | — | — |
| 76 | `transfer.release` | daemon | control_plane | — | — | — | — |
| 77 | `cancel` | shared | control_plane | — | — | CancelParams | CancelResult |
