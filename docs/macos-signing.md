# macOS 签名与公证

macOS 发布走 **Developer ID 签名 → 生成 `.pkg` → Apple 公证 → staple** 的流程；`tar.gz` 便携包也会签名其中的 Mach-O 二进制。

## 需要的材料

| 材料 | 用途 |
| --- | --- |
| Developer ID Application 证书 | 签 `node` 等 Mach-O 二进制 |
| Developer ID Installer 证书 | 签 `.pkg` |
| Apple ID + App 专用密码 + Team ID | `notarytool` 提交公证 |

证书从 Apple Developer 导出为 `.p12`，CI 用 Base64 存放在 Secrets 中。

## 本地操作

```sh
# 1. 生成 stage（跨架构可下载对应 Node 运行时）
node tools/package-portable.mjs --platform darwin --arch arm64 --stage-only --json

# 2. 签名 stage 里的 Mach-O
bash tools/sign-macos.sh --dir "$STAGE" --identity "Developer ID Application: Your Name (TEAMID)"

# 3. 重新打包 tar.gz
node tools/package-portable.mjs --pack-dir "$STAGE" --platform darwin --arch arm64 \
  --out dist/BridgeDeck-cli-0.1.2-darwin-arm64.tar.gz

# 4. 生成并签名 pkg
bash tools/build-macos-pkg.sh --stage "$STAGE" --version 0.1.2 \
  --out dist/BridgeDeck-0.1.2-darwin-arm64.pkg \
  --identity-installer "Developer ID Installer: Your Name (TEAMID)"

# 5. 公证 + staple
bash tools/notarize-macos.sh --file dist/BridgeDeck-0.1.2-darwin-arm64.pkg \
  --apple-id you@example.com --team-id TEAMID --password '<app-specific-password>'
```

`sign-macos.sh` 会对 `node` 使用 `tools/macos-entitlements.plist`（JIT / unsigned executable memory），这是 Node.js 在 hardened runtime 下运行所必需的。

## 验证

```sh
codesign --verify --strict --verbose=2 "$STAGE/bin/node"
spctl --assess --type execute --verbose=4 "$STAGE/bin/node"   # 公证后
xcrun stapler validate dist/BridgeDeck-0.1.2-darwin-arm64.pkg
```

## CI Secrets

| Secret | 说明 |
| --- | --- |
| `APPLE_CERT_P12_BASE64` | Developer ID Application `.p12` 的 Base64 |
| `APPLE_CERT_PASSWORD` | `.p12` 密码 |
| `APPLE_SIGN_IDENTITY` | 例如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_INSTALLER_IDENTITY` | 例如 `Developer ID Installer: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID |
| `APPLE_TEAM_ID` | Team ID |
| `APPLE_APP_PASSWORD` | App 专用密码（不是账号密码） |

没有配置证书时，`publish-cli` / `release-cli` 只生成未签名的 `tar.gz`，不生成 `.pkg`。

## 注意

- `tar.gz` 无法 staple 公证票据；需要“双击安装 + Gatekeeper 认可”时请分发 `.pkg`。
- 公证提交的是签名后的 `.pkg`；先 `productsign` 再 `notarytool submit`。
- 不要把 `.p12`、密码或 App 专用密码提交到仓库。
