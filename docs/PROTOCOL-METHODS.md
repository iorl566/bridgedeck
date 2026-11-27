# 协议方法索引（自动生成）

由 `node tools/gen-protocol.mjs` 生成（`tools/protocol-sections.mjs --write` 等价）；新增/删除方法后重新生成，不要手改。
单一源：`lib/method-catalog.mjs`（owner/effect/feature floor/五维状态）；schema 键由 `lib/schemas.mjs` 派生。
本文件的索引表是 `tools/protocol-single-source.mjs` 的审计对象；特性门与方法状态机为只读快照。

## daemon 本地方法（owner=local）

| 方法 | 副作用 | scope |
| --- | --- | --- |
| `audit.list` | read | local |
| `browsers` | read | local |
| `cancel` | read | local |
| `command.cancel` | read | local |
| `daemon.stop` | read | local |
| `inflight.list` | read | local |
| `ledger.request` | read | local |
| `ledger.resolve` | read | local |
| `ledger.status` | read | local |
| `local.pair` | read | local |
| `local.trust` | read | local |
| `operations.get` | read | local |
| `operations.list` | read | local |
| `pair.create` | read | local |
| `pair.list` | read | local |
| `pair.redeem` | read | local |
| `pair.renew` | read | local |
| `pair.revoke` | read | local |
| `pair.rotate` | read | local |
| `session.claim_control` | read | local |
| `session.control_mode` | read | local |
| `session.control_status` | read | local |
| `session.handoff` | read | local |
| `session.list` | read | local |
| `session.pause` | mutation | local |
| `session.rebind` | mutation | local |
| `session.release_control` | read | local |
| `session.request_cancel` | read | local |
| `session.request_claim` | read | local |
| `session.request_prepare` | read | local |
| `session.request_status` | read | local |
| `session.resume` | read | local |
| `session.run_log` | read | local |
| `session.start` | mutation | local |
| `session.start_tracked` | mutation | local |
| `session.stop` | mutation | local |
| `session.stop_all` | read | local |
| `settings.get` | read | local |
| `settings.set` | read | local |
| `status` | read | local |
| `transfer.begin` | read | local |
| `transfer.chunk` | read | local |
| `transfer.finish` | read | local |
| `transfer.read` | read | local |
| `transfer.release` | read | local |
| `view` | read | local |

## 会话方法（owner=session → 扩展）

| 方法 | 副作用 | scope |
| --- | --- | --- |
| `actionable` | read | session |
| `blur` | mutation | session |
| `click` | mutation | session |
| `click-backend` | mutation | session |
| `click-point` | mutation | session |
| `console` | read | session |
| `cooperate.handback` | read | session |
| `cooperate.hold` | read | session |
| `cooperate.sync` | read | session |
| `cooperate.wait` | read | session |
| `debug.capabilities` | read | session |
| `debug.coverage` | read | session |
| `debug.current` | read | session |
| `debug.delete` | read | session |
| `debug.fetch_probe` | mutation | session |
| `debug.history` | read | session |
| `debug.performance` | read | session |
| `debug.pin` | mutation | session |
| `debug.pinned` | read | session |
| `debug.request` | read | session |
| `debug.rule_add` | mutation | session |
| `debug.rule_clear` | mutation | session |
| `debug.rule_disable` | mutation | session |
| `debug.rule_enable` | mutation | session |
| `debug.rule_export` | read | session |
| `debug.rule_import` | mutation | session |
| `debug.rule_list` | read | session |
| `debug.rule_remove` | mutation | session |
| `debug.start` | mutation | session |
| `debug.stop` | mutation | session |
| `dialog.accept` | mutation | session |
| `dialog.arm` | mutation | session |
| `dialog.disarm` | mutation | session |
| `dialog.dismiss` | mutation | session |
| `dialog.handle` | mutation | session |
| `dialog.list` | read | session |
| `dialog.status` | read | session |
| `download` | mutation | session |
| `drag` | mutation | session |
| `emulate` | mutation | session |
| `evaluate` | mutation | session |
| `extract` | read | session |
| `extract.discover` | read | session |
| `extract.list` | read | session |
| `extract.table` | read | session |
| `fill` | mutation | session |
| `focus` | mutation | session |
| `get-html` | read | session |
| `hover` | mutation | session |
| `longshot.recover` | read | session |
| `navigate` | mutation | session |
| `navigate-back` | mutation | session |
| `navigate-forward` | mutation | session |
| `network.detail` | read | session |
| `network.list` | read | session |
| `network.replay` | mutation | session |
| `network.start` | mutation | session |
| `network.stop` | mutation | session |
| `network.waterfall` | read | session |
| `observe` | read | session |
| `observe-frames` | read | session |
| `operation.await` | read | session |
| `operation.cancel` | read | session |
| `pdf` | read | session |
| `plan` | mutation | session |
| `press` | mutation | session |
| `read` | read | session |
| `record.list` | read | session |
| `record.start` | mutation | session |
| `record.status` | read | session |
| `record.stop` | mutation | session |
| `refs.negotiate` | read | session |
| `reload` | mutation | session |
| `request-help` | mutation | session |
| `screenshot` | read | session |
| `screenshot.manual.frame` | mutation | session |
| `screenshot.manual.save` | mutation | session |
| `screenshot.manual.start` | mutation | session |
| `screenshot.read` | read | session |
| `screenshot.release` | read | session |
| `scroll-to` | mutation | session |
| `select` | mutation | session |
| `shadow.click` | mutation | session |
| `shadow.read` | read | session |
| `snapshot` | read | session |
| `step` | mutation | session |
| `tab.borrow` | mutation | session |
| `tab.policy` | read | session |
| `tab.return` | mutation | session |
| `trace.start` | mutation | session |
| `trace.status` | read | session |
| `trace.stop` | mutation | session |
| `upload` | mutation | session |
| `video.discard` | mutation | session |
| `video.fetch` | mutation | session |
| `video.list` | read | session |
| `video.prune` | read | session |
| `video.recover` | mutation | session |
| `video.start` | mutation | session |
| `video.status` | read | session |
| `video.stop` | mutation | session |
| `video.verify` | read | session |
| `wait-for-element` | read | session |
| `wait-for-navigation` | read | session |
| `wait-ms` | read | session |
| `webmcp.call` | mutation | session |
| `webmcp.list` | read | session |
| `wheel` | mutation | session |
| `window.resize` | mutation | session |

## 实例方法（owner=instance → 扩展）

| 方法 | 副作用 | scope |
| --- | --- | --- |
| `control-hint` | mutation | instance |
| `debugger.detach` | mutation | instance |
| `debugger.simulate-detach` | mutation | instance |
| `diagnostics.ui` | read | instance |
| `tab.alias` | read | instance |
| `tab.cleanup` | mutation | instance |
| `tab.close` | mutation | instance |
| `tab.list` | read | instance |
| `tab.move` | mutation | instance |
| `tab.new` | mutation | instance |
| `tab.select` | mutation | instance |
| `ui.open` | read | instance |
| `window.close` | mutation | instance |
| `window.ensureAgent` | mutation | instance |
| `window.focus` | mutation | instance |
| `window.list` | read | instance |
| `window.newAgent` | mutation | instance |

## 特性门与最低协议版本（15 个，当前协议 1.9，兼容基线 1.8）

| 特性 | 最低协议 | 标签 | 触发 |
| --- | --- | --- | --- |
| `unverified` | 1.9 | 未校验执行 | 参数 unverified |
| `expect` | 1.9 | 期望断言 | 参数 expect |
| `read` | 1.9 | 确定性读取 | 方法级 1 个 |
| `observe-delta` | 1.9 | 观察增量 | 参数 delta |
| `plan` | 1.9 | 计划执行 | 方法级 1 个 |
| `video` | 1.9 | 视频录制 | 方法级 9 个 |
| `capture.stream` | 1.9 | 流式截图 | 方法级 3 个 + 参数 stream/segmented/staleAttempts |
| `debug.journal` | 1.9 | 调试日志持久化 | 方法级 4 个 |
| `har` | 1.9 | HAR 重放 | 方法级 1 个 |
| `borrow_confirmation_timeout` | 1.9 | 借用确认超时 | 参数 confirmationTimeoutMs |
| `interaction_policy` | 1.9 | 人工介入策略 | 方法级 1 个 |
| `incognito_sessions` | 1.9 | 无痕会话 | 参数 incognito |
| `dialog_control` | 1.9 | 对话框控制 | 方法级 9 个 |
| `click_move_click` | 1.9 | 点击-移动-点击拖拽 | 参数 mode |
| `target_control` | 1.9 | 目标控制策略 | 参数 control_policy/policy |

## 方法状态机（五维快照）

partial=结果可能部分返回；unknown=派发后可能无法证明是否生效；reconcile=unknown 后的收敛策略。

| 方法 | owner | effect | partial | unknown | reconcile |
| --- | --- | --- | --- | --- | --- |
| `actionable` | session | passive_read | no | no | none |
| `audit.list` | local | control_plane | no | no | none |
| `blur` | session | browser_mutation | no | yes | observe |
| `browsers` | local | control_plane | no | no | none |
| `click` | session | browser_mutation | no | yes | observe |
| `click-backend` | session | browser_mutation | no | yes | observe |
| `click-point` | session | browser_mutation | no | yes | observe |
| `console` | session | passive_read | yes | no | none |
| `control-hint` | instance | browser_mutation | no | yes | observe |
| `cooperate.handback` | session | control_plane | no | no | none |
| `cooperate.hold` | session | control_plane | no | no | none |
| `cooperate.sync` | session | passive_read | no | no | none |
| `cooperate.wait` | session | control_plane | no | no | none |
| `daemon.stop` | local | control_plane | no | no | none |
| `debug.capabilities` | session | control_plane | no | no | none |
| `debug.coverage` | session | passive_read | no | no | none |
| `debug.current` | session | passive_read | no | no | none |
| `debug.delete` | session | control_plane | no | no | none |
| `debug.fetch_probe` | session | browser_mutation | no | yes | observe |
| `debug.history` | session | control_plane | no | no | none |
| `debug.performance` | session | passive_read | no | no | none |
| `debug.pin` | session | browser_mutation | no | yes | observe |
| `debug.pinned` | session | control_plane | no | no | none |
| `debug.request` | session | passive_read | no | no | none |
| `debug.rule_add` | session | browser_mutation | no | yes | observe |
| `debug.rule_clear` | session | browser_mutation | no | yes | observe |
| `debug.rule_disable` | session | browser_mutation | no | yes | observe |
| `debug.rule_enable` | session | browser_mutation | no | yes | observe |
| `debug.rule_export` | session | passive_read | no | no | none |
| `debug.rule_import` | session | browser_mutation | no | yes | observe |
| `debug.rule_list` | session | passive_read | no | no | none |
| `debug.rule_remove` | session | browser_mutation | no | yes | observe |
| `debug.start` | session | browser_mutation | no | yes | status:debug.current |
| `debug.stop` | session | browser_mutation | no | yes | status:debug.current |
| `debugger.detach` | instance | browser_mutation | no | yes | observe |
| `debugger.simulate-detach` | instance | browser_mutation | no | yes | observe |
| `diagnostics.ui` | instance | control_plane | no | no | none |
| `dialog.accept` | session | browser_mutation | no | yes | status:dialog.status |
| `dialog.arm` | session | browser_mutation | no | yes | observe |
| `dialog.disarm` | session | browser_mutation | no | yes | observe |
| `dialog.dismiss` | session | browser_mutation | no | yes | status:dialog.status |
| `dialog.handle` | session | browser_mutation | no | yes | status:dialog.status |
| `dialog.list` | session | control_plane | no | no | none |
| `dialog.status` | session | control_plane | no | no | none |
| `download` | session | browser_mutation | no | yes | observe |
| `drag` | session | browser_mutation | no | yes | observe |
| `emulate` | session | browser_mutation | no | yes | observe |
| `evaluate` | session | browser_mutation | no | yes | observe |
| `extract` | session | passive_read | yes | no | none |
| `extract.discover` | session | passive_read | yes | no | none |
| `extract.list` | session | passive_read | yes | no | none |
| `extract.table` | session | passive_read | yes | no | none |
| `fill` | session | browser_mutation | no | yes | observe |
| `focus` | session | browser_mutation | no | yes | observe |
| `get-html` | session | passive_read | no | no | none |
| `hover` | session | transient_input | no | yes | observe |
| `local.pair` | local | control_plane | no | no | none |
| `local.trust` | local | control_plane | no | no | none |
| `longshot.recover` | session | passive_read | yes | no | none |
| `navigate` | session | browser_mutation | no | yes | observe |
| `navigate-back` | session | browser_mutation | no | yes | observe |
| `navigate-forward` | session | browser_mutation | no | yes | observe |
| `network.detail` | session | passive_read | no | no | none |
| `network.list` | session | passive_read | yes | no | none |
| `network.replay` | session | browser_mutation | no | yes | observe |
| `network.start` | session | browser_mutation | no | yes | observe |
| `network.stop` | session | browser_mutation | no | yes | observe |
| `network.waterfall` | session | passive_read | yes | no | none |
| `observe` | session | passive_read | yes | no | none |
| `observe-frames` | session | passive_read | yes | no | none |
| `operation.await` | session | passive_read | no | no | none |
| `operation.cancel` | session | control_plane | no | no | none |
| `operations.get` | local | control_plane | no | no | none |
| `operations.list` | local | control_plane | no | no | none |
| `pair.create` | local | control_plane | no | no | none |
| `pair.list` | local | control_plane | no | no | none |
| `pair.redeem` | local | control_plane | no | no | none |
| `pair.renew` | local | control_plane | no | no | none |
| `pair.revoke` | local | control_plane | no | no | none |
| `pdf` | session | passive_read | no | no | none |
| `plan` | session | control_plane | no | yes | ledger |
| `press` | session | browser_mutation | no | yes | observe |
| `read` | session | passive_read | no | no | none |
| `record.list` | session | control_plane | no | no | none |
| `record.start` | session | browser_mutation | no | yes | status:record.status |
| `record.status` | session | control_plane | no | no | none |
| `record.stop` | session | browser_mutation | no | yes | status:record.status |
| `refs.negotiate` | session | passive_read | no | no | none |
| `reload` | session | browser_mutation | no | yes | observe |
| `request-help` | session | browser_mutation | no | yes | observe |
| `screenshot` | session | passive_read | yes | no | none |
| `screenshot.manual.frame` | session | browser_mutation | no | yes | observe |
| `screenshot.manual.save` | session | browser_mutation | no | yes | observe |
| `screenshot.manual.start` | session | browser_mutation | no | yes | observe |
| `screenshot.read` | session | passive_read | yes | no | none |
| `screenshot.release` | session | passive_read | no | no | none |
| `scroll-to` | session | browser_mutation | no | yes | observe |
| `select` | session | browser_mutation | no | yes | observe |
| `session.claim_control` | local | control_plane | no | no | none |
| `session.control_mode` | local | control_plane | no | no | none |
| `session.control_status` | local | control_plane | no | no | none |
| `session.handoff` | local | control_plane | no | no | none |
| `session.list` | local | control_plane | no | no | none |
| `session.pause` | local | control_plane | no | yes | ledger |
| `session.rebind` | local | control_plane | no | yes | ledger |
| `session.release_control` | local | control_plane | no | no | none |
| `session.request_cancel` | local | control_plane | no | no | none |
| `session.request_claim` | local | control_plane | no | no | none |
| `session.request_prepare` | local | control_plane | no | no | none |
| `session.request_status` | local | passive_read | no | no | none |
| `session.resume` | local | control_plane | no | no | none |
| `session.run_log` | local | passive_read | no | no | none |
| `session.start` | local | control_plane | no | yes | ledger |
| `session.start_tracked` | local | control_plane | no | yes | ledger |
| `session.stop` | local | control_plane | no | yes | ledger |
| `session.stop_all` | local | control_plane | no | no | none |
| `settings.get` | local | control_plane | no | no | none |
| `settings.set` | local | control_plane | no | no | none |
| `shadow.click` | session | browser_mutation | no | yes | observe |
| `shadow.read` | session | passive_read | no | no | none |
| `snapshot` | session | passive_read | no | no | none |
| `status` | local | control_plane | no | no | none |
| `step` | session | browser_mutation | no | yes | observe |
| `tab.alias` | instance | control_plane | no | no | none |
| `tab.borrow` | session | browser_mutation | no | yes | status:tab.list |
| `tab.cleanup` | instance | browser_mutation | no | yes | status:tab.list |
| `tab.close` | instance | browser_mutation | no | yes | status:tab.list |
| `tab.list` | instance | control_plane | no | no | none |
| `tab.move` | instance | browser_mutation | no | yes | status:tab.list |
| `tab.new` | instance | browser_mutation | no | yes | status:tab.list |
| `tab.policy` | session | control_plane | no | no | none |
| `tab.return` | session | browser_mutation | no | yes | status:tab.list |
| `tab.select` | instance | browser_mutation | no | yes | status:tab.list |
| `trace.start` | session | browser_mutation | no | yes | status:trace.status |
| `trace.status` | session | passive_read | no | no | none |
| `trace.stop` | session | browser_mutation | no | yes | status:trace.status |
| `transfer.begin` | local | control_plane | no | no | none |
| `transfer.chunk` | local | control_plane | no | no | none |
| `transfer.finish` | local | control_plane | no | no | none |
| `transfer.read` | local | control_plane | no | no | none |
| `transfer.release` | local | control_plane | no | no | none |
| `ui.open` | instance | control_plane | no | no | none |
| `upload` | session | browser_mutation | no | yes | observe |
| `video.discard` | session | browser_mutation | no | yes | status:video.list |
| `video.fetch` | session | browser_mutation | no | yes | status:video.status |
| `video.list` | session | control_plane | no | no | none |
| `video.prune` | session | control_plane | no | no | none |
| `video.recover` | session | browser_mutation | no | yes | status:video.status |
| `video.start` | session | browser_mutation | no | yes | status:video.status |
| `video.status` | session | control_plane | no | no | none |
| `video.stop` | session | browser_mutation | no | yes | status:video.status |
| `video.verify` | session | read | no | no | none |
| `view` | local | passive_read | no | no | none |
| `wait-for-element` | session | passive_read | no | no | none |
| `wait-for-navigation` | session | passive_read | no | no | none |
| `wait-ms` | session | passive_read | no | no | none |
| `webmcp.call` | session | browser_mutation | no | yes | observe |
| `webmcp.list` | session | read | no | no | none |
| `wheel` | session | browser_mutation | no | yes | observe |
| `window.close` | instance | browser_mutation | no | yes | status:window.list |
| `window.ensureAgent` | instance | browser_mutation | no | yes | status:window.list |
| `window.focus` | instance | browser_mutation | no | yes | status:window.list |
| `window.list` | instance | control_plane | no | no | none |
| `window.newAgent` | instance | browser_mutation | no | yes | status:window.list |
| `window.resize` | session | browser_mutation | no | yes | status:window.list |
