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
- capture 绑定 tab，保留 10 分钟、最多 20 个；过期或不存在回 `E_CAPTURE_STALE`，重新截图。
- 坐标只对那张图有效；页面滚动、换分辨率或重新截图后不要复用旧 capture。

## Canvas

- Canvas 内容读不到 DOM，只能截图看、按图坐标点，或用页面自己暴露的辅助元素操作。
- 先滚动到可见区域再截图；需要点击时优先生成带标注的截图，拿 `capture_id` 再点。
- 不要在 Canvas 截图失败时改页面或拼接截图绕过；截图可能包含用户隐私，只保存到用户指定位置。
