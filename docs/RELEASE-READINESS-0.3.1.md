# Release Readiness — BridgeDeck 0.3.1

> 本文件记录发布候选（RC）证据与阻塞项。所有命令在本仓库根目录执行。
>
> **2026-11-27 更新：GitHub Release `v0.3.1` 已发布**（生产密钥签名，keyId `c7b5e21301f91a2d`，12 个资产）；Edge 商店仍缺 Client ID / Product ID。
> **凭证安全**：不要把 PAT / Edge API Key / 签名私钥写入仓库；只放 GitHub Secrets 或本机环境变量。

## 1. 构件与签名（本地 RC）

`dist/release.json`：version `0.3.1`，**9 个 artifact**，keyId `4ee9753d5d93f35d`（本地验证密钥，不可对外分发）。

| Artifact | Bytes | SHA256 前 16 |
| --- | ---: | --- |
| BridgeDeck-extension-0.3.1.zip | 2,988,058 | b5205ff85ee90bdd |
| BridgeDeckSetup-0.3.1.exe | 40,886,272 | 86952dd070781c44 |
| BridgeDeck-cli-0.3.1-win32-x64.zip | 41,218,332 | 904ebfe334dad885 |
| BridgeDeck-cli-0.3.1-darwin-x64.tar.gz | 5,658,411 | a5595df63aabc73a |
| BridgeDeck-cli-0.3.1-darwin-arm64.tar.gz | 5,658,415 | 71622df49b98d302 |
| BridgeDeck-cli-0.3.1-linux-x64.tar.gz | 5,658,412 | 86be12256c3f66d8 |
| BridgeDeck-cli-0.3.1-linux-arm64.tar.gz | 5,658,420 | a923129ce689ec61 |
| BridgeDeck-cli-bundle-0.3.1.zip | 2,144,255 | 50232a31cc15acf1 |
| BridgeDeck-dsh-plugin-0.3.1.zip | 140,216 | b64fe538ab2e0227 |

扩展包体积：**2,988,058 B**（o200k 前缀压缩后；此前 3.67MB）。

## 2. 门禁证据（本轮复跑）

- `node tools/release-brand-scan.mjs` → PASS（源码 + 已构建包无对标品牌字眼）
- `node tools/pack-o200k.mjs --check` → clean（1,405,147 bytes）
- `node tools/verify-extension-package.mjs` → PASS（含 runtime 381 JS、静态引用检查）
- `node tools/release-preflight.mjs` → **PREFLIGHT PASS**
- `node tools/release.mjs --check --public-key dist/release-public.pem` → **release ok: v0.3.1 / 9 artifacts**
- 单元 5087 / 5087；真实 Edge E2E 222 / 222；CLI 404；MCP 216；Python 181
- 矩阵：641 格（equal 36 / partial 333 / missing 0 / extra 252 / unknown 20）；**P0 = 0**（剩余均为 contract partial/extra/unknown；direct tools、feature gate 已具备）

## 3. 商店素材

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `docs/assets/store/store-01.png` | 1280×800 | 总览 |
| `docs/assets/store/store-02.png` | 1280×800 | 弹窗主面板 |
| `docs/assets/store/store-03.png` | 1280×800 | 快捷功能 |
| `docs/assets/store/store-04.png` | 1280×800 | 操作录制 |
| `docs/assets/store/store-05.png` | 1280×800 | 网站调试 |
| `docs/assets/store/icon-300.png` | 300×300 | 商店图标 |

文案/审核/隐私：`docs/STORE-LISTING.md`、`docs/STORE-REVIEW.md`、`docs/privacy-policy.html`、`extension/PRIVACY.md`。
隐私 URL（启用 GitHub Pages 后）：`https://iorl566.github.io/bridgedeck/privacy-policy.html`。

## 4. CI 工作流

已存在：`release-extension.yml`、`release-cli.yml`、`release-dsh-plugin.yml`、`sign-release.yml`、**`release-store.yml`**（Edge API 上传/提交）；品牌扫描已接入 quality 与 release 工作流。
需要的 Secrets：`RELEASE_SIGNING_PRIVATE_KEY`、`RELEASE_PUBLIC_KEY_ID`、`EDGE_API_KEY`、`EDGE_PRODUCT_ID`，可选 Windows 证书。

## 5. 阻塞项（必须由持有者完成）

1. **生产 Ed25519 私钥**：已由 GitHub Actions Secret `RELEASE_SIGNING_PRIVATE_KEY` 完成生产签名；本地私钥副本不在本机（无需再生成）；
2. **GitHub 仓库写权限**：已完成（main + tag `v0.3.1` + Release 已发布）；
3. **Edge Partner Center**：已有 API Key；仍缺 **`EDGE_CLIENT_ID`** 与 **`EDGE_PRODUCT_ID`**（Product ID 是 Extension Identity 的小写 GUID）；
4. **凭证轮换**：本地已按授权存入 `D:\BridgeDeck-secrets`（ACL 仅当前用户）；建议后续轮换并以新值替换。

## 6. 一键执行顺序（凭证就绪后）

```powershell
# 1) 生产公钥/keyId 固定到仓库并提交
# 2) 配置 Secrets 后
git tag v0.3.1; git push origin v0.3.1          # 触发 release-extension/cli/dsh-plugin
# 3) 生产私钥签名清单（sign-release workflow 或本地）
node tools/release.mjs --sign-ed25519 <生产私钥>
node tools/release-preflight.mjs
# 4) GitHub Release 上传 9 个 artifact + release.json + SHA256SUMS + release-public.pem
# 5) Edge 提交
gh workflow run release-store.yml -f tag=v0.3.1 -f submit=review
# 6) 下载全部资产回归
powershell -File tools/verify-release.ps1 -Dist <下载目录>
```
