# 官网演示视频字幕核对（BrowserSkill 0.4.2 · zh-CN）

日期：2026-11-12 · 视频：`https://browserskill.weixin.qq.com/assets/demo/browserskill-demo-zh-CN.mp4`（1920×1080，81 秒，4.91 MB）

## 0. 方法与限制

- 页面 `<video id="heroVideo">` 没有 `<track>`，站点也没有 `.vtt/.srt` 侧车文件（探测 11 个常见文件名全部 404）→ **字幕是烧进画面的**。
- 用 BridgeDeck 把视频逐帧定位（`v.currentTime = t`）再对 `#heroVideo` 元素截图，按 2 秒/1 秒间隔采样 21 + 34 帧，从画面底部读取字幕与幻灯片。
- 注意：窗口在后台时 CDP 截到的是旧帧，必须先 `bridge window focus` 目标窗口，seek 才会真正重绘。这一点本身也值得记进产品说明。

## 1. 视频结构（从画面读出的章节）

| 时间 | 画面 | 字幕（截取时正在打出的原文） |
|---|---|---|
| 0–2s | 黑场/加载 | — |
| 2–18s | 片头：「你的 Agent。你的浏览器。让它们连起来。」+ 6 个 Agent 图标（Codex、Claude Code、Cursor、OpenClaw、CodeBuddy、WorkBuddy） | 你的 Agent → 让它读懂网页…（打字机效果） |
| 20–28s | **01 / 07 读懂网页，找到重点。** 命令：`bsk cooperate sync`、`bsk fill · bsk select`；操作结果：搜索与状态筛选已生效、共享控制提示始终可见 | 「它能读懂网页」「读取页面内容」 |
| 28–56s | **03 / 07 填好表单，办成任务。** 命令：`bsk fill`、`bsk select`、`bsk click`；结果：标题/负责人/优先级已填写、已创建任务 NS-109 | 「一键生效：屏幕上的共享控制提示始终可见」「填好表单、办成任务：标题、负责人、优先级自动填好」 |
| 54–59s | **网站调试**总览（请求 + 控制台消息 + 页面变化一起排查） | 「网站调试把请求、控制台消息和页面变化放在一起排查」「保存为什么失败，查看接口响应」 |
| 60–63s | **06 / 07 查看响应，找到原因。** 命令：`bsk debug request --part response`；结果：`VALIDATION ERROR`、字段 `version`、格式示例 `0.3.3` | 「一眼定位是版本号格式校验出错」「线索全程留存」 |
| 64–76s | 表单/反馈（Request a feature）+ GitHub 仓库卡片 | 「GitHub 上的 Tencent BrowserSkill 仓库」 |
| 76–81s | 结尾卡：「你的浏览器。你的 Agent。」 | — |

> 画面里 7 章只拍到 01 / 03 / 06 三章（02/04/05/07 在当前剪辑里没有独立出现），但演示到的能力面已经覆盖片头承诺的几件事：读页面、填表、共享控制、调试取证。

## 2. 逐项对照：视频内容 → 我们的实现

| 视频里的内容 | 我们 | 对应命令 / 实现 |
|---|---|---|
| 「一个浏览器扩展，一套 CLI」 | ✅ | `extension/` + `bin/bridge.cmd`、`cli/bridge.mjs` |
| 6 个 Agent 图标（Codex/Claude Code/Cursor/OpenClaw/CodeBuddy/WorkBuddy） | ✅ 且更多 | `install-skill` 共 12 个 target（再加 dsh/qoder/pi/hermes/kimi-code，claude 与 claude-code 同路径），另有 `bridge mcp` |
| 读懂网页 / 读取页面内容 | ✅ | `observe`（含 VOM、iframe、closed shadow）、`read`、`extract discover/table/list` |
| 搜索与状态筛选（读列表、按关键字/状态过滤） | ✅ | `observe` + `click`/`select` 驱动页面筛选，`extract` 出结构化结果 |
| `bsk cooperate sync` / 共享控制提示始终可见 | ✅ | `bridge cooperate sync` + 接管浮层（`takeover.js` / `ControlOverlay`），卡片上就是「Agent 正在操作 / 暂停 Agent / 停止任务」 |
| `bsk fill` / `bsk select` / `bsk click` | ✅ | `bridge fill/select/click`（fill 含 date 系列类型校验） |
| 「标题、负责人、优先级自动填好」+ 提交任务 | ✅ | `fill`＋`select`＋`click`；提交后的结果用 `wait-for-navigation`/`observe` 确认 |
| 网站调试：请求 + 控制台 + 页面变化一起排查 | ✅ | `debug start/requests/console/performance/aggregate`，`debug requests --filter` 聚合请求、控制台、操作时间线 |
| `bsk debug request --part response` 看接口响应 | ✅ | `bridge debug request <id> --part response`（也支持 headers、timing、request、all） |
| 「一眼定位版本号格式校验出错」 | ✅ | `debug request --part response` 看响应体 + `debug analyze` |
| 「线索全程留存」 | ✅ | `debug journal`、`debug archive/archives`、`debug evidence` |
| 本地演示数据 / 真实浏览器录制（画面角标） | ⚠️ 演示脚手架 | 我们的 `record`/`video` 能录真实操作与屏幕，但没有 Northstar 这种内置演示站点；这是他们的营销素材，不是产品能力 |
| 浮层英文文案（Agent is syncing / Pause Agent / Stop task） | ✅ 等价（中文） | 我们的浮层按语言显示「Agent 正在操作 / 暂停 Agent / 停止任务」；`--lang` 为英文时显示英文 |
| GitHub 开源仓库 | ✅ | 仓库 MIT（`package.json` license）；对外发布走 GitHub |

## 3. 结论

- 视频里演示到的**功能面在我们项目里全部存在**，而且命令一一对得上（`cooperate sync`、`fill/select/click`、`debug request --part response`、debug journal/archive）。
- 唯一的"没有"是它自带的 **Northstar 演示站点 + 本地演示数据角标**，属于营销素材脚手架，不是产品能力；如果要做对标 demo，我们缺的是这个演示页面，不是命令。
- 一个值得记的产品细节：录视频/截图时窗口在后台会拿到旧帧，需要先 `window focus`。如果以后我们要自动截取演示，这一步要写进脚本。

## 4. 证据帧

- 片头 + Agent 图标：`ref/vf2/sheets/grid-1.png`
- 01/07 读懂网页：`ref/vf2/sheets/grid-2.png`
- 03/07 填表：`ref/vf2/sheets/grid-3.png`、`grid-4.png`
- 06/07 调试响应：`ref/vf2/sheets/grid-5.png`
- 字幕连帧：`ref/vf3/sheets/band-2.png`、`band-3.png`、`band-4.png`
