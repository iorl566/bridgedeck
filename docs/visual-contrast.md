# VOM 颜色对比度

`observe --vom` 返回的结构化节点现在带 WCAG 对比度，用于发现“文字看不清 / 低对比度按钮 / 深色模式失效”等问题。对标 BrowserSkill 0.5.0 的 `oklch/lab/color-mix` 对比度解析。

## 字段

每个 VOM 节点新增：

| 字段 | 说明 |
| --- | --- |
| `contrast` | 文字色对有效背景的 WCAG 对比度（1–21）；无法解析时为 `null` |
| `lowContrast` | 有文字/交互语义且 `contrast < 4.5`（WCAG AA 正文阈值）时为 `true` |

示例：

```json
{
  "id": "bad-contrast",
  "role": "paragraph",
  "name": "低对比度文字",
  "contrast": 2.85,
  "lowContrast": true
}
```

## 颜色空间

`getComputedStyle` 返回的任意 CSS 颜色（`rgb/rgba`、`hsl`、`oklch`、`lab`、`color-mix(...)`、`color(display-p3 ...)`）先写进 1×1 canvas，再用 `getImageData` 读回 sRGB 像素。这样不需要手写各颜色空间的转换矩阵，浏览器负责广色域映射。

- 文字色带 alpha 时先合成到背景上。
- 背景从元素向上逐层收集，按 alpha 从底到顶合成；默认底色为白。
- 缓存按颜色字符串去重，VOM 几百个节点也不会重复解析同一颜色。

## 范围与限制

- 只在 `observe --vom` 的结构化节点里计算；普通 `observe` 文本树不增加开销。
- `lowContrast` 只对“有名字/文本或交互语义”的节点置位，避免容器节点刷屏。
- 对比度使用 WCAG 2.x 公式（sRGB 相对亮度），不区分大字号/图形（可用 `contrast < 3` 自行判断）。
- 背景图、渐变、canvas 绘制的内容无法从 `background-color` 还原，仍以纯色背景近似。
- `oklch/lab/color-mix` 的最终值取决于浏览器版本与显示器色彩配置；同一页面在不同环境可能有细微差异。
