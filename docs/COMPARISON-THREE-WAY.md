# 三方对照：BridgeDeck 0.3.0 / BSK 0.5.0 / OpenCode Browse dev

日期：2026-11-18。目的：用同一张表判断“谁更强、强在哪、我们吸收什么”。
三方源码都在本机只读研究：

- BSK 0.5.0：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`
- OpenCode Browse dev：`ref/opencode-browse-dev/browse-dev`（GitHub anomalyco/browse，dev 分支，2026-11-18 下载）
- BridgeDeck 0.3.0：`D:\浏览器桥` 当前工作树

> 行数/文件数包含测试与部分资源，只用于解释复杂度，不直接等于能力。参考实现不进入发布包。

## 1. 量化

| 指标 | BSK 0.5.0 | OpenCode Browse dev | BridgeDeck 0.3.0 |
| --- | ---: | ---: | ---: |
| 扩展源码 | 557 文件 / 188,904 行 | 595 文件 / 6.85 MB（TS+Rust 469 文件 / 112,866 行） | 156 文件 / 31,497 行（运行时 136 / 23,090） |
| 核心运行时 | Rust CLI 87k 行 + 协议 9.6k 行 | Rust relay 6 crates（page/capture/script/relay/core/browse） | Node CLI 5,990 + daemon 3,155 |
| VOM/观察 | 独立 packages/vom 5,370 行 | 注入脚本 compact/aria 两模式，无 computedStyle/paintOrder 阶段 | observation 563 + ax 254 + visual 57 + lib |
| cooperation | 22 文件 / 14,441 行 | 每 tab busy + handoff 状态卡，无显式输入租约 | 10 文件 / 1,083 行 + authority/归因 + 共享 tab 控制权/租约/handoff |
| 测试/评测 | ~255 test + 24–30 eval case | 源码内单元/集成测试（未单列总量） | **710 单测 + 507 reference + 202 真实 E2E + 115 eval** |
| 浏览器覆盖 | 以 Chromium 为主 | Chrome/Edge/Brave/Arc/Helium/Vivaldi/Opera/Chromium | Edge/Chrome 真实 197 |
| MCP 接入 | 自有 CLI/DSH 生态 | **30+ 客户端自动写配置** | 30 客户端一键写入 + JSONC/TOML/YAML/DSH | 接近 |

## 2. 能力矩阵

| 能力 | BSK | OpenCode Browse | BridgeDeck | 领先 |
| --- | --- | --- | --- | --- |
| 真实浏览器 + 登录态 | ✅ | ✅ | ✅ | 平 |
| 浏览器覆盖 | 中 | **广（8 种）** | 中 | Browse |
| MCP/Agent 接入 | 中 | **极广（30+ 自动配置）** | 30 客户端 + JSONC/TOML/YAML/DSH | Browse |
| 配对/连接安全 | 强 | **强（ECDH + endpoint/nonce + 短码预算）** | 强（endpoint+双 nonce HMAC + 失败预算 + WS challenge + 激活即作废旧链接） | Browse 略强（ECDH） |
| Tab 句柄/组/回收 | 中 | **强（命名 id、组、idle、重启回收）** | 中（reservation/borrow） | Browse |
| 拟人输入 | 有 | **强（Bezier/最小 jerk/Fitts/过冲/滑行）** | 基础 CDP | Browse |
| 焦点/后台执行 | 后台（`Emulation.setFocusEmulationEnabled`，人工介入才 `Page.bringToFront`） | **默认禁止 `Page.bringToFront`**（`guardrails.ts`），需要前台要显式允许 | 默认后台（同焦点仿真）+ `--focus` 显式置前；不再隐式 `bringToFront`/`windows.update(focused)` | 接近 |
| 观察/VOM 深度 | **强（6 阶段/paint-order）** | 中（compact outline + refs） | **强（分层/视觉/stableRef/issues）** | BSK≈BridgeDeck |
| Ref 身份/代际 | **强（cdpSessionId+revision）** | 强（selector+role+name+frame，文档代际） | **强（identityKey + document/revision + stableRef）** | 三方接近 |
| 跨帧几何 | 强 | 中（owner 偏移逐级相加） | **强（仿射+matrix3d+perspective homography）** | BridgeDeck |
| 动作/命中 | 强 | 强（actionability+遮挡点名） | 强（trusted/lease/fail-closed） | 平 |
| 协作状态机 | **强（4 authority/归因时钟）** | 中（handoff 卡片/四态） | 强（generation/stale/frameState/归因） | BSK |
| 共享 tab 控制权 | 中（tab busy + handoff 卡片） | 中（handoff 卡片） | **强（open/exclusive + 租约 + claim/release/handoff + epoch CAS + 停止转交）** | BridgeDeck |
| 长/宽 capture | 强 | 中（captureBeyondViewport/条带/16MP） | **强（2D 分块 40000px/页脚/final/恢复）** | BridgeDeck |
| 视频 | **强（fragmented+worker）** | 强（MJPEG→MKV 录制） | 中（MediaRecorder+分片日记+恢复） | BSK≈Browse |
| 网络/console | 强 | 强（脱敏/结构化） | 强（debug 归档/重放/脱敏） | 平 |
| execute 沙箱 | 有 | **强（QuickJS 64MB/无 Node）** | `bridge exec`（Node vm 默认；QuickJS 同步契约 + 全量 locator，非安全边界） | Browse 略强 |
| 每 tab 护栏 | 部分 | **强（allowedOrigins/readOnly/CDP guardrails）** | **强（action-policy 表 + tab policy + session read scope）** | 对齐 |
| 截图 diff | 部分 | **强（YIQ pixelmatch 兼容）** | 无（本轮后补） | Browse |
| i18n/RTL | 中 | 站点 18 语言，工具面英文 | **12 语言全量 RTL** | BridgeDeck |
| 回归/评测门禁 | 中 | 源码测试 | **596/507/173/86，PR 真实 E2E** | BridgeDeck |
| 发布/签名 | 强 | 商店 + 自动更新 | 9 制品/签名/preflight | 平 |

## 3. 各自护城河

- **BSK**：VOM/cooperation 的内部状态机最深，适合“复杂页面 + 多权威协作”的重型引擎。
- **OpenCode Browse**：产品化和接入面最强，适合“任意 Agent 低成本用上真实浏览器”；安全模型、tab UX、拟人输入、execute 沙箱是明显长板。
- **BridgeDeck**：跨帧几何、分层观察、capture 恢复、协作归因和**可验证门禁**最深，适合“复杂页面可控 + 可审计 + 可回归”。

## 4. 本轮已吸收（来自 Browse 源码）

1. **MCP 一键写入（11 客户端 + JSONC 保注释）**
   - 新增 [mcp-config.mjs](cli/mcp-config.mjs) + `bridge mcp-install`：Claude/Claude Desktop/Cursor/OpenCode/VS Code/Windsurf/Kilo/Amp/Copilot/Kiro/Qwen。
   - JSONC 注释/尾逗号保留，写入后二次解析校验；冲突不覆盖，`--dry-run` 可预演。
   - 测试：`tests/unit/mcp-config.test.mjs`、`mcp-install.test.mjs`。

2. **拟人鼠标轨迹**
   - 新增 [human-input.js](extension/src/lib/human-input.js)：Fitts 时长 + 三次贝塞尔弓形 + minimum-jerk + 抖动/过冲 + 60–140ms 按住。
   - `click --human --trusted` 接入 [interaction.js](extension/src/tools/interaction.js)，E2E `23h5` 断言多段轨迹。
   - 来源：`rust/crates/browse-page/src/human.rs` 的物理模型，按 JS 重写，未复制代码。

3. **YIQ 截图差分**
   - 新增 [pixel-diff.js](extension/src/lib/pixel-diff.js)：pixelmatch 同量纲，返回 changed/ratio/bbox。
   - `screenshot --diff` 接入 [screenshot.js](extension/src/screenshot.js)，CLI summary 输出 diff。
   - E2E `31g`：改背景后 `changed=923424 / ratio=0.9674`。

4. **观察输出 issue/省略语义**
   - 上一轮已有 `issues[]` 与 paint-order 分层；本轮对齐 Browse “截断要说明”的原则。

5. **归因时钟**
   - 已有 expectation kinds + ±2px + key 匹配，与 Browse “deny-by-default” 原则一致。

## 5. 高 ROI 吸收清单（未做，按优先级）

| # | 吸收点 | 来源证据 | 最小实现范围 |
| --- | --- | --- | --- |
| 1 | **MCP 30+ 客户端 / TOML·YAML 改写** | `rust/crates/browse/src/agents.rs` | 在 11 客户端上补 TOML/YAML writer 与剩余客户端 |
| 2 | **配对证明绑定 endpoint+nonce** | `pairing.rs`、`handshake.ts` | 现有 local-pairing 上加 HMAC/双向 nonce、码 PBKDF2、10min TTL、5 次作废 |
| 3 | **CDP 护栏表** | `guardrails.rs`、`domain.rs` | 新 `guardrails.js`：只读白名单 + cookie/storage 限本 tab host + scheme 拒绝，表驱动单测 |
| 4 | **Ref 代际契约** | `snapshot.rs` | ref 记录加 identityKey/documentGeneration；失配返回 `OBSERVE_STALE_DOCUMENT` |
| 5 | ~~每 tab allowedOrigins/readOnly~~ | `domain.rs` | 已完成：`tab policy` / `tab new` + daemon read scope |
| 6 | **Tab 命名 id/组/重启回收** | `tabs.rs`、`tab-cleanup.ts` | reservation 增加 alias/group/keepOpen，SW 重启从 storage 恢复 |
| 7 | **handoff 双匹配/四态** | `presentation.rs` | takeover 现有状态机补 tab+id 双匹配、outcome 四态、按 tab 串行投递 |

## 6. 不建议照搬

- Rust 五 crate + QuickJS + 内嵌 Playwright 注入：与 BridgeDeck 零依赖 Node 的维护/体积不匹配。
- 按 `clientInfo.name` 切工具面：客户端改名就变行为。
- 全局“永不 enable”隐身：与现有分层 anti-bot 正交，易回归。
- 把 execute 沙箱当安全边界：源码自己标注“不是边界”。
- 远程明文连接：依赖 VPN，不适合托管。
- 自更新替换二进制 + 包管理器协商：与现有签名发布冲突。

## 7. 结论

- **单看“接入与产品体验”**：OpenCode Browse 第一。
- **单看“VOM/协作内部深度”**：BSK 第一。
- **单看“复杂页面可控 + capture 恢复 + 回归可信度”**：BridgeDeck 第一。
- 我们不需要变成他们；已吸收 **MCP 五客户端写入、拟人输入、截图 diff**，下一步补 **JSONC 保注释/TOML/YAML、配对证明、护栏表**，同时保留跨帧/观察/协作/评测的深度护城河。
