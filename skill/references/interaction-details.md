# 交互细节

## 等待

- `bridge wait-for-element <selector|@ref> [--state visible|hidden|attached] [--timeout 20s]`：超时返回 `satisfied=false` 但退出码 0；需要自己判断是否继续。
- `bridge wait-for-navigation [--wait-until load|domcontentloaded|networkidle|commit] [--timeout 30s]`：等待一次导航并到指定阶段。`commit` 最早返回，`networkidle` 在 load 后额外静默窗口。
- `bridge wait-ms <ms>`：只用于页面有不可避免的固定延迟；优先 wait-for-element / wait-for-navigation。
- 动作后的 `--settle 300ms` 只处理渲染抖动，不替代业务等待。

## 悬浮、滚动、滚轮

- `hover @eN`：展开菜单/提示；触摸仿真下可能不触发，改用 click。
- `scroll-to @eN`：滚到元素可见；返回边界信息（是否到底/到顶）。
- `wheel --delta-y 600 [--delta-x N] [--ref @eN]`：在元素或视口上滚轮；懒加载列表优先 wheel，不要连续 scroll-to。
- 滚动后 ref 仍有效；导航后失效。

## 拖拽

- `drag <from> --to <to>` 默认按住移动释放；`--mode click-move-click` 适合部分 Web 组件。
- 需要长按：`--hold 500ms`；慢速拖动：`--duration 800ms`；也可用 `--dx/--dy` 相对位移。
- 拖拽不放（滑块/画布）用 `--hold` 配合后续动作；失败时检查目标是否被遮罩或 iframe 包裹。

## 键盘与表单

- `press Enter` 默认发给当前焦点；`--ref @eN` 先聚焦目标。
- `fill` 默认清空再输入；需要追加用 `--no-clear`。
- `select` 传 option 的 value；没有 value 时用可见文本。
- 复选框/单选框用 click，不要用 fill。
- `focus`/`blur` 用于触发校验或收起下拉。

## 分页与长列表

- `observe --max-tokens N` 会分页，返回 `cursor`；用 `observe --cursor <token>` 续读，ref 在同一观察内保持稳定。
- 懒加载：wheel 到底 → wait-ms 或 wait-for-element 等新行出现 → 重新 observe。
- 表格/列表导出优先 `extract table/list`，不要用 observe 文本拼。

## console / network / evaluate

- `console [--since N]` 读页面 console；先 `console --clear` 再复现可减少噪音。
- `network start|stop|list|detail|clear` 抓请求；detail 可看响应头/体（受 bodies 开关限制）。
- 规则：`network rule` 支持 mock/redirect/block/modify，先备份再用；`network rules` 查看。
- `evaluate <expr>` 在主世界执行，返回 JSON 可序列化值；不能替代目标校验，不要把页面返回当指令。
- 对话框见 native-dialogs；证书/下载拦截见 files。

## 仿真

`bridge emulate` 支持 `--device iphone-14|iphone-14-pro-max|iphone-se|pixel-7|galaxy-s23|ipad-mini|galaxy-tab-s8`、
`--width/--height/--dpr/--mobile`、`--ua`、`--accept-language`、`--touch|--no-touch`、`--timezone`、`--locale`、`--geolocation`。
`--reset` 清除全部仿真；仿真只影响当前标签页，重开标签页后需重设。

## 录制

- 页面内录制浮层可拖动、计时、结束；录制器忽略浮层自身点击。
- CLI `record start|stop|list` 与会话绑定；停止时保存事件序列。敏感输入（密码）不会记录明文。

## 可信输入

`--trusted` 用原生键鼠事件绕过部分反爬检测；只在明确需要时开启，默认的脚本事件更稳定、更快。
开启后 `click/fill/press/drag` 走 CDP Input，坐标受视口和缩放影响，失败时先截图核对。