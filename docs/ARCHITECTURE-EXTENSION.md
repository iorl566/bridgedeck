# Extension Architecture & Extension Points

版本：0.3.0（质量批次期间不升号）

## 分层

```text
background/entry
  bridge.js       消息路由、record/control 接线
  dispatch.js     方法分发、receipt、revision fence
      │
tools/            领域动作
  observation.js  observe / layers / visual
  observation-ax.js AX 采集/租约/VOM backend
  observe-frames.js
  interaction.js  click/fill/...
  ops.js          record / network / video / debug
  tabs.js         tab/window 主体
  tabs-borrow.js  tab.borrow / tab.return 业务
      │
browser-driver/  CDP 驱动（ChromiumCdp + mixin 模块）
  chromium-cdp.js attachment/发送/事件/清理核心
  cdp-frames.js   frame 发现 / FrameGraph
  cdp-dialogs.js  原生对话框
  cdp-console.js  console 缓冲
  cdp-network.js  network 缓冲/元数据
  cdp-emulation.js Emulation
  cdp-sessions.js 会话占用/后台执行
  cdp-buffer-utils.js / cdp-timing.js 纯函数
      │
refs/             身份与解析
  ref-registry.js
  resolve-backend.js
cross-frame-geometry.js
      │
lib/              纯函数/契约
  action-receipt.js
  observation-cursor.js
  visual-objects.js
  ref-details.js
  receipt-methods.js
  layer-summary.js
      │
injected/page-lib.js  页面内快路径
```

## 依赖规则

1. `lib/*` 不 import `tools/*`、`bridge.js`、`dispatch.js`；
2. `tools/*` 可以 import `lib/*`、`refs/*`、`debugger`；
3. `bridge.js` / `dispatch.js` 是组合层，不能反向被 tools import；
4. `injected/page-lib.js` 必须自包含，不 import 扩展模块；
5. 循环依赖为 0（`architecture-guards.test.mjs`）。

## 扩展点

### VOM / 视觉

- `observe.layers` / `blockingLayers`：分层文档；
- `visualObjects`：region + ref 融合；
- `stableRef` / `refDetails`：稳定身份；
- `--stable-ref` 由 CLI `resolveTarget` 统一解析，schema 的 `TARGET_PROPS` 允许它驱动
  fill/select/read/hover/actionable 等目标动作；
- 新视觉事实加在 `lib/visual-objects.js` 或 `lib/ref-details.js`，不要塞回 `observation.js`。

### Ref / 跨帧

- `refs/ref-registry.js`：复合身份、revision/document 失效；
- `refs/resolve-backend.js`：selector → backendNodeId；
- `cross-frame-geometry.js`：OOPIF owner 链；
- `lib/frame-matrix.js`：owner 仿射投影（2D/无 perspective 的 matrix3d）；
- 新 frame 能力优先加在这些模块，动作层只调用。

### Cooperation

- `content/cooperation.js`：FrameState / authority / stale generation；
- `src/cooperation.js`：block/passthrough 消息；内容脚本回 `stale` 时把 generation
  抬到内容权威代 +1 重试，仍失败抛 `E_COOPERATION_STALE`（动作 fail-closed）；
- `control-generation.js`：generation/context，`raiseControlGeneration` 负责对齐；
- 新状态计数加在 FrameState，不要散落在 UI。

### Record / Capture

- `content/record-capture.js`：per-document Port、events；
- `ops.js`：coordinator、activation；
- `src/capture-persist.js`：长截图分片 → IndexedDB + `bb.capture.manifests`；
- `lib/capture-manifest.js`：索引（`upsertCaptureManifest` 去重/TTL/上限）；
- `lib/longshot-store.js`：分片存储（drawY/prune）；
- `screenshot.js`：宽/高 >12000px 的整页自动 CDP 2D 分块（8000px/块）拼接，`tiled` 返回块数；
- `overlay-suppress.js`：ref-counted 浮层隐藏 + 页面内 2 rAF ack（无固定 sleep）；
- 新持久化走 manifest/chunk，不把大 dataURL 塞索引。

### UI / 方向

- `overlay-ui.js`：浮层/呼吸框；
- `ui/panels/*`：面板；
- token 走 `overlay-theme.js` / `ui.css`；
- `ui/direction.js`：扩展页首帧方向（RTL 语言自动、`?dir=rtl|ltr` 覆盖）；
- 语言包：`ui/locales.js`（12 语言）+ `overlay-locales.js`（12×54）；
  新增语言必须同时更新 `translation/*.json`、`SUPPORTED_LANGS` 与三处测试清单；
- 新样式必须用逻辑属性（`inset-inline-*` / `margin-inline-*` / `text-align:start`），
  方向性图标用 `[dir="rtl"]` 镜像；浮层宿主同时接受 RTL 语言与页面 `dir`；
- 新 UI 不引入构建工具。

## 复杂度预算

- 非生成源文件 ≤ 1100 行；
- 超过 800 行的新增文件必须写 ADR 或拆分；
- `chromium-cdp.js`、`generated/protocol.js` 例外，但改动必须加测试；
- CDP 纯工具放 `browser-driver/cdp-buffer-utils.js` / `cdp-timing.js`，
  AX 采集放 `tools/observation-ax.js`，不要再塞回主文件。

## 质量门禁

```powershell
node --test "tests/unit/*.test.mjs"
node --test "tests/reference/*.test.mjs"
node tools/source-guard.mjs
$env:BB_E2E_SYNC_DOCS='0'; node tools/e2e.mjs
node tools/eval-from-e2e.mjs
node tools/check-vendor-leak.mjs
node tools/release-preflight.mjs
```

版本号只在批次完成后调整，不为单个修复升号。
