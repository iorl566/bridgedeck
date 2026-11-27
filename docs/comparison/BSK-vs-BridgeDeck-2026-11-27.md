# BSK 0.5.0 vs BridgeDeck 0.3.1 实测对比

> 2026-11-27。方法：同一台机器、同一份夹具页 / 同一批真实站点、两个工具各自独立的 Edge profile + daemon + 扩展，
> 顺序执行同一组动作，断言看页面结果（不是看工具自报）。命令：`node tools/compare/run.mjs --tool bsk|bridge --phase e2e|real`。
> 原始数据：`docs/comparison/runs/2026-11-27-full/`，逐任务日志在 `.tmp/cmp-*.log`。

## 一、E2E（确定性夹具页，8 项）

| 任务 | BSK 0.5.0 | BridgeDeck 0.3.1 | 差异 |
| --- | --- | --- | --- |
| T1 打开 + 读结构 | ✅ 1034ms | ✅ 893ms | 持平 |
| T2 填表 + 提交 + 回读（5 步） | ✅ 1059ms | ✅ 1720ms | BSK 快 ~0.6s |
| T3 基础表格提取 | ✅ 119ms | ✅ 221ms | **BSK 快 ~1.9×** |
| T4 视口截图落盘 | ❌ 写盘被拒（os error 5） | ✅ 322ms / 37KB | 环境相关，见下 |
| T5 多行表头提取（rowspan/colspan） | ✅ 93ms | ✅ 221ms | **BSK 快 ~2.4×**，结果都完整 |
| T6 closed shadow 点击 | ✅ 462ms（VOM ref） | ✅ 481ms（`--closed-shadow-text`） | 持平 |
| T7 原生 confirm 对话框 | ✅ 481ms（click→dialog accept→operation await） | ✅ 727ms（click→dialog accept） | BSK 更快但多一步 operation await |
| T8 文件上传 | ✅ 314ms | ✅ 434ms | 持平 |
| **通过率** | **7/8** | **8/8** | |

要点：

- **性能**：BSK 在 `extract`（表格）上稳定快 2 倍左右，VOM 生成也略快；BridgeDeck 在打开/动作上与之相当或略慢（每次动作附带校验与 settle）。
- **截图**：BSK 的截图由 daemon 在 CLI 主机侧写盘，本机沙箱直接拒绝（`write screenshot ... os error 5`）；BridgeDeck 走扩展下载落盘，正常出图。这不是能力缺失，而是**执行环境对写盘权限的要求不同**——但意味着在受限环境里 BSK 的截图/落盘类能力会不可用。
- **对话框**：两边都能处理，BSK 语义更“重”（原操作被挂起，必须 `operation await` 取回结果），BridgeDeck 一步到位。
- **closed shadow**：两边都能点；BSK 靠 VOM 给 ref，BridgeDeck 有专门的 `--closed-shadow-text`。

## 二、真实网站（可访问站点，3 项）

本机网络只放行部分域名（HN、Wikipedia 均 `curl 000`，已排除），改用以下可达站点：

| 任务 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| R1 example.com | ✅ 960ms | ✅ 746ms |
| R2 GitHub 仓库页（重 JS） | ❌ 31.3s：`Document changed during observation` | ❌ 60.9s：`navigate 超时（60500ms）` |
| R3 Microsoft Learn 文档 | ❌ 784ms：`strict observation changed before this action` | ✅ 5057ms |
| **通过率** | **1/3** | **2/3** |

要点：

- **BSK 的 strict 观察模型在动态页上很脆**：文档一变，之前 sync 的 observation 立刻失效（`Document changed during observation` / `strict observation changed`），对 GitHub 这种持续渲染的页面几乎不可用；每个动作前都要重新 `sync`。
- **BridgeDeck 的 `navigate` 默认等整页 load**，重页面直接卡到 60s 超时；但同样页面用 `open --observe` 在 Learn 上 5s 完成。**这是最适合优先改的一项**：默认 `waitUntil=domcontentloaded`，或把“导航完成”和“观察就绪”解耦。

## 三、差异结论

| 维度 | 更强的一方 | 说明 |
| --- | --- | --- |
| 表格提取速度 | BSK | 大约快 2 倍，且多行表头同样完整 |
| 动态页鲁棒性 | BridgeDeck | BSK 的 strict observation 一旦页面变化就失败 |
| 重页面导航 | BSK（部分） | BSK 的 open 在 Learn 上成功；BridgeDeck 卡 60s 超时 |
| 受限环境落盘 | BridgeDeck | BSK daemon 写盘被沙箱拒绝 |
| 交互安全模型 | BSK | 每个动作都要求新鲜观察，最严格；代价是步骤多、动态页易失败 |
| CLI 一致性 | 持平 | 命令面高度同构（open/click/fill/select/extract/screenshot/dialog/upload） |

## 四、给 BridgeDeck 的提升项（按优先级）

1. **`navigate`/`open` 的等待策略**：默认 `domcontentloaded` 或 `commit`，把整页 load 留给显式 `--wait-until load`；重页面不再 60s 卡死。这一项直接决定真实站点通过率（R2）。
2. **表格提取提速**：BSK 同页 90–160ms，我们 220–290ms。检查 `extract` 是否走了多余的 AX/几何校验；只在需要时取列定义与来源。
3. **动态页观察降级**：真实页面渲染中 ref 失效时，自动重观察一次再失败（类似 BSK 的“observe again”提示），而不是直接报错。
4. **截图落盘的健壮性**：保持走扩展下载路径（已验证可用），并把“daemon 侧写盘”作为可选路径时给出明确错误码。
5. **对话框一步到位**：保留现有 `dialog accept`，但补一个“点击并自动接受 confirm”的便捷动作（BSK 需要 operation await，我们有条件做得更简单）。

## 五、复现

```powershell
node tools/compare/run.mjs --tool bsk    --run docs/comparison/runs/<id> --phase e2e
node tools/compare/run.mjs --tool bridge --run docs/comparison/runs/<id> --phase e2e
node tools/compare/run.mjs --tool bsk    --run docs/comparison/runs/<id> --phase real
node tools/compare/run.mjs --tool bridge --run docs/comparison/runs/<id> --phase real
node tools/compare/report.mjs --run docs/comparison/runs/<id>
```

网络受限时真实站点会全部 000/超时，换可达域名再跑即可（任务定义在 `tools/compare/run.mjs` 的 `tasks` 数组）。

## 六、已落地的改进（0.3.2 起）

**导航等待策略（第 1 项）**：`bridge navigate` / `bridge open` 默认改为 `--wait-until domcontentloaded`：

- 导航 RPC 只等 2s（`commit` 模式 0.8s），随后用 `wait-for-navigation --wait-until domcontentloaded` 精确等 DOM 就绪；
- 需要整页 load 时显式 `--wait-until load`，行为与旧版一致；
- 重页面不再卡满 60s：Microsoft Learn 实测 5057ms → **2819ms**；GitHub 从“60s 超时”变为 20s 内返回明确原因（本机该页面在 Edge 里报错误页，非导航逻辑问题）。

回归：CLI selftest 404/404 PASS；E2E 8 项仍 8/8、耗时基本不变（T1 969ms、T2 1601ms、T3 211ms、T4 370ms、T5 220ms、T6 478ms、T7 772ms、T8 442ms）。

**动态页 ref 失效自动重观察（第 2 项）**：`healAction` 从“必须显式 `--heal`”改为**默认开启**——动作返回 `E_STALE_REF / E_REF_NOT_FOUND` 时，自动重新 observe、按稳定的动作缓存找回目标并重试一次；`--heal=false` 可关闭。回归：CLI selftest 404/404、E2E 8/8。

**`click --accept-dialog` 一步式确认框（第 3 项）**：点击命中原生 confirm/alert/prompt 时，CLI 自动接受对话框并取回被挂起的原始点击结果（内部 `dialog.accept` + `operation.await`），不再需要手动两步。夹具页实测：`bridge click "#dlg-confirm" --accept-dialog` 返回 ok，随后 `#dlg-out` 读到 `accepted`。

**截图失败原因细分（第 4 项）**：`bridge screenshot` 失败现在带 `data.reason`——`capture` 表示扩展侧捕获失败，`write` 表示已捕获但本地写盘失败（附 `path` 与 `cause`，错误码 `E_SCREENSHOT`）。实测把 `--out` 指到不存在的 `Z:\\...`：返回 `E_SCREENSHOT`，`reason=write`，`cause=ENOENT`。

**`extract` 提速（第 1 项，完成）**：把 `video / page / pair / debug / network / recipe / daemon-log` 七个模块从顶层静态 import 改成按需 `import()`：

| 指标 | 基线 | 最终 |
| --- | --- | --- |
| CLI 冷启动（`--version`） | 156.5ms | **123ms**（-21%） |
| `extract table`（3×3） | 211–289ms | **181ms** |
| `extract table`（多行表头） | 221–289ms | **174ms** |
| 视口截图 | 339–370ms | 298ms |

已进入 BSK 的 90–160ms 区间上沿附近（差约 14ms）：剩余固定成本是 Node 进程启动（node 冷启动约 40ms + 模块初始化），BSK 是原生二进制（`--version` 19.5ms）。常驻进程（MCP / SDK / daemon 内调用）不付这段启动成本，算法侧 extract 的 RPC 耗时远低于 CLI 端到端值。

**整体回归**：CLI selftest **404/404 PASS**；E2E 8 项 **8/8**（T3 181ms、T5 174ms、T4 298ms、T6 404ms、T7 639ms、T8 359ms）。

**仍待观察（非本轮目标）**：daemon 侧重写盘失败目前归到 `capture`，如需再细分为 `daemon-write` 可在下一版补。
## 七、复跑 + 真实网站同站测试（2026-11-27 第二轮）

### 7.1 E2E 复跑（确认上一轮的优化没有回退）

BridgeDeck 8/8，耗时 4726ms：T1 937ms、T2 1461ms、T3 **186ms**、T4 295ms、T5 **184ms**、T6 502ms、T7 754ms、T8 407ms（`docs/comparison/runs/2026-11-27-rerun`）。

### 7.2 同一批真实网站，两边跑同样 6 个任务

站点全部在本机可达（example.com、httpbin.org、learn.microsoft.com、MDN、Edge 加载项商店页；HN/Wikipedia 仍不可达，未用）：

| 任务 | 站点 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| W1 读取标题 | example.com | ✅ 864ms | ✅ 1423ms |
| W2 点击链接并跳转 | example.com → iana.org | ✅ 1130ms | ✅ 1627ms |
| W3 填表并提交（POST） | httpbin.org/forms/post | ✅ 1372ms | ✅ 2416ms |
| W4 整页截图 | learn.microsoft.com | ❌ strict observation 失效 | ✅ 4.1s / 1.21MB |
| W5 滚动 + 键盘 | MDN | ❌ strict observation 失效 | ✅ 3718ms |
| W6 读取商店页 | Edge 加载项详情页 | ❌ `cdp_failed: Not allowed` | ✅ 3554ms |
| **通过率** | | **3/6**（27.9s） | **6/6**（15.9s） |

原始数据与报告：`docs/comparison/runs/2026-11-27-web/`（`report.md`、`bsk.json`、`bridge.json`、`shots/`）。

### 7.3 结论

- 静态/简单页面（W1–W3）两边都稳定，BSK 略快（原生二进制启动优势）。
- **动态或重页面是分水岭**：BSK 的 strict 观察在页面渲染中失效（连 `evaluate` 都会被 `cdp_failed` 挡住），BridgeDeck 的 target 策略 + 默认 domcontentloaded + 自动重观察把 6 项全过。
- 整页截图这类重动作，BridgeDeck 现在 4.1s 出 1.21MB PNG，BSK 在本机受 strict 观察与 daemon 写盘双重限制。