# 浏览器矩阵

BridgeDeck 是 Chromium 扩展（MV3）+ CDP 驱动。这里记录“实际验证过”和“代码可识别/预期可用”的边界，
避免把未跑的浏览器写成已验证。

## 0. 本机探测

```powershell
node tools/browser-matrix.mjs
node tools/browser-matrix.mjs --json
```

2026-11-18 本机结果：**found edge, chrome**；**missing brave, vivaldi, opera, arc, helium**。
2026-11-19 补跑：**Chrome 190/190 真实 E2E 通过**。为此修了两处测试基建：
`20p` 不再硬编码 `--browser edge`；`tools/uia-click.ps1` 从只找 `msedge` 改为识别
`msedge/chrome/brave/vivaldi/opera/helium` 的进程。Edge/Chrome 现在都有真实结果，
其余浏览器仍缺安装。
`tools/e2e.mjs --browser brave|vivaldi|opera|arc|helium` 已预留路径，装好后可直接跑同一套用例。
便携版可显式指定 exe：`$env:BB_BROWSER_HELIUM='D:\path\helium.exe'; node tools/e2e.mjs --browser helium`。

国内 GitHub 镜像实测（2026-11-18）：ghfast.top 可用，单连接约 150 KB/s；8 段并行约 800 KB/s。已下载并解压 Helium 0.21.3.1（Chromium 157），--version 正常，但带新 profile/扩展启动时浏览器立即退出，扩展未连上 daemon；BB_E2E_ALLOW_LOAD_EXTENSION=1 也无效。已删除临时浏览器与 profile，**未做系统安装，Edge/Chrome 未改动**。

同日尝试下载 Helium 便携版做真实矩阵，GitHub 下载约 **9.4 MB / 10 分钟**，按此速度不可用；
改用国内镜像 `ghfast.top`（单连接 ~150 KB/s，8 段并行 ~800 KB/s）下载成功；Helium
0.21.3.1 `--version` 正常，但带新 profile/扩展启动时立即退出，扩展未连上，E2E 失败。
已删除临时浏览器与 profile。

国内站点排查（2026-11-19）：

| 站点 | 内容 | 结果 |
| --- | --- | --- |
| [腾讯软件 Opera](https://pc.qq.com/detail/14/detail_314.html) | 132 MB 安装包 | 页面只暴露 QQ 软件管家 stub，未取得直链 |
| [天极下载 Vivaldi](https://mydown.yesky.com/pcsoft/102517486.html) | 113.9 MB 安装包 | 页面未暴露可解析直链 |
| [52pojie Brave 便携版](https://www.52pojie.cn/forum.php?mod=viewthread&tid=2131185) | Brave Origin 便携版 | 百度网盘，需登录，不适合自动化 |
| [宽带技术网 Brave](https://www.chinadsl.net/forum.php?mod=viewthread&action=printable&tid=182235) | 安装/便携版 | 百度/夸克网盘，需登录 |
| [ChromiumPortable Helium](https://piracola.github.io/ChromiumPortable/helium/) | Helium 便携版 | 下载仍走 GitHub Release，已用 ghfast 镜像 |
| [Opera 官方 CDN](https://download3.operacdn.com/pub/opera/desktop/126.0.5750.59/win/Opera_126.0.5750.59_Setup.exe) | 125 MB 安装包 | 可下载且签名有效（Opera Norway AS），但 `--silent` 安装退出 116，进程残留，已清理 |
| [360 Opera](http://baoku.360.cn/qbfl/105288.html) | 117 MB | 需 360 软件管家 |

结论：国内站点有安装包/网盘资源，但要么需要登录网盘，要么是第三方管家 stub；
可自动化的 Opera 官方安装包在静默安装阶段失败。**未完成任何系统安装，Edge/Chrome 未被改动**。

## 1. 识别矩阵

扩展在 `hello` 里上报浏览器名与版本，识别逻辑在
[`browser-detect.js`](../extension/src/lib/browser-detect.js)：

| 浏览器 | UA / API 标记 | 名称 | 真实 E2E |
| --- | --- | --- | --- |
| Microsoft Edge | `Edg/` | `edge` | ✅ 本仓库全部 E2E |
| Google Chrome | `Chrome/` | `chrome` | ✅ 真实 E2E 190/190（2026-11-19） |
| Brave | `Brave/` 或 `navigator.brave` | `brave` | ⏳ 仅识别，未跑本机 E2E |
| Opera | `OPR/` | `opera` | ⏳ 仅识别 |
| Vivaldi | `Vivaldi/` | `vivaldi` | ⏳ 仅识别 |
| Arc | `Arc/` 或 brands | `arc` | ⏳ 仅识别 |
| Helium | `Helium/` | `helium` | ⏳ 便携版启动失败，未验证 |
| Chromium | `Chromium/` | `chromium` | ⏳ 仅识别 |

> 未安装的浏览器无法在本机做真实 E2E；识别矩阵是代码事实，能力声明以“已测试”列为准。

## 2. 选择浏览器

```powershell
bridge browsers
bridge status
bridge tab list --browser brave
bridge observe --browser opera
```

`--browser` 支持 `instanceId`、唯一 label、浏览器名前缀。多个实例同名会返回
`E_BROWSER_AMBIGUOUS`，不会“猜一个”。

## 3. 已知差异/边界

- MV3 扩展在 Brave/Opera/Vivaldi/Arc/Helium 上通常可直接加载；扩展 API 差异（如
  `tabGroups`、`chrome.debugger` 行为）需逐浏览器冒烟，当前只做了识别和文档。
- 企业策略可能禁用 `chrome.debugger`；失败会返回 `E_DEBUGGER_BUSY`/`E_FORBIDDEN`。
- 移动端/非 Chromium（Firefox/Safari）不在支持范围。

## 4. 下一个验收动作

1. 准备一台装有 Brave/Opera/Vivaldi/Arc/Helium 的机器；
2. 跑 `tools/e2e.mjs` 的同一套 177 条，至少覆盖 observe/click/fill/screenshot/tab group；
3. 把结果写入本表，未通过项记录差异（不要改“预期可用”冒充已验证）。
