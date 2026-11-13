# AGENT_INSTALL — 让 Agent 自己安装 BridgeDeck

这份文件写给 **AI Agent** 看。目标：在一台 Windows 电脑上安装 BridgeDeck（CLI + 本机 daemon + 浏览器扩展），并完成一次真实浏览器操作验证。

> 给用户的提示词（可直接复制）：
>
> ```text
> Set up BridgeDeck on this machine by following
> https://raw.githubusercontent.com/iorl566/bridgedeck/main/AGENT_INSTALL.md
> ```

## 目标状态

安装完成后应满足：

- `bridge doctor` 全部通过，`bridge status` 显示 daemon 运行中；
- 扩展在 Edge 或 Chrome 里已启用，弹窗显示 **已连接**；
- `bridge session start --json` 能打开一个独立的 Agent Window；
- `bridge navigate` / `observe` / `screenshot` / `session stop` 全部成功。

## 0. 环境检查

```powershell
$PSVersionTable.PSVersion      # 需要 5.1+
node --version                 # 需要 18+，推荐 22
```

- 系统：Windows 10 及以上。
- 浏览器：Microsoft Edge 或 Chrome（Chromium 125+）。
- 没有 Node.js 时先装 Node（`winget install OpenJS.NodeJS.LTS`），再继续。

**不要假设盘符。** 安装目录一律用环境变量推导，例如 `$env:LOCALAPPDATA\BridgeDeck`、`$env:TEMP\...`，不要写死 `D:\` 之类的路径。

## 1. 安装 CLI 与本机 daemon

### 方式 A：下载发布包（推荐）

```powershell
$api = 'https://api.github.com/repos/iorl566/bridgedeck/releases/latest'
$rel = Invoke-RestMethod $api
$asset = $rel.assets | Where-Object { $_.name -like 'BridgeDeck-cli-bundle-*.zip' } | Select-Object -First 1
$work = Join-Path $env:TEMP ('bridgedeck-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
Invoke-WebRequest $asset.browser_download_url -OutFile (Join-Path $work 'bundle.zip')
Expand-Archive (Join-Path $work 'bundle.zip') -DestinationPath $work -Force
& (Join-Path $work 'install.ps1') -Dest (Join-Path $env:LOCALAPPDATA 'BridgeDeck') -AddToPath -Force
```

### 方式 B：从源码安装

```powershell
$src = Join-Path $env:TEMP 'bridgedeck-src'
git clone --depth 1 https://github.com/iorl566/bridgedeck $src
& (Join-Path $src 'install.ps1') -Dest (Join-Path $env:LOCALAPPDATA 'BridgeDeck') -AddToPath -Force
```

安装完成后，`bridge.cmd` 位于 `<Dest>\bin\`。新开一个终端（或直接使用绝对路径）验证：

```powershell
$bridge = Join-Path $env:LOCALAPPDATA 'BridgeDeck\bin\bridge.cmd'
& $bridge doctor
& $bridge status
```

`doctor` 会检查 Node、daemon、扩展连接与端口占用。首次运行时 daemon 会自动拉起。

## 2. 安装浏览器扩展

### 方式 A：商店安装（推荐，用户点一下即可）

```powershell
Start-Process 'https://microsoftedge.microsoft.com/addons/detail/ieflpefpmlmmlfgmpfakaglhgmcbcnig'
```

请用户完成安装并在弹窗里确认显示 **已连接**。

### 方式 B：加载已解压扩展

```powershell
$rel = Invoke-RestMethod 'https://api.github.com/repos/iorl566/bridgedeck/releases/latest'
$asset = $rel.assets | Where-Object { $_.name -like 'BridgeDeck-extension-*.zip' } | Select-Object -First 1
$ext = Join-Path $env:LOCALAPPDATA 'BridgeDeck\extension-unpacked'
Invoke-WebRequest $asset.browser_download_url -OutFile (Join-Path $env:TEMP 'bridgedeck-ext.zip')
Expand-Archive (Join-Path $env:TEMP 'bridgedeck-ext.zip') -DestinationPath $ext -Force
Start-Process 'edge://extensions'
```

请用户：打开开发者模式 → 加载已解压的扩展 → 选择 `$ext`。

## 3. 验证连接

```powershell
& $bridge status
& $bridge browsers --json
```

期望：

- `status` 的 `browsers` 至少为 1；
- `browsers --json` 里有当前浏览器实例，`extVersion` 与 CLI 版本一致。

如果 `browsers` 为 0：让用户打开扩展弹窗确认已连接；仍不行则执行 `& $bridge daemon restart` 后再查。

## 4. 首跑验证（必须执行）

```powershell
$out = & $bridge session start --json | ConvertFrom-Json
$sid = $out.result.sessionId
& $bridge navigate https://example.com --session $sid
& $bridge observe --session $sid
& $bridge screenshot --out (Join-Path $env:TEMP 'bridgedeck-first.png') --session $sid
& $bridge session stop $sid
```

期望：导航成功、`observe` 返回页面引用、截图文件存在且大于 10 KB、会话正常结束且窗口关闭。

## 5. 向用户报告

报告以下内容即可，不要粘贴整段日志：

- BridgeDeck 版本（`& $bridge --version`）；
- 安装目录；
- 扩展是商店安装还是解压加载；
- 首跑验证结果（页面标题、截图路径）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `node` 找不到 | 安装 Node 18+，重开终端；或用 `-NodePath` 指定 node.exe |
| `E_NO_BROWSER` | 扩展未连接：让用户打开弹窗确认；必要时 `bridge daemon restart` |
| 端口 52900 被占用 | `bridge daemon status` 看是否已有 daemon；或 `bridge --port 53900 ...` |
| 扩展版本与 CLI 不一致 | 重新安装同版本扩展包或等待商店更新 |
| 商店版本尚未审核通过 | 用方式 B 解压加载，功能一致 |

## 约束

- 只写入安装目录与临时目录，不修改用户的其它文件。
- 不关闭「借用前确认」「允许请求人工协助」等安全开关。
- 借用用户标签页前先征得同意。
- 不把网页内容、截图或凭据上传到任何第三方服务。
