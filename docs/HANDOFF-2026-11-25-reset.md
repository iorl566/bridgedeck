# BridgeDeck 交接（2026-11-25 重置会话用）

## 0. 状态更新（2026-11-25 下午，晚于本文件其余章节）

- 用户已**解除 0.3.0 冻结**并下达"全面对标 BSK 0.5.0（深度 + 体量）"：
  - 架构路线：`docs/ARCH-TRACK.md`（`apps/extension` = WXT + TS + React，已可构建/类型检查/单测；
    `crates/bridge-cli` = Rust 骨架，8 项测试通过，二进制可运行）。
  - 对标计划与进度：`docs/BSK-PARITY-PROGRAM.md`（W1 波次已落地，体量约 119k 行 / 36%）。
  - 仍**未改**版本号、未重新打包、`dist/` 未动；发布物与冻结包保持原样。
- 本文件下文 §1/§5 关于"只做 0.3.0 / 不升版本 / 不重新打包"的描述是当时的约束，现以本条为准。
- 事故记录：2026-11-25 15:14 `dsh-plugin/**` 与真实 DSH profile 曾被清空，已恢复并加固
  （`tools/plugin-profile-check.mjs` 改为隔离临时 `DSH_HOME`）；详见 `docs/BSK-PARITY-PROGRAM.md` 运维记录。

> 给新会话：先读本文件，再读 `docs/COMPARISON-BSK-0.5.0.md`。当前**只做 0.3.0**；不要再创建 0.4/独立产品。

## 1. 当前仓库状态（已核验）

- 产品版本：**0.3.0**（根 `package.json`），已冻结，未升号、未重新打包、`dist/` 未改。
- 0.3 工作树已恢复到冻结备份的**逐文件一致**状态：
  - 产品条目（extension/daemon/cli/tools/tests/translation/docs/bin/lib/mcp/sdk/skill/vendor/dsh-plugin + 根文件）：**1,381 项，0 差异 / 0 缺失 / 0 多余**；
  - `dist/` 抽查 98 项，0 差异；
  - 7 个曾被改动的文档已从备份恢复；新增的 0.4 计划文档已删除。
- 0.4 已**全部删除**：`0.4/` 目录（927 文件/20MB）、`0.4/dist-extension-*`、`.tmp-bench`（2.9GB 0.4 缓存）、根目录 42 个 0.4 临时日志；无 0.4 进程/代理。
- 保留的 `docs/` 为冻结快照本身（含 COMPARISON、bsk-study 等研究文档）。

## 2. 备份（不要动）

- 路径：`D:\浏览器桥-0.3.0-backup-20261125-110641`
- 规模：22,011 文件 / 4,113,237,640 B（≈3.83GiB），含 `dist/` 与 `.git/` 历史；只读。
- 校验：`SHA256SUMS.txt` 22,011 行；清单 SHA256 = `DF82DA15156FC94F6E769035B8C808F8CD4C498C3541BC0CC6A293771233C3B8`；抽样 0 mismatch。
- 恢复方式：整目录复制回，或按清单逐文件校验。

## 3. 0.3 最近一次全量门禁（仓库文档记录，2026-11-22）

来源：`docs/FINAL-STATUS-0.3.0.md`。本次会话只做了哈希校验，未重跑全部门禁。

| 项 | 结果 |
| --- | --- |
| 单测 | 1025/1025 |
| CLI selftest | 159/159 |
| MCP selftest | 21/21 |
| Edge eval | 127/127（attempts=1） |
| Edge E2E / Chrome E2E | 212/212 / 212/212 |
| source / encoding guard | clean（212 / 1023 files） |
| page-lib check | 通过（4,168 行） |
| 规模 | 760 文件 / 91,016 行 |
| 协议 / MCP | 165 方法 / 67 工具 |
| release preflight | PASS |

常用命令：`node tests/cli/selftest.mjs`、`node tests/extension/module-load.mjs`、`node tools/scale-report.mjs`、`node tools/e2e.mjs`（重）、`node tools/audit-source-parity.mjs`。

## 4. 与 BSK 0.5.0 的差距（结论，详见 COMPARISON）

**外部能力面基本对齐、局部更宽；差在深度/规模/平台化。**

缺功能（无对应面）：
1. 多平台原生发布（Rust 二进制、macOS/Linux、原生 fsync）；
2. DSH 插件子系统深度（0.3 约 1/16 体量）；
3. eval oracle / fake adapter / 三态判定；
4. 协议 feature floor 与单一 catalog（0.3 5 floor/多源生成，BSK 9 floor/单源）；
5. TS/React/WXT 扩展构建与组件化 a11y；
6. 协作 passthrough token、引用计数 suppression、toolbar controller；
7. 调试 journal/IDB/coverage/gaps 持久化。

深度不够（有面对应但更浅）：VOM affordance/layers/stable refs、动作事务（native input clock、3 步 fill、virtual row guard）、协作 capture 抑制、视频原生持久化、协议状态机可证明性、测试金字塔、整体规模（约 BSK 27.4% 代码量）。

0.3 领先：165 方法/67 MCP、12 语言 RTL、212 真实 E2E、HAR/trace、可恢复 capture、发布门禁、单栈可维护。

## 5. 用户已明确否决/约束

- 不要新建平行 0.4 或“重新做一个产品”；**只在 0.3 上工作**。
- 不要“乱加功能/花架子”；每项必须有真实浏览器 E2E 或可复现 DOM 证据，优先实用。
- 不升 0.3.0 版本、不重新打包、不发布；不改 `dist/`；不动 `D:\CTRM自动录入`。
- 范围要先与用户确认；上一轮用户对“功能堆砌、没有实用价值”明确不满。

## 6. 建议的下一步（等用户选定一项）

按实用优先：
1. 动作事务/输入时钟/virtual row guard（复杂页面稳定性）；
2. 协作 suppression/passthrough token（人机协作互斥）；
3. VOM affordance/layers/stable refs（观察质量）；
4. DSH 插件 + eval oracle（Agent 集成/回归）；
5. 多平台/TS 架构（最后）。

新会话开场建议：让助手读本文件 + `docs/COMPARISON-BSK-0.5.0.md`，然后只选一项开工，按真实 Edge E2E 验收。
