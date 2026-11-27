# 权限审计

最后更新：2026-11-27。版本：0.3.1。

## 当前声明（14 项）

| 权限 | 用途 | 是否可去掉 |
| --- | --- | --- |
| `tabs` | 标签页查询、绑定、激活、移动 | 否，Agent 窗口/会话核心 |
| `windows` | 窗口创建、聚焦、尺寸 | 否 |
| `scripting` | 注入 page-lib、读取/操作页面 | 否 |
| `storage` | 设置、会话状态、录制缓存 | 否 |
| `alarms` | Service Worker 重连、CDP 空闲清理 | 否，MV3 后台唤醒依赖 |
| `idle` | 系统空闲恢复后重连 daemon | 否，睡眠/离开恢复依赖 |
| `notifications` | 借用确认、人工协助、录制完成的系统提醒 | 否，弹窗关闭时仍能提醒 |
| `downloads` | 截图/CSV/视频/导出落盘、等待下载完成 | 否，`download` 命令与文件导出依赖 |
| `webNavigation` | iframe 树、隐藏/跨源 frame 标记 | 否，iframe 观察依赖 |
| `debugger` | 可信输入、CDP 网络/截图/AX/closed shadow | 否，核心执行通道 |
| `tabCapture` | 标签页视频录制 | 仅去掉视频功能时可去掉 |
| `offscreen` | 视频编码 offscreen 文档 | 仅去掉视频功能时可去掉 |
| `tabGroups` | Agent 窗口标签页分组 | 仅去掉标签组 UX 时可去掉 |
| `declarativeNetRequest` | 调试规则 block/redirect | 可迁移到 CDP Fetch 后去掉 |

主机权限：`<all_urls>`，任意页面自动化与内容脚本所需，无法收窄。

## 未声明且代码未使用的权限

- `activeTab`：未使用，当前 `<all_urls>` 已覆盖；
- `history`、`bookmarks`、`cookies`、`clipboardRead` 等均未使用。

## 已移除

- `webRequest`：网络采集已统一走 `debugger` 的 `Network` 域，不再需要 webRequest；代价是采集期间可能出现调试提示条。

## 进一步收紧的顺序

1. 把调试规则从 `declarativeNetRequest` 迁到 CDP `Fetch`，去掉 `declarativeNetRequest`；
2. 若不需要标签页视频，去掉 `tabCapture` + `offscreen`；
3. 其余权限均与核心功能绑定，去掉会直接破坏会话、文件落盘、iframe 观察、系统提醒或标签组。

## 验证

- 单测 955/955、CLI 155/155、真实 Edge E2E 145/147（2 项按借用确认策略跳过）。
- 网络、debug、规则、视频、iframe、录制、人工协助用例均通过。
