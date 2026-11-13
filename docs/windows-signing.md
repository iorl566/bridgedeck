# Windows 签名

发布流水线支持 **EV 代码签名**（Authenticode）；本地开发仍可用自签证书。签名只影响安装器与可执行文件，不影响 CLI 的 JS 代码。

## 自签测试证书（不是 EV）

EV 证书只能由 CA 完成组织验证后签发，**不能用脚本“生成”**。本地联调可以生成自签证书：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\make-selfsigned-cert.ps1 `
  -OutDir .\dist\signing -Password '<test password>'

.\tools\sign-windows.ps1 -File .\dist\BridgeDeckSetup-0.1.2.exe `
  -Pfx .\dist\signing\BridgeDeck-selfsigned.pfx `
  -Password '<test password>' -NoTimestamp -AllowUntrusted
```

自签证书的签名状态会是 `UnknownError`（根证书不受信任）；`-AllowUntrusted` 只用于本地测试，发布流水线必须要求 `Valid`。

## 证书类型

| 类型 | 用途 | `signtool` 参数 |
| --- | --- | --- |
| EV PFX | CI 导入 PFX 后签名 | `/f cert.pfx /p <password>` |
| EV 硬件令牌 | 证书在令牌/HSM 中，按指纹选证书 | `/sha1 <thumbprint>` |
| 证书主题 | 证书已在当前用户/机器证书库 | `/n "<subject>"` |

EV 证书通常要求硬件令牌或云 HSM；CI 环境应使用可导入的 PFX，或带有签名服务的自托管 runner。不要把 PFX、密码或令牌 PIN 提交到仓库。

## 本地签名

```powershell
node tools/build-setup-exe.mjs

powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sign-windows.ps1 `
  -File .\dist\BridgeDeckSetup-0.1.2.exe `
  -Pfx .\dist\signing\BridgeDeck-ev.pfx `
  -Password '<password>' `
  -RequireTimestamp
```

也可以用证书库里的证书，不导出 PFX：

```powershell
.\tools\sign-windows.ps1 -File .\dist\BridgeDeckSetup-0.1.2.exe `
  -Thumbprint '0123456789ABCDEF...' -RequireTimestamp
```

脚本默认使用 `http://timestamp.digicert.com`，`-NoTimestamp` 可关闭。`-RequireTimestamp` 会在缺少时间戳时失败，发布流水线应始终带上。

## 校验

```powershell
Get-AuthenticodeSignature .\dist\BridgeDeckSetup-0.1.2.exe | Format-List
Get-FileHash .\dist\BridgeDeckSetup-0.1.2.exe -Algorithm SHA256
node tools/release.mjs --check
```

## CI 配置

在仓库 Secrets 中设置：

| Secret | 说明 |
| --- | --- |
| `WINDOWS_PFX_BASE64` | PFX 的 Base64（`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`） |
| `WINDOWS_PFX_PASSWORD` | PFX 密码 |
| `WINDOWS_CERT_THUMBPRINT` | 可选；证书已装在 runner 证书库时按指纹签名（需要自托管 runner 或已导入证书） |
| `RELEASE_SIGNING_KEY` | 可选；`release.json` 的 HMAC 签名密钥 |
| `RELEASE_SIGNING_PRIVATE_KEY` | 可选；`release.json` 的 Ed25519 私钥（推荐，见 [发布清单签名](release-signing.md)） |

`release-extension.yml` 优先使用 PFX；没有 PFX 但配置了指纹时使用证书库中的证书。两者都没有时跳过签名并继续发布（产物会显示“未知发布者”）。

## 证书边界

- 自签证书只用于本机/内部测试，Windows 会显示“未知发布者”。
- 公开分发应使用受信任的 EV/OV 代码签名证书。
- 密码、PFX、令牌 PIN 不应进入安装包、日志或版本控制。
- 时间戳只证明签名时间，不改变证书信任状态。
