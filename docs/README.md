# 文档

BridgeDeck 的文档分两层：用户文档说明怎么用，验证记录说明已经实现并验证了什么。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [架构](architecture.md) | CLI、daemon、扩展、会话与数据流 |
| [扩展与技能](extension-and-skill-guide.md) | 加载扩展、装技能、三种 Agent 接入方式与首跑流程 |
| [协议](PROTOCOL.md) | 消息帧、握手、方法表 |
| [本地配对](local-pairing.md) | 配对链接、凭据、严格模式 |
| [长截图](long-screenshot.md) | 自动、手动、可见区域与拼接 |
| [视频录制](video-recording.md) | MP4 分片、恢复、保存、清理 |
| [网站调试](website-debugging.md) | 请求、控制台、证据、规则、重放 |
| [操作审计](operation-audit.md) | 审计开关、任务列表、导出 |
| [MCP](mcp.md) | MCP server 与工具面 |
| [安全](security.md) | 本机边界、凭据、隐私 |
| [Windows 签名](windows-signing.md) | 自签、时间戳、安装器 |
| [排障](troubleshooting.md) | 常见失败与排查顺序 |

## 能力与验证

| 文档 | 说明 |
| --- | --- |
| [功能矩阵](FUNCTION-MATRIX.md) | CLI、MCP、插件与 SDK 的能力覆盖 |
| [当前状态](STATUS.md) | 测试计数、性能与运行环境 |
| [9 站实测](SITE-BENCH-BRIDGEDECK-1.9.md) | 主流站点上的观察、脚本、截图与会话启动数据 |
| [收官报告](FINAL-REPORT-2026-11-15.md) | 能力、性能、回归与后续方向的总结 |
| [运行时决策](RUNTIME-DECISION.md) | CLI / MCP / 插件直连 / 原生 thin client 的取舍与实测 |
| [剩余工作](REMAINING-GAPS.md) | 已知边界与后续计划 |
| [商店文案](STORE-LISTING.md) | 扩展商店描述 |
| [商店审核](STORE-REVIEW.md) | 审核材料与隐私说明 |

## 写作约定

- 只写 BridgeDeck 自己实现了什么、如何验证，不写与其他产品的对比。
- 标题只表达一个主题，正文先给结论再给细节。
- 命令、路径、字段名用代码格式。
- 状态表只写可验证事实，不写“应该”“大概”。
