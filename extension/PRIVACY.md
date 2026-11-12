# 隐私说明 / Privacy Notice

BridgeDeck扩展在你的本机运行，用于让本机命令行 Agent 操作用户已登录的浏览器。

## 访问的数据

- 页面内容：DOM/文本、可访问性树、截图、表单状态（仅在用户或 Agent 发起命令时读取）。
- 标签页信息：标题、URL、窗口与标签页结构。
- 网络与控制台：仅在用户显式开启“网站调试/采集”时读取请求元数据、响应正文与控制台输出。
- 视频与录制：仅在用户显式开始录制时捕获当前标签页画面/操作事件。
- 设置与审计：保存在浏览器本地存储（chrome.storage）与下载目录。

## 数据去向

- 默认只在本机流转：扩展 ↔ 本机 daemon（127.0.0.1）。
- 如果用户配置了远程 daemon，数据会发送到该地址；非本机地址强制使用 wss://。
- 扩展不包含遥测、分析 SDK 或广告；不向任何第三方服务器上传数据。
- 用户主动导出/下载的文件保存在本机下载目录。

## 权限用途

- `tabs`/`scripting`/`activeTab`/`<all_urls>`：读取和操作用户指定的页面。
- `debugger`：可信输入、设备仿真、关闭 shadow DOM 读取、整页截图。
- `webRequest`/`declarativeNetRequest`：网站调试时的请求观察与规则（仅用户开启时）。
- `downloads`：保存截图、表格、视频与导出文件。
- `tabCapture`/`offscreen`：用户主动开始的标签页录制。
- `storage`/`alarms`/`windows`：本地设置、会话与窗口管理。

## 保留与删除

- 设置、审计、录制历史保存在本地，可在扩展页面清空或删除扩展后由浏览器清理。
- 下载文件由用户自行管理。

## 联系

请通过扩展商店页面的发布者联系方式反馈。

---

The extension runs locally and lets a local command-line agent operate the browser session the user is already signed in to. It reads pages, tabs, screenshots, and (only when explicitly enabled) network/console data or recordings. Data stays on the machine by default; a user-configured remote daemon receives data only over wss://. There is no telemetry, analytics, or advertising, and no third-party upload.
