# 仓库发布规则（对齐 Tencent/BrowserSkill 的公开结构）

> 目的：GitHub 仓库只承载“能构建、能验证、能读文档”的源码与产品资料；商店运营、竞品对比、原始跑测数据属于内部资料，不随仓库发布。
> 参照：https://github.com/Tencent/BrowserSkill 的公开结构（apps / crates / packages / docs 产品文档 / evals / scripts / ci + README、CHANGELOG、install 脚本）。

## 放什么

| 类别 | 内容 |
| --- | --- |
| 源码 | `cli/`、`daemon/`、`lib/`、`mcp/`、`sdk/`、`skill/`、`extension/`、`apps/`、`packages/`、`translation/` |
| 测试 | `tests/`（unit / cli / extension / mcp / pairing / tls） |
| 构建与发布工具 | `tools/` 中参与构建、校验、签名、发版的部分（`build-*`、`release-*`、`verify-*`、`sign-*`） |
| 产品/技术文档 | `docs/` 下的架构、协议、平台、权限、安全、MCP、排障、签名等 |
| 发布说明 | `docs/releases/<version>.md` |
| 安装与 CI | `install*.sh|ps1`、`uninstall*.sh|ps1`、`AGENT_INSTALL.md`、`.github/workflows/` |
| 根目录 | `README.md`、`LICENSE`、`package.json`、`.gitignore` 等 |

## 不放什么

- 商店 listing 文案、截图、图标、提审备注（如 `docs/store-listing/`、`docs/assets/store/`、`docs/STORE-*.md`）；
- 竞品/对照实测与原始数据（如 `docs/comparison/`、`tools/compare/`、benchmark 日志与截图视频）；
- 内部性能基准记录（`docs/PERFORMANCE.md`、`tools/bench-perf.mjs` 的输出）；
- 日志、临时文件（`.tmp*`、`*.log`）、一次性脚本（`i18n.fixed.js` 之类）；
- 密钥、token、证书私钥、CI secret。

上述内部资料统一放仓库外的私有目录（当前：`D:\BridgeDeck-private\<日期>\`），需要时本地引用。

## 上传前自检

```powershell
git ls-files | Select-String -Pattern 'docs/comparison|docs/store-listing|docs/assets/store|\.log$|^\.tmp|i18n\.fixed'
# 应无输出
git status --porcelain   # 只应有预期内的源码/文档改动
```

发布包（zip）只由 `extension/` 与 CLI 源构建，`docs/` 不会进入任何制品：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::OpenRead("dist\BridgeDeck-extension-<ver>.zip")
$z.Entries | Where-Object FullName -match '^docs/|store-listing'   # 应为空
```

## 例外

- `docs/releases/` 保留（用户需要 release notes），但只写“改了什么/怎么验证”，不写内部商店操作步骤。
- `apps/extension/` 与 `extension/` 的取舍需要单独评审；在确认前不删除，避免误删构建源。
