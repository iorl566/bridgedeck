# 0.3.1 版本升级与 CI 发布 Runbook

> 状态（2026-11-26 15:10）：**版本已升到 0.3.1，本地全流水线重跑全绿（16/16 步，PREFLIGHT PASS，
> verify ok: 0.3.1 / 9 artifacts）；CI 端到端发布未执行**——本环境缺少三项硬条件（见 §4），
> 需要你在有权限的环境里按 §3 执行。行为级差分基准（BSK vs 我们）已完成可行性探测（§6），
> 完整 harness 尚未落地。

## 1. 版本升级清单（已完成）

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `package.json` | 0.3.0 | **0.3.1** |
| `extension/manifest.json` | 0.3.0 | **0.3.1** |
| `apps/extension/package.json` | 0.3.0 | **0.3.1** |
| `apps/extension/wxt.config.ts`（manifest version） | 0.3.0 | **0.3.1** |
| `dsh-plugin/package.json` | 0.3.0 | **0.3.1** |
| `lib/har.mjs` / `har-merge.mjs` / `har-normalize.mjs`（creatorVersion 兜底） | 0.3.0 | **0.3.1** |
| `crates/bridge-cli/Cargo.toml` | 0.1.0（独立 Rust CLI 版本，未改） | 0.1.0 |

运行时版本统一从 `package.json` 读取（CLI/daemon/MCP/插件），扩展版本来自 manifest；无需改代码常量。

## 2. 本地 0.3.1 流水线结果（实跑）

| 步骤 | 结果 |
| --- | --- |
| build-extension / verify-extension-package | ✅ 3,633,480 B，426 entries |
| build-cli-bundle | ✅ 2,136,272 B，349 entries |
| portable win32-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 | ✅ 40,160,371 B（含 Node）/ 4,601,6xx B ×4（外部 Node） |
| build-setup-exe + 自签名 | ✅ 39,830,904 B（本机无 signtool，回退 Set-AuthenticodeSignature） |
| dsh-plugin zip + sha256 | ✅ 140,216 B |
| Ed25519 清单签名（临时验证密钥 keyId `4ee9753d5d93f35d`） | ✅ release.json 2,332 B，9 artifacts |
| **release-preflight** | ✅ **PREFLIGHT PASS**（含 packages.consistency、vendor/source/quality/perf 门禁） |
| **verify-release.ps1** | ✅ **verify ok: 0.3.1 / 9 artifacts**（自签名 untrusted 警告属预期） |

- 产物在 `dist/`（0.3.0 旧产物已备份到 `.tmp/dist-0.3.0-backup/`）。
- 其他门禁：单测 5,051/5,051、CLI 404、MCP 216、Python 181、静态门禁全 0、TS tsc 0 + TS 测试 649、
  JS E2E **222/222**；TS E2E 本轮最好 **220/222**（20m/33 两个 debug 抓取用例受环境/负载影响，
  复跑出现 31 系列截图 readback/CDP 超时抖动，属已知环境 flake，非 0.3.1 变更面）。
- **重要**：`dist/release.json` 目前由**临时验证密钥**签名，`lib/release-public-key.mjs` 已同步为该
  临时公钥（keyId `4ee9753d5d93f35d`），因此**这批 0.3.1 产物只能用于本地验证，不可对外分发**；
  生产公钥已保存为 `tools/release-public-key.production.pem`（keyId `c7b5e21301f91a2d`）。

## 3. CI 正式发布步骤（需要在有 GitHub 权限的环境执行）

前置：
- 已 push 仓库并打 tag `v0.3.1`（CI 按 tag 解析版本）。
- Secrets：`RELEASE_SIGNING_PRIVATE_KEY`（生产 Ed25519 私钥 PEM）、`WINDOWS_PFX_BASE64` or
  `WINDOWS_CERT_THUMBPRINT`、Apple 证书/notary（macOS 目标）。
- 先恢复生产公钥到 `lib/release-public-key.mjs`（内容取 `tools/release-public-key.production.pem`，
  `RELEASE_PUBLIC_KEY_ID` 改回 `c7b5e21301f91a2d`），提交后再打 tag；否则已发布客户端无法验证新清单。

1. `publish-cli.yml`（workflow_dispatch，version=0.3.1）：4 平台 CLI 干跑构建，确认产物名/体积。
2. `release-cli.yml`（tag=v0.3.1）：构建 + 设计可执行文件签名 + 发布 GitHub Release 资产。
3. `release-extension.yml`（tag=v0.3.1）：`build-extension` → `verify-extension-package` →
   `build-setup-exe` → 签名 → 上传。
4. `release-dsh-plugin.yml`（tag=v0.3.1）：打包 `BridgeDeck-dsh-plugin-0.3.1.zip` + sha256 并上传。
5. `sign-release.yml`（release_id、version=0.3.1、publish 按需）：下载草稿资产 →
   `node tools/release.mjs --sign-ed25519 <生产私钥>` → 生成 `release.json`/`SHA256SUMS`/`release-public.pem`
   → 上传并（可选）发布。
6. 发布后校验：下载全部资产执行 `powershell -File tools/verify-release.ps1 -Dist <下载目录>`，
   确认输出 `verify ok: 0.3.1 / 9 artifacts`，并核对 `release.json.signature.keyId === "c7b5e21301f91a2d"`。

## 4. 为什么本环境不能直接跑 CI（如实说明）

| 阻塞项 | 现状 |
| --- | --- |
| 生产签名私钥 | 仓库内只有公钥/备份，无私钥；私钥只应在 CI Secret |
| git / gh / token | 有 `.git` 目录但**无 git 二进制**、无 `gh`、无远端凭据，无法 push/tag/触发 workflow |
| 网络发布 | 无法访问 GitHub API/上传资产 |
| Windows 真实签名 | 无 `signtool.exe`（无 Windows SDK），本地仅自签名回退验证 |
| macOS 公证 | 需 macOS runner + Apple secrets |

因此本轮交付的是“**版本升级 + 本地同构流水线全绿 + CI runbook**”，CI 真实执行待上述条件具备。

## 5. 回滚

- 代码版本回滚：将上述 6 处 0.3.1 改回 0.3.0（或从快照 `D:\BridgeDeck-backups\bridge-deck-wip-20261126-1428.tgz` 取）。
- dist 回滚：`Remove-Item dist\*; Copy-Item .tmp\dist-0.3.0-backup\* dist\`，并把
  `tools/release-public-key.production.pem` 内容写回 `lib/release-public-key.mjs`（keyId `c7b5e21301f91a2d`）。
- 快照不含 `dist/`（体积原因），发布产物以 `.tmp/dist-0.3.0-backup/` 与当前 `dist/` 为准。

## 6. 行为级差分基准（BSK vs 我们）——可行性探测结果

**已打通 BSK 侧驱动链**（真实浏览器）：
- `BSK_HOME=<temp>`、先以持久任务启动 `bsk.exe daemon start --foreground`，再设 `BSK_AUTO_START=0`；
- 用临时 profile 启动 Edge 并 `--load-extension=ref/bsk-0.5.0-ext`；
- `bsk status --json` / `bsk browsers --json` 已能看到 `browser_name=edge, extension_version=0.5.0,
  extension_protocol_version=1.9` 的未配对本地连接（无需 pair）。
- 注意：`bsk.exe` 在本会话的 Job Object 内**不能自启 detached daemon**（os error 5），必须
  `daemon start --foreground` 作为持久任务。

**下一步 harness 设计**（`tools/bsk-differential/run.mjs`，待实现）：
同一 fixture 页 + 同一任务集，两边各跑一遍并归一化比较：
1. open（标题/标记文本）、2. observe/snapshot（元素文本命中）、3. click + read 验证副作用、
4. fill + read 验证值、5. extract table 行数/表头、6. screenshot PNG 尺寸、7. get-html 标记、8. status 字段。
输出 `docs/BEHAVIOR-DIFF-BSK.md` + JSON（逐任务 equal/partial/diff/unsupported + 耗时），
未知/不可比一律标 unsupported，不写成等价。

## 7. 行为差分基准：首份结果（2026-11-26 15:30）

- 工具已落地：`tools/bsk-differential/run.mjs`（真实 Edge；两侧临时 profile/HOME；BSK daemon 以
  `--foreground` 持久任务 + `--reuse-daemon` 复用）。
- 首份报告：`docs/BEHAVIOR-DIFF-BSK.md` + `docs/behavior-diff/report.json`。
- 结果：10 个任务 **9 equal / 1 diff**；唯一 diff = `read_after_fill`（我们返回输入框 value，
  BSK 返回 `values.text=""`，疑似脱敏设计）。其余 open/observe/click/read-after-click/fill/
  extract-table/get-html/screenshot/错误拒绝均行为一致。
- 复跑命令见 `docs/BEHAVIOR-DIFF-BSK.md` 末尾。
- 说明：本次按用户要求**未向 GitHub / Edge 商店上传任何内容**；对话中提供的 PAT 不应写入仓库，
  建议尽快 revoke/rotate。


## 8. 扩展打包轻量化（2026-11-26 追加）

- 新增 `tools/build-extension-bundled.mjs`：先 WXT 构建，再把 `apps/extension/.output/chrome-mv3`
  打成发布 zip。实测 **34 个文件、zip 401,428 B、解压 ≈ 1.32 MB、background.js 538,757 B**
  （源码树逐文件包为 426 文件 / 3,633,480 B）。
- `dist/release.json` 已按新扩展包重签并复验：`PREFLIGHT PASS`、`verify ok: 0.3.1 / 9 artifacts`
  （仍是临时验证密钥，正式发布须按 §3 用生产私钥重签）。
- `.github/workflows/release-extension.yml` 已改为 `npm install`（apps/extension）+
  `node tools/build-extension-bundled.mjs`；源码树包入口 `tools/build-extension.mjs` 保留。
- README 已补充「打包与体积」「质量与可验证性」章节与 0.3.1 发布说明（`docs/releases/0.3.1.md`）。


> **2026-11-26 更正（按用户要求）**：不采用参考实现的“单包少文件”打包方式，扩展发布包恢复/维持
> 我们自己的源码树逐文件打包（`tools/build-extension.mjs`，426 文件 / zip ≈ 3.6 MB，
> `tools/verify-extension-package.mjs` 校验）；此前追加的轻量打包段落仅保留为历史记录，
> 不作为发布路径。


## 9. 发布前密钥模式与 tag 清单（2026-11-26 准备，不执行上传）

发布前必须把内置公钥切回生产公钥，否则已发布客户端校验不过：

```powershell
node tools/release-key-mode.mjs --check             # 看当前模式（local-verify / production）
node tools/release-key-mode.mjs --mode production   # 切回生产公钥（tools/release-public-key.production.pem）
node tools/release-preflight.mjs --key <生产私钥>    # 版本/制品/签名/门禁一致性
```

打 tag 前检查清单（全部满足再推 tag）：

1. `package.json` / `extension/manifest.json` / `apps/extension/package.json` / `wxt.config.ts` /
   `dsh-plugin/package.json` 版本一致（当前 0.3.1）；
2. 全量门禁：单测、CLI、MCP、Python、source-guard、vendor-leak、scale、quality、longtail、bsk-diff；
3. `dist/` 制品由生产私钥重签并 `release-preflight` PASS（本地临时密钥产物不可分发）；
4. `lib/release-public-key.mjs` 为生产公钥（keyId `c7b5e21301f91a2d`）；
5. tag 名 `v0.3.1`，推送后按 §3 依次 dispatch 工作流；
6. 发布后下载资产跑 `tools/verify-release.ps1 -Dist <目录>`，核对 keyId。

> 本文件只准备清单；**按用户要求暂不上传 GitHub / Edge 商城**，不执行 tag/push/release。

## 8. 品牌清理与当前状态（2026-11-27）

- 发布源码与打包产物已清理对标品牌字眼，新增 `npm run brand:scan` 门禁并接入 preflight / CI / release workflows。
- dist 已重建 9 个 artifact 并重新签名（本地验证密钥 keyId `4ee9753d5d93f35d`）；`release-preflight` PASS、`release --check` PASS。
- 正式发布仍需：生产 Ed25519 私钥（CI Secret）、GitHub Token、Edge `EDGE_API_KEY`/`EDGE_PRODUCT_ID`；按 `docs/STORE-PUBLISH-RUNBOOK.md` 执行。
- 商店素材：`docs/assets/store/store-01..05.png`、`icon-300.png`；listing/审核文案：`docs/STORE-LISTING.md`、`docs/STORE-REVIEW.md`。
- ⚠️ 任何在聊天/日志中出现过的凭证必须吊销重建，禁止写入仓库。
