# 发布清单签名

`dist/release.json` 记录每个 artifact 的 SHA256，并可选带 `signature`。客户端/daemon 在更新前可以校验它，防止清单或产物被替换。

支持两种签名：

| 算法 | 密钥 | 适用 |
| --- | --- | --- |
| `ed25519` | CI 私钥 + 客户端内置公钥 | **推荐**，公开分发 |
| `hmac-sha256` | 同一个 secret | 发布机/运维自校验；不要把 secret 发给客户端 |

## Ed25519（推荐）

### 1. 生成密钥对

```powershell
node tools/release-keygen.mjs --write-public-key
```

产物：

- `dist/signing/release-private.pem`：私钥，**不要提交**
- `dist/signing/release-public.pem`：公钥
- `lib/release-public-key.mjs`：写入公钥与 `keyId`，提交这个文件

### 2. 配置 CI

```powershell
# 私钥整段 PEM 作为 Secret（也支持 Base64）
gh secret set RELEASE_SIGNING_PRIVATE_KEY --body (Get-Content .\dist\signing\release-private.pem -Raw)
```

`release-cli.yml` 检测到该 Secret 后会用 `--sign-ed25519` 生成 `signature: { alg: "ed25519", value, keyId }`，并把公钥写入 `dist/release-public.pem` 一并上传。

### 3. 本地校验

```powershell
node tools/release.mjs --check --public-key .\dist\signing\release-public.pem
```

### 4. 客户端校验

CLI 会内置 `lib/release-public-key.mjs` 的公钥；当清单是 `ed25519` 时自动校验，不需要用户额外传 key。

也可以显式指定：

```powershell
bridge update fetch --key .\release-public.pem
bridge update fetch --key .\release-signing.key      # HMAC 模式
```

`bridge update check`、`bridge update install --manifest`、daemon 自动更新同样支持。

## HMAC（兼容保留）

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > release-signing.key
gh secret set RELEASE_SIGNING_KEY --body (Get-Content .\release-signing.key -Raw)
node tools/release.mjs --sign-key .\release-signing.key
node tools/release.mjs --check --sign-key .\release-signing.key
```

限制：HMAC 是对称的，谁能校验谁就能伪造。密钥不能分发给用户，所以它只适合发布机/运维侧校验，不能让终端用户建立信任。

## 轮换

1. 重新运行 `node tools/release-keygen.mjs --write-public-key --force`（或在旧公钥模块里替换）。
2. 更新 `RELEASE_SIGNING_PRIVATE_KEY` Secret。
3. 发布一个新版本；旧版本客户端仍会拿旧公钥校验，所以**旧版本不支持新 key**。需要平滑轮换时，客户端应同时内置新旧两个公钥并按 `keyId` 选择；当前版本只内置一个。

## 校验范围

签名覆盖 `version` 与所有 artifact 的 `name/file/bytes/sha256`（按名字排序）；签名本身不含 `generatedAt`，也不覆盖 `release-public.pem` 文件。
