# BridgeDeck 0.3.0 发布链路验证报告

> 背景：用户于 2026-11-26 解除 0.3.0 冻结，授权验证发布链路。本报告记录**本地可验证的全部发布步骤**、
> 真实产物哈希、以及距离“公网正式发布”还缺什么。
> 方法：为不破坏现有 `dist/`（其中是 2026-11-18/20 的 0.3.0 历史产物），验证时把生产 `dist/`
> 临时改名，用**空 dist 沙箱**跑完整流水线，结束后恢复生产 `dist/`；新产物与日志保存在
> `.tmp/release-verify/`（`dist-built/`、`pipeline2.log`）。

## 1. 结论

**本地发布链路全部通过**：15 个步骤 exit 0；`release-preflight` **PREFLIGHT PASS**；
`verify-release.ps1` 输出 **verify ok: 0.3.0 / 8 artifacts**（自签名证书给出 untrusted 警告，属预期）。
距离公网发布仍缺 5 项环境/密钥条件（见 §5），其中最关键的是**生产 Ed25519 私钥**与**真实代码签名证书**。

## 2. 流水线执行结果

| 步骤 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| keygen（临时签名密钥） | `node tools/release-keygen.mjs --out .tmp/release-verify/keys --force` | exit 0，keyId `3e0f1736f821c3ed` | 116 ms |
| 扩展 zip | `node tools/build-extension.mjs` | exit 0，3,633,480 B，426 entries | 26.1 s |
| 扩展包校验（解压 + SW/import/HTML 引用） | `node tools/verify-extension-package.mjs` | exit 0 | 5.1 s |
| CLI bundle | `node tools/build-cli-bundle.mjs` | exit 0，2,136,276 B，349 entries | 8.5 s |
| 可移植包 win32-x64（含宿主 Node） | `node tools/package-portable.mjs --platform win32 --arch x64` | exit 0，40,160,376 B | 13.4 s |
| 可移植包 linux-x64（外部 Node） | `node tools/package-portable.mjs --platform linux --arch x64 --no-node` | exit 0，4,601,596 B | 7.9 s |
| 可移植包 linux-arm64（外部 Node） | 同上 `--arch arm64` | exit 0，4,601,605 B | 7.7 s |
| 可移植包 darwin-arm64（外部 Node） | 同上 `--platform darwin --arch arm64` | exit 0，4,601,612 B | 7.9 s |
| Windows 安装器 exe（IExpress） | `node tools/build-setup-exe.mjs` | exit 0，39,829,504 B | 37.1 s |
| DSH 插件 zip | `tar -a -c -f dist/BridgeDeck-dsh-plugin-0.3.0.zip -C . dsh-plugin` + sha256 | exit 0，140,217 B | 0.2 s |
| 自签名证书（验证签名路径） | `tools/make-selfsigned-cert.ps1` | exit 0，thumbprint `29E41AF7…` | 1.6 s |
| 签名安装器（manifest 之前） | `tools/sign-windows.ps1 -Pfx … -NoTimestamp -AllowUntrusted` | exit 0（signtool 缺失 → 回退 `Set-AuthenticodeSignature`，untrusted 警告） | 1.3 s |
| 发布清单 + Ed25519 签名 | `node tools/release.mjs --sign-ed25519 .tmp/release-verify/keys/release-private.pem` | exit 0，**8 artifacts**，`release.json` 2,095 B | 180 ms |
| 发布前一致性检查 | `node tools/release-preflight.mjs --key .tmp/release-verify/keys/release-private.pem` | **exit 0 / PREFLIGHT PASS** | 35.9 s |
| 发布产物校验 | `tools/verify-release.ps1 -Dist dist` | **exit 0 / verify ok: 0.3.0 / 8 artifacts** | 1.4 s |

`release-preflight` 的关键检查（全 ok）：版本一致性、协议版本、方法面、特性门表、错误码与 SDK 覆盖、
协议门禁接线、**制品与包体积一致性（大小/sha256/SHA256SUMS/签名/上限）**；外部门禁
vendor-leak / source-guard / architecture-guards / performance-budgets / fault-injection /
method-catalog / performance-budget 全 ok。

## 3. 本次构建产物（`.tmp/release-verify/dist-built/`）

| 产物 | 字节 | SHA-256 |
| --- | --- | --- |
| BridgeDeck-cli-0.3.0-win32-x64.zip | 40,160,376 | `f54d80d1097d46c920644b56e0197f40780827402a6eae84a34ba39efff1bd3f` |
| BridgeDeck-cli-0.3.0-linux-x64.tar.gz | 4,601,596 | `7e843b0a5baef5967d64a0f7a70d919d589100fb1596aabcddf2a342a47da963` |
| BridgeDeck-cli-0.3.0-linux-arm64.tar.gz | 4,601,605 | `14c7c8a923bb616cba029bcb081632de5292037535ce57916db04c3398d358ce` |
| BridgeDeck-cli-0.3.0-darwin-arm64.tar.gz | 4,601,612 | `c0b637bab47f37043ab36df2e8e9e1dd39430c7408e647e0d2de2f6b88f64bd5` |
| BridgeDeck-cli-bundle-0.3.0.zip | 2,136,276 | `b42f8df53edc438354edd6413d95c4f21a0152d0a0d1451927b86e6876b1c769` |
| BridgeDeck-dsh-plugin-0.3.0.zip | 140,217 | `037cbf258bc975e1870c90e1f88fc5beea06f9262e954bcc4396c6cbc7570a1b` |
| BridgeDeck-extension-0.3.0.zip | 3,633,480 | `0317d0d2e58f92ab5e8b55a0b9cf9da49c895f4b309ed4024c82a7f742649643` |
| BridgeDeckSetup-0.3.0.exe | 39,830,904 | `f53604bbc9ddcda3d4a0d706273bfc4b9ae2f4fc9d935533eea10c77ef14e90c` |
| release.json | 2,095 | `f47466e1bf32c521a91a787e49eeef53ff8de417100817d4cc56ada3509dca6e` |
| SHA256SUMS | 803 | `62d9621e62ee6c2a16f650ec935eecde2e5b27adbd80d171c6977f628d3538f5` |

> 可复现性：同一棵树两次构建，**扩展 zip 的 sha256 完全一致**（`0317d0d2…`，说明扩展打包确定性较好）；
> CLI bundle / 可移植包 / 安装器因归档时间戳与签名不同而字节不同。本次 win32 包内含宿主 Node（≈40 MB），
> linux/darwin 用 `--no-node`（要求目标机已装 Node ≥20）。历史上的 0.3.0 发布产物明显更小
> （win32 753,932 B / extension 443,292 B），说明发布时是否内嵌 Node 是可配置的设计选择。

## 4. 与生产 `dist/` 的关系

- 验证期间生产 `dist/` 被临时移走，结束后**已恢复**：`dist/release.json` 仍为生产版本
  （version 0.3.0，keyId `c7b5e21301f91a2d`，9 artifacts），`dist/` 无 `dist.__production__` 残留。
- **生产 `dist/` 已过期**：其 0.3.0 产物来自 2026-11-18/20，而当前工作树已增长到 35 万行以上；
  本次重新构建的扩展 zip 3.63 MB（生产 0.44 MB）、CLI bundle 2.14 MB（生产 0.30 MB）。
  这正说明了“解除冻结后必须重新打包”的必要性。

## 5. 距离“公网正式发布”还缺什么

| # | 缺口 | 现状 / 需要的动作 |
| --- | --- | --- |
| 1 | **生产 Ed25519 私钥** | 仓库只有公钥（`lib/release-public-key.mjs`，keyId `c7b5e21301f91a2d`）与 `dist/release-public.pem`；私钥只在 CI Secret `RELEASE_SIGNING_PRIVATE_KEY`。本次用临时 keypair 验证了签名与校验路径，真实发布必须用生产私钥（否则已发布客户端无法验证）。 |
| 2 | **真实代码签名证书 + signtool** | 本机无 `signtool.exe`（无 Windows SDK），`sign-windows.ps1` 回退 `Set-AuthenticodeSignature`；本次用自签名证书验证了“签名→manifest→校验”的时序与回退逻辑。正式发布需要 CA 证书（PFX/Thumbprint）+ signtool + 时间戳服务。 |
| 3 | **macOS 签名/公证** | 需要 macOS runner + Apple Developer 证书 + `APPLE_ID` 等 secrets；Windows 环境无法执行 `sign-macos.sh`/`notarize-macos.sh`。 |
| 4 | **GitHub 发布（tag + release assets）** | 本工作树无 git 仓库、无 `gh`/token；`.github/workflows/{release-cli,release-extension,release-dsh-plugin,sign-release,publish-cli}.yml` 依据 tag 与 release id 执行，本地只能验证其等价的构建/校验命令。 |
| 5 | **跨平台 Node 运行时下载** | 离线环境下载 Node 官方包会挂起；linux/darwin 包本次用 `--no-node`（外部 Node）。正式发布要么在 CI 中允许联网下载，要么明确“目标机自备 Node”的产品决策。 |
| 6 | **版本号** | 本次在 0.3.0 上验证。正式发布需先升版本（`package.json`、`extension/manifest.json`、`apps/extension/package.json`、`crates/bridge-cli/Cargo.toml`、release 产物命名），再重跑本流水线（版本一致性检查会强制这一点）。 |
| 7 | **可复现构建** | 扩展 zip 已确定性；CLI bundle / 可移植包 / 安装器仍受时间戳影响。若要发布可复核构建，需给 zip/tar 注入固定 mtime（`SOURCE_DATE_EPOCH` 风格）。 |

## 6. 复跑方式（沙箱，不覆盖生产 dist）

```powershell
cd D:\浏览器桥
$env:PATH='D:\tools\node;'+$env:PATH
# 关键等价步骤（单条执行；完整脚本思路见 .tmp/release-verify/pipeline2.log）
node tools/build-extension.mjs
node tools/verify-extension-package.mjs
node tools/build-cli-bundle.mjs
node tools/package-portable.mjs --platform win32 --arch x64
node tools/package-portable.mjs --platform linux --arch x64 --no-node
node tools/build-setup-exe.mjs
node tools/release-keygen.mjs --out .tmp/release-verify/keys --force
powershell -File tools/make-selfsigned-cert.ps1 -OutDir .tmp/release-verify/cert
powershell -File tools/sign-windows.ps1 -File dist\BridgeDeckSetup-0.3.0.exe -Pfx .tmp\release-verify\cert\BridgeDeck-selfsigned.pfx -Password 'BridgeDeck-SelfSigned-2026!' -NoTimestamp -AllowUntrusted
node tools/release.mjs --sign-ed25519 .tmp/release-verify/keys/release-private.pem
node tools/release-preflight.mjs --key .tmp/release-verify/keys/release-private.pem
powershell -File tools/verify-release.ps1 -Dist dist
```

> 注意：上述命令会写真实 `dist/`；要像本次一样“不影响生产 dist”，需先备份/移走 `dist/` 再执行并恢复。
> `.tmp/release-verify/` 不属于发布物，可随时删除。


## 7. 0.3.1 轻量扩展包（2026-11-26 追加）

发布扩展包改为 **WXT 打包产物**（`tools/build-extension-bundled.mjs`）：34 个文件、zip 401,428 B、
解压约 1.32 MB（对比源码树包 426 文件 / 3.63 MB），与参考实现的少文件分发形态一致。
重新签名后：`release-preflight` PREFLIGHT PASS、`verify-release.ps1` verify ok: 0.3.1 / 9 artifacts。
源码树包（`tools/build-extension.mjs`）保留用于 JS 基线 E2E 与逐文件审计。


> **2026-11-26 更正（按用户要求）**：不采用参考实现的“单包少文件”打包方式，扩展发布包恢复/维持
> 我们自己的源码树逐文件打包（`tools/build-extension.mjs`，426 文件 / zip ≈ 3.6 MB，
> `tools/verify-extension-package.mjs` 校验）；此前追加的轻量打包段落仅保留为历史记录，
> 不作为发布路径。
