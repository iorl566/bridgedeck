# BSK 0.5.0 代码研读索引

源目录：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`。
目标：为 BridgeDeck 提炼可执行的不变量，而不是复制框架。

## 子系统笔记

| 笔记 | 覆盖 |
| --- | --- |
| [extension-transport-session.md](bsk-study/extension-transport-session.md) | WebSocket 传输、generation、握手、session 状态机、tab 所有权 |
| [cdp-attachment-focus-frames.md](bsk-study/cdp-attachment-focus-frames.md) | CDP attach/soft-detach、焦点/可见性、frame graph、跨帧几何、target 选择 |
| [observation-vom.md](bsk-study/observation-vom.md) | VOM 捕获漏斗、ref identity、layers、delta/cursor、token budget |
| [input-transactions-and-file-transfer.md](bsk-study/input-transactions-and-file-transfer.md) | 输入事务、hit-test、press/release、上传/下载/文件事务 |
| [shared-control.md](bsk-study/shared-control.md) | 人机协作状态机、borrow、target marker、capture suppression、passthrough |
| [capture-video-debug.md](bsk-study/capture-video-debug.md) | 长截图分片、视频编码/恢复、debug journal/归档/脱敏 |
| [extension-overlay-ui-i18n.md](bsk-study/extension-overlay-ui-i18n.md) | overlay 双权威状态、epoch/generation、主题、i18n 完整性 |
| [daemon-ipc-lifecycle.md](bsk-study/daemon-ipc-lifecycle.md) | daemon lock/probe、进程生命周期、IPC、队列、安装 |
| [protocol-schema-versioning.md](bsk-study/protocol-schema-versioning.md) | method 目录、schema、两轴版本、错误 taxonomy、兼容性 |
| [eval-harness-test-pyramid.md](bsk-study/eval-harness-test-pyramid.md) | 测试金字塔、fake adapter、case JSON、tri-state oracle、CI |
| [dsh-plugin-subsystem.md](bsk-study/dsh-plugin-subsystem.md) | DSH 插件 router、runner、journal、session 生命周期 |
| [docs-style.md](bsk-study/docs-style.md) | 文档作为契约、命名/错误/生成物规范 |

## 量化

| 指标 | BSK 0.5.0 | BridgeDeck 0.1.8 |
| --- | ---: | ---: |
| 扩展源码（含测试） | 557 文件 / 188,904 行 / 7.89 MB | 118 运行时 JS / 约 2.8 万行 / 约 1.25 MB |
| CLI crate | 177 文件 / 87,079 行 | `cli/` 5,983 行 + `daemon/` 3,091 行 |
| 协议 crate | 39 文件 / 9,643 行 | `lib/` 约 4.6k 行 |
| VOM 包 | 11 文件 / 5,370 行 | 无独立包；观察在 `extension/src/tools/observation.js` |
| 测试/评测 | 255 test 文件 + 24 eval case | 469 运行时单测 + 507 参考 + E2E |

## 结论

BSK 的体量主要买到了：异步身份/fence、浏览器焦点与可见性、跨帧几何、完整 capture/协作
状态机、评测语料。BridgeDeck 不应复制 9 万行，而应移植这些**不变量**，用更小的模块和
fake adapter 测试实现。

主理论文档：[CODE-THEORY.md](CODE-THEORY.md)。
