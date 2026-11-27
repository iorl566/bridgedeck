# Refactor Playbook（BridgeDeck 内部）

目标：把大模块拆小，但不把仓库拆坏。下面流程来自本仓库的真实事故与修复。

## 1. 先守卫，再动手

每次重构前：

```powershell
node tools/source-guard.mjs
node --test "tests/unit/*.test.mjs"
node tools/e2e.mjs
```

- `source-guard` 检查语法与占位符；
- 单测/真实 E2E 是“拆之前”的基线；
- 没有基线，不拆大文件。

## 2. 小步、可回滚

- 一次只拆一个**内聚块**（一个 map + 几个函数）；
- 拆之前保留一份可恢复副本（发布 zip 或临时备份）；
- 先写新模块，再改 import，再删旧块；
- 每步跑 `node --check` + `source-guard`；
- 失败立刻回退，不在坏文件上继续叠加。

## 3. 依赖方向

```text
lib/*      纯函数，不依赖 tools/bridge/dispatch
refs/*     身份/解析，不依赖 UI
tools/*    领域逻辑，可依赖 lib/refs
bridge/dispatch 只做组合
```

- 新模块不能引入循环依赖；
- `architecture-guards.test.mjs` 会失败；
- 不能从 `lib/*` 反向 import `tools/*`。

## 4. 拆什么、不拆什么

优先拆：

- 纯状态/映射（attribution、controlled tabs、human decisions）；
- 消息处理（record events、record ports）；
- 纯数据构建（vom payload、visual objects）。

不要硬拆：

- 与 Chrome 生命周期强耦合、且被多个函数共享的 borrow 主体；
- 大 switch/路由，除非能先抽纯函数；
- 生成文件（protocol）与 ChromiumCdp 例外，改它们必须加测试。

## 5. 测试契约

- 新模块必须有单测；
- 领域行为变化必须补 E2E；
- 发布前 `release-preflight` 会跑架构/性能/故障/契约；
- skip 不算 pass。

## 6. 事故复盘：tabs 拆分

发生过两次：

1. 用字符串替换抽取 `selfCreated` 时把 `tabs.js` 写成 `utf8`；
2. 抽取 borrow UI 时切到了 `requestHelp` 中间，造成语法错误。

修复方式：

- 从已发布 0.3.0 zip 恢复 `tabs.js`；
- 回退未完成拆分；
- 新增 `source-guard`，把语法/占位符变成发布 blocker。

教训：

- 不要用大段字符串替换切大文件；
- 用明确函数边界/行号，先复制、后删除；
- 每步验证，失败就回滚；
- 不要为了“拆完”而留下坏代码。

## 7. 学习成熟经验（吸收为自己的）

- 契约优先：method catalog / receipt / error effect 先行；
- 接缝提取：先抽纯函数，再抽模块；
- 绞杀者模式：新模块接管一小块，旧调用方逐步迁移；
- 测试金字塔：纯函数单测 → 领域集成 → 真实浏览器 E2E；
- 失败关闭：不确定就 `unknown`，不静默 committed；
- 可观测：Action Receipt + boundary + evidence；
- 小批次、可回滚、可验证。

## 8. 每次拆分后的固定检查

```powershell
node --check <new-file>
node tools/source-guard.mjs
node --test "tests/unit/*.test.mjs"
node --test "tests/reference/*.test.mjs"
node tools/e2e.mjs
node tools/eval-from-e2e.mjs
node tools/check-vendor-leak.mjs
node tools/release-preflight.mjs
```

## 9. 本轮实录（2026-11-18 质量批次）

- `tabs` borrow/help：
  - 先写 `tabs-borrow.js`（复制业务函数，不改逻辑），再按行号截断 `tabs.js`
    （保留 window/tab 主体），最后改 `dispatch.js` / `bridge.js` 的 import；
  - 借用 UI 只保留 `borrow-ui.js` 一份，删除 `tabs.js` 内重复 rehome/注入；
  - `borrow-ui-source.test.mjs` 立即改成断言新模块，并断言旧文件不再重复实现。
- RTL：
  - 扩展页 CSP 禁止内联脚本 → 用同步外部脚本 `ui/direction.js` 在样式前定方向；
  - CSS 只改逻辑属性，方向性图标用 `[dir="rtl"]` 镜像；
  - 用真实 Chromium `tests/browser/rtl-dom.*` 断言几何和 transform，不靠肉眼。
- cooperation stale：
  - 先补内容脚本真实 DOM 的 stale generation 断言；
  - 再做后台“generation 落后 → 抬到内容权威代 +1 重试”，失败 `E_COOPERATION_STALE`；
  - 新错误码必须同时改 `lib/error-codes.mjs`、`extension/src/errors.js`，再跑
    `node tools/gen-error-codes.mjs`，否则文档/SDK/契约测试会失败。
- eval：
  - corpus 只收录能解析到 `PASS <id>` 的 E2E case；新 case 先跑 E2E 再登记，
    缺 case 会以 `unverified` 失败，不能算通过。
- observation / chromium-cdp 拆纯工具：
  - 用一次性脚本按**行号**切除并先断言首尾行内容，再写回文件；切完立即
    `node --check` + `source-guard` + 目标单测；
  - 被拆出的函数必须 `export`，主文件 import；新增纯函数单测（缓冲游标/截断/等待预算）；
  - 注意别把主文件仍在用的“纯函数调用点”一起切掉：先 `grep` 调用点，再切定义。
- 长截图恢复：
  - IndexedDB 是异步 IO，headless `--dump-dom` 不会等它完成，IndexedDB 行为不要写成
    浏览器 unit case；用真实 E2E 页面（`?selftest=restore`）验证落盘 → manifest → 重拼；
  - 拼接几何抽成 `planStitch` 纯函数做单测，浏览器里只做 IO 和画布。
- ChromiumCdp 拆 mixin：
  - class 方法不可枚举，`Object.assign` 会静默失败；用 `Object.getOwnPropertyDescriptor`
    逐个复制到原型；
  - 每个域一个 `class CdpXxxMethods` 文件，main 里 `applyMixin(ChromiumCdp.prototype, ...)`；
  - 拆块用行号 + 首尾断言，抽完立即跑该域的单测（frames/dialogs/console/network）。
- OOPIF 矩阵：
  - Chromium 没有 `getBoxQuads`；用 computed `transform` 矩阵 + 临时清空自身 transform
    取回未变换 rect，重建四角（rotate/skew/scale/translate）；
  - page-lib 检测到 transform 时返回 null，让 CDP owner 链接管，避免两套数学；
  - 同源/跨源各一个 E2E，断言真实按钮点击而非只断言 via。
- 视频恢复：
  - 不要靠 `offscreen.closeDocument()` 模拟崩溃（会触发 onstop 清分片）；
  - 用页面里的真实 MediaRecorder 生成分片写入 `bb-videos/chunks`，再跑 `video recover`，
    既确定又覆盖真实编码数据。
- capture suppression / 2D 分块（第一梯队轮）：
  - 浮层隐藏不再用固定 80ms，改为页面内 `requestAnimationFrame` ×2 确认后返回，
    ref-counted 计数不变；截图 E2E 覆盖；
  - 超长/超宽用同一套 8000px 2D 网格：`Page.captureScreenshot` 的 clip 分块，
    OffscreenCanvas 按 (x,y) 拼接；返回值必须有 `tiled`，并同步 CLI JSON summary；
  - E2E 同时断言 PNG 头尺寸与 `tiled`，防止“图对了但调用方看不到分块”。
- VOM visualObjects：
  - 视觉 ref 的 stableRef 必须在 `buildRefDetails` 之后回填；让视觉对象与 DOM ref 共用同一条
    registry 路径，才能直接 `click --stable-ref`；
  - E2E 同时断言 `visualObjects` 结构、`vom.visual.stableRef` 和一次真实点击。
- cooperation frameState：
  - E2E 要制造真实 mutation + scroll 再 sync，断言计数器与 revision 同时推进；
  - 只断言 revision 会漏掉“计数没接上”的回归。
- 新语言包：
  - 按 `translation/worklist.json` + `missing-worklist.json` 的键序生成
    `translation/<lang>.json` / `missing-<lang>.json`；技术 token（`$1`/`--browser`/`wss://`）
    原样保留，`translation-quality` 会逐条卡；
  - `SUPPORTED_LANGS`、`options.html`、三处测试清单（locale-pack/overlay-locales/translation-quality）
    必须同时更新。
- 3D / 超长 capture（2026-11-18 加深轮）：
  - matrix3d 无 perspective 时，DOMMatrixReadOnly 的 a/b/c/d/e/f 就够 2D 投影，
    E2E 直接用 `rotateY+rotateX+scale` 验证点击；带 perspective 再另做；
  - 单次 CDP 整页截图有高度上限：>12000px 改 8000px 分块 + OffscreenCanvas 拼接，
    E2E 用 20000px 夹具断言 `height/tiles/PNG 头`；
  - **新增结果字段必须同步 CLI JSON summary**：`tiled` 第一次没加进
    `cli/bridge.mjs` 的 screenshot summary，E2E 读到 undefined。
- AX 兜底：`observeAxFallback` 是纯组合（hide/show takeover + AX + facts），
  放进 `observation-ax.js` 后 observation 654 → 563，AX 测试仍全绿。
