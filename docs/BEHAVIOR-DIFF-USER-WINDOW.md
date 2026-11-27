# 行为差分：真实用户窗口场景（borrow / record→replay）

> 目的：把差分基准从“Agent 自己开的全新 profile（用户窗口只有 about:blank）”推进到
> **带真实用户页面的用户窗口**，验证「借用用户标签页」与「录制用户操作 → 回放」这类
> 必须有人类窗口参与的路径。
> 工具：`tools/bsk-differential/run.mjs`（本轮已加真实用户窗口模式）+ `tools/uia-click.ps1`（UIA 真人点击）。

## 1. 场景设计

### 1.1 环境布局

| 元素 | 设计 |
| --- | --- |
| 用户窗口 | 浏览器启动时**直接打开 fixture 页**（不再用 `about:blank`）；这是“用户自己的标签页” |
| Agent Window | 两侧 CLI 各自 `open` 创建的独立任务窗口（共享同一浏览器 profile） |
| 夹具页 | 同一 HTML：标题 `Differential Fixture`、按钮 `Submit Query`、输入框、表格、同源 iframe、跨源 OOPIF、超长区域 |
| 真人输入 | `tools/uia-click.ps1`（Windows UIA）按窗口标题 + 控件名点击；用于「Allow 借用确认」和「录制用户操作」 |
| 隔离 | 每侧独立临时 profile + 临时 HOME；两侧串行跑，避免窗口/daemon 互相干扰 |

启动参数修正（本轮关键修复）：`browserArgs()` 末尾原本固定带 `about:blank`，追加 URL 会同时开出
两个标签页；现在真实用户模式下**移除 `about:blank` 再放 fixture URL**，确保用户窗口里就是真实页面
（否则参考实现会拒绝借用：“No user tab can display the borrow confirmation”）。

### 1.2 borrow 场景步骤

1. 两侧各自 `open fixture`（创建 Agent Window）；此时用户窗口保留 fixture 标签页；
2. `tab list --scope user --json` 找到用户标签页 id（两侧都支持 user scope）；
3. 后台发起 `tab borrow <tabId>`（阻塞等待确认）：
   - 参考实现：浏览器 UI 弹出确认（英文 `Allow tab borrow?` / 中文 `允许借用标签页？`，按钮 `Allow/允许`）；
   - 我们：扩展在**用户标签页**注入借用确认模态（`Allow tab borrowing?`，按钮 `Allow/允许`）；
4. 1200ms 后用 UIA 点击窗口 `Differential Fixture` 里的 `Allow`（候选文案：`Allow` / `允许` / `Erlauben` / `Permit`）；
5. 收回 borrow 结果并校验（参考实现返回 `borrowed tab_id=… → agent_window=…`）。

### 1.3 record → replay 场景步骤

1. 参考实现：后台 `record start --url fixture --output <dir>`（阻塞式），UIA 点击页面 `Submit Query`
   模拟真人操作，`record stop --output <dir>` → 期望 `<dir>/trace.json` + `states/*.txt`；
2. 我们：`record start --include-agent --session <id>`，一次 Agent 动作（`click #btn`）+ UIA 真人点击，
   `record stop` → 期望返回 recording id 且 events ≥ 1；
3. 回放：比较「录制产物能否被对等回放」——当前两侧都**没有对等 CLI**：
   - 参考实现只有 `recipe run`（需要先保存/审批 recipe），没有 `replay` 子命令；
   - 我们的回放引擎在 extension 内部（Trace v3 规划/执行/差分），CLI 未暴露 `replay <trace>`；
   - 因此本项如实记为 **unsupported**，不伪造等价；下一步若要补，建议两侧各加 `replay <trace.json>` 的
     显式命令再做行为差分。

## 2. 实测结果（2026-11-26，19 任务全跑）

| 任务 | 我们 | 参考实现 | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| 基础 10 项（open/observe/click/read/fill/extract/get-html/screenshot/错误拒绝/read_after_fill） | ✅ | ✅/❌ | 9 equal + 1 diff | `read_after_fill` 仍为价值暴露差异 |
| iframe / OOPIF / 视频 / 多会话 / 配对链接 | ✅ | ✅ | equal | — |
| 整页截图 | ✅ | ⚠️ | diff（环境敏感） | 参考实现要求页面可见；窗口被遮挡时拒绝（`page became hidden`），前台跑过 equal |
| **borrow（真实用户窗口）** | ⏳ 等待真人确认 | ✅ UIA 确认成功 | diff（设计差异） | 参考实现确认条可被 UIA 点到（本轮点击 `允许` 成功 borrowed）；我们的确认模态在 **closed shadow DOM** 且 `borrowConfirm` 是 **human-only 设置**（agent 不可改），UIA 不可达 → harness 如实记为 `pendingConfirmation`，需要真实人点击 |
| record（录制） | ✅ events=1 | ✅ saved 1 steps + trace.json | **equal** | 两侧都能录制出产物；我们对 Agent 动作 `--include-agent`，参考实现录真人 UIA 动作 |
| record→replay（回放） | ❌ | ❌ | **unsupported** | 两侧都无对等 `replay <trace>` CLI（见 §1.3） |

汇总：**19 任务 15 equal / 3 diff / 1 unsupported**。

## 3. 结论与设计含义

1. **借用确认的安全姿态不同**：我们刻意做成 human-only + closed shadow（Agent 无法点确认、无法改设置）；
   参考实现的确认条在可访问性树里，UIA/自动化可以点到。这不是缺陷，而是**安全取舍**；
   真实人类场景下两者都能完成借用。
2. **录制的输入源不同**：我们侧重 Agent 动作（`--include-agent`），参考实现侧重真人动作；两者都能产出
   trace，但语义需要显式声明，避免把“录 Agent”与“录人”混为一谈。
3. **回放是共同缺口**：需要一个对等 `replay <trace>` 命令才能做行为级回放差分；当前只能做 E2E 内部验证。
4. **整页截图是环境敏感项**：参考实现要求页面可见，遮挡/后台会拒绝；差分报告应保留“环境条件”列。

## 4. 复跑

```powershell
cd D:\浏览器桥
$env:PATH='D:\tools\node;'+$env:PATH
$env:BSK_HOME='D:\浏览器桥\.tmp\bsk-diff\harness-home'; $env:BSK_AUTO_START='0'
# 持久任务里启动参考实现前台 daemon：
ref\bsk-0.5.0-bin\bsk.exe daemon start --foreground
# 另一个终端：
node tools/bsk-differential/run.mjs --reuse-daemon
```

> UIA 依赖前台窗口与中文/英文控件名候选；若机器语言不同，可在 harness 的 `uiaInvoke([...])`
> 候选数组里加对应文案。报告在 `docs/behavior-diff/report.json` 与 `docs/BEHAVIOR-DIFF-BSK.md`。
