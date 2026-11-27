# Skills Assessment（BridgeDeck 0.3.0）

问题：为了把 BridgeDeck 做到第一梯队并最终超过 BSK 0.5.0，需要安装哪些 DSH skill？

## 1. 当前目录里可用的 skill

| Skill | 对本项目的作用 | 是否建议使用 |
| --- | --- | --- |
| `browser-bridge` | 本项目自己的浏览器自动化 skill；真实页面回归、调试、录制 | **必用**（产品本身） |
| `dsh-doc` | 改 DSH 插件/agent preset/插件 bundle 时查安装版文档 | 做 DSH 插件时用 |
| `office` / `office-docx` / `office-pptx` / `office-xlsx` | Edge 商店材料、发布说明、对比表 | 发布批次用 |
| `diagnose-windows-sandbox-acl` | DSH 文件沙箱 ACL 异常 | 环境问题用 |
| `pua` | 任务过程提醒/执行纪律 | 不需要 |

结论：**核心开发不需要安装新 skill**。现有 `browser-bridge` 覆盖真实浏览器；质量/架构/测试靠仓库内工具。

## 2. 缺少的是“项目专用 skill”，不是第三方 skill

建议后续自建两个项目 skill（先不安装，等质量批次稳定）：

1. `bridge-quality`
   - 触发：重构、拆分、发布前检查；
   - 内容：`source-guard`、architecture guards、performance/fault、preflight；
   - 价值：避免再次出现 `tabs.js` 被写成 `utf8` 的事故。

2. `bridge-release`
   - 触发：构建、签名、GitHub/Edge 发布；
   - 内容：9 制品、Actions 签名、Edge 同版本替换限制、preflight；
   - 价值：发布流程不靠记忆。

这两个应由 `skill/SKILL.md` 或 DSH bundle 承载；不要现在硬装，先把质量门禁稳定。

## 3. 是否需要新会话

质量批次（2026-11-18）已在本会话完成四项优先，产物见 `docs/HANDOFF-0.3.0.md`。

- 继续做深度批次时，仍建议开新会话；
- 新会话按 `docs/HANDOFF-0.3.0.md` 第 7 节开场，可直接拿到最新基线（596 单测 / 167 E2E / 103 eval）。

```text
继续 BridgeDeck 0.3.0 质量/深度批次。
先读 docs/HANDOFF-0.3.0.md、docs/QUALITY-ROADMAP.md、docs/REFACTOR-PLAYBOOK.md、docs/SKILLS-ASSESSMENT.md。
保持 0.3.0 不升号、不发版；先跑测试基线，再按小步+source-guard 重构。
优先：chromium-cdp/observation 继续拆、长截图恢复 E2E、VOM/cooperation 深度、RTL 翻译包。
不修改 D:\CTRM自动录入；发布包不得含参考实现标识。
```

## 4. 第一梯队判断

- 功能面：已进入 BSK 同一讨论范围；
- 质量门禁：已建立并硬阻断（596 单测 / 167 真实 E2E / 103 eval / preflight PASS）；
- 深度：cooperation authority、OOPIF 矩阵（含 matrix3d + perspective homography）、长/宽/超高截图分块、长截图/视频恢复、12 语言 RTL 已闭环；
- CI：`quality.yml` + `real-browser-e2e.yml` 均在 push/PR 跑；
- 结论：**达到第一梯队**，见 `docs/FIRST-TIER-CRITERIA.md`（多层 3D/40000px 以上列为后续边界）。
