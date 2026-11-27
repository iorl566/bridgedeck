# 依赖与 vendored 组件

从 Phase D 起允许打破“零依赖/纯 JS”约束；依赖必须 **vendored 到仓库**，不依赖运行时 npm 安装。

## QuickJS（`bridge exec --sandbox quickjs`）

| 组件 | 版本 | 位置 | 许可 |
| --- | --- | --- | --- |
| `quickjs-emscripten-core` | 0.32.0 | `vendor/quickjs/core` | MIT |
| `@jitl/quickjs-wasmfile-release-asyncify` | 0.32.0 | `vendor/quickjs/async` | MIT |
| `@jitl/quickjs-ffi-types` | 0.32.0 | `vendor/quickjs/ffi-types` + `vendor/quickjs/node_modules` | MIT |

- 运行时：QuickJS WASM/ASYNCIFY，内存上限 64 MB，栈 512 KB，有超时中断。
- 脚本没有 Node 的 `require/process/fetch/fs`；`page` 方法通过 asyncify host 调用桥接到 CLI。
- **QuickJS 的 page/locator 是同步 API**（host 调用阻塞返回），脚本里不要写 `await`/`async function`；
  需要 `await`/Playwright 风格时用默认 Node `vm`。两边 surface 由 `lib/exec-page.mjs` 统一生成，单测防漂移。
- 失败以结构化对象跨边界（`code`/`message`/`data`），脚本可 `catch` 到 `e.code`，CLI 保留原错误码。
- 已知版本边界：该 vendored asyncify 构建在“async 用户脚本 + 手写 promise 轮询”驱动下，连续 2-3 次
  host 调用会触发 QuickJS refcount 断言（wasm abort）。因此 CLI 统一用同步契约 + 直接 dump 结果；
  回归见单测 `exec-quickjs.test.mjs`（25 次连续调用、同进程多次运行）。
- `bridge exec` 默认仍是 Node `vm`（await 风格、兼容 locator）；QuickJS 需显式 `--sandbox quickjs`。
- 不是完整的浏览器官方沙箱；安全边界仍以页面/CLI 权限为准。

## 未引入

- fMP4 muxer（mp4box/ffmpeg WASM）尚未 vendored；视频仍是 MediaRecorder 分片 + verify。
- 浏览器安装包不进入仓库。

## 约束

- 新增 vendored 依赖必须记录版本、许可、来源和 E2E/单测覆盖。
- 不得在运行时下载依赖；发布包必须包含 `vendor/` 所需文件。
