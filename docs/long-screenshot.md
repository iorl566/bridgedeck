# 长截图

长截图把页面从上到下分块截取，再拼接成一张 PNG。适合文档、商品详情、长列表和聊天记录。

## 自动整页

```powershell
node cli/bridge.mjs screenshot --mode auto --out page.png
node cli/bridge.mjs screenshot --mode auto --out page.png
```

自动模式会滚动页面、等待渲染、按重叠区域拼接。页面有固定头部/懒加载时，优先用自动模式。

## 可见区域

```powershell
node cli/bridge.mjs screenshot --scope viewport --out view.png
```

只截当前视口，不滚动。

## 手动拼接

页面无法自动滚动或需要逐屏检查时：

```powershell
node cli/bridge.mjs screenshot --mode manual --out frame.png --scope current
node cli/bridge.mjs screenshot --mode manual --stitch --out page.png
```

手动模式先截若干帧，再统一拼接；拼接前可以检查每帧是否完整。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--mode visible` | 当前可见区域 |
| `--mode auto` | 自动滚动整页 |
| `--mode manual` | 手动分帧 |
| `--scope viewport` | 视口截图 |
| `--scope document` | 文档截图 |
| `--scope follow` | 跟随滚动 |
| `--scope current` | 当前帧 |
| `--region x,y,w,h` | 像素区域 |
| `--overlap <px>` | 拼接重叠像素 |
| `--ref @eN` / `--selector css` | 只截元素 |
| `--annotate` | 标注可交互元素 |

## 结果

- 输出是标准 PNG，带尺寸校验。
- 图片只在本地生成与保存。
- 扩展弹窗的“长截图”面板提供自动/可见两种快捷入口；手动拼接在完整页。

## 限制

- 超高页面受浏览器画布/内存限制，可能被截断。
- 固定头尾、滚动动画、懒加载可能造成重复或缺失；可调 `--overlap` 或改用手动模式。
- 跨源 iframe 只截可见部分，不展开内部滚动。
