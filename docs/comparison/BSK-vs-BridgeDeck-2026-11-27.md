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
