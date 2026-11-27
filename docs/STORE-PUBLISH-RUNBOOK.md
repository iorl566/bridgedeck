# Edge 商店发布 Runbook（0.3.1）

> 目标：把 0.3.1 扩展包提交到 Microsoft Edge 加载项并完成审核。GitHub Release 已完成，这里只处理商店。
> 相关：文案素材见 [STORE-LISTING.md](STORE-LISTING.md)，审核页答案见 [STORE-REVIEW.md](STORE-REVIEW.md)。

## 0. 当前状态（2026-11-27）

| 项 | 值 |
| --- | --- |
| 产品 ID（Partner Center） | `0fc99cde-b63d-40a6-9101-1849797a0d8f` |
| 商店 ID（CRX） | `ieflpefpmlmmlfgmpfakaglhgmcbcnig` |
| 线上版本 | 0.3.0（0.3.1 待提交） |
| 0.3.1 draft 包 | 已上传，最近一次 operation `acfc5b64-b1f1-4149-84ae-d99c9da21cd5`，状态 `Succeeded` |
| 提交审核 | **已提交（2026-11-27 11:45）**：submission `1152921505702520664`，publish operation `5f5c3dd1-ca0f-43b1-a079-9ac3dc05cd1b`，状态 `Succeeded`；Partner Center 显示「正在审阅，预计 7 个工作日」 |
| 商店 listing | **13 个语言行全部「已完成」**（描述 + 300×300 徽标）；Website 仍是 `example.com`（Properties 里可再改） |
| 线上版本 | 审核通过前仍是 0.3.0 |
| 凭证 | `D:\BridgeDeck-secrets\edge-api-key.txt`、`edge-client-id.txt`、`edge-product-id.txt`（均在仓库外） |

已确认 API 链路可用：`POST /submissions/draft/package` 上传成功即说明 API Key、Client ID、产品 ID 三者匹配。
**注意**：Edge Add-ons API 只提供“上传包 / 查上传状态 / 提交 / 查提交状态”四个接口，**不能改 listing**；
文案、图片、隐私页必须在 Partner Center 网页里填。`ModuleStateUnPublishable` + `Invalid module : LISTING`
就是这个限制的直接证据：listing 没填完，提交一定失败。

## 1. 前置检查

```powershell
# 包在、校验过
& 'D:\tools\node\node.exe' tools\verify-extension-package.mjs dist\BridgeDeck-extension-0.3.1.zip

# 文案齐全且符合长度限制
& 'D:\tools\node\node.exe' docs\store-listing\validate.mjs
```

`node` 不在 PATH 上时用 `D:\tools\node\node.exe`；`tools\publish-edge.ps1` 会自动找 node，
也可以设 `BRIDGEDECK_NODE`。

## 2. 上传（draft）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-edge.ps1 -DraftOnly
```

> 本机默认执行策略禁止运行 `.ps1`，不加 `-ExecutionPolicy Bypass` 会报 "running scripts is disabled"。
> 也可以在会话里先 `Set-ExecutionPolicy -Scope Process Bypass -Force`。

- 只替换 draft 包，不触发审核；
- 输出里的 `uploadId` 就是后续排查用的 operation ID；
- 同一版本重复上传是安全的，最终以最后一次为准。

## 3. 填充商店 listing（Partner Center，最容易卡住的一步）

1. 登录 <https://partner.microsoft.com/dashboard/microsoftedge/public/login>，进 Edge → BridgeDeck。
2. **Availability**：Public；Markets 保持默认。
3. **Properties**：Category = Productivity；Website = `https://github.com/iorl566/bridgedeck`；
   Support = `https://github.com/iorl566/bridgedeck/issues`；不勾 Mature content。
   （`example.com` 必须改掉，占位站点是常见退回理由。）
4. **Privacy**：照 [STORE-REVIEW.md](STORE-REVIEW.md) 逐项粘贴（Single purpose、14 条权限理由、
   Remote code = No、Data usage 勾选、隐私 URL）。
5. **Store listings**：13 个语言行逐个 `Edit details`：
   - 先打开本地粘贴单 `docs/store-listing/paste-sheet.html`（浏览器直接打开，每段都有“复制”按钮）；
   - Description：从 `docs/store-listing/<locale>.md` 的 `## Description` 段整段粘贴（250–10,000 字符）；
   - Extension logo：`docs/assets/store/icon-300.png`，传完点 **Duplicate this logo for all languages**；
   - Small / Large promotional tile：`promo-small-440x280.png` / `promo-large-1400x560.png`，同样 Duplicate；
   - Screenshots：按 `store-01..05.png` 顺序上传 5 张，传完 Duplicate 到所有语言；
   - Search terms：粘贴对应 `.md` 的 `## Search terms`（≤7 条）；
   - 每行都要点 **Save draft**，行状态变成 `Complete` 才算完。

> 登录总会过期：把这一步一次性做完，别中途停。文案已经按语言分文件准备好，图片只要在一个语言行传一遍再
> Duplicate，13 行里真正需要手打的只有 Description 和 Search terms。

## 4. 提交审核

listing 全部 `Complete` 后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-edge.ps1
```

它会重新上传同一个包（幂等），然后 `POST /v1/products/<id>/submissions`，把
`docs/assets/store/certification-notes-0.3.1.md` 作为 **Notes for certification** 提交，
并轮询到 `Succeeded`。也可以点 Partner Center 的 **Publish** 按钮，效果相同（备注框里粘同一份文件）。

## 5. 验证发布

```powershell
# 商店页版本（审核通过后应变 0.3.1）
curl.exe -s https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/ieflpefpmlmmlfgmpfakaglhgmcbcnig

# 只取关键字段
$j = curl.exe -s https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/ieflpefpmlmmlfgmpfakaglhgmcbcnig | ConvertFrom-Json
$j | Select-Object name,version,shortDescription,privacyUrl,publisherWebsiteUri,@{n='langs';e={$_.availableLanguages -join ','}},@{n='shots';e={$_.screenshots.Count}}
```

审核 SLA 最长 7 个工作日。通过前商店仍是 0.3.0，属于正常。

## 6. 故障对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `404 Resource not found` | 产品 ID 不是 GUID、不属于该账号，或请求了不存在的路由（GET 产品信息本来就没有） | 只用文档里的 4 个接口；核对 `edge-product-id.txt` 是否为 Partner Center 扩展概览里的产品 ID |
| `401 Unauthorized` | API Key 过期/被吊销，或 Client ID 与 Key 不配对 | 在 Partner Center → Publish API 重新生成，写入 secrets 目录 |
| `InProgressSubmission` | 已有一个提交在审 | 等审核结束再提交 |
| `NoModulesUpdated` | 包与已发布版本等价，没有可提交的变更 | 确认 draft 里确实是 0.3.1 的包 |
| `SubmissionValidationError` | listing 缺字段（Description <250、缺 Logo、语言行没 Complete） | 回到 Store listings 逐语言补 |
| `ModuleStateUnPublishable`（`errors: ["Invalid module : LISTING"]`） | listing 模块不完整：某语言缺 Description / Logo，或没点 Save draft | 回 Store listings 逐语言补；用 `docs/store-listing/paste-sheet.html` 直接复制 |
| `ModuleStateUnPublishable`（其它 module） | 包本身校验不过 | 重跑 `build-extension.mjs` + `verify-extension-package.mjs` |
| `429` | 轮询过密 | 降低频率，间隔 ≥5 秒 |

## 7. 回滚与善后

- API 没有“撤销提交”能力；提交后要改只能等审核结束再发新版本。
- 已上架版本下架走 Partner Center 的 **Unpublish**。
- listing 每次修改都要再提交一次才会生效（改文案也算一次提交）。
- 凭证只在 `D:\BridgeDeck-secrets\`；日志（`.tmp/edge-upload-draft.log`）只有产品 ID 与 operation ID，不含 Key。

## 8. 后续（下一次发版）

1. 改版本号 → 重新打包 → `release-preflight` → 打 tag；
2. `release-store.yml` 现在直接调用 `tools/edge-publish.mjs`，需要仓库 Secrets：
   `EDGE_API_KEY`、`EDGE_CLIENT_ID`、`EDGE_PRODUCT_ID`；
3. 更新 `docs/assets/store/certification-notes-<version>.md`，并把 `tools/publish-edge.ps1` 与 workflow
   里的路径一起改掉；
4. 文案有变化时同步 `docs/store-listing/*.md` 并跑 `validate.mjs`。

## 9. 本次实际执行记录（2026-11-27）

全部由 BridgeDeck 自己驱动已登录的 Partner Center 完成（会话 `ecuv`），可复用的经验：

- **13 个语言行来自包内 `_locales/`**：manifest 用 `__MSG_*` 占位符，上传 0.3.1 后 Partner Center 自动列出 13 行；少一行 `发布` 就灰着，API 也会回 `Invalid module : LISTING`。
- **描述填写**：Angular formly 的 textarea 直接 `.value=` 不触发保存按钮；需要原生 setter + `input`/`change` + **blur**，再等「保存草稿」变可用。
- **徽标上传**：给隐藏 `input[type=file]` 赋值会偶发服务端「文件上传已失败」；**必须点「添加图像」按钮走文件选择器拦截**（`bridge upload <按钮选择器> --file ...`，结果 `via: "chooser"`），等预览图变成 `*.blob.core.windows.net` 才算真上传。
- **某语言行卡死时**：`移除` 该语言行 → 用「添加语言」重新加回来（重建行状态），再上传即可；西语行就是这么救回来的。
- **发布**：13 行全 `已完成` 后，`tools\publish-edge.ps1` 直接返回 `Succeeded`，审核开始。脚本：`tools/store-fill.mjs`（填行）、`tools/publish-edge.ps1`（提交）。