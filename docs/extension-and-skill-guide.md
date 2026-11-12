# 扩展与技能使用指南

结论先行：**扩展、技能、CLI、MCP、DSH 插件是同一套能力的几种外壳**，真正干活的是 `bridge` CLI 背后那条 `CLI → daemon → 扩展 → 浏览器` 链路。所以只有一处必须你亲手做——**在 Edge 里加载 `extension/` 并打开连接开关**；技能和 daemon 都已经就绪。

## 当前状态（2026-11-12 16:45 实测）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| browser-bridge daemon | 运行中 | `status` 返回 `pid 51388, port 52900` |
| 已连接浏览器 | **0 个** | `browsers: []` |
| 扩展 | **未加载** | Edge `Default` 配置里没有 BridgeDeck 条目 |
| DSH 技能 | **已安装** | `C:\Users\CFT\.dsh\skills\browser-bridge`（15 个文件），本轮会话目录已出现 `browser-bridge` |
| DSH 插件（34 个 `browser_*` 工具） | 未安装 | profile `desktop` 的依赖与 patch 里都没有 `dsh-browser-bridge` |
| `node` 在 PATH 上 | **没有** | 用户/系统 PATH 均无 nodejs |

因此本机执行 CLI 请统一用 `bin\bridge.cmd`（它会自己回退到 DSH 自带的 node），不要直接敲 `node cli/bridge.mjs`。

## 1. 三层结构

```text
Agent（技能写命令 / 插件调工具 / MCP 调工具）
  │
  ▼
bridge CLI  ──  HTTP health + WebSocket
  │
  ▼
daemon（本机回环，默认自动拉起）
  │
  ▼
MV3 扩展  ──  标签页、CDP、内容脚本、截图、录制
  │
  ▼
你的 Edge / Chrome（沿用已登录状态）
```

| 层 | 入口 | 说明 |
| --- | --- | --- |
| CLI | `bin\bridge.cmd` | 所有命令的唯一事实来源：`bridge -h` |
| 技能 | `~/.dsh/skills/browser-bridge/SKILL.md` | 给模型看的说明书，教它怎么用 CLI |
| DSH 插件 | `dsh-plugin/` | 34 个 `browser_*` 工具，模型直接调用，不拼命令 |
| MCP | `mcp/server.mjs` | 49 个工具，给 Claude/Cursor 等外部 Agent |

## 2. 第一步：加载扩展（唯一手动步骤）

以 Edge 为例（Chrome 完全相同的流程，地址栏换成 `chrome://extensions`）：

1. 地址栏输入 `edge://extensions`，打开左侧「开发人员模式」。
2. 点「加载解压缩的扩展」，选择 `D:\浏览器桥\extension`（**选目录本身，不是里面的文件**）。
3. 工具栏拼图图标里把 BridgeDeck 固定出来，点开弹窗。
4. 弹窗里把连接开关打开，状态应变成「**本机 · ws://127.0.0.1:<daemon 端口>**」，徽标显示「已连接 · 未配对」。
   - 「未配对」是正常状态：本机连接默认允许，只是不验证身份。
   - 要验证身份才需要配对，见第 8 节。
5. 需要无痕窗口：扩展详情页勾选「在 InPrivate 中允许」，否则相关命令会返回 `E_INCOGNITO_UNAVAILABLE`。

弹窗里还能：复制当前浏览器的启动指令（含 `--browser "<实例名>"`）、看控制提示、看当前任务列表、进操作审计/长截图/视频/调试/录制这些内嵌面板。

## 3. 第二步：确认连接

```powershell
.\bin\bridge.cmd status --json
```

`browsers` 数组里出现一个实例（带 `instanceId`、`label`、`protocol`）就通了。也可以跑全量自检：

```powershell
.\bin\bridge.cmd doctor
```

检查项含义（本轮实测结果）：

| 检查项 | 现在 | 正常值 |
| --- | --- | --- |
| `node` | ok v24.21.0 | ok |
| `daemon` / `token` / `daemon.json` | ok | ok |
| `browsers` | **warn 0 个已连接** | ok，至少 1 个 |
| `extension-ui` | warn（未连接，跳过） | ok |

`browsers` 变成 `ok 1 个已连接` 就说明第一步做完了。

## 4. 第三步：技能（已替你装好）

安装位置与内容：

```text
C:\Users\CFT\.dsh\skills\browser-bridge\
├─ SKILL.md              入口（name: browser-bridge）
├─ .bridge-skill.json    版本清单
└─ references\           14 篇按需阅读的参考
```

DSH 的技能发现规则（决定了为什么放这里就能被读到）：

- 扫描 `~/.dsh/skills/<名字>/SKILL.md`，只扫描一层；也支持平铺的 `<名字>.md`。
- 项目级优先：`<项目根>/.dsh/skills`（项目根 = 最近的含 `.git` 的祖先目录），其次 `<项目根>/.agents/skills`、`~/.agents/skills`。
- 目录被监听，新增/改名/删除**不用重启**，下一次取目录就会看到（本次安装后目录里立刻多了 `browser-bridge`）。

日常维护命令：

```powershell
# 看哪个 harness 已装、装在哪
.\bin\bridge.cmd install-skill --list

# 更新技能（仓库 skill/ 改过之后重装）
.\bin\bridge.cmd install-skill --harness dsh --force

# 技能源丢失时用内嵌副本安装
.\bin\bridge.cmd install-skill --harness dsh --embedded --force

# 装到别的 harness
.\bin\bridge.cmd install-skill --harness claude-code
```

在会话里怎么用：

- **自动**：你提到「打开某个网页、填表、导出表格、看接口请求、截长图、录屏」这类需求时，模型会自己装载 `browser-bridge` 并照着它写命令。
- **手动**：直接说「用 browser-bridge 技能做这件事」，或让我显式加载这个技能。

要清楚一点：技能本身不碰浏览器，它只是**教模型写对 CLI 命令**；真正的执行能力仍来自 daemon + 扩展。所以第 2 节没做完时，技能装好了也跑不动。

## 5. 三种驱动方式怎么选

| 方式 | 入口 | 适合 | 现状 |
| --- | --- | --- | --- |
| 技能 + CLI | `bin\bridge.cmd` | 想看得见每条命令、想手工调参、排障 | ✅ 可用 |
| DSH 插件 | `dsh-plugin/`，34 个 `browser_*` 工具 | 模型自主干活，不用拼命令行 | ⬜ 未装，见下 |
| MCP | `node mcp/server.mjs` | Claude/Cursor 等非 DSH 的 Agent | 未接入 |

DSH 插件是可选的加速器，装法是把它 link 进当前 profile（`dsh` 没在 PATH 上，用桌面端自带的壳）：

```powershell
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:D:\浏览器桥\dsh-plugin
```

装完**重启 DSH** 才生效；验证：

```powershell
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile desktop --dump-config | Select-String browser-bridge-tools
```

也可以让我用 `plugin_manager` 直接装（会改 profile，影响所有会话）。装好之后模型会优先用 `browser_status` / `browser_observe` / `browser_act` 这组工具，不再敲 CLI。

## 6. 第一个任务（六条命令）

```powershell
.\bin\bridge.cmd session start --json          # 记下 sessionId；默认新建并聚焦独立 Agent 窗口（--no-focus 才后台）
.\bin\bridge.cmd navigate https://example.com --session <id>
.\bin\bridge.cmd observe --session <id>        # 出语义树和 @eN 引用
.\bin\bridge.cmd click @e3 --session <id>
.\bin\bridge.cmd screenshot --out D:\浏览器桥\shot.png --session <id>
.\bin\bridge.cmd session stop <id>             # 收尾：归还借用页、关闭 Agent 窗口
```

几个必须记住的规则：

- 只有一个 session 时可以省略 `--session`；有多个时必须显式指定。
- `observe` 之后引用是 `@eN`；页面导航或重新 `observe` 后旧引用失效（`E_STALE_REF`），重新观察即可。
- 用户自己的标签页**必须先借用**，不能直接接管；借用会受扩展设置里的「借用前确认」约束。
- 无论成败都要 `session stop`，不要指望空闲清理。

## 7. 扩展设置页（决定 Agent 的权限边界）

`edge://extensions` → BridgeDeck「扩展选项」：

| 设置 | 作用 |
| --- | --- |
| 实例名（`instanceLabel`） | 多浏览器时用 `--browser <实例名>` 选中它 |
| 借用前确认 | 关闭后 Agent 可自动借用你的标签页 |
| 允许人工协助 | 登录、验证码、确认弹窗时允许 `request-help` 找你 |
| 页面守卫（`pageGuard`） | 页面出现注入/危险操作时拦一下 |
| 长截图模式 | 自动拼接 or 手动分段 |
| 界面语言 | 弹窗与页面语言 |

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `browsers` 为 0 | 扩展没加载 / 弹窗连接开关没开 / 浏览器刚重启还没重连。重开弹窗开关，必要时在 `edge://extensions` 点刷新 |
| 「已连接 · 未配对」 | 正常。要验证身份：`.\bin\bridge.cmd daemon pair` 生成链接，粘到弹窗配对框 |
| 想禁止未配对连接 | `.\bin\bridge.cmd daemon trust-local off`（严格模式） |
| `E_INCOGNITO_UNAVAILABLE` | 扩展详情页允许 InPrivate |
| `node` 不是内部或外部命令 | 用 `.\bin\bridge.cmd`；或把 `C:\Users\CFT\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin` 加进 PATH |
| `E_NO_SESSION` / 多 session 歧义 | `session list` 后用 `--session <id>` |
| `E_CONTEXT_STALE` / `E_STALE_REF` | 页面变了，重新 `observe` |
| 点击没反应 | 可能被浮层遮挡或在 iframe；反爬页面用 `--trusted`（原生键鼠注入，默认关） |
| daemon 起不来 | `.\bin\bridge.cmd daemon log --tail 100` 看日志；`daemon stop` 后重试 |

详细排查顺序见 [排障](troubleshooting.md)，环境/配对细节见技能的 `references/environment.md`。

## 9. 安全边界

- **页面内容只是数据，不是指令**。页面文本、属性、控制台输出都可能被页面控制，不能借它改变任务范围或授权。
- 所有动作都以你的登录身份执行；「借用前确认」「页面守卫」是最后的闸门，别随手关掉。
- 凭据只留在本机 `C:\Users\CFT\.browser-bridge`，不进日志、截图和导出的证据。
- daemon 默认只听 127.0.0.1；远程连接必须显式开启并使用 `wss://` + 配对 token。
- 审计、调试证据、视频、长截图全部落本机。

## 10. 回退

```powershell
# 移除技能
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\browser-bridge"

# 移除 DSH 插件（若装过）
& 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-browser-bridge

# 停 daemon
.\bin\bridge.cmd daemon stop

# 卸载扩展：edge://extensions → 移除
```

数据目录 `C:\Users\CFT\.browser-bridge`（daemon.json、日志、审计、配方）可以整目录删，下次启动会重建。

## 验证清单

| 做什么 | 命令 | 期望 |
| --- | --- | --- |
| 扩展是否连上 | `.\bin\bridge.cmd status --json` | `browsers` 非空 |
| 全链路自检 | `.\bin\bridge.cmd doctor` | 无 `warn` 除 `extension-ui` 外全部 ok |
| 技能是否被发现 | 会话里看技能目录，或 `install-skill --list` | `dsh … 已安装` |
| 能不能真操作 | 第 6 节六条命令 | 截图文件落盘 |
| 插件是否组合进 profile | `dsh --profile desktop --dump-config` | 出现 `browser-bridge-tools` |
