# UI 截图对比：BridgeDeck vs 参考实现（2026-11-26，真实 Edge）

> 截图方式（本轮打通）：E2E 同款启动链——我们起临时 `BB_HOME` + daemon `--foreground` + 复制扩展并改写
> WS 探测端口；参考实现起临时 `BSK_HOME` + `bsk daemon start --foreground` + 复制扩展；两侧都用
> `browserArgs()`（含 `--load-extension` 与 `--remote-debugging-port=0`）拉起有头 Edge。等扩展真正连上
> （我们：daemon status 有 browsers；参考实现：`bsk browsers` 非空）后，从扩展 service worker 用
> `chrome.tabs.create(chrome.runtime.getURL(page))` 打开页面，再用页面级 CDP 截图。
> 工具：`tools/ui-shots-e2e.mjs`（已验证可重复出图）；旧的无 EXT 路线 `tools/ui-shots.mjs` 保留作参考。
> 截图原始文件：`docs/ui-shots/ours/*.png`、`docs/ui-shots/bsk/*.png`。

## 1. 弹出主面板

| 我们 | 参考实现 |
| --- | --- |
| ![ours popup](ui-shots/ours/popup.png) | ![bsk popup](ui-shots/bsk/popup.png) |

**视觉对比**

- **配色/气质**：我们蓝色主色（#2f6fed）+ 白底灰边，信息密度高；参考实现橙色主色 + 暖白/奶油底、
  更大的圆角与留白，品牌感更强。
- **层级**：两者都是“状态卡 → 连接设置 → 配对设备 → 控制提示 → 自动化设置 → 版本页脚”，结构几乎一致。
- **差异**：参考实现的“本机/远程”是**分段控件**（灰底选中），配对链接是输入框 + 实心橙色主按钮；
  我们同样有连接/端口/保存配对，但按钮为描边风格，且“配对设备”折叠行与“控制提示”行更紧凑。
- **可改**：统一主按钮实心化、加大卡片内边距与节间距、连接设置默认折叠、分段控件样式对齐。

## 2. 操作审计

| 我们 | 参考实现 |
| --- | --- |
| ![ours audit](ui-shots/ours/audit.png) | ![bsk audit](ui-shots/bsk/audit.png) |

- 我们都是“本地记录 + 隐私说明 + 空态”；参考实现用**虚线空态大卡片 + 居中图标/说明**，留白充足，
  顶部有“打开文件夹”快捷入口；我们工具栏更密（搜索/筛选/排序/时间线/导出/复制/导入/分页），
  信息能力强但**视觉更像后台表格**，空态局促。
- 可改：空态改成大号虚线卡（图标+标题+CTA）；工具栏分组（筛选组/导出组），降低按钮密度；
  宽度上限从 ~520px 放宽到 960–1080px（或自适应两栏）。

## 3. 网站调试

| 我们 | 参考实现 |
| --- | --- |
| ![ours debug](ui-shots/ours/debug.png) | ![bsk debug](ui-shots/bsk/debug.png) |

- 我们首屏是**多卡片堆叠**（手动采集/性能指标/请求规则/操作时间线/历史记录），工具齐全但首屏偏长、
  规则表单字段裸排；参考实现首屏是“历史记录 + 大空态”，把采集范围/限权折叠在底部，
  层级更清爽，后续记录列表是主角。
- 可改：把“性能指标/请求规则/手动采集”折叠到“高级”区；首屏突出空态与主 CTA；
  表单改成 label 左对齐 + 控件右对齐的两列，减少裸输入框。

## 4. 数据工作台（我们独有）

![ours workspace](ui-shots/ours/workspace.png)

- 功能：格式（JSON/CSV）导出、复制、导入、清空、载入审计/调试/录制数据、过滤语法提示、表格与分页。
- 视觉问题：顶部错误提示条（红字）与工具栏同排、按钮多且平铺；“0 行匹配”与快捷键提示混排；
  空态按钮“导入数据”蓝色实心与整体描边风格不一致。
- 可改：工具条分组+“更多”菜单；错误/空态移到表格内；快捷键提示收进 tooltip。

## 5. 长截图（参考实现）

![bsk long-screenshot](ui-shots/bsk/long-screenshot.png)

- 参考实现是“预览不可用”空态：顶部品牌头 + 居中图标/说明；我们的 longshot 页（下方附图）有更多
  模式/进度/预览控件，能力更全，但空态与主操作区的视觉引导可以借鉴。

## 6. 其余页面（全部截图见目录）

| 我们页面 | 截图 |
| --- | --- |
| options | ![ours options](ui-shots/ours/options.png) |
| quick | ![ours quick](ui-shots/ours/quick.png) |
| ops（操作录制） | ![ours ops](ui-shots/ours/ops.png) |
| record（视频录制） | ![ours record](ui-shots/ours/record.png) |
| longshot | ![ours longshot](ui-shots/ours/longshot.png) |
| preview | ![ours preview](ui-shots/ours/preview.png) |
| privacy | ![ours privacy](ui-shots/ours/privacy.png) |

| 参考实现页面 | 截图 |
| --- | --- |
| video | ![bsk video](ui-shots/bsk/video.png) |

## 7. 设计差距总结（截图证据）

| # | 差距 | 证据 | 优先级 |
| --- | --- | --- | --- |
| 1 | 主按钮/分段控件/空态风格不统一（蓝实心 vs 描边 vs 裸表单混用） | popup：我们描边“保存端口/保存配对”；workspace 蓝色实心“导入数据”；audit 全描边按钮 | **P0** |
| 2 | 首屏信息密度过高、留白不足（debug/audit/workspace） | audit 工具栏 1 行 8 个按钮；debug 首屏 5 张卡堆叠 | **P0** |
| 3 | 空态不够“产品化” | audit/workspace 小空态行；参考实现大虚线卡+图标+CTA | P1 |
| 4 | 表单控件风格（裸 select/input、label 混排） | debug 请求规则表单、options 表单 | P1 |
| 5 | 品牌色/图形语言弱于参考实现（无 logo 图形、警告色与主色混用） | popup 顶部 logo 为小图标；连接设置处同时出现蓝主色与橙色警告 | P2 |
| 6 | 页面宽度/栅格不统一（audit ~520px vs workspace 全宽） | audit 截图左右大量留白；workspace 全宽 | P1 |
| 7 | 组件库缺失导致同类控件多套实现 | `ui/lib` helper 无 button/card/switch 组件；样式散落 3 个 CSS | **P0（组件库）** |

## 8. 增强方案（可执行）

**P0（下一刀）**
1. 新建 `extension/ui/components.css` + `ui/components/*.js`：`btn`（primary/secondary/ghost/danger）、
   `card`、`switch`、`field`（label+control 行）、`empty-state`、`segmented`；统一 4/8/12/16/24 间距与
   radius 10/12、focus-visible 2px ring。
2. popup：主按钮实心化；连接设置默认折叠；分段控件样式对齐；警告色只用于“未配对/版本偏差”。
3. audit/workspace：页面宽度统一（960–1080 或自适应）；工具栏分组 + “更多”；空态换成大虚线卡+图标+CTA。

**P1**
4. debug：首屏只保留“历史记录/空态 + 主 CTA”，性能/规则/手动采集折叠进“高级”。
5. 表单统一：label 左、控件右，错误态红框+行内提示；`select` 用统一样式。
6. 空态/加载/错误三态组件化，接入现有 `ui/lib/empty-state.js` 与 `aria-live`。

**P2**
7. 品牌图标/插画、状态色 token、暗色模式 token 预留。
8. 截图回归：把本目录截图纳入门禁（当前先人工对比；后续用 `tools/ui-shots-e2e.mjs` 生成基线并 diff）。

## 9. 复现

```powershell
cd D:\浏览器桥
$env:PATH='D:\tools\node;'+$env:PATH
node tools/ui-shots-e2e.mjs --side all
# 产物：docs/ui-shots/ours/*.png、docs/ui-shots/bsk/*.png
```

> 说明：截图是“首次打开/空数据”状态；功能数据态（有记录、有视频、长截图预览）需要先造数据再截，
> 下一轮可加 `--with-data` 场景（预置审计/调试/录制记录）。

## 10. UI 增强第一刀（已落地，2026-11-26）

按截图对比的 P0/P1 项先做了一轮**低风险视觉层**（不改 DOM/行为）：

- 新增 `extension/ui/components.css`（共享 token：间距 4/8/12/16/24、radius 8/12/16、阴影、focus-visible 环、
  muted/border/accent 色），由 `ui.css` 与 `popup.css` 顶部 `@import` 引入，11 页统一生效。
- 主按钮实心化 + 阴影/hover/active 反馈；按钮圆角 10px、字重 600；subtle 按钮 hover 边框。
- 卡片统一圆角 16px + 1px 边框 + 阴影；相邻卡片间距统一。
- 输入/下拉/文本域统一圆角与 focus 态（边框 + 3px ring）；开关 focus 环；细滚动条；
  `prefers-reduced-motion` 下关闭过渡。
- 新增通用空态类 `.bd-empty`（虚线大卡 + 图标位 + 标题/说明/CTA 结构），供 audit/workspace/debug 迁移。

**增强后截图已重新采集**（`docs/ui-shots/ours/*.png` 为增强后版本，可直接与 `bsk/*.png` 对照）：
popup 的主按钮/卡片层次已更接近参考实现的“实心主操作 + 留白卡片”风格。

**下一刀（P0/P1，未做）**：
1. popup 连接设置默认折叠、分段控件统一；
2. audit/workspace 宽度与工具栏分组、空态迁移到 `.bd-empty`；
3. debug 首屏折叠“性能/规则/手动采集”，突出空态+主 CTA；
4. 把 `components.css` 扩展为 `ui/components/*.js`（button/card/switch/field/empty-state/segmented）并迁移
   popup/audit，补组件单测。

## 11. 品牌感增强（自有蓝配色，2026-11-26 第二轮）

按“保持我们自己的蓝配色、不照搬参考实现橙色”的要求做了品牌层：

- **品牌锁头**：popup 头部改为“蓝渐变 logo 底座（34×34，radius 11，品牌蓝 #2f6fed→#1f4fd0）+ BridgeDeck 字标
  （15px/750）+ 副标题「本地浏览器 Agent 工作区」”；图标仍用自有 icon48，不引入外部素材。
- **品牌 token**：components.css 增加 `--bd-brand-blue / -deep / -soft / --bd-brand-gradient`，后续按钮、
  选中态、焦点环可按同一蓝色阶扩展。
- **页面级品牌头**：`page-header::before` 增加品牌蓝渐变竖条（页面标题左侧），统一 11 页的“页面品牌感”。
- **页面宽度统一**：`body .page` 从 560px → 1040px；audit/debug 等页不再只有窄条内容（workspace 维持 1180）。
- **空态产品化**：`.state-block` 改为虚线大卡片（40px 内边距、居中、柔和底色），audit 空态已生效。

增强后截图（ours 全部 11 页重新采集）：
![ours popup brand](ui-shots/ours/popup.png)

对比参考实现：配色仍是我们的蓝，但“logo 底座 + 字标 + 副标题 + 页面品牌竖条”补上了品牌识别度；
下一步可把同一蓝色阶用到选中 tab、进度条、状态徽标，并做暗色 token。

### 品牌 mark 清晰度修复（同日）

用户反馈 popup 品牌图标模糊（icon48.png 缩放到 22–34px）。已改为**矢量 mark**：

- 新增 `extension/ui/assets/brand-mark.svg`：自有蓝渐变圆角底 + 白色“桥拱 + 桥面 + 桥墩 + Agent 节点”字形，
  纯矢量、任意 DPI 清晰；不使用外部素材/字体。
- popup 品牌头改用该 SVG（34×34），字体 16px/780；tile 阴影改 CSS drop-shadow。
- 重新截图确认：`docs/ui-shots/ours/popup.png`（增强后）。

![brand mark fixed](ui-shots/ours/popup.png)

### 扩展图标统一为矢量 mark（同日，工具栏/商店图标）

用户要求“按照之前的整清晰来”——把浏览器工具栏/商店图标也换成同一矢量 mark：

- 新增 `tools/make-brand-icons.mjs`：零依赖，用无头 Edge `--screenshot` 把 `brand-mark.svg`
  以精确尺寸栅格化（透明底），生成 16/32/48/128 PNG，替换 `extension/icons/icon*.png`。
- 生成结果：icon16 694B / icon32 1,602B / icon48 2,716B / icon128 10,691B（全部 1:1 像素精确）。
- 扩展包重建并重签本地清单：`BridgeDeck-extension-0.3.1.zip` 428 entries / 3,648,365B /
  sha256 `88ea7130…`；`release-preflight` PASS、`verify-release` verify ok: 0.3.1 / 9 artifacts。

### P0 继续：组件库接入 + popup 折叠 + 品牌状态 + 截图基线（2026-11-26）

- **组件库接入**：`extension/ui/audit.js` 的错误/空态改用 `createEmptyState/createButton`（`components/index.js`），
  空态渲染为虚线大卡片；6 条组件单测通过。
- **popup 初次体验**：连接设置默认折叠；分段控件 pill 化（灰底容器 + 白色选中块 + 品牌蓝文字）。
- **品牌蓝状态扩展**：`[aria-selected=true]` 行高亮、tab 选中、progress 进度、链接色、`::selection` 统一使用
  自有蓝色阶（不引入参考实现配色）。
- **截图基线门禁**：`tools/ui-shots-e2e.mjs --update-baseline / --check` 记录 16 张截图的 hash+尺寸；
  `--check` 用“尺寸漂移 ±15%”作为回归信号（截图含端口/时间等实时数据，hash 变化只提示不失败），
  当前 **screenshot baseline: clean (16 shots)**。

### 1-4 项推进记录（2026-11-26 晚）

1. **workspace/debug 组件化**：audit 空/错态用 `createEmptyState/createButton`；workspace 空态宿主加 `bd-empty`；
   debug 的请求/控制台/历史/操作/规则/性能空态加 `bd-empty` 卡片样式。
2. **debug 首屏折叠**：debug.js 增加 `foldAdvancedPanels()`（把“性能指标/请求规则”包成 `<details class="panel bd-fold">`）。
   ⚠️ 最新截图显示该折叠**未生效**（仍是展开的 section），原因待查（可能模块初始化时序/选择器不匹配），
   已记录为下一步第一优先修复项。
3. **暗色 token + 截图**：components.css 增加 `prefers-color-scheme: dark` token（bg/fg/card/line/muted/品牌蓝阶）；
   修复暗色下品牌字标不可见（brand h1 改用 var(--fg)）；已生成 `docs/ui-shots-dark/ours/*.png`（11 张），
   popup 暗色可读。数据态截图：`docs/ui-shots-data`（ours 11 + bsk 5），其中 debug 有真实操作时间线；
   **audit 数据态仍为空**（会话关闭后审计入库时序/需要再补 `close` 等待），列为下一步。
4. **组件库扩展到 popup**：popup.js 启动时把静态 `.seg` 与 `button.sw[id]` 渐进替换为 `createSegmented/createSwitch`
   （保留 id，后续事件绑定不变）；popup 截图正常，交互待一次真实点击回归（E2E 全量未跑）。

### 下一步 1/3/4 结果（2026-11-26）

1. **debug 折叠修复**：上次未生效的根因是补丁正则未匹配（debug.js 以注释开头），这次改为插到最后一个 import 之后。
   截图确认：**性能指标 / 请求规则已折叠为 details（带箭头）**，操作时间线/历史记录的空态为虚线大卡。
   ![debug folded](ui-shots/ours/debug.png)
3. **popup 组件替换点击回归**：`tools/ui-shots-e2e.mjs --popup-check` 在真实 popup 页执行：
   点击 `#modeRemote` → 远程段选中、`#modeLocal` 取消；点击 `#connToggle` → `aria-checked` 翻转；
   本轮 **failed=0（PASS）**，并保存 `popup-conn-settings.png`（连接关闭态）。
4. **截图基线已更新**：折叠生效后重新采集 ours 全页并执行 `--update-baseline`；
   `docs/ui-baseline.json` 为最新 16 张截图基线。
2. **audit 数据态（未完成）**：给 `--with-data` 加了 `close` + 等待，但 data 运行在本环境仍挂起（>10min，已终止）；
   轻量截图与 popup 回归不受影响。下一步改用“直接构造 audit 记录文件/接口”或缩短 CLI 超时后重试。
