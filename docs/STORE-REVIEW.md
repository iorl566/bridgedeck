# 商店审核与权限说明（0.3.1）

> 面向 Edge Add-ons / Chrome Web Store 审核：权限用途、数据流向、测试说明、已知限制。
> 不含第三方品牌信息；隐私政策 URL 与支持 URL 见 `docs/STORE-LISTING.md`。

## 1. 权限与用途（与 `extension/manifest.json` 逐项对应）

| 权限 | 用途 | 触发时机 | 说明 |
| --- | --- | --- | --- |
| `tabs` | 列出/绑定/分组标签页，支持 Agent Window | 用户启动会话或操作标签页 | 只操作用户授权或 Agent 新建的标签页 |
| `scripting` | 在用户指定页面读取 DOM、点击、填表、截图 | 用户/Agent 发起命令 | 不注入浏览器内部页（chrome://、商店页等） |
| `<all_urls>`（host） | 允许用户在任意站点工作 | 同 `scripting` | 不做全站后台扫描；仅命令触达的页面 |
| `debugger` | 可信输入（反爬场景）、设备仿真、closed shadow 读取、整页截图 | 显式命令或截图 | 用户不需要该扩展时不会主动 attach；浏览器会显示调试提示 |
| `declarativeNetRequest` | 网站调试的拦截/重定向规则 | 用户开启规则 | 规则在显式 debug session 内生效 |
| `downloads` | 保存截图、CSV、视频、导出文件 | 用户导出 | 只写用户下载目录 |
| `tabCapture` + `offscreen` | 当前标签页无声音录制 | 用户开始录制 | 录制期间浏览器显示「正在共享」提示 |
| `storage` | 本地设置、会话状态、审计/别名/策略 | 持续 | 本机存储，不上传 |
| `alarms` + `idle` | 生命周期、定时清理、空闲恢复 | 持续 | 不后台偷跑 |
| `windows` | 创建/复用 Agent Window | 用户启动会话 | 不自动弹窗打扰 |
| `webNavigation` | iframe/导航观察、跨源 frame 标记 | 观察或录制时 | 只观察已授权标签页 |
| `notifications` | 借用确认、人工协助、录制完成的系统提醒 | 需要用户确认/任务完成 | 仅在用户开启时 |
| `tabGroups` | Agent Window 标签页分组 | 创建/复用 Agent Window | 只给 Agent 标签页命名分组 |

## 2. 数据与合规

- 无远程代码、无 `eval`/`new Function`、无动态 script 外链；所有 JS 随包发布；
- 无遥测、广告、分析 SDK；默认只连本机 daemon（127.0.0.1）；
- 远程 daemon 必须显式配对且使用 wss://；token 只存本机；
- 截图/录制/调试证据/审计默认本机保存，用户可清理/删除；
- 网络与控制台数据只在用户显式开启调试时读取；
- 敏感字段（Cookie、Authorization、密码框等）按规则脱敏，导出可复核。

## 3. 测试与验证说明（给审核）

- 无账号也可基本验证：默认本地模式连接本机 daemon；`bridge status --json` 可查看连接；
- 扩展自检入口：`chrome-extension://<id>/ui/popup.html`（UI 自检开关由构建保留）；
- a11y：12 语言覆盖、RTL 逻辑属性、WCAG AA 对比度门禁、焦点顺序与 `aria-live`；
- 自动化回归：JS E2E 222 条（真实 Edge）、单元 5060、CLI 404、MCP 216、Python 181；
- 发布门禁：品牌扫描、source-guard、编码/模块加载、vendor-leak、协议 4 门禁、体积预算。

## 4. 已知限制（如实说明）

- 不启用 incognito（需用户在扩展详情页手动允许）；
- 部分页面（商店页、chrome://、PDF 内置查看器）不可注入；
- `debugger` 生效时浏览器显示调试提示，属预期行为；
- 录制为标签页画面（无声音），文件保留在本地视频库，用户可删除。

## 5. 打包与来源

- 商店包：`dist/BridgeDeck-extension-0.3.1.zip`（由 `node tools/build-extension.mjs` 生成，`verify-extension-package.mjs` 校验）；
- 包内不含 `.ref`、测试数据、第三方二进制；发布前跑 `npm run brand:scan`。

## 6. 审核联系

- 支持/反馈：https://github.com/iorl566/bridgedeck/issues
- 隐私政策：https://iorl566.github.io/bridgedeck/privacy-policy.html
