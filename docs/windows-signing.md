# Windows 签名

安装器使用 IExpress 打包，自签证书签名，并尝试公共时间戳。自签证书不受系统信任，Windows 会显示“未知发布者”；这是当前分发方式的预期结果。

## 生成自签证书

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=BridgeDeck" `
  -FriendlyName "BridgeDeck" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(5)
```

导出 PFX 后放入 `dist/signing/`，不要把密码提交到仓库。

## 构建

```powershell
node tools/build-setup-exe.mjs
```

产物：

```text
dist/BridgeDeckSetup-0.1.1.exe
dist/bridgedeck-0.1.1-edge.zip
dist/bridgedeck-cli-0.1.1.zip
dist/release.json
dist/SHA256SUMS
```

## 签名

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sign-windows.ps1 `
  -File .\dist\BridgeDeckSetup-0.1.1.exe `
  -Pfx .\dist\signing\BridgeDeck-selfsigned.pfx `
  -Password '<password>' `
  -TimestampUrl 'http://timestamp.digicert.com'
```

时间戳服务不可用时签名仍可完成，但没有时间戳；发布前应确认时间戳成功。

## 校验

```powershell
Get-AuthenticodeSignature .\dist\BridgeDeckSetup-0.1.1.exe | Format-List
Get-FileHash .\dist\BridgeDeckSetup-0.1.1.exe -Algorithm SHA256
node tools/release.mjs --check
```

## 证书边界

- 自签证书只用于本机/内部测试。
- 公开分发应使用受信任的代码签名证书。
- 密码与 PFX 不应进入安装包、日志或版本控制。
- 时间戳只证明签名时间，不改变证书信任状态。
