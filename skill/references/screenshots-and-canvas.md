# 截图与 Canvas

```sh
bridge screenshot --out shot.png --session <id>
bridge screenshot --mode auto --out full.png --session <id>
bridge screenshot --mode auto --scope viewport --out view.png --session <id>
bridge screenshot --selector '#chart' --out chart.png --session <id>
bridge screenshot --annotate --out marked.png --session <id>
bridge click --capture <capture_id> --image-x 320 --image-y 240 --session <id>
```

- 截图写到本机 `--out`，返回宽高与字节数；必须看图再解释，不要凭文件名猜内容。
- `--mode visible`（默认）当前视口；`auto` 滚动拼整页（最多 8 帧 / 16000px）；`manual` 每次前进一屏拍一帧。
- `--scope viewport` 强制只截可视区（即使带 `auto`）；`--scope document` 是默认整页行为。
- `--ref`/`--selector` 截元素，元素必须在当前视口内，否则 `E_NOT_FOUND`；元素截图不能与整页模式混用。
- 整页模式会滚动页面并在结束后恢复位置；长页面 8 帧封顶，超出范围要如实说明“不是全量”。
- 长截图：`bridge screenshot --mode manual --out` 逐帧拍（滚动后重复），最后 `bridge screenshot --mode manual --stitch --out full.png` 拼接；也可用 `bridge ui --page longshot` 打开快捷功能页。
- 背景标签页也能截（不抢焦点）；导航、失去控制或 debugger 重连会中断采集。

## 标注与视觉点击

- `--annotate` 在可视区截图上给主文档可点击元素画框和 `@eN`，返回 `capture_id` 与 `visual_refs`（含 `image_x/image_y`）。
- 视觉点击必须用**图片原始像素坐标**：`bridge click --capture <capture_id> --image-x X --image-y Y`，CLI 按滚动与缩放换算成页面坐标（优先 CDP 可信点击，失败退回页面内 click-point）。
- **视觉拖拽**用同一套坐标：`bridge drag --capture <id> --image-x X --image-y Y --image-dx N --image-dy N`。起点是图片像素，位移也是图片像素；扩展换算后**强制走 CDP 原生输入**（不回退页面合成事件——canvas 类控件不吃合成事件）。
- 典型场景：滑块/拼图验证码、自绘画布。先 `screenshot --annotate` 拿到 `capture_id`，看图确定起点与位移，再一次性拖。
- capture 绑定 tab，保留 10 分钟、最多 20 个；过期或不存在回 `E_CAPTURE_STALE`，重新截图。
- 坐标只对那张图有效；页面滚动、换分辨率或重新截图后不要复用旧 capture。

## Canvas 与"看图取坐标"

**桥不做图像识别，也不接视觉模型——看图、判断目标在哪，由你（agent）自己完成。** 桥负责把画面截清楚、把坐标换算准、把动作校验住。

```sh
bridge visuals --session <id>                       # 列出视觉候选：canvas / 图片 / 自绘区域（带页面坐标）
bridge screenshot --visual 2 --out crop.png --session <id>   # 只拍该候选，自动放大，坐标变成"相对这张图"
bridge visual-drag  --visual 2 --image-x 300 --image-y 100 --image-dx 60 --session <id>
bridge visual-click --visual 2 --image-x 300 --image-y 100 --session <id>
```

- `visuals` 的序号只在当前文档有效；页面一变就重新扫。
- `--visual` capture 的坐标是**区域相对**的（0..宽/高），桥按 `region.x + x/图宽*区域宽` 归一化回页面坐标。
- `visual-drag` / `visual-click` 是一步式：截区域 → 派发 → 命中校验 → capture 即弃；`--out` 顺手存区域预览，方便事后核对。
- **多点/多把手用 `visual-gesture`**：`--visual N --points "x,y;x,y"` 依次点；或 `--plan gesture.json` 混合点击/拖拽/等待（拖拽步支持 `hold` 长按、`duration` 时长、`steps` 插值）。Point 选类验证码、双滑块类要两个手柄时用它；PowerShell 5.1 下内联 JSON 会丢引号，用文件。
- 命中校验会拦"落点没元素 / 落在 html、body / pointer-events:none / inert / 被铺满视口的东西遮住"，并要求落点属于该候选（否则 `E_TARGET_MISMATCH`）。校验不可用时**拒绝盲发**。

辅助手段（都在桥里）：

```sh
bridge screenshot --grid --grid-step 25 --out g.png --session <id>      # 坐标网格，直接读数
bridge screenshot --profile x --out p.png --session <id>                # 一维差分剖面，找强边界
bridge screenshot --region 300,690,310,190 --region-scale 4 --out z.png --session <id>   # 区域放大
```

离线复盘用 `node tools/image-inspect.mjs`（crop/zoom/grid/profile/match，零依赖），不必连浏览器。

**不要假装有识别能力**：看不懂就放大再看、加网格读坐标，或者用 `request-help` 让人点。

## Canvas

- Canvas 内容读不到 DOM，只能截图看、按图坐标点，或用页面自己暴露的辅助元素操作。
- 先滚动到可见区域再截图；需要点击时优先生成带标注的截图，拿 `capture_id` 再点。
- 不要在 Canvas 截图失败时改页面或拼接截图绕过；截图可能包含用户隐私，只保存到用户指定位置。
