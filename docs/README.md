# 文档

BridgeDeck 的文档分两层：用户文档说明怎么用，内部验证记录说明实现与对照状态。

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

## 内部验证

| 文档 | 说明 |
| --- | --- |
| [交付闭环](CLOSURE.md) | 当前交付范围与验证结果 |
| [镜像审计](SOURCE-PARITY.md) | 目录级行数覆盖 |
| [逐文件清单](PARITY-MANIFEST.md) | 每个对照文件的行数差 |
| [剩余差异](REMAINING-GAPS.md) | 仍然存在的行为/结构差异 |
| [功能矩阵](FUNCTION-MATRIX.md) | CLI、MCP、插件工具覆盖 |
| [UI 对照](UI-PARITY.md) | 弹窗结构与视觉对照 |
| [阶段状态](STATUS.md) | 当前阶段与测试计数 |
| [范围](SCOPE.md) | 交付边界 |
| [对照总览](PARITY.md) | 协议、工具与验证的总览 |
| [复刻矩阵](REPLICATION-MATRIX.md) | 文件级复刻关系 |
| [代码学习](CODE-LEARNINGS.md) | 关键实现与踩坑记录 |
| [商店文案](STORE-LISTING.md) | 扩展商店描述 |
| [商店审核](STORE-REVIEW.md) | 审核材料与隐私说明 |

## 写作约定

- 标题只表达一个主题，正文先给结论再给细节。
- 命令、路径、字段名用代码格式。
- 状态表只写可验证事实，不写“应该”“大概”。
- 用户文档不记录内部实现细节；内部验证文档不混入使用教程。
