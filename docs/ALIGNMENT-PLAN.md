# 与 BSK / OpenCode Browse 的“体量差距”拆解与对齐计划

日期：2026-11-18。对照源码：

- BSK 0.5.0：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`
- OpenCode Browse dev：`ref/opencode-browse-dev/browse-dev`
- BridgeDeck 0.3.0：当前工作树

> 行数包含测试/生成物，只用于解释复杂度来源，不等于能力，也不应成为“追平”目标。

## 1. 代码体量分布（按子系统）

| BSK 子系统 | 文件 | 行数 | 对应能力 |
| --- | ---: | ---: | --- |
| apps/extension/src/tools | 184 | 84,007 | 观察/VOM、动作、长截图、video、debug、eval 工具 |
| apps/extension/src/transport | 35 | 20,335 | WebSocket/握手/generation/session 生命周期 |
| apps/extension/src/cooperation | 22 | 14,441 | 人类/Agent 状态机、authority、capture suppression |
| apps/extension/src/entrypoints | 58 | 12,507 | MV3 各入口/消息路由/注入 |
| apps/extension/src/lib | 86 | 11,341 | 通用库 |
| apps/extension/src/debug | 38 | 10,792 | debug journal/network/coverage |
| apps/extension/src/content | 32 | 10,301 | 页面侧采集/输入/协作 |
| apps/extension/src/browser-driver | 12 | 7,602 | CDP attachment/frame graph |
| apps/extension/src/session-manager | 25 | 6,130 | session/ref store |
| apps/extension/src/long-screenshot | 28 | 5,866 | 磁盘分片/拼接/页脚 |
| apps/extension/src/video | 33 | 5,297 | fragmented 录制/恢复 |
| packages/vom | 11 | 5,370 | VOM 独立包 |
| packages/dsh-plugin | 81 | 25,407 | DSH 插件 |
| evals/browser | 59 | 10,687 | eval case/oracle/fixtures |

| OpenCode Browse 子系统 | 文件 | 行数 | 对应能力 |
| --- | ---: | ---: | --- |
| rust/browse-page | 21 | 18,929 | 快照/refs/动作/拟人输入 |
| rust/browse-relay | 28 | 9,491 | relay/tab/配对/handoff |
| rust/browse | 23 | 8,330 | CLI/MCP/安装矩阵/协议 |
| rust/browse-capture | 18 | 6,536 | 截图/差分/录制/network |
| rust/browse-script | 12 | 2,922 | QuickJS execute 沙箱 |
| test + stress | 70 | ~8,300 | 真实浏览器/压力/隐身 |

| BridgeDeck | 文件 | 行数 | 对应能力 |
| --- | ---: | ---: | --- |
| extension/src（运行时） | 136 | 23,090 | 扩展主体 |
| extension/src/tools | 16 | 2,532 | 观察/动作 |
| extension/src/browser-driver | 14 | 2,511 | CDP 驱动 |
| cooperation（含 content） | 10 | 1,083 | 协作 |
| VOM/观察相关 | 10 | 1,142 | 观察/视觉 |
| CLI | 2 | 5,990 | CLI |
| daemon | 1 | 3,155 | daemon |
| lib | 59 | 4,916 | 协议/工具库 |
| MCP | 1 | 935 | MCP server |
| DSH plugin | 8 | 1,591 | 插件 |
| 测试 | — | 563 单测 + 507 reference + 175 E2E + 88 eval | 门禁 |

**结论**：我们的“扩展”只占 BSK 的 1/6、Browse 的约 1/4；但差距主要不在 UI 或脚手架，而在
**tools/transport/cooperation/debug/capture 这些高复杂度子系统**。

## 2. 他们大在哪里（代码分布说明的投入）

1. **工具层（BSK 84k）**：观察、VOM、动作、长截图、video、debug 都塞在 tools 下；说明他们把
   “页面语义 + 动作事务 + 证据”当成一个整体工程，而不是零散命令。
2. **transport（BSK 20k）**：WebSocket、握手、generation、重连、session 生命周期独立成层；
   这是长时间运行/远程/多实例可靠性的成本。
3. **cooperation（BSK 14k）**：人类/Agent 状态机、authority、capture suppression 是独立子系统，
   不是 UI 开关。
4. **debug/capture（BSK 10.8k + 5.9k + 5.3k；Browse 6.5k）**：证据、长截图、视频是产品可信度，
   代码量接近一个中等应用。
5. **安装/协议/集成（Browse 8.3k；BSK transport/entrypoints）**：多浏览器、多 Agent、自动更新、
   MCP 配置矩阵，是“接入产品”的成本。
6. **测试/压力/夹具（Browse 8k；BSK eval 10.7k）**：真实浏览器、seeded case、stress/canary
   是稳定性的来源。

## 3. 体量大 = 他们大概率考虑过、而我们较薄的 12 类

| # | 主题 | 他们的体现 | 我们现状 |
| --- | --- | --- | --- |
| 1 | 传输/session 生命周期 | generation、soft-detach、重连、多实例 ownership | 有 generation/重连，但 layer 较薄 |
| 2 | 工具目录/版本/feature floor | method catalog、schema、两轴版本、错误 taxonomy | 有 protocol/schema，但无 feature floor/目录分层 |
| 3 | 取消/超时/队列 | CdpReadGate、deadline class、queue busy/cancel | 有 timeout/queue，但无统一 read gate |
| 4 | cooperation 全状态机 | 4 authority、context ticket、归因时钟、frameState | 有 generation/stale/frameState/粗归因，仍薄 |
| 5 | VOM 6 阶段/token 预算 | facts/identity/graph/resolve/scene/render | 有分层/视觉/ref，但无 6 阶段与 per-line 预算 |
| 6 | 跨帧生命周期 | frame graph、OOPIF、iframe 导航/沙箱 | 几何强，生命周期/导航失效待补 |
| 7 | 输入事务 | pointer/file/drag transaction、readiness、focus lease | 有 input lease/trusted，但事务边界薄 |
| 8 | capture 工程 | 页脚/stale/final exposure、fragmented video、恢复 | 长截图/恢复强，视频仍是分片日记 |
| 9 | 调试证据 | journal/coverage/budget/pin/脱敏 | 有归档/重放/脱敏，无 coverage/budget/pin 三层 |
| 10 | 多浏览器/多版本 | Brave/Arc/Helium/Vivaldi、版本适配 | 主要 Edge/Chrome |
| 11 | 分发/接入 | 30+ MCP 客户端、自动更新、安装器 | 11 客户端、无自动更新 |
| 12 | 测试/压力/可观测 | seeded eval、stress/canary、CI lane、日志 | 175 E2E/88 eval 很强，但缺 stress/seeded/版本矩阵 |

另外两类容易被忽略：
- **UI/可访问性/i18n 工程**：BSK 有 `packages/ui` + `i18n`，Browse 有完整 options/status 页；
  我们 12 语言 RTL 是优势，但组件化和 a11y 仍可补。
- **隐私/商店审核**：权限最小化、数据保留、脱敏、store 文案与截图；这是“能不能上架”的成本。

## 4. 怎么对齐：行为契约优先，不追行数

### 4.1 原则

1. **以能力矩阵/契约对齐，不以 LOC 对齐**：同一行为用更少代码是优势。
2. **每吸收一项，先写 eval/E2E，再写实现**：避免“代码像了但行为没变”。
3. **薄垂直切片**：一次只补一个子系统端到端，不铺大框架。
4. **保持零依赖 Node/MV3**：不引入 Rust/QuickJS/重型构建。
5. **明确不做什么**：不复制 30+ 客户端全矩阵、不自更新、不做明文远程。

### 4.2 分阶段路线

**Phase A（已完成/本轮）**

- MCP 11 客户端 + JSONC 保注释
- 配对 endpoint+nonce HMAC + 失败预算
- action-policy 护栏表 + per-tab allowedOrigins/readOnly
- ref identityKey
- 拟人输入、截图 diff、长截图页脚、视频分片语义

**Phase B（对齐高复杂度子系统，4–6 周）**

1. **transport/session 层**：抽 `extension/src/transport/`，补 soft-detach signature、read gate、
   queue busy/cancel 语义与单测。
2. **cooperation 深化**：context ticket、frameState 的 pending/busy/attribution、capture suppression
   ref-count + 2rAF（已有 2rAF）统一。
3. **VOM 预算/issue**：6 阶段映射到现有 observation，补 token per-line 预算与 `omitted` 说明。
4. **输入事务**：pointer press/release、file upload/download transaction、focus lease 边界。
5. **debug 证据**：coverage/gaps/budget/pin 四件套。
6. **视频**：fragmented MP4 journal + worker 重封装（或明确保持 MediaRecorder 并写边界）。

**Phase C（产品化/矩阵，进行中）**

- 浏览器识别矩阵已完成（edge/chrome/brave/opera/vivaldi/arc/helium/chromium），
  真实 E2E 仍只有 Edge/Chrome；见 [BROWSER-MATRIX.md](BROWSER-MATRIX.md)。
- tab groups 已完成；命名 tab id/keepOpen、MCP 20+、stress/seeded 仍在队列。

1. **浏览器矩阵**：Brave/Arc/Vivaldi/Opera 冒烟 + 版本适配表。
2. **MCP 30+ 客户端/TOML-YAML**：扩安装器，写后校验。
3. **自动更新/分发**：商店更新说明、版本检查（不做自替换）。
4. **stress/canary/seeded eval**：从 88 eval 扩到 seeded/压力 lane。
5. **a11y/UI 组件化/商店隐私**：权限最小化、数据保留、store 文案。

### 4.3 验收指标（替代 LOC）

- 每个子系统有：单测 + 至少 1 条真实 E2E + 失败路径。
- eval 从 88 → 120，增加 seeded/fault/stress case。
- 浏览器矩阵：Edge/Chrome + 至少 3 个 Chromium 变体冒烟。
- 传输/协作：soft-detach、重连、并发 sync、human 归因四条 E2E。
- 发布：vendor-clean、preflight、权限清单、隐私说明。

## 5. 不建议照搬

- BSK 的 84k tools/14k cooperation 全量重写：维护成本远超收益。
- Browse 的 Rust 五 crate + QuickJS + 内嵌 Playwright：与零依赖 Node 冲突。
- 30+ 客户端全矩阵：按“目标用户实际使用的前 10 个”逐步扩。
- 自动替换二进制/自更新：与签名发布/商店审核冲突。

## 6. 一句话

他们代码多，主要多在三件事：**长时运行的传输/会话、复杂页面的 VOM/动作事务、证据与恢复**。
对齐方式不是写得一样多，而是把这三件事的**不变量**补进我们更小的模块，并用 eval/E2E 证明。
