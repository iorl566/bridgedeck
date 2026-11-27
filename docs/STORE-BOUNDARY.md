# 商店边界（a11y / 权限 / 隐私）

这份文档是“上架前必须能解释清楚”的边界，不是营销文案。当前版本 **0.3.0**，未重新打包/发版。

## 1. 权限

`extension/manifest.json` 当前声明：

| 权限 | 用途 | 审核需要能说明的边界 |
| --- | --- | --- |
| `debugger` | CDP 动作/截图/网络/调试 | 只在用户显式 session/动作时 attach；空闲软分离 |
| `tabs` | tab 列表/新建/关闭/分组 | 只操作用户授权或 Agent 新建的 tab |
| `tabGroups` | 命名标签组 | 只给 Agent tab 分组 |
| `scripting` | 页面内注入/隔离世界 | 不注入浏览器内部页 |
| `storage` | 设置/审计/别名/策略 | 本机存储，不上传 |
| `alarms` / `idle` | 生命周期/空闲 | 不后台偷跑 |
| `webNavigation` | frame/导航观察 | 只观察已授权 tab |
| `notifications` | 人工协助提醒 | 只在用户开启时 |
| `declarativeNetRequest` | 调试规则/请求重放 | 规则只在显式 debug session |
| `<all_urls>` | 用户指定站点工作 | 不做全站后台扫描 |

新增权限必须先更新本表、`docs/security.md` 与 preflight。

## 2. 数据边界

- 截图、长截图、视频、debug 证据默认落本机（IndexedDB/临时目录），不上传。
- 网络/控制台脱敏：密码、文件、OTP、卡号、Authorization/Cookie 等按规则脱敏。
- 配对 token 只在本机 daemon/扩展之间使用；远程连接需要显式配对。
- 不收集遥测；不把页面内容发给除用户指定模型之外的第三方。
- 审计日志/操作记录在本机，用户可清理。

## 3. 可访问性

已做的基础检查：

- `html[lang]` 存在，i18n 支持 12 语言（含 ar/he RTL）。
- 弹窗按钮有可读名称（文本/`aria-label`/`title`）。
- `role="switch"` 带 `aria-checked`。
- 图片有 `alt`（当前 UI 无装饰图例外）。
- 自检入口：`ui?page=popup&selftest=a11y`，E2E `29e` 断言 `SELFTEST:ok:a11y:0`。

仍可加强：焦点顺序/键盘全流程、对比度自动检查、屏幕阅读器实测、动态 `aria-live` 覆盖。

## 4. 上架前检查清单

- [ ] 权限表与 manifest 一致
- [ ] 隐私说明（本地存储、不上传、保留期）
- [ ] 单一用途说明（真实浏览器自动化/协作）
- [ ] 无远程代码加载（MV3 约束）
- [ ] 截图/视频/debug 导出路径明确
- [ ] 用户可撤销配对/清理数据
- [ ] a11y 自检通过（`29e`）
- [ ] vendor leak / preflight / 签名 release 通过

## 5. 已知审核风险

- `debugger` 权限 + `<all_urls>` 是强权限，需要在 listing 中解释“用户显式操作才 attach”。
- 页面内 `evaluate`/脚本注入容易被误判为远程代码；说明这是用户/Agent 主动动作，不是扩展自身执行远程脚本。
- 录制/截图涉及隐私，需要明确“仅本机、用户可删除”。
