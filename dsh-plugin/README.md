# dsh-browser-bridge

DeepSeek Harness 插件：把 **BridgeDeck** 的 CLI 包装成模型可直接调用的 `browser_*` 工具（34 个）。
模型在会话里就能读页面、点按填表、导出表格、截图、抓网络，用的还是用户本机已登录的浏览器。

## 工具

| 工具 | 作用 |
| --- | --- |
| `browser_status` | daemon / 浏览器实例 / 活动会话 |
| `browser_session_start` | 开 Agent 窗口会话，或 `tab` 借用已有标签页 |
| `browser_session_stop` | 结束会话（借用页归还、Agent 页关闭） |
| `browser_navigate` | 导航并等加载 |
| `browser_observe` | 语义树 + `@eN` ref（可用 `grep` 过滤；`vom:true` 返回结构化节点） |
| `browser_act` | click/hover/focus/blur/scrollTo/fill/select/press/drag/wheel |
| `browser_read` | 读字段值 / HTML / 表格导出（read、html、extract） |
| `browser_screenshot` | 可见区域或整页长截图落盘 |
| `browser_eval` | 页面主世界执行表达式 |
| `browser_network` | 网络采集 start/list/detail/stop |
| `browser_dialog` | 原生弹窗拦截 arm/list/disarm |
| `browser_tab_borrow` | 借用用户标签页（受扩展设置里的“借用前确认”约束） |
| `browser_debug` | 网站调试：采集/请求/控制台/性能/导出 |
| `browser_video` | 标签页视频录制 start/stop/save/list/prune |
| `browser_record` | 操作录制 start/stop/list |
| `browser_cooperate` | 共享控制 sync/wait/handback |
| `browser_recipe` | 流程 list/show/save/approve/run/rm |
| `browser_pair` | 远程配对 create/list/redeem/revoke |

上表是主要工具。其余为便捷封装：`browser_tab` / `browser_tab_new` / `browser_tab_select` /
`browser_tab_close` / `browser_window` / `browser_audit` / `browser_brief` /
`browser_debug_query` / `browser_debug_evidence` / `browser_network_list` /
`browser_video_list` / `browser_video_status` / `browser_rule_list` /
`browser_settings` / `browser_update` / `browser_install_skill`。

工具内部就是一次 `bridge <命令> --json` 调用：退出码 0 取 `result`，否则抛带错误码的异常
（`E_STALE_REF`、`E_TIMEOUT`、`E_BORROW_DENIED`…），模型能按错误码自我修正。

## 安装

先确保BridgeDeck本体可用（`bridge doctor` 全 ok），然后：

```powershell
# 用 link: 安装，插件能按自身位置找到仓库里的 cli/bridge.mjs
dsh plugin --profile <你的 profile> add link:D:\BridgeDeck\dsh-plugin

# 重启 profile 生效
dsh --profile <你的 profile>
```

如果使用 `file:` 或复制方式安装（插件不在仓库目录里），把 CLI 路径写进配置：

```yaml
# 在 profile 的 cordis.patch.yml 里追加（或用 dsh 的插件设置界面改）
- insert:
    - id: browser-bridge-tools
      name: dsh-browser-bridge
      config:
        bridgeCli: D:\BridgeDeck\cli\bridge.mjs
        nodePath: ''      # 留空时自动：非 Electron 用当前 node，Electron 用运行时自带的 node.exe
        home: ''          # 需要和桌面端 daemon 隔离时指向另一个 BB_HOME
        sessionScope: ''  # 可选：注入 BB_SESSION_SCOPE，工具未传 sessionId 时按 controller 选会话
        timeoutMs: 120000
```

> `link:` 安装时 pnpm 会提示 peerDependencies（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）
> 不由目标 node_modules 解析——这是正常的，运行时由 Harness 提供。

## 验证

```powershell
# 1. 组合进 profile（只看配置，不启动）
dsh --profile <你的 profile> --dump-config | Select-String browser-bridge

# 2. 启动后在新会话里让模型调用 browser_status
#    或直接跑本体自测：
node tests/plugin/selftest.mjs    # 工具映射 + 入口 apply
node tools/plugin-profile-check.mjs  # 建临时 profile 安装并验证组合（自动清理）
```

## 边界

* 插件不读 cookie/密码；所有能力都等价于一次 `bridge` 命令。
* 借用用户标签页、人工协助受扩展设置约束，插件不绕过。
* `browser_network --bodies`、`browser_dialog`、`emulate` 会挂 `chrome.debugger`（浏览器显示调试提示条），
  用完由 `session stop` 统一释放。
