# 能力差异：BridgeDeck 0.1.8 vs BSK 0.5.0

日期：2026-11-17。对照源：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`。

## 结论先说

1. **“变轻”没有直接降级已发布能力**：从 `extension/` 移走的 132 个 JS 是静态入口图不可达的参考镜像；构建仍打包 118 个运行时 JS，运行时测试、CLI selftest、module-load、协议检查和真机流程都通过。
2. **但 BridgeDeck 的能力面确实比 BSK 0.5.0 窄**，窄在 VOM/视觉语义、完整 cooperation capture/state、评测体系和部分远程设备生命周期；这些是“没实现”，不是“为了变轻而删掉”的已工作功能。
3. **不建议把参考镜像整体搬回**：它们不在运行时图里，搬回来只增体积、不增能力；要补就按能力补实现 + 测试。

## 量化差异

| 指标 | BridgeDeck 0.1.8 | BSK 0.5.0 扩展 |
| --- | --- | --- |
| 运行时/源码 JS/TS 文件 | 118 个 JS（extension） | 301 个 TS/TSX（src，不含测试） |
| 源码行数 | 约 2.8 万行 | 约 9.1 万行 |
| 源码字节 | 约 1.23 MB | 约 3.16 MB |
| 测试文件 | 运行时 467 项 + 参考 507 项 | 255 个 test/browser.test 文件 |
| 评测集 | Edge E2E 用例（本地） | 24 个 eval case（约 7 千行） |
| 构建包 | 413 KB 扩展 zip | 未在本机构建对照 |

> 文件/行数不是能力本身，但能解释为什么 BSK 在边界场景更厚。

## 能力矩阵

| 能力 | BridgeDeck | BSK 0.5.0 | 判断 |
| --- | --- | --- | --- |
| 基础动作：observe/snapshot/click/fill/select/drag/upload/download/dialog | 有，CLI 真机验证 | 有，且有更多输入/focus/geometry 边界处理 | 基本对齐 |
| 表格/列表提取、长截图、视频、录制、网络/调试、审计 | 有 | 有 | 对齐或各有侧重 |
| VOM / 视觉对象模型 / 语义图 / 视觉去重 | **没有** | `packages/vom` 11 文件/5.3k 行；视觉/几何/去重测试很多 | **最大能力差距** |
| 浏览器驱动细节（焦点/可见性覆盖、软 detach、frame geometry、pointer/file transaction） | 有基础 CDP，边界覆盖较少 | `browser-driver` 12 文件/7.6k 行 | BSK 更厚 |
| 协作 capture/state/toolbar/target | 可选输入锁、read、mode/revision、target 标记 | `cooperation` 22 文件/14.4k 行，完整 controller/capture/toolbar | **明显差距** |
| 远程设备 | 配对、scope read/control、renew、revoke、只读 viewer | 完整设备/配对/远程状态与 UI preview/focus | 我们第一版，仍窄 |
| i18n | 10 语言 UI 225 词条已翻译；内容浮层/部分页面仍 zh/en | 10 locale key-based 全 UI | 仍差覆盖范围 |
| 评测体系 | 本地单测/集成/E2E | 24 个 eval case + seeded generator | 缺系统评测 |
| 打包/上架 | 9 制品，preflight 只剩签名 | 已上架商店 | 缺签名/上架 |

## 哪些是“删重”造成的

- **没有造成回归**：132 个参考镜像迁出后，`extension/` 仍可构建、可加载、可连接；运行时不可达数为 0；单元/集成/CLI/module-load/协议/包验证均通过。
- **真正被删/未实现的**：
  - 参考镜像里的 `cooperation-capture`、`overlay-bridge`、`help-bridge` 等；
  - VOM/视觉语义；
  - 完整 cooperation state；
  - 评测体系。
- 其中 `overlay-bridge/help-bridge` 当年没有运行时监听者，属于死协议；删掉是降复杂度，不是降能力。`cooperation-capture` 是未接线的能力，删掉后我们后来补了简化版 `cooperation.js`。

## 我们的相对优势

- 单文件零依赖 CLI + 本地 daemon + 明确错误码/协议 schema；
- 远程配对/scope/renew/revoke 和只读 viewer 已落地；
- 长截图、视频、操作录制、审计、DSH/MCP/Claude/Codex 集成；
- 0.1.8 九制品统一、preflight 可执行；
- 测试数量多、构建小、安装轻。

## 建议优先级

1. **P0：补 i18n 覆盖**（内容浮层 + debug/ops/privacy/preview），这是当前 0.1.8 目标里最直接的缺口。
2. **P1：交互式远程 viewer / 设备细粒度权限**（点击、输入、短期 token、按域名/方法授权）。
3. **P1：cooperation capture/state**（如果目标是“共享控制”而不是“只读预览”）。
4. **P2：VOM/视觉语义**（如果目标是复杂页面/视觉定位质量）。
5. **P2：评测体系**（24 case 级别，不是继续堆单测）。

## 不做的事

- 不把 `reference/extension-mirror/` 整体搬回 `extension/`；
- 不用“代码存在”代替“运行时可调用”；
- 不用机器翻译冒充母语审校；
- 不在没有私钥/商店权限时声称已签名/上架。
