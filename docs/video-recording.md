# 视频录制

视频录制把授权任务标签页录成 MP4，保存在扩展本地。录制与编码在扩展内完成，CLI 只负责开始、停止、查询、保存和清理。

## 开始

```powershell
node cli/bridge.mjs video start --duration 60s --quality high
```

- `--duration`：最长录制时间，到点自动停止。
- `--quality`：`standard` 或 `high`。
- 每个标签页同时只允许一个录制。
- 录制前会检查 session、标签页归属与 Agent Window。

## 状态与停止

```powershell
node cli/bridge.mjs video status <id>
node cli/bridge.mjs video stop <id>
```

停止后进入 `finalizing`，编码完成后才是 `ready`。`ready` 之前保存会失败。

## 保存

```powershell
node cli/bridge.mjs video save <id> --out video.mp4 --overwrite
node cli/bridge.mjs video list
node cli/bridge.mjs video discard <id>
node cli/bridge.mjs video prune --ttl 24h
```

- 保存是复制，不删除原录制。
- 覆盖已有文件必须显式 `--overwrite`。
- `list` 返回录制 id、状态、时长、大小与创建时间。

## 恢复

```powershell
node cli/bridge.mjs video recover
```

页面导航、worker 重启或编码中断后，恢复流程会检查分片、补齐索引并落盘可恢复的录制。

## 实现

| 层 | 行为 |
| --- | --- |
| 采集 | CDP screencast 帧 + 页面事件 |
| 编码 | WebCodecs H.264 → fragmented MP4 |
| 存储 | 分片日志 + OPFS/IndexedDB |
| 恢复 | 启动时扫描未完成录制 |
| 下载 | 保存为普通 MP4 文件 |

## 限制

- 只录授权标签页，不录整个桌面。
- 受浏览器编码器支持限制；不支持 H.264 时明确报错。
- 页面不可见时帧率会下降甚至暂停，录制时间仍按墙钟计算。
- 录制中导航会暂时挂起并尝试恢复；失败时以 `capture_failed` 结束。
