# 商店审核与权限说明

本文档用于扩展商店提交时的权限/数据说明，不含第三方品牌信息。

## 权限与用途

| 权限 | 用途 | 触发时机 |
| --- | --- | --- |
| `tabs`, `windows` | 列出/绑定标签页与窗口，支持 Agent 窗口 | 用户启动会话或操作标签页 |
| `scripting` + `<all_urls>` | 在用户指定页面读取 DOM、点击、填表、截图 | 用户/Agent 发起命令 |
| `debugger` | 可信输入（反爬场景）、设备仿真、closed shadow 读取、整页截图 | 显式命令或截图 |
| `webRequest`, `declarativeNetRequest` | 网站调试的请求观察与拦截规则 | 用户开启调试/规则 |
| `downloads` | 保存截图、CSV、视频、导出文件 | 用户导出 |
| `tabCapture`, `offscreen` | 标签页录制（无声音） | 用户开始录制 |
| `storage`, `alarms` | 本地设置、会话状态、定时清理 | 持续 |

## 数据与合规

- 无远程代码：所有 JS 随包发布，无 eval/new Function，无动态 script 注入外部 URL。
- 无遥测/广告/分析 SDK；默认只连本机 daemon（127.0.0.1）。
- 远程 daemon 必须 wss://；token 存本地。
- 隐私说明：`extension/PRIVACY.md`（提交时作为隐私政策链接内容）。
- 权限警告说明：`debugger` 与全站访问是核心功能所需；不使用该扩展时不会主动读取页面。

## 提交前检查

- [ ] manifest name/short_name/description 为用户品牌
- [ ] 图标 16/32/48/128 齐全且为自有资产
- [ ] 隐私政策 URL 可访问
- [ ] 截图不含第三方品牌/公司名
- [ ] 版本号与更新说明
- [ ] 打包内容无 .ref、测试数据、第三方二进制

## 已知限制（审核可说明）

- 不启用 incognito 模式（需要用户在扩展详情页手动允许）。
- 部分页面（商店页、chrome://、PDF 内置查看器）不可注入。
- `debugger` 生效时浏览器会显示调试提示条，属预期行为。

## 打包

在 `extension/` 目录执行（Windows 自带 tar，条目使用正斜杠）：

```powershell
tar.exe -a -c -f ..\dist\bridgedeck-0.1.1-edge.zip *
```

产物：`dist/bridgedeck-0.1.1-edge.zip`（manifest 在根目录，约 150 KB）。
