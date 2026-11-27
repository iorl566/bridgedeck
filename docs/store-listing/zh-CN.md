# BridgeDeck — zh-CN 商店文案

语言：`zh-CN`（包内 locale `zh_CN`）

名称（来自 manifest，只读）：`BridgeDeck`

短描述（来自 manifest `_locales/zh_CN/messages.json`，只读）：
BridgeDeck 把已登录的浏览器变成 AI Agent 的工作区：本地 daemon + MV3 扩展，数据只在本机流转。

## Description

BridgeDeck 把你已经在用的浏览器，变成 AI Agent 的工作区。

把任务交给 Agent，它会在独立的 Agent Window 里、用你已经登录的会话完成操作；你随时看得到它在做什么，也能随时接手、暂停或停止。

能做什么

- 用你已有的账号做网站任务：读文档、搜内部系统、走完需要本人登录的网页流程。
- 把一句指令落成浏览器操作：读取页面结构、点击、输入、填表、选择、拖拽、滚动、上传下载文件、管理标签页。
- 过程始终可控：可见的接管卡片、被控制页面外的蓝色呼吸边框、随时暂停或停止，借用你已有标签页前会先征求确认。
- 把网页数据带走：表格与列表导出为 JSON 或 CSV，保留列名以及每个值所在的页面或 iframe 来源。
- 出问题时找得到证据：请求、响应正文、控制台消息、页面变化、性能耗时与疑似重复请求，可导出为 JSON。
- 留下可回放的过程：把一个已授权的任务标签页录成无声 MP4，在扩展里预览、保存或删除。
- 整页留档：自动滚动、手动拼接，或只截可见区域。
- 留下记录：可开启的操作审计、任务历史与证据，全部保存在本机。

为 Agent 而做

一个 CLI、一个 MCP 服务器（92 个工具）、一个 DeepSeek Harness 插件（37 个工具），以及 Node.js 与 Python SDK。只要能执行本地命令，Agent 就能驱动浏览器；不绑定任何模型或厂商。

默认本地、默认私密

- 默认只连本机 127.0.0.1 上的 daemon，没有云服务，也没有遥测。
- 远程配对是可选项，且始终使用带认证的 WSS；未配对的本地连接仍可用，但会显示身份未验证提示。
- 截图、录制、调试证据与审计记录都留在你的机器上。
- 扩展不会自行调用任何 AI 提供商。

环境要求

- Microsoft Edge 或其他 Chromium 内核浏览器，版本 111 及以上。
- Node.js 20 或更高版本（用于本机 daemon 与 CLI）。
- daemon 支持 Windows、macOS 与 Linux；Windows 有图形安装器，macOS/Linux 使用 tar.gz 包内的 install.sh。

开始使用

安装扩展后打开弹窗，确认显示"已连接"。第一次执行 bridge 命令时，daemon 会自动拉起。

源码、CLI 安装指南与文档：https://github.com/iorl566/bridgedeck

隐私说明：https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- 浏览器自动化
- AI Agent
- 浏览器控制
- 网页抓取
- 页面读取
- MCP 服务器
- Edge 扩展

## 说明

- 名称与短描述在 Partner Center 里是只读的，来自包内 manifest；要改就更新 `extension/_locales/*/messages.json` 后重新上传包。
- 小节标题保持全大写风格；商店页面按纯文本段落渲染，保留换行。
- 工具数量（MCP 92、插件 37）由 `tests/unit/mcp-tool-methods.test.mjs`、`tests/unit/dsh-tools.test.mjs` 断言，数量变了要同步改本文件。
