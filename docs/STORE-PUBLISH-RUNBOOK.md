# 发布 Runbook：GitHub Releases + Edge Add-ons（0.3.1）

> ⚠️ **凭证安全（先做）**
> 任何曾在聊天、工单、日志里明文出现的 GitHub PAT / Edge API Key 都必须**立即吊销并重建**。
> 本仓库只使用 GitHub Actions Secrets / 本机环境变量，**不写入任何文件**；本文所有值均为占位符。
> 建议：GitHub PAT 使用 fine-grained、仅本仓库 `contents: write`；Edge API Key 只在 Partner Center 重新生成并保存到密码管理器。

## 0. 前置清单

| 项 | 说明 |
| --- | --- |
| 生产签名密钥（Ed25519） | 私钥离线生成，托管密码库 + CI Secret；公钥入库 |
| GitHub 仓库 | `iorl566/bridgedeck`，可 push 与打 tag |
| GitHub Secrets | `RELEASE_SIGNING_PRIVATE_KEY`、`RELEASE_PUBLIC_KEY_ID`、`EDGE_API_KEY`、`EDGE_PRODUCT_ID`、`WINDOWS_PFX_BASE64`/`WINDOWS_PFX_PASSWORD`（可选） |
| Edge Partner Center | 已创建 BridgeDeck 产品；拿到 Product ID；API Key 已生成 |
| 隐私政策 URL | 启用 GitHub Pages（`docs/`）后：`https://iorl566.github.io/bridgedeck/privacy-policy.html` |
| 商店素材 | `docs/assets/store/store-01..05.png`、`icon-300.png`、`docs/STORE-LISTING.md` |

## 1. 生产签名密钥（只做一次）

```powershell
# 离线/受控机器；私钥不要进仓库
openssl genpkey -algorithm ED25519 -out bridge-release-private.pem
openssl pkey -in bridge-release-private.pem -pubout -out bridge-release-public.pem
```

- 私钥：放密码管理器 + GitHub Secret `RELEASE_SIGNING_PRIVATE_KEY`（PEM 原文）；
- 公钥：写入 `lib/release-public-key.mjs` 与 `tools/release-public-key.production.pem`，记录 keyId 到 `RELEASE_PUBLIC_KEY_ID`；
- 切换模式：`node tools/release-key-mode.mjs production`（以脚本实际参数为准），确保 `lib/release-public-key.mjs` 指向生产公钥；
- 轮换：生成新 keypair → 更新公钥/ keyId → 发布新版本清单；旧版本客户端按旧 keyId 验证已发布清单，不允许静默换钥。

## 2. 本地完整构建与预检

```powershell
node tools/build-extension.mjs
node tools/verify-extension-package.mjs
node tools/build-cli-bundle.mjs
node tools/package-portable.mjs --out dist/BridgeDeck-cli-0.3.1-win32-x64.zip --platform win32 --arch x64
node tools/package-portable.mjs --out dist/BridgeDeck-cli-0.3.1-darwin-x64.tar.gz --platform darwin --arch x64 --no-node
# darwin-arm64 / linux-x64 / linux-arm64 同理
node tools/build-setup-exe.mjs
tar.exe -a -cf dist/BridgeDeck-dsh-plugin-0.3.1.zip dsh-plugin
node tools/release-brand-scan.mjs          # 必须 PASS
node tools/release.mjs --sign-ed25519 <生产私钥 PEM>
node tools/release-preflight.mjs           # 必须 PASS
node tools/release.mjs --check --public-key dist/release-public.pem
```

> 本地若没有生产私钥，可用临时验证密钥跑通流程，但**不得对外分发**；正式发布必须由 CI 用 Secret 签名。

## 3. GitHub Release（标签触发）

1. 更新版本（`package.json` / `extension/manifest.json` / `apps/extension` / `dsh-plugin`），提交；
2. `git tag v0.3.1 && git push origin v0.3.1`；
3. 触发/等待工作流：
   - `release-extension.yml`：构建扩展 + Setup exe + 上传资产；
   - `release-cli.yml`：5 平台 CLI + 归档；
   - `release-dsh-plugin.yml`：插件 zip + sha256；
   - `sign-release.yml`：下载草稿资产 → 生产私钥签名 `release.json`/`SHA256SUMS` → 上传/发布；
4. 下载全部资产跑 `powershell -File tools/verify-release.ps1 -Dist <目录>`，确认 `verify ok: 0.3.1 / 9 artifacts` 且 keyId 与生产一致；
5. 在 Release 中附 `docs/STORE-LISTING.md` 的更新说明与隐私政策链接。

## 4. Edge Add-ons 提交（API 或 Partner Center UI）

### 4.1 用工作流（推荐）

```powershell
gh workflow run release-store.yml -f tag=v0.3.1 -f submit=review
```

工作流内容：checkout tag → setup Node → `brand:scan` → 构建/验证扩展 → 调 Edge Add-ons API 上传 `dist/BridgeDeck-extension-0.3.1.zip` → 轮询上传 → 提交审核。

### 4.2 手动 API（等价，便于排查）

```powershell
$key = $env:EDGE_API_KEY
$product = $env:EDGE_PRODUCT_ID
$zip = Get-ChildItem dist/BridgeDeck-extension-*.zip | Select-Object -First 1

# 上传草稿包
$resp = Invoke-WebRequest -Method Post `
  -Uri "https://api.addons.microsoftedge.microsoft.com/v1/products/$product/submissions/draft/package" `
  -Headers @{ Authorization = "ApiKey $key" } `
  -ContentType 'application/zip' -InFile $zip.FullName
$opId = ($resp.Content | ConvertFrom-Json).operationId

# 轮询上传状态
Invoke-WebRequest -Uri "https://api.addons.microsoftedge.microsoft.com/v1/products/$product/submissions/draft/package/operations/$opId" `
  -Headers @{ Authorization = "ApiKey $key" }

# 提交审核（json body 按 Partner Center 当前要求填写 notes）
Invoke-WebRequest -Method Post `
  -Uri "https://api.addons.microsoftedge.microsoft.com/v1/products/$product/submissions" `
  -Headers @{ Authorization = "ApiKey $key"; 'Content-Type' = 'application/json' } `
  -Body '{ "notes": "0.3.1 release" }'
```

- 提交后在 Partner Center 查看审核状态；
- 商店 listing 文案/截图直接从本文件 §1–§5 粘贴，截图使用 `docs/assets/store/store-*.png`；
- 隐私政策 URL：`https://iorl566.github.io/bridgedeck/privacy-policy.html`。

## 5. 发布后验证与回滚

- 从商店安装新版本 → popup 底部版本/协议正确 → 本机 `bridge status` 正常 → 做一次 open/observe/screenshot；
- GitHub：下载全部资产跑 `verify-release.ps1`；比对 `SHA256SUMS`；
- 回滚：GitHub Release 标记 draft/删除并重新发上一版；Edge 商店用上一版包重新提交（审核后生效）；保留旧版 `dist` 备份与上一版清单。

## 6. 禁止事项

- 不把 PAT / Edge API Key / 私钥写进仓库、issue、构建日志；
- 发布包不包含 `.ref`、测试数据、第三方二进制；品牌扫描必须 PASS；
- 不在审核期间改版本号或重复提交同一 zip（会导致哈希/签名失效）。
