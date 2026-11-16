# 视觉定位接口：按图片坐标拖拽

> 2026-11-16 新增。补上了"看图 → 报坐标 → 动手"这条链路的最后一环：此前 `click` 已支持按截图坐标点击，但拖拽只能按元素（ref/selector）起点，canvas 类控件与验证码滑块根本用不上。

## 1. 用法

```powershell
# 1) 先截一张带标注的图，拿 capture_id
bridge screenshot --annotate --out shot.png --session <sid>       # → capture_id

# 2) 直接用图片像素坐标拖：起点 (image-x, image-y)，位移 (image-dx, image-dy)
bridge drag --capture <capture_id> --image-x 318 --image-y 157 --image-dx 200 --image-dy 0 `
  --duration 800ms --session <sid>
```

- 起点和位移**都用图片像素**，和 `click --capture --image-x/--image-y` 同一套坐标，模型只需"看图 → 报坐标"。
- 换算集中在 `resolveCapturePoint`（`extension/src/screenshot.js`）：`page = capture.scroll + image / capture.scale`，click 与 drag 共用，不会出现两套口径。
- 视觉拖拽**强制走 CDP 原生输入**，不回退页面内合成事件——canvas 类控件不吃合成事件（见 [第三层实测](ANTI-BOT-LAYER3-BENCH.md) 第 6 节：JS teleport 位移 200px、页面零反馈）。

## 2. 实测（Edge 157 + 0.1.3）

在 SpiderDemo 的「滑动拼图」上跑通一次完整链路：

```
capture_id          46f817f8-7744-4d02-ad1d-a48bcd2595d5
滑块页面坐标          (318, 531)
window.scrollY       374
换算后的图片坐标      (318, 157)          ← 318, 531-374
drag 返回            { ok: true, trusted: true, from: {318,531}, to: {518,531} }
页面反馈              "验证失败，请重试"    ← 手势被受理并判定，不是被忽略
```

最后一行是关键：页面**给出了判定**，说明这次拖拽是被当成真实指针流处理的。位置错是必然的（我们没算缺口），但"接口通不通"这个问题有了答案。

## 3. 边界

- **桥不做图像识别**。它只负责"把图片坐标换算成页面坐标 + 用原生输入执行"；看哪、往哪拖，仍然由调用方（模型或人）决定。想加视觉，只需在调用前算出 `image-x/image-y/image-dx`。
- 实测边界很具体：拼图页 1x 区域截图（310×190）**看不清 40px 的拼图块**，`--region-scale 4` 放大到 1240×760 后画面清楚了，但"缺口在哪一列"仍然要靠判断——这正是需要视觉模型（或 CV 脚本）的那一步，桥不替你猜。
- `capture` 绑 tab、保留 10 分钟、最多 20 个；过期回 `E_CAPTURE_STALE`（当前经 dispatch 包装后表现为 `E_INTERNAL` + 明确文案，与 `click` 一致）。滚动、换分辨率、重新截图后不要复用旧 capture。
- 位移为 0 会被拒（`E_BAD_ARG`）——没有位移的"拖拽"没有意义。

## 4. 让"看图"更准：坐标网格与差分剖面

光有坐标通道还不够——看图的人（模型）也得能读准位置。两个辅助开关：

```powershell
# 叠加坐标网格（红=竖直刻度、蓝=水平刻度，每 2 格标一次数值），同时返回 capture_id
bridge screenshot --grid --grid-step 50 --out grid.png --session <sid>

# 顺带返回一维差分剖面：沿 x 或 y 的相邻像素亮度差累计，给出"哪里变化最剧烈"
bridge screenshot --profile x --out p.png --session <sid>

# 区域截图可以放大：看清 40px 的拼图块、10px 的字
bridge screenshot --region 300,690,310,190 --region-scale 4 --out zoom.png --session <sid>
```

`--profile` 的返回结构：

```json
{ "capture_id": "...", "profile": { "axis": "x", "width": 921, "height": 872,
  "peaks": [ { "pos": 412, "score": 18.7 }, { "pos": 96, "score": 11.2 } ] } }
```

- `peaks` 是**峰值位置与强度**，不解释"那是什么"。用它找边界/接缝/缺口是调用方的事，桥只提供测量。
- 两个开关都会注册 `capture_id`，可以直接接 `click --capture` / `drag --capture`。

> 边界说明：网格和剖面都是**测量工具**，不是识别器。桥不判断"这里是缺口""这是飞机"，也不内置任何验证码解法——那部分仍然由调用方（模型或人）看图决定。

实测（SpiderDemo 滑动拼图，921×872 视口）：

```json
{ "capture_id": "b66d7bcd-086f-46e2-bd9f-e276fa50b6dd", "width": 921, "height": 872,
  "profile": { "axis": "x", "peaks": [
    {"pos": 906, "score": 128.87}, {"pos": 20, "score": 119.89}, {"pos": 886, "score": 118.97},
    {"pos": 303, "score": 35.15}, ...] } }
```

- `pos 20 / 886 / 906` 是页面内容边缘（卡片左右边界），`pos 303` 正好是拼图图片的左边缘——和网格图上读到的 x≈303 一致，说明"剖面峰位"与"肉眼读数"能对上。
- 网格图 `.tmp-bench/grid-shot.png` 上，红/蓝刻度每 50px 一条、每 100px 标数，滑块中心可直接读成 (318, 531)。
- 放大验证：拼图区域 `--region 300,690,310,190 --region-scale 4` 得到 1240×760 的清晰图（`.tmp-bench/loop-zoom4.png`），40px 的拼图块清晰可辨；但"缺口在第几列"仍需视觉判断——这一层桥不替你做。

## 5. 命中校验与单次消费

派发前先问页面："这个坐标下面是什么？"（`verifyVisualHit` → page-lib `hit-at`）。

```
BridgeDeck 实测（滑动拼图）：
  image (318,157) → page (318,531)
  正常坐标 → hit: { tag: "div", id: "sliderMoveBtn", cls: "slider-move-btn" }
  超界坐标 (5000,5374) → E_NOT_ACTIONABLE: 坐标 (5000,5374) 下面没有元素
```

拦的五类：落点无元素、落在 `html/body`、`pointer-events:none`、`inert` 子树、被铺满视口（>80%）的元素遮住（后者报 `E_OBSCURED`）。命中简报会带进结果和错误里。

**它拒绝盲发**：命中校验本身不可用（页面能力库缺失）时直接报 `E_INTERNAL`，而不是"降级直接派发"——坐标是外部给的，没有校验就派发等于赌。

**capture 单次消费**：同一张图只能派生一次动作。第二次用同一 `capture_id` 会被拒（实测返回"capture 不存在或已过期"），因为失败往往意味着页面已经变了，重新截图比复用旧坐标安全。

## 6. 视觉候选：让坐标有"对象"

坐标不绑对象时，只能问"这里能不能点"；绑上候选之后才能问"点的是不是它"。

```powershell
# 1) 列出当前视口的视觉候选（canvas / 图片 / 自绘背景区域）
bridge visuals --session <sid>
#   视觉候选 3 个（页面坐标）：
#     v1  <svg>  vector  578,563 25x25
#     v2  <div#captchaImage>.captcha-image  region  303,327 300x184
#     v3  <div#slider>.slider  region  303,327 300x80

# 2) 只拍这个候选（自动放大），坐标变成"相对这张图"
bridge screenshot --visual 2 --out crop.png --session <sid>
#   capture_id: 33ad2cf8-…
#   区域 capture：候选 v2 <div#captchaImage>，图片 600x368（坐标相对该图，0..宽/高）

# 3) 用区域坐标派发；命中校验会顺带确认"落点属于 v2"
bridge drag --capture 33ad2cf8-… --image-x 300 --image-y 100 --image-dx 60 --image-dy 0 --session <sid>
#   { ok: true, trusted: true, from: {x:453,y:377}, to: {x:513,y:377},
#     hit: { tag:"div", id:"slider", cls:"slider" } }
```

坐标换算是**归一化**的：`page = region.x + imageX / imageWidth * region.width`。实测 300→453、100→377，与 `#captchaImage` 的 303,327 / 300x184 对得上。

`hit.matches` 的判定是"落点 === 候选 或 落在候选子树/祖先链上"——这次落点 `#slider` 恰好是 `#captchaImage` 的子元素，所以判为命中；不是候选就会报 `E_TARGET_MISMATCH`。

### 一步式：不用在两条命令之间传 capture_id

```powershell
bridge visuals --session <sid>                                   # 先看有哪些候选
bridge visual-drag  --visual 2 --image-x 300 --image-y 100 --image-dx 60 --out preview.png --session <sid>
bridge visual-click --visual 2 --image-x 300 --image-y 100 --session <sid>
```

内部按顺序做：截候选区域 → 用区域坐标派发 → 命中校验（自动带候选序号）→ capture 一次用完即弃。`--out` 会顺手保存区域预览图，方便事后核对。

实测输出：

```
区域拖拽完成：候选 v2 从 453,377 到 513,377，命中 <div#slider>
区域预览：D:\浏览器桥\.tmp-bench\vd-preview.png
```

> 为什么不做成 recipe：配方不支持"上一步结果喂给下一步"（`capture_id` 是动态的），把这条链路压成一条命令比拆成配方步骤更贴合实际用法。

### 多段手势：点选与多把手

单次拖拽覆盖不了两类控件：**点选类**（要按顺序点若干位置）和**多把手类**（双滑块要依次拖两个手柄）。用 `visual-gesture`：

```powershell
# 简写：对候选 v2 依次点两个点
bridge visual-gesture --visual 2 --points "70,70;140,90" --session <id>

# 计划文件：可混合点击 / 拖拽（含长按）/ 等待
bridge visual-gesture --plan gesture.json --session <id>
```

```json
{
  "steps": [
    { "type": "click", "visual": 2, "x": 70, "y": 70 },
    { "type": "wait", "ms": 300 },
    { "type": "drag", "visual": 2, "x": 70, "y": 70, "dx": 40, "hold": "800ms", "duration": "600ms", "steps": 20 },
    { "type": "drag", "visual": 3, "x": 70, "y": 70, "dx": -30 }
  ]
}
```

- 每一步的 `x/y/dx/dy` 都是**该候选区域图内**的像素坐标，桥逐步重新截图（单次消费规则不变：一张图只派发一次动作）。
- `hold` 是按下后停顿（长按类控件需要），`duration` 是整段拖拽时长，`steps` 是插值点数。
- 最多 12 步；步间默认留 120ms，可用 `gap` 调整。
- PowerShell 5.1 传内联 JSON 会被吃掉引号，**建议用 `--plan` 文件**。

实测（点击拼图，4 个 `.piece` 候选）：`--points "70,70;70,70"` 两步都命中 `div.piece`；混合计划（点击 → 等待 → 长按拖拽 → 反向拖拽）全部返回 `ok`。

## 7. 涉及改动

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 协议 schema | `lib/schemas.mjs` | `drag` 增加 `capture/imageX/imageY/imageDx/imageDy`；`screenshot` 增加 `grid/gridStep/profile/scale` |
| 生成物 | `extension/src/generated/protocol.js` | `node tools/gen-protocol.mjs` 重新生成（`--check` 通过） |
| 扩展 | `extension/src/screenshot.js` | `resolveCapturePoint`（click/drag 共用）、`consumeCapture`（单次消费）、`verifyVisualHit`（派发前命中校验）、`gridShot`、`profileShot`；annotate/grid/profile 都会注册 capture |
| 扩展 | `extension/injected/page-lib.js` | 新增 `hitAt` 与 `handle` 的 `hit-at` 分支（LIB_VERSION 36，`inject.js` 同步） |
| 扩展 | `extension/src/tools/interaction.js` | `withImageDrag` + `trustedDrag` 支持预换算起点（`fromPoint`） |
| CLI | `cli/bridge.mjs` | 视觉拖拽参数、`--grid/--grid-step/--profile/--region-scale/--visual`、`visuals` / `visual-drag` / `visual-click` 组合命令、帮助文本、JSON 结果里透出 `profile`/`visual` |
| 文档 | `docs/PROTOCOL.md`、`skill/references/screenshots-and-canvas.md`、`cli/embedded-skill.mjs` | 协议行、技能内说明 |
| 测试 | `tests/unit/vision-drag.test.mjs` | 5 条静态护栏（拖拽 schema / 生成物 / 换算集中 / CLI 参数 / 网格与剖面接入） |

## 8. 回归

```powershell
node tools/gen-protocol.mjs --check
node --test tests/unit/vision-drag.test.mjs
node tests/extension/module-load.mjs
```
