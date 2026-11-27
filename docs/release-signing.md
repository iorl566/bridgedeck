# 发布签名与上架准备（0.3.1）

> 目标：`dist/release.json` 由**生产 Ed25519 私钥**签名，客户端可离线验证；扩展包可提交 Edge/Chrome 商店。
> 当前本地产物可能使用临时验证密钥（keyId `4ee9753d5d93f35d`），**不可对外分发**；正式发布必须由 CI Secret 签名。
> 安全：私钥/Token/API Key 只放密码库与 GitHub Secrets，禁止写入仓库、聊天或日志。

## 1. 密钥与密钥模式

| 项 | 路径/Secret | 说明 |
| --- | --- | --- |
| 生产私钥 | GitHub Secret `RELEASE_SIGNING_PRIVATE_KEY` | Ed25519 PEM 原文；离线备份 |
| 生产公钥 | `lib/release-public-key.mjs`、`tools/release-public-key.production.pem` | 客户端内置验证 |
| keyId | `RELEASE_PUBLIC_KEY_ID`（GitHub Actions Variable/Secret） | 例如生产 keyId；必须在 `release.json` 与客户端一致 |
| 本地验证密钥 | `.tmp/release-verify-031/keys/release-private.pem` | 仅本地 dry-run，不得发布 |

生成与切换：

```powershell
openssl genpkey -algorithm ED25519 -out bridge-release-private.pem
openssl pkey -in bridge-release-private.pem -pubout -out bridge-release-public.pem
node tools/release-key-mode.mjs production   # 以脚本参数为准；把生产公钥写入 lib/release-public-key.mjs
```

轮换：生成新对 → 更新公钥与 keyId → 发新版本清单；不要在同一版本内静默换钥。

## 2. 构建 + 签名 + 预检（顺序固定）

```powershell
node tools/build-extension.mjs
node tools/verify-extension-package.mjs
node tools/build-cli-bundle.mjs
node tools/build-setup-exe.mjs
tar.exe -a -cf dist/BridgeDeck-dsh-plugin-0.3.1.zip dsh-plugin
node tools/release-brand-scan.mjs
node tools/release.mjs --sign-ed25519 <私钥 PEM> [--public-key <生产公钥>]
node tools/release-preflight.mjs
node tools/release.mjs --check --public-key dist/release-public.pem
```

要求：

- `release-brand-scan` **必须 PASS**（源码 + 已构建压缩包均无对标品牌字眼）；
- `release-preflight` **必须 PASS**（版本四方一致、制品字节/哈希、SHA256SUMS、签名、体积上限、协议/错误码/生成物一致）；
- `release.json` 的 `signature.keyId` 必须等于客户端内置生产 keyId；
- 发布前不得再改版本号或重新打包，否则哈希/签名失效。

## 3. 客户端验证

- 下载 `release.json`、`SHA256SUMS`、`release-public.pem` 与全部制品；
- `node tools/release.mjs --check --public-key release-public.pem`；
- 客户端更新器按内置公钥验签，验签失败拒绝更新。

## 4. 商店与 GitHub

- GitHub Release：tag 触发 `release-extension.yml` / `release-cli.yml` / `release-dsh-plugin.yml` / `sign-release.yml`；
- Edge 商店：`release-store.yml`（需 `EDGE_API_KEY`、`EDGE_PRODUCT_ID`），或按 `docs/STORE-PUBLISH-RUNBOOK.md` 手动 API；
- Chrome Web Store：同一扩展 zip，按商店后台流程提交（如启用）；
- 商店 listing 文案/截图/隐私见 `docs/STORE-LISTING.md`、`docs/STORE-REVIEW.md`。

## 5. 门禁清单（发布前）

- [ ] `npm run brand:scan` PASS
- [ ] `release-preflight` PASS
- [ ] `release --check` PASS
- [ ] 9 个制品齐全（扩展/Setup/5 平台 CLI/CLI bundle/插件）
- [ ] 商店截图与图标已更新（`docs/assets/store/store-01..05.png`、`icon-300.png`）
- [ ] 隐私政策 URL 可访问
- [ ] 凭证未出现在仓库/日志；已吊销聊天中泄露的 PAT/API Key
