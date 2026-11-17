# 发布签名与上架准备

`dist/release.json` 当前 **unsigned**；签名/上架需要私钥和商店权限，属于外部阻塞。

## 1. 预检

```sh
node tools/release-preflight.mjs
node tools/release-preflight.mjs --json
```

检查：

- 每个 artifact 是否存在；
- 实际字节数/sha256 是否与 manifest 一致；
- 制品版本是否混合（例如 0.1.7 CLI + 0.1.8 extension）；
- `release.json` 是否已签名；
- 提供 `--key` 时只校验私钥类型，不签名。

当前（2026-11-17）状态：0.1.7 制品已移到 `dist/archive-0.1.7/`，`release.json` 只含 0.1.8：

```text
[ok] darwin-arm64/darwin-x64/linux-arm64/linux-x64 portable
[ok] win32-x64 portable
[ok] CLI bundle
[ok] DSH plugin
[ok] extension
[ok] BridgeDeckSetup-0.1.8.exe
blocker: release.json 缺少签名
```

0.1.8 的 macOS/Linux/Windows portable、CLI bundle、DSH plugin、extension、Setup exe 都已重建；只剩签名。

## 2. 重新构建全部制品

```sh
node tools/build-extension.mjs
node tools/build-cli.mjs
node tools/build-cli-bundle.mjs
node tools/build-dsh-plugin.mjs
node tools/build-installer.ps1
node tools/release.mjs
```

以各自脚本的实际参数为准；先确保所有制品都是 0.1.8。

## 3. 签名

```sh
node tools/release.mjs --sign-ed25519 C:\keys\bridge-release.pem
```

- 私钥不能提交到仓库；
- 公钥写入 `dist/release-public.pem`，并同步到 `lib/release-public-key.mjs`；
- 验证：
  ```sh
  node tools/release.mjs --verify --public-key dist/release-public.pem
  node tools/release-preflight.mjs
  ```

## 4. 上架

- GitHub Release：上传 `release.json`、`release-public.pem`、extension zip、CLI 包、安装包；
- Edge Add-ons：上传 extension zip，填写权限说明和隐私说明；
- 商店审核通过前不要改版本号或重新打包，否则哈希/签名失效。

## 5. 外部阻塞

以下需要用户提供，不能由 Agent 自行完成：

- Ed25519 私钥（或签名服务）；
- GitHub release 写权限；
- Edge Partner Center 账号/产品权限。

没有这些材料时，只能完成预检、打包和文档，不能完成签名/上架。
