# 视频录制

- `bridge video start --session <id> [--duration 60s] [--quality clear|standard]` 开始录制当前任务标签页（无声音）。
- 录制在后台进行，切换标签页不影响；上限到期自动停止保存。
- `bridge video stop --session <id>` 提前结束并保存；`video list` 查看，`video prune` 清理过期。
- 页面上会出现录制状态（红点/计时/结束）；扩展弹窗视频面板显示“录制中 · mm:ss”和停止按钮。
- 保存位置与下载目录一致；失败时检查磁盘空间和页面是否受限（chrome:// 等不能录制）。
- 录制文件按保留策略清理；需要长期保存时先复制到任务目录。
- 录屏不等于审计：操作审计在 `audit.html` / `bridge audit list`。