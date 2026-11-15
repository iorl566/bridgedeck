# 当前状态

最后更新：2026-11-15（BridgeDeck 0.1.3，协议 1.9）

## 已验证

| 项 | 结果 |
| --- | --- |
| 真实 Edge E2E | 141/143（2 项按借用确认安全策略跳过） |
| 纯函数单测 | 955/955 |
| CLI selftest | 155/155 |
| 宿主插件 | 26/26 |
| 插件直连冒烟（真实 Edge） | 11/11，0 次 CLI 回退 |
| MCP selftest | 10/10 |
| Node / Python SDK | 8/8 / 8/8 |
| protocol-check | 全绿 |
| 发布清单 | 4 artifacts（含 Ed25519 签名） |

## 性能（050g，9 站中位）

| 指标 | 数值 |
| --- | --- |
| 导航 | 1166 ms |
| 观察 | 186 ms |
| 脚本验证型 | 156 ms |
| 截图 | 358 ms |
| 会话启动 | 367 ms |
| MCP observe | 12 ms |
| 插件直连 observe（warm） | 9 ms |

## 环境

- Windows + Node 22，Edge 157（未登录测试配置）。
- 扩展 0.1.3，daemon 本机单实例，协议 `1.9`。
- 运行时零依赖；MCP 51 工具、DSH 插件 35 工具、Node/Python SDK。

## 已知边界

- CLI 冷启动 72–86ms，受 Node 运行时限制；推荐 MCP/插件常驻路径。
- 视口截图 358ms，主要受 CDP PNG 编码限制。
- 观察主遍历仍为 page-lib；`--compare-ax` 提供 AX 覆盖率基线与降级路径。
- 真实反爬站点在当前网络环境不可达，本地靶场已覆盖核心检测项。
