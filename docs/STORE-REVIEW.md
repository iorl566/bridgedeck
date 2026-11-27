# Edge 审核页填写答案（Partner Center → Privacy / Submit）

> 用途：把这一段直接抄进 Partner Center 的 Privacy 与 Submit 页面，避免在会过期的登录会话里现写。
> 口径与 `docs/privacy-policy.html`、`docs/PERMISSIONS.md`、manifest 保持一致；改权限或数据流向时同步改三处。

## 1. Single Purpose Description

粘贴（英文）：

```
BridgeDeck connects a locally running command-line AI agent to the browser the user is already signed in to, so the agent can carry out the web tasks the user asks for: read pages, click, type, fill forms, extract tables, record a task and collect debugging evidence. All automation runs through a local daemon on 127.0.0.1; the extension does not contact any remote service on its own, contains no telemetry, and never calls an AI provider by itself.
```

## 2. Permission justification（14 项 + host）

逐条粘贴（英文）：

| 权限 | 粘贴内容 |
| --- | --- |
| `tabs` | List, create, activate, move and close tabs so the agent can work in its own Agent Window and bind a task to the tab the user chooses. |
| `windows` | Create and focus the Agent Window for a task and read window bounds. |
| `scripting` | Inject the extension's page library into pages the user asks the agent to work with, and read page structure. |
| `storage` | Store local settings, session state and recording buffers in the browser profile. |
| `alarms` | Keep the MV3 service worker reconnecting to the local daemon and clean up idle debugger sessions. |
| `idle` | Reconnect to the local daemon after the system wakes from sleep. |
| `notifications` | Ask the user to confirm borrowing a tab, request human help for login or verification, and report recording completion while the popup is closed. |
| `downloads` | Save screenshots, extracted CSV/JSON and recordings to the download folder, and wait for a download to complete. |
| `webNavigation` | Build the iframe tree and mark hidden or cross-origin frames while observing a page. |
| `debugger` | Use the DevTools protocol for trusted input events, page screenshots, the accessibility tree, closed shadow DOM access and network evidence collection. |
| `tabCapture` | Record one authorized task tab as a silent video when the user starts recording. |
| `offscreen` | Encode the recorded tab in an offscreen document, which MV3 requires for video recording. |
| `tabGroups` | Group the agent's tabs into an Agent Window group. |
| `declarativeNetRequest` | Apply user-defined request block/redirect rules while debugging a site. |
| host `<all_urls>` | The agent performs tasks on arbitrary sites the user chooses. Page automation and content scripts require access to any URL, and the access is used only while a task is running under the Agent Window. |

## 3. Are you using remote code?

选 **No, I am not using remote code**。扩展包内没有 `eval`、`new Function`、远程脚本加载；所有代码随包发布。

## 4. Data usage

勾选建议（与隐私政策列出的数据类别一致）：

| 选项 | 勾选 | 理由 |
| --- | --- | --- |
| Website content（页面内容） | ✅ | Agent 按用户指令读取 DOM/文本/表格、截图；仅在命令执行时读取 |
| Browsing activity / tab URLs | ✅ | 需要列出与绑定标签页、记录操作时间线 |
| 其它（PII、健康、财务、认证信息、位置、个人通信等） | ❌ | 不读取密码、不抓取输入框内容、不做画像 |

认证声明（全部勾选）：

- 不出售或转让用户数据给第三方；
- 不将数据用于与扩展单一用途无关的目的；
- 不用于信用评估或放贷；
- 符合 Microsoft Edge 加载项开发者政策中的有限使用要求。

补充说明（如果审核人员问起，可直接引用）：

```
All processing is local. Page content, tab metadata, screenshots, recordings, debugging evidence and audit records stay on the user's machine and flow only to the user's own local daemon on 127.0.0.1. If the user explicitly configures a remote daemon, data is sent there over authenticated WSS. There is no telemetry, no analytics, no advertising and no upload to the developer or any third party, which is exactly what our privacy policy states.
```

## 5. Privacy policy URL

```
https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html
```

> 仓库内副本是 `docs/privacy-policy.html`；线上这份在 `iorl566/bridgedeck-privacy`（GitHub Pages）上，
> 两处内容必须一致。`docs/releases/0.3.1.md` 里的旧链接（`bridgedeck/privacy-policy.html`）已不可用，
> 不要再用那个地址。

## 6. Notes for certification（提交时粘贴）

完整文件：`docs/assets/store/certification-notes-0.3.1.md`（`tools/publish-edge.ps1` 默认引用的就是它）。

要点：

- 说明这次是 0.3.1 更新，以及相比 0.3.0 的变化；
- 说明不登录、不需要测试账号：扩展本身可离线打开，页面自动化需要用户自己的本机 daemon；
- 给出 3 步验证路径（装扩展 → 打开弹窗 → 打开“快捷功能”各页面）；
- 说明 `<all_urls>` / `debugger` 的用途，且不得不用；
- 说明没有远程代码、没有遥测。

## 7. 提交前自查（对照常见退回理由）

- [ ] Website 字段已从 `example.com` 改成真实地址（`https://github.com/iorl566/bridgedeck`）
- [ ] Support 联系方式是可达的 issues 页面
- [ ] 隐私政策 URL 可访问，内容与勾选的数据类别一致
- [ ] 13 个语言行都有 Description + Logo（缺一个语言行就会卡住 Publish）
- [ ] 截图 5 张、1280×800、顺序按 `docs/STORE-LISTING.md`
- [ ] 名称/短描述没有超长或与 manifest 冲突（只读字段，改只能重打包）
- [ ] 认证备注写清了“无需登录、无测试账号、本地 daemon 可选”
- [ ] 商店 listing 里不再出现 `example.com`、旧隐私 URL、旧的 “49 tools” 之类的陈旧信息
