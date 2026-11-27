# 视频录制与分片边界

## 当前实现

- 录制：页面内 `MediaRecorder`（优先 MP4，回退 WebM），通过 offscreen document 落库。
- 分片日记：每个 timeslice chunk 记录 `index/at/bytes/sha256`。
- 恢复：扫描 IndexedDB 残留 chunk，按 index 排序重建文件；恢复记录标记
  `completeness=partial`、`stop_reason=recovered`，恢复分片同样计算 SHA-256。
- 校验：`bridge video verify <id>` 按 fragment 字节切分整段文件，逐片核对 SHA-256；
  返回 `verified/chunks/bytes/container/mismatches`。
- **MP4 容器**：解析顶层 `ftyp/moov/moof/mdat`；Edge/Chrome MediaRecorder 的 MP4
  实测带 `moof`，`container.fragmented=true`（E2E `35`）。
- 保存：`bridge video save <id> --out file.mp4`，直接写 MediaRecorder 原始字节。

## fMP4 结论

MediaRecorder 的 MP4 输出本身是 fragmented MP4；BridgeDeck 记录的是分片流，并额外维护
chunk 级 SHA 日记。**不做**二次 remux/worker：没有重新封装需求，重封装只会增加
muxer 依赖和转码风险。`video verify` 会报告 `container.fragmented`，不是“改扩展名”。

## 明确不做：fragmented MP4 重封装 / worker

当前**不做** fragmented MP4（ftyp+moov+moof+mdat）重封装，也不引入 muxer worker。
原因：

1. MediaRecorder 输出的音视频流本身可播放；重封装需要完整 ISO BMFF + 编解码参数解析，
   引入 native/WASM muxer 会打破“零依赖”和扩展体积边界。
2. 恢复/校验只需要分片完整性与可播放性，不需要 fMP4 的随机访问/低延迟分片语义。
3. 强行把 WebM 转 fMP4 需要转码，成本与风险远高于收益。

## 影响

- 不支持“边录边播”的 fMP4 消费端；保存的是录制容器原格式。
- 录制中断时恢复为 `partial`，可能缺尾部帧；分片 SHA 能证明“哪些片完整”。
- 没有 worker，长录制在 offscreen document 内完成，受浏览器内存/时长限制。

## 未来若要上 fMP4

需要单独立项：选定 muxer（WASM/native）、处理 H.264/VP9 参数、worker 管线、
恢复时 moof 索引重建，并新增对应 E2E/性能门禁；不能只改扩展名。
