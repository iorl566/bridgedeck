# 平台支持矩阵

最后更新：2026-11-27。版本：0.3.1。

## CLI / daemon

| 平台 | 发布物 | 自动验证 | 状态 |
| --- | --- | --- | --- |
| Windows x64 | `BridgeDeckSetup-*.exe`、`BridgeDeck-cli-*-win32-x64.zip` | CI 三平台单测 + Windows Edge E2E | 支持 |
| macOS arm64 | `BridgeDeck-cli-*-darwin-arm64.tar.gz` | CI 单测 + 打包 | 支持 |
| macOS x64 | `BridgeDeck-cli-*-darwin-x64.tar.gz` | CI 单测 + 打包 | 支持 |
| Linux x64 | `BridgeDeck-cli-*-linux-x64.tar.gz` | CI 单测 + 打包 | 支持 |
| Linux arm64 | `BridgeDeck-cli-*-linux-arm64.tar.gz` | CI 单测 + 打包 | 支持 |

说明：

- CLI/daemon 是 Node 零依赖实现，路径使用 `os.homedir()` / `BB_HOME`，没有 Windows 专有运行时依赖。
- Windows 有图形安装器；macOS/Linux 使用 tar.gz 内的 `install.sh`，默认装到用户目录。
- macOS `.pkg` 由 `tools/build-macos-pkg.sh` 生成，可选，不是每次 release 必带。
- CI 的浏览器 E2E 只在 Windows + Edge 跑；macOS/Linux 目前只跑单测与打包，不跑真实浏览器 E2E。

## 扩展

| 浏览器 | 加载方式 | 自动验证 | 状态 |
| --- | --- | --- | --- |
| Microsoft Edge | Edge 加载项商店 / 开发者模式 | Windows Edge E2E | 支持 |
| Google Chrome | 开发者模式加载 `extension/` 或 Chrome for Testing | **Windows Chrome 157 E2E 145/147** | 支持（E2E 通过） |
| Edge / Chrome on macOS | 同上 | 无 | 兼容，未自动验证 |
| Edge / Chrome on Linux | 同上 | 无 | 兼容，未自动验证 |

### Chrome 注意

- Chrome Web Store **暂未上架**，Chrome 用户需在 `chrome://extensions` 开发者模式加载，或使用 Chrome for Testing。
- Chrome 137+ 稳定版忽略 `--load-extension`；E2E 改用 **CDP pipe 的 `Extensions.loadUnpacked`** 自动加载扩展，需要 `--enable-unsafe-extension-debugging`。
- Windows Chrome 157 已完成真实浏览器 E2E：145/147 通过（2 项按借用确认策略跳过）。
- 扩展使用标准 MV3 API（`chrome.tabs`/`scripting`/`debugger`/`tabCapture`/`offscreen`/`tabGroups`/`notifications`），没有 Edge 专有 API。

## E2E 浏览器发现

`node tools/e2e.mjs --browser edge|chrome` 现在按平台查找：

- Windows：Program Files / Program Files (x86)
- macOS：`/Applications/*.app/Contents/MacOS/*`
- Linux：`which google-chrome` / `chromium` / `microsoft-edge` 及常见固定路径

浏览器未安装时会直接报“找不到浏览器”，不再硬编码 Windows 路径。

## 结论

- **Windows + Edge：完整支持**（安装器、商店扩展、真实浏览器 E2E）。
- **Windows + Chrome：功能与 E2E 支持**；缺 Chrome Web Store 上架，用户需开发者模式加载。
- **macOS / Linux + Edge/Chrome：CLI、daemon、扩展代码层面支持**，但没有和 Windows 等价的浏览器端自动验收。
- **Chrome Web Store 上架**是当前最大发布缺口，不是代码兼容缺口。
