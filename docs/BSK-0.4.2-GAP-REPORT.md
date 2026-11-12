# BridgeDeck 对照 BrowserSkill 0.4.2 差距报告

日期：2026-11-12 · 项目版本：bridge v0.1.1（协议 1.8）· 对照版本：bsk 0.4.2（`cli-v0.4.2`，2026-11-05 发布）

---

## 0. 复核过程与来源

> **2026-11-12 16:5x 更新**：第 3 节的 P0/P1 已全部修掉（见第 7 节），并定位修复了"Agent 跑在用户同一个页面里"的页面守卫竞态。

| 项 | 结果 |
|---|---|
| 官网 | https://browserskill.weixin.qq.com/#features（首次打开时 `app.js` 抛 `Cannot read properties of undefined (reading 'i18n')`，功能/命令区空白；重载后恢复） |
| 数据源 | 页面内容由 `assets/i18n.js` 的 `window.SITE` 渲染（features / secFeatures / commands / faq / releases），已落盘 `ref/i18n.js` |
| 版本清单 | `stable/version.json` → **bsk 0.4.2**，GitHub tag `cli-v0.4.2` |
| 用 BridgeDeck 下载 | `bsk-windows-x64.zip` 7,390,199 B；`browser-skill-extension.zip` 1,120,368 B → `ref/bsk-0.4.2/` |
| 版本自证 | `bsk.exe --version` → `bsk 0.4.2` |
| 我方 CLI | `bridge --help`、`fill/session/settings/install-skill` 实测 |

> 说明：官网那份 0.4.2 的 changelog 只有 7 条；0.4.1/0.4.0 的条目在 `releases` 数组里，下文一并核对。

---

## 1. 结论摘要

- 官方 9 项产品能力：**6 项完整具备，3 项部分具备**（借用确认可被 CLI 关掉、审计默认关闭、harness 少 Pi/Hermes）。
- 官方 4 条安全策略：**3 条具备，1 条有实质偏差**（借用前确认可被 CLI 关闭）。
- 官方 0.4.2 的 7 条更新：**2 条完全具备**（会话标签、fill 日期类）、**2 条部分**（`--mcp` 入口缺、敏感字段遮蔽缺 2 个出口）、**1 条未做**（更新双源）、**2 条待核对**（共享控制 2 秒静默、滚动/无效按键）。
- 命令面：官方命令表 60 余条，我们只缺 **`daemon restart`** 一条（另有 `emulate --off` 命名差异）。
- 真正需要动手的缺口共 **4 个功能点 + 3 个细节**，见第 3 节。

---

## 2. 已具备（附证据，避免误判）

### 2.1 官方 9 项产品能力

| 官方能力 | 我们 | 证据 |
|---|---|---|
| 复用已有登录状态 | ✅ | 复用实例浏览器 profile；`session start` 默认开独立窗口 |
| 借用标签页，先问后动 | ⚠️ 有借用/归还，但确认可被 CLI 关掉 | `tab borrow/return`；`settings set --borrow-confirm` |
| 关键环节，人来决定 | ✅ | `request-help --reason`、`HelpRequestOverlay`、`takeover.js` |
| 操作留痕，安全可查 | ⚠️ 有 `audit list`，但默认 `auditEnabled=false` | `settings --json` 实测 `auditEnabled:false` |
| 云端 Agent，本机浏览器 | ✅ | `pair create/redeem/revoke`、`daemon trust-local`、TLS、`remote-authorization.js` |
| 独立执行，互不干扰 | ✅ | Agent Window（`session-manager/agent-window.js`）、多 session |
| 不挑 Agent，不锁模型 | ⚠️ 8 个 harness（缺 Pi、Hermes，多 qoder） | `SKILL_TARGETS` @ cli/bridge.mjs:3817-3827 |
| 先看懂页面，再动手 | ✅ | `observe`/`snapshot` + `@eN` refs + VOM |
| 复杂交互 | ✅ | click/fill/select/press/hover/scroll/upload/download + 截图 + console/network + emulate + canvas 坐标点选 |

### 2.2 官方 0.4.2 七条更新

| 官方条目 | 我们 | 证据 |
|---|---|---|
| 会话控制标签（agent 名/项目/会话 ID/颜色，覆盖层显示） | ✅ | `session start --agent-name --project --controller-color`；`lib/controller-info.js`、`content/ControlOverlay.js` |
| fill 支持 date/time/datetime-local/month/week + 格式与 min/max 校验 | ✅ **实测通过** | 五类输入全部填入成功；越界 `2025-01-01`（min 2026-01-01）→ `E_BAD_ARG: 日期/时间值 2025-01-01 超出允许范围`；非法 `2026-13-45` → `E_BAD_ARG: 格式不合法` |
| `bsk mcp` + `install-skill --mcp` | ⚠️ 功能有，CLI 入口缺 | `configureMcp()` @ 4094、调用 @ 4194；但 `--mcp` 实测报"未知选项" |
| 更新优先国内源、回退 GitHub、双源失败列 URL | ❌ 未做 | `update` 只有 manifest/`--source` + SHA256（`sha256File` @ 905） |
| 共享控制：人最后一次完成后静默 2 秒（原 650ms） | ？ 未验证 | 代码里没有 `650`/2000ms 对应常量，需人工核对等价实现 |
| 敏感字段（autocomplete otp/card/password）不进共享字段状态、expect 失败详情、结构化提取、录制填充 | ⚠️ 覆盖 2/4 | `sensitiveAutocomplete` 仅用于 `cooperation-capture.js:217`、`record-capture.js:275`（+密码切换 `:248/:1028`）；expect 失败详情、extract 未见同源遮蔽 |
| 滚动/无效按键期间共享控制保持运行 | ？ 未验证 | 同上一行，需人工核对 |

### 2.3 官方 0.4.1 / 0.4.0 已对齐项

协议 1.8（`extension/src/protocol-version.js:2`）、`--expect`/`--policy strict`、DOM ref 跨观察保持、导航使 ref 失效、`step`/`view`、`drag --mode hold|click-move-click`、`session start --incognito`、无 tabGroups 依赖、`createRandomUuid` 兜底（`lib/random-uuid.js`）、命令取消与截取期限（`command-cancel.js`、`command-deadline.js`）。

---

## 3. 确定缺失项（按优先级）

### P0 `install-skill --mcp` 不可用（一行 bug）
- 代码里 `configureMcp()`（cli/bridge.mjs:4094）与调用点（4194）都在，能写 Codex `config.toml`、Cursor `mcp.json`、Claude `~/.claude.json`。
- 但 `'mcp'` 没注册进 `BOOL_FLAGS`（cli/bridge.mjs:91）。
- 实测：`bridge install-skill --mcp --list` → `参数错误：未知选项：--mcp`。
- 修法：`BOOL_FLAGS` 加 `'mcp'`，并在总帮助的 install-skill 行补 `[--mcp]`。

### P1 缺 Pi、Hermes 两个 harness
- 官方"9 款主流 Agent 开箱即用"：WorkBuddy、CodeBuddy、Cursor、Codex、Claude Code、Pi、OpenClaw、Hermes、DSH。
- 我们：dsh、claude-code/claude、codex、cursor、codebuddy、workbuddy、openclaw、qoder（8 个；多 qoder，缺 Pi、Hermes）。
- 补：`SKILL_TARGETS` 增加 `pi`、`hermes` 的安装路径，并在 README/SKILL 的 harness 列表同步。

### P1 借用前确认可被 CLI 关闭（与官方安全策略冲突）
- 官方："「借用标签前确认」默认开启，而且**不能用命令行参数绕过**。最终以你在浏览器里保存的设置为准，Agent 一侧改不动。"
- 实测：`bridge settings set --borrow-confirm off` 直接生效（已恢复为 on）。
- 影响：Agent 只要跑一条命令就能关掉"先问后动"，安全承诺失效。
- 建议：`borrowConfirm` 只允许扩展 UI 修改；CLI 侧改为只读，或要求 `--confirm-human` 二次确认。

### P1 缺 `daemon restart`
- 官方命令表有 `bsk daemon restart`；我们只有 `daemon start|stop|status|log|pair|devices|revoke|trust-local`（实测 `bridge daemon restart` → 用法报错）。
- 补：内部 `stop` → `start`，保留 `sessions.json`，重启后旧 sessionId 仍可用（现有 `daemon` 生命周期已支持该语义）。

### P2 更新通道无镜像回退
- 官方：官网国内源优先 → GitHub 回退 → 双源都失败时列出各 URL 与原因，全程 SHA256。
- 我们：`update check|verify|stage|fetch|apply` 依赖 `--manifest`/`--source`，SHA256 校验已有（905 行），但没有内置镜像与自动回退。

### P2 敏感字段遮蔽只覆盖一半
- 官方 0.4.2 要求 4 个出口：共享控制字段状态、`expect` 失败详情、结构化提取、录制填充步骤。
- 我们只有前两项的一半（`cooperation-capture`、`record-capture`），`expect` 失败详情与 `extract` 未接 `sensitiveAutocomplete`。

### P3 细节
1. `bridge <子命令> -h` 只打印总帮助（`fill -h`、`session start -h` 实测均是根帮助）；bsk 每个子命令有独立 help。
2. `bridge mcp` 命令存在（cli/bridge.mjs:4364）但总帮助里没列，只在页脚写"node mcp/server.mjs"。
3. `emulate --off`（bsk）↔ 我们 `--reset`，建议加别名。

---

## 4. 我们领先官方的部分（保持住，别在追赶时砍掉）

调试与取证：`debug` 全链路（requests / console / performance / rules mock·redirect·block / replay / archive / journal / evidence / duplicates / fetch_probe）；`record` → trace 教材；`video` 录制与导出；`long-screenshot`；`recipe` + `plan` + `step`；`audit`；closed shadow root 支持；VOM 结构化观察；canvas 按图坐标点选；`agent brief`；`session rebind`；`tab borrow --timeout`。

官方命令表里没有对应的：`debug *`、`video *`、`record export`、`plan`、`recipe`、`audit`、`agent brief`。这块是我们的差异化，建议在 README 里单独成节，而不是只当"内部能力"。

---

## 5. 建议动作清单（按性价比排序）

1. **一行修**：`BOOL_FLAGS` 加 `'mcp'`，install-skill 帮助补 `[--mcp]`（P0）。
2. `SKILL_TARGETS` 加 `pi`、`hermes`（P1，两条路径 + 文档）。
3. `daemon restart` 走 `stop`→`start`（P1，约 20 行）。
4. `borrowConfirm` 收口到扩展侧，CLI 只读（P1，安全承诺对齐）。
5. `expect` 失败详情与 `extract` 结果接 `sensitiveAutocomplete` 遮蔽（P2）。
6. `update` 加国内镜像回退（P2）。
7. 子命令 `-h`、`bridge mcp` 写进总帮助、`emulate --off` 别名（P3）。

---

## 6. 复现命令（本次核验用）

```sh
bridge session start --json
bridge navigate https://browserskill.weixin.qq.com/#features --session <id>
bridge download --url <stable/bsk-windows-x64.zip> --out ref/bsk-0.4.2/bsk-windows-x64.zip --session <id>
ref/bsk-0.4.2/cli/bsk.exe --version            # bsk 0.4.2
bridge install-skill --mcp --list               # 修复前：未知选项 → 修复后：正常解析
bridge daemon restart                           # 修复前：用法报错 → 修复后：daemon 已重启
bridge settings set --borrow-confirm off        # 修复前：生效 → 修复后：E_FORBIDDEN
bridge fill @e1 --value 2025-01-01              # E_BAD_ARG 超出范围
bridge fill @e1 --value 2026-13-45              # E_BAD_ARG 格式不合法
bridge screenshot --out ref/shot.png --json     # width/height/bytes 均返回
```

---

## 7. 本轮修复（2026-11-12）

### 7.1 「Agent 跑在用户同一个页面里」——页面守卫竞态（用户实测反馈）

- **现象**：`session start` 返回了新的 `windowId`，但那个窗口随即消失，标签页落到用户窗口里（`tab list` 显示窗口是用户的），Agent 就在用户当前窗口里操作。
- **根因**：`extension/src/bridge.js` 的页面守卫（"外部/手动新建的标签页落进 agent 窗口时移回用户窗口"）与 `chrome.windows.create` 存在竞态。`ensureAgent` 先 `writeAgentWindowId(新id)` 再 `markSelfCreated(tabId)`，守卫在这两步之间看到「新窗口 + 未标记的 tab」，判成外部标签页 → `chrome.tabs.move` 移进用户窗口 → 空窗口被关闭。实测两次复现：`window list` 里根本没有返回的 windowId，tab 却出现在用户窗口。
- **修复**：
  - `extension/src/tabs.js`：新增窗口维度标记 `markSelfCreatedWindow()` / `isSelfCreatedWindow()`；建窗返回后**同步**登记窗口，并把 tab 标记提前到任何 await 之前（普通窗口 / 无痕窗口 / `tab new --window` 三处）。
  - `extension/src/bridge.js`：页面守卫在 `consumeSelfCreated(tabId)` 之后追加 `isSelfCreatedWindow(tab.windowId)` 放行，覆盖 tab 标记尚未落上的时间窗。
- **顺带修**：`session start` 默认焦点反了——之前 `noFocus` 默认 true（后台开窗，用户看不见），与官方语义（`--no-focus` 才是后台）相反。现改为默认聚焦新建的独立 Agent Window，`--no-focus` 才后台。

### 7.2 其它已修

| 项 | 改动 |
|---|---|
| `install-skill --mcp` 不可用 | `cli/bridge.mjs` 的 `BOOL_FLAGS` 补 `mcp`；总帮助补 `[--mcp]` 与说明 |
| 缺 Pi / Hermes | `SKILL_TARGETS` 增加 `pi`（`~/.pi/agent/skills`）、`hermes`（`%LOCALAPPDATA%/hermes/skills`）、`kimi-code`（`~/.kimi-code/skills`），路径取自 `bsk 0.4.2 install-skill --list` |
| 缺 `daemon restart` | 新增 `bridge daemon restart`（stop → ensure，保留 BB_HOME 会话数据），实测 `daemon 已重启 (pid …, port 52900)` |
| 借用确认可被 CLI 关闭 | 双层收口：CLI 拒绝 `settings set --borrow-confirm`（`E_FORBIDDEN`）；`extension/src/settings.js` 的 `settings.set` 拒绝 daemon/CLI 来源的 `borrowConfirm`；`extension/src/tabs.js` 的 `tab.borrow` 不再接受参数降级，只听浏览器里保存的设置 |
| 文档口径 | `skill/SKILL.md`、`skill/references/tabs-and-profiles.md`、`docs/PROTOCOL.md`、`docs/extension-and-skill-guide.md` 同步；`cli/embedded-skill.mjs` 同步 |

### 7.3 验证状态

- `tests/extension/module-load.mjs`：PASS（新增 import 不破模块加载）。
- **新增回归** `tests/extension/page-guard.mjs`（`selftest:page-guard`，已并入 `pnpm test`）：用最小 chrome stub 复现建窗时序，断言三条——自建窗口放行、单 tab 新窗口放行、2 tab agent 窗口里的外部 tab 仍被搬回用户窗口。**PASS**。
- `tests/unit/*`（`--experimental-test-isolation=none`）：全通过；单文件跑 `lib-agent-describe-target` 6/6（合并跑时那 1 条失败是测试间全局污染，隔离模式不复现）。
- `bridge daemon restart` / `install-skill --list`（含 pi/hermes/kimi-code）/ `settings set --borrow-confirm`（E_FORBIDDEN）/ `install-skill --mcp` 解析：已在真实 daemon 上实测通过。
- 扩展侧设置收口：直接打 daemon RPC `settings.set {patch:{borrowConfirm:false}}` → `E_FORBIDDEN`，确认新代码已在浏览器里生效。
- 页面守卫修复在 reload 后**已在真实浏览器验证通过**：
  - reload 前：`session start` 返回的 windowId 不存在，tab 落进用户窗口（用户窗口 tab 数 +1）。
  - reload 后：`session start --agent-name BridgeDeck` → 用户窗口保持 15 个 tab 不变，新建 `window 1500946983`（1 tab）；`navigate https://example.com` 后 `tab list --scope agent` 仍显示 `1500946984 @ 1500946983`。独立 Agent Window 成立。
- 说明：`edge://extensions` 里显示"服务工作进程（不活动）"是 MV3 正常状态，不代表加载失败；worker 被事件唤醒时重新从磁盘加载脚本，所以改完代码点一次「重新加载」即可。
  ```powershell
  bridge session list; bridge session stop <id>; bridge session start --json --agent-name BridgeDeck
  bridge window list --json   # 期望：出现新 windowId，用户窗口 tab 数不变
  ```

### 7.4 会话隔离与连接日志（2026-11-12 第二批）

- **会话共用 tab 的缺陷**：`window.ensureAgent` 复用 agent 窗口当前激活的 tab，导致两个 session 绑同一 tab，停掉其中一个会把另一个的页面一起关掉（实测 `uecu`/`onrf` 都指向 tab 1500946984）。
  - 先修成"每 session 一个 tab"（`session.start` 传 `newTab`），验证：`swjt → tab 1500947002`、`pvjh → tab 1500947007`，停 swjt 后 pvjh 存活。
  - 第三批进一步升级为"每 session 一个专属窗口"，见 7.5。
- **重连日志降噪**：`ws-client.js` 连接循环改为每轮只打一条摘要（"WS 连接失败（10 个端点）…"），不再刷 10 行；浏览器自身对每个失败 WebSocket 打的 `ERR_CONNECTION_REFUSED` 无法抑制，但扩展侧日志干净了。
- 说明：实例 id 在 reload 后会变化属正常（`chrome.storage.session` 随重载清空）。

### 7.5 每任务一个专属窗口 + 敏感字段遮蔽（2026-11-12 第三批）

- **每 session 一个 Agent 窗口**（取代"单窗口多 tab"）：
  - 新增 `window.newAgent`（建窗 + 注册）与 `window.close`（关窗）；`session.start` 改走 `newAgent`，`session.stop` 在关 tab 后连带关窗。
  - 扩展维护 `bb.agentWindowIds` 注册表：`tab.list --scope agent`、页面守卫、接管浮层、`tab.new` 都按"所有 Agent 窗口"判断；窗口被用户手动关掉时自动注销。
  - `tab.new` 由 daemon 注入本会话的 `windowId`，新标签页落在自己的窗口里。
  - 实测：`ozwb → window 1500947016 / tab 1500947017`，`hdun → window 1500947022 / tab 1500947023`（两个独立窗口，各 1 tab，用户窗口 15 tab 不变）；`session stop ozwb` 后窗口 1500947016 消失，`hdun` 不受影响。
- **敏感字段遮蔽复核**：这项其实早已覆盖，上次判断漏看了 page-lib：
  - `injected/page-lib.js` 的 `sensitiveField()` 覆盖 `type=password`、`autocomplete` 的 `current-password/new-password/one-time-code/cc-*`，以及"密码框切成 text 后"的字段（WeakSet + MutationObserver）；
  - `expect-check`、`read`/`read --all`、结构化提取的 `value` 读取都替换为 `********`；
  - 本轮补了唯一的口子：敏感字段读 `value` **属性**（`attribute=value`）也遮蔽。
  - 实测：OTP 框填值后触发 expect 失配 → 报错 `期望 "********"，实际 "********"`；`read --all` 返回 `otp=********`、`pwd=********`、普通字段正常。

### 7.6 0.4.2 七条更新逐条对照（2026-11-12，第四批）

| 0.4.2 更新 | 我们 | 证据 |
|---|---|---|
| 会话控制标签（agent 名 / 项目 / 会话 ID / 颜色） | ✅ **修好并实测** | 之前 `showTakeover` 注入时把 `controller` 丢了，浮层永远显示默认 "BridgeDeck"；已补传 `controller`/`mode`。实测 `--agent-name 小助手 --project 浏览器桥 --controller-color '#3b82f6'`：浮层 brand=`小助手`、项目=`浏览器桥`、会话=`zdfp`、`--bb-accent=#3b82f6`。DSH 插件也支持这三个参数 |
| fill 支持 date/time/datetime-local/month/week + 格式与 min/max | ✅ | 五类输入实测填入成功；越界/非法值报 `E_BAD_ARG`；后台标签页填充不走聚焦路径 |
| `bsk mcp` + `install-skill --mcp`（Codex/Claude Code/Cursor） | ✅ | `bridge mcp` 已有；`--mcp` 之前因 flag 未注册不可用，已修。实测 `install-skill --harness codex --mcp`（CODEX_HOME 指向临时目录）写出 `[mcp_servers.browser-bridge]` |
| 更新优先国内源、回退 GitHub、双源报错 | ➖ 不做 | 产品决定只走 GitHub，保留 SHA256 校验 |
| 共享控制：人的最后完成动作后静默 2 秒 | ✅ 等价 | `page-lib.js` 的 `humanActivity()` 用 **2000ms** 静默窗口；`cooperate.wait` 轮询该状态，静默后返回 ready |
| 敏感字段不进共享控制字段状态 / expect / 提取 / 录制填充（含密码切 text） | ✅ | `sensitiveField()` 覆盖 password、current-password/new-password/one-time-code/cc-*、密码切 text（WeakSet+MutationObserver）；`expect-check`/`read`/`extract` 输出 `********`，本轮补 `value` 属性口子；实测 OTP expect 失配 → `期望 "********"，实际 "********"` |
| 滚动/无效按键期间保持控制；坐标输入等滚动停止；仅聚焦不占用 | ✅ | 只有 `click/input/change` 会重启静默窗口（滚动、修饰键、focus、无效按键都不算）；本轮补 `click-point` 的滚动停稳等待（120ms 静止 / 最长 800ms） |

另外修了一个恢复性问题：`instanceId` 改为存 `chrome.storage.local`（原 `session` 每次 reload 清空 → daemon 把旧会话判成"所属实例已断开"）。现在 reload 后同一浏览器沿用同一 instanceId，daemon 可恢复既有会话。更新通道按产品决定只走 GitHub，不做镜像双源（第 3 节 P2 该条关闭为 Won't do）。

---

## 8. 官方能力逐项复核（2026-11-12，取代第 2.1 节）

来源：https://browserskill.weixin.qq.com/#features（0.4.2，2026-11-05），页面数据源 `ref/i18n-latest.js`。

| 官方能力 | 我们 | 证据 / 说明 |
|---|---|---|
| 🔑 复用已有登录状态 | ✅ | 直接驱动已登录的实例浏览器；cookie 不出浏览器 |
| 🔁 借用标签页，先问后动 | ✅ | `tab borrow` + `BorrowConfirmationOverlay`；`borrowConfirm` 已收口为人工开关（CLI 报 `E_FORBIDDEN`，RPC 也拒绝，`tab.borrow` 不再接受参数降级） |
| 🙋 关键环节，人来决定 | ✅ | `request-help` + `HelpRequestOverlay` + `takeover.js`；实测 `allowHelp=false` 时 `request-help` → `E_HELP_DISABLED` |
| 📝 操作留痕，安全可查 | ✅ | `audit list` 可用（实测有记录）；与官方一致为"开启后记录"（`auditEnabled` 默认关） |
| ☁️ 云端 Agent，本机浏览器 | ✅ | `pair create/redeem/revoke`、`daemon trust-local`、TLS、`remote-authorization.js`；非回环强制 token |
| 🪟 独立执行，互不干扰 | ✅ | 每个 session 一个专属 Agent 窗口（`window.newAgent` / `window.close`），与用户窗口彻底分开；`session stop` 只关自己的窗口。实测 `ozwb`/`hdun` 两个独立窗口，停一个另一个不受影响 |
| 🔌 不挑 Agent，不锁模型 | ✅ | 11 个 harness target：dsh / claude-code / codex / cursor / codebuddy / workbuddy / openclaw / qoder / pi / hermes / kimi-code；另有 MCP（`bridge mcp`、`install-skill --mcp`） |
| 👀 先看懂页面，再动手 | ✅ | `observe` / `snapshot` / VOM / `@eN` refs，含 closed shadow 与多 frame |
| 🎛️ 复杂交互 | ✅ | click/fill/select/press/hover/scroll/wheel/drag/upload/download/evaluate/screenshot（视口·元素·长图·canvas 坐标）/emulate/console/network |

安全策略四条：

| 官方安全项 | 我们 | 证据 |
|---|---|---|
| 🚫 不碰任何敏感数据 | ✅ | `page-lib.js` 的 `sensitiveField()`（password / current-password / new-password / one-time-code / cc-* / 密码框切 text 后）+ `sensitive-autocomplete.js` + `redact.js` + SKILL 明文约束；expect 失败详情、read/extract 的 value 与 value 属性均输出 `********`（实测） |
| ✋ 借用之前必先同意 | ✅ | CLI/RPC 双层拒绝修改 `borrowConfirm`；`tab.borrow` 只认浏览器里保存的设置 |
| 🆘 你关掉的，它绕不过 | ✅ | 实测 `E_HELP_DISABLED` |
| 🏠 默认不出本机 | ✅ | 扩展只连 127.0.0.1；非回环必须配对 token + 加密（`BB_TLS` / 反向代理） |

**结论**：9 项能力**全部具备**；4 条安全策略全部具备（敏感字段遮蔽覆盖 expect 失败详情 / read / 结构化提取 / 录制填充步骤，含 value 属性口子）。更新通道按产品决定只走 GitHub，不做镜像双源。
