# 视频 H.264/MP4 可行性 spike（0.4，只读证据）

> 任务：`task-8`（共享任务板），只做可行性证据。**未改产品代码、未改 0.3.0/dist/D:\CTRM自动录入、未跑阶段门**。
> 唯一新增文件：本文件 `docs/VIDEO-MP4-SPIKE.md`。
> 结论一句话：**在真实 headless Edge 158 的页面上下文里，`MediaRecorder` 的 MP4/H.264 路径真实可用**（`isTypeSupported` 全真、真录出可播放 fMP4、`ftyp/moov/moof/mdat` + `stsd=avc1` 结构成立），且 **0.4 现有 CDP screencast JPEG 帧可以直接喂进它**；因此"零依赖 muxer"不再是硬阻塞。建议**保持 AVI 为默认，另立 MP4 扩展 ingress 轮**，而不是在本轮改 `tool.video`。

- 日期：2026-11-23（本机 Asia/Shanghai，下午）
- 仓库：`D:\浏览器桥`，commit `333d667a9c35762f601301f551396355d6bcd463`（branch `main`）
- 运行环境：Windows 25H2（build `10.0.26200.9974`；注册表 `ProductName` 仍报 "Windows 10 Home China"），Node `v24.21.0`
- 浏览器：**Microsoft Edge `158.0.4370.33`**（`--headless=new`，真实进程，非模拟）
- 证据类型：真实浏览器页面上下文断言 + 真实录制产物结构校验 + 页面内回放解码校验；无 ffprobe/ffmpeg（本机不存在），所以**不做外部解码器验证**，只做结构 + 浏览器自解码。

---

## 1. 断言：`MediaRecorder.isTypeSupported`

### 1.1 仓库内可复现命令（`0.4/cli/bridge-remote.mjs`，无需扩展）

```powershell
node "0.4/cli/bridge-remote.mjs" --url "about:blank" --evaluate "({mp4_avc1_42E01E: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E'), mp4_any: MediaRecorder.isTypeSupported('video/mp4'), webm_vp9: MediaRecorder.isTypeSupported('video/webm;codecs=vp9'), ua: navigator.userAgent})" --json
```

### 1.2 原始输出（整行，未删改）

```json
{"ok":true,"url":"about:blank","title":"","nodes":1,"rows":0,"tokens":0,"truncated":false,"action":null,"wait":null,"read":null,"dialog":null,"console":null,"emulate":null,"windowSize":null,"html":null,"evaluate":{"tab_id":0,"ok":true,"value":{"mp4_avc1_42E01E":true,"mp4_any":true,"webm_vp9":true,"ua":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0"},"error":null,"dialogs":[]},"snapshot":null,"observe":null,"tabs":null,"tabAction":null,"capabilities":null,"refRoundtrip":null,"refFillRoundtrip":null,"refPressRoundtrip":null,"refSelectRoundtrip":null,"refDragRoundtrip":null,"graph":null,"extract":null,"navigation":null,"ax":null,"axGraph":null,"axNamesApplied":0,"axRolesApplied":0,"axLease":null,"axMultiframe":null,"network":null,"networkBody":null,"networkBodies":null,"record":null,"video":null,"captureControl":null,"overlay":null,"cooperate":null,"screenshot":null,"fullScreenshot":null,"text":""}
```

### 1.3 全量 MIME 矩阵（同一 headless Edge，页面上下文 `Runtime.evaluate`）

`navigator.userAgent`：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0`
`isSecureContext`：`true`

| 请求的 MIME | `MediaRecorder.isTypeSupported` |
| --- | --- |
| `video/mp4` | **true** |
| `video/mp4;codecs=avc1.42E01E` | **true**（主断言） |
| `video/mp4;codecs=avc1.4D401E` | true |
| `video/mp4;codecs=avc1.640028` | true |
| `video/mp4;codecs="avc1.42E01E"`（带引号） | true |
| `video/mp4;codecs=avc1.42E01E,mp4a.40.2` | true |
| `video/mp4;codecs=avc1.42E01E,opus` | true |
| `video/webm;codecs=vp9`（对照） | true |
| `video/webm;codecs=vp8` | true |
| `video/webm` | true |
| `video/x-matroska;codecs=avc1` | true（探测层"支持"，未录） |

> `MediaRecorder` 层 MP4/H.264 与 WebM 在本机 Edge 上**同时可用**；AVI/MJPEG 是 0.4 自己的纯 JS 封装器，不依赖 `MediaRecorder`，两条路径可以并存而不是二选一。

---

## 2. 真实录制：`canvas.captureStream()` + `MediaRecorder` → MP4

### 2.1 方法（临时 CDP harness，已删除，不入库）

临时脚本放系统 Temp，按 `0.4/packages/browser-adapter/src/cdp-ws.js` 的 `connectCdp` 连真实浏览器：

1. 启动 `msedge.exe`，参数：
   `--headless=new --remote-debugging-port=0 --user-data-dir=<Temp>\...\profile --no-first-run --no-default-browser-check --disable-background-networking --autoplay-policy=no-user-gesture-required about:blank`
2. 从 `<profile>\DevToolsActivePort` 取端口，`fetch /json/version` 取 `Browser`/`User-Agent`。
3. 起一个本地 `http://127.0.0.1:<随机端口>/` 页面（避免 `data:`/`about:blank` 的 opaque origin 干扰 blob 回放），页面内定义探针函数。
4. `Target.createTarget` + `Target.attachToTarget`（flatten），`Page.navigate`，等 `document.readyState === 'complete'`。
5. `Runtime.evaluate`（`awaitPromise:true, returnByValue:true`）跑录制；Blob 字节转 base64 回 Node 做 box 结构解析；**同一 Blob 留在页面里**再做 `<video>` 回放校验。
6. 清理：`child.kill()` + `rmSync(temp)`（结果里 `tempCleaned: true`）。

录制 A（纯 canvas 动画）：320×240，`canvas.captureStream(30)` → `MediaRecorder(stream, {mimeType:'video/mp4;codecs=avc1.42E01E', videoBitsPerSecond:1200000})`，`start(100)`，录 ~1.5s，`stop()`，收 `dataavailable` 分片。
录制 B（**模拟 0.4 真实管线**）：先用一张草图 canvas 生成 12 帧 JPEG dataURL，`fetch → blob → createImageBitmap` 当作"CDP screencast 解出来的帧"，`setInterval 50ms` 逐帧 `drawImage` 到目标 canvas 并 `track.requestFrame()`，其余同 A。这就是"JPEG 帧 → 浏览器 H.264 编码 → 浏览器自带 MP4 muxer"的等价管线。
对照录制 C：同 A 但 `video/webm;codecs=vp9`。

### 2.2 原始输出（关键字段，逐字取自 harness JSON）

```json
"recordings": {
  "mp4": {
    "requestedMime": "video/mp4;codecs=avc1.42E01E",
    "actualRecorderMime": "video/mp4;codecs=avc1.420015",
    "blobType": "video/mp4;codecs=avc1.42e01e",
    "size": 93990,
    "chunkCount": 2,
    "chunkSizes": [751, 93239],
    "framesDrawn": 205,
    "firstBox": { "type": "ftyp", "size": 36 },
    "startsWithFtyp": true,
    "playback": { "ok": true, "videoWidth": 320, "videoHeight": 240, "duration": 1.672267, "readyState": 4, "decodedFrameDistinctColors": 41, "decodeOk": true }
  },
  "mp4FromJpegFrames": {
    "requestedMime": "video/mp4;codecs=avc1.42E01E",
    "actualRecorderMime": "video/mp4;codecs=avc1.420015",
    "blobType": "video/mp4;codecs=avc1.42e01e",
    "size": 67527,
    "chunkCount": 2,
    "chunkSizes": [751, 66776],
    "jpegFramesAvailable": 12,
    "framesDrawn": 30,
    "wallMs": 1668,
    "firstBox": { "type": "ftyp", "size": 36 },
    "startsWithFtyp": true,
    "playback": { "ok": true, "videoWidth": 320, "videoHeight": 240, "duration": 1.5346, "readyState": 4, "decodedFrameDistinctColors": 34, "decodeOk": true }
  },
  "webm": {
    "requestedMime": "video/webm;codecs=vp9",
    "actualRecorderMime": "video/webm;codecs=vp9",
    "blobType": "video/webm;codecs=vp9",
    "size": 64117,
    "chunkCount": 12,
    "firstBytesHex": "1a45dfa39f4286810142f7810142f2810442f38108428284",
    "playback": { "ok": true, "videoWidth": 320, "videoHeight": 240, "duration": null, "readyState": 4, "decodedFrameDistinctColors": 43, "decodeOk": true }
  }
}
```

说明：

- `playback` 是**页面内** `<video src=blobURL>` 的 `loadeddata` + seek + `drawImage` 读像素：`decodeOk: true` 表示 Edge 自己把这份 MP4 解回来了；`duration` 1.67s / 1.53s，与录制墙钟一致（含尾部 flush）。
- `decodedFrameDistinctColors` > 1 表示不是纯色空帧（有实际画面）。
- 两个 MP4 的 `chunkCount` 都是 2（首片 751B 含 `ftyp`+`moov`，尾片含后续 `moof`+`mdat`），这是 MediaRecorder 默认 timeslice 的行为，不代表只有 2 帧。
- 对照 webm `duration: null` 是 live WebM（无时长头）的正常表现，不影响"harness 本身有效"这个对照结论。

### 2.3 MP4 字节结构校验（纯 Node，`ftyp` box + 顶层/嵌套 box 树）

录制 A 的 box 树（深度展开；录制 B 同构）：

```text
depth0 ftyp  size=36   majorBrand=isom minorVersion=512 compat=[isom, iso6, iso2, avc1, mp41]
depth0 moov  size=715
  depth1 mvhd   size=120  version=1 timescale=1000 duration=0
  depth1 trak   size=547
    depth2 tkhd size=104
    depth2 mdia size=435
      depth3 mdhd  size=44  version=1 timescale=30000 duration=1472 (≈0.049s)
      depth3 hdlr  size=45  handler=vide
      depth3 minf  size=338
        depth4 vmhd size=20
        depth4 dinf size=37  → dref size=29
        depth4 stbl size=273 → stsc 16, stts 16, stsz 20, stco 16, stsd 197
          depth5 stsd entry: avc1 (size=181)
  depth1 mvex   size=40   → trex size=32
depth0 moof  size=448  → mfhd 16, traf 424 (tfhd 20, tfdt 20, trun 376)
depth0 mdat  size=78400 payloadBytes=78392
depth0 moof  size=152  → mfhd 16, traf 128 (tfhd 20, tfdt 20, trun 80)
depth0 mdat  size=15420 payloadBytes=15412
```

结论：

- 文件确实以 `ftyp` 开头（`startsWithFtyp: true`），brand 里带 `avc1`；
- `moov` 完整（`mvhd`/`trak`/`mdia`/`minf`/`stbl`/`stsd`，采样表 `stsc/stts/stsz/stco` 齐全），`mvex`+`moof` 说明是 **fragmented MP4**；
- `stsd` 条目 fourcc = **`avc1`**，即 H.264 视频轨；
- **`mvhd.duration = 0`（timescale=1000），`mdhd.duration = 1472`/timescale 30000 ≈ 0.049s（仅单帧量级）**：fMP4 的时长在 `moof/trun` 分片里，不在 `moov`。任何"从 moov 读时长"的校验都会误判，这是给后续 MP4 校验器的重要坑；页面内回放实测 `duration` 1.67s 才反映真实时长。
- 这是浏览器原生 muxer 产出的合法 fMP4，**不是改扩展名的 WebM**（WebM 前 4 字节是 `1a45dfa3` EBML 头，MP4 是 box 长度 + `ftyp`）。

### 2.4 MIME 归一化的坑（实测）

请求 `video/mp4;codecs=avc1.42E01E`，但：

- `recorder.mimeType` 变成 **`video/mp4;codecs=avc1.420015`**（浏览器自己选定的 profile/level，本例 Baseline、level 2.1；`42 00 15`）；
- `blob.type` 变成小写 **`video/mp4;codecs=avc1.42e01e`**。

所以后续实现/校验**不要**用 `recorder.mimeType === requested` 或大小写敏感的 MIME 比较；也不要用 MIME 里的 level 当作实际编码参数断言。

---

## 3. 旁证：WebCodecs（`VideoEncoder`）也真实可用

同一次 harness 里对 `VideoEncoder.isConfigSupported` 与**真编码 1 帧**：

```json
"webcodecs": {
  "hasVideoEncoder": true,
  "avcBaseline": { "codec": "avc1.42E01E", "supported": true },
  "avcMain": { "codec": "avc1.4D401E", "supported": true },
  "avcHigh": { "codec": "avc1.640028", "supported": true },
  "vp09": { "codec": "vp09.00.10.08", "supported": true },
  "vp8": { "codec": "vp8", "supported": true },
  "avcRealEncode": { "ok": true, "chunks": [{ "type": "key", "bytes": 321 }] }
}
```

即：**编码器**在（H.264 真出 1 个 key chunk）。但 0.4 的 `browser-adapter` 里没有 fMP4 muxer：

- 走 WebCodecs 就得自己写 ISO-BMFF 封装（`avcC`、`moof/trun`、`mvhd` 等），等于引入 muxer 工作量/依赖风险——与 `docs/VIDEO.md`、`docs/0.4-BEYOND-BSK.md:122` 的边界一致，**不推荐**；
- 走 `MediaRecorder` 则是**浏览器同时提供编码器和 MP4 muxer**，零新依赖、零 muxer 代码，这正是本次 spike 的价值。

---

## 4. 对 `tool.video` 的建议

现状（0.4）：`tool.video` = `Page.startScreencast` 取 JPEG 帧 → 纯 JS 封 MJPEG-AVI（`0.4/packages/browser-adapter/src/video-handlers.js` + `avi-mjpeg.js` + `avi-verify.js`），产物 `video/x-msvideo`，诚实标记 `playable:true`，并有结构校验器。`docs/0.4-BEYOND-BSK.md:122` / `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` 把"proven H.264/MP4 encode+mux path"当作 MP4 立项触发条件。

建议（按优先级）：

1. **本轮不动 `tool.video` 契约**：AVI/MJPEG 已是验收过的窄契约，shipping 改动会牵动 verify/read/export/E2E 门禁。结论写进缺口台账即可。
2. **另立一轮"MP4 扩展 ingress"**（显式 opt-in，非默认）：
   - 入参加显式 `format: "mp4"`（如 `video start --format mp4`），默认仍是 AVI；
   - 打进 `Page.startScreencast` JPEG 帧不变，**在页面上下文（优先 `Page.createIsolatedWorld` 隔离世界，避免污染页面全局）** 跑 `canvas.captureStream()` + `MediaRecorder('video/mp4;codecs=avc1.42E01E')`；把 Blob 字节按 timeslice 捞回 Node 落临时文件；
   - **能力探测 + 诚实失败**：先 `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E')`，false 时返回 `E_UNSUPPORTED`（可用时也可显式降级 WebM，但必须如实上报 `container/codec`，绝不改扩展名冒充 MP4）；
   - 产物元数据如实标 `container: 'mp4'`、`video_codec: 'h264'`、`format: 'fragmented-mp4'`、`audio: none`；`read/export` 复用现有分片读取，按 artifact mime 分发；
   - 新增 `mp4-verify`（对标 `avi-verify`）：校验 `ftyp`（含 `avc1` brand）+ `moov/trak/mdia/hdlr=vide/stbl/stsd=avc1` + `mvex` + 至少 1 组 `moof/mdat`；**时长不要读 `mvhd`**（实测为 0），需要时长就读 `moof/trun` 或交给播放器；
   - 不在本轮做 remux/worker/转码（与 `docs/VIDEO.md` 一致）。
3. **验收门禁证据形态**（可直接复用本 spike 方法）：1–2 秒真实录制 → `ftyp` 开头 + `stsd=avc1` + ≥1 `moof/mdat` → 页面内 `<video>` 回放 `decodeOk` 且 `videoWidth/Height` 符合采集尺寸；再补一条"能力探测 false → `E_UNSUPPORTED`"的负例。
4. **跨环境矩阵必须重测**：本证据只覆盖 **Windows + Edge 158.0.4370.33 + headless=new**。立项前至少补 Chrome 同版本区间、Edge 有头、以及目标 `duration/分辨率`（1080p/长录制）——`isTypeSupported` 因版本/构建而异，必须运行时探测而不是硬编码。

**触发条件判定**：`0.4-BEYOND-BSK.md:122` 的"proven browser-encoder path"在 **Windows Edge 158 headless 上已被本证据证明成立**（编码 + mux + 可播）；是否立项仍是产品决策（跨浏览器矩阵、性能门禁、是否值得增加一条 ingress）。

---

## 5. 未覆盖 / 限制（不得外推）

- 未测 1080p/高帧率/长录制/内存增长；本次仅 320×240、~1.5s。
- 未测多会话并发、后台标签页隐藏时 `captureStream`/`MediaRecorder` 的帧率与卡顿（0.4 daemon 多会话下必须补 E2E）。
- 未测有头 Edge、未测 Chrome 版本、未测 MV3 扩展 `offscreen` 路径（0.3 的老路径是扩展内 `MediaRecorder`，与本次 headless 页面上下文不同）。
- 未用外部解码器复核（本机无 ffprobe/ffmpeg）：可播放性只由 Edge 自身解码 + 结构 box 双重支撑。
- 未评估把帧画进 canvas 的 CPU 成本（本次 JPEG 帧管线 1.67s 内画 30 帧、无明显卡顿，但未做性能基线）。
- 未验证 `MediaRecorder` 在 `Page.createIsolatedWorld` 中的行为（建议实现时先做 1 个 smoke；本 spike 用的是 main world）。
- 临时 harness 与临时 profile 均已删除（`tempCleaned: true`），仓库无残留改动。

## 6. 复现清单

| 步骤 | 命令/方式 | 期望 |
| --- | --- | --- |
| 环境探测 | 上面 §1.1 的 `bridge-remote.mjs --evaluate` | `mp4_avc1_42E01E: true`、`webm_vp9: true` |
| 录制 + 结构/回放 | 临时 CDP harness（§2.1 步骤） | `startsWithFtyp: true`、`stsd=avc1`、≥1 组 `moof/mdat`、回放 `decodeOk: true` |
| 清理 | kill 浏览器 + 删临时 profile | 无 `bd-mp4-spike-*` 残留 |

> 本文件中 `tools` 均为仓库现有能力（`0.4/cli/bridge-remote.mjs`、`0.4/packages/browser-adapter/src/cdp-ws.js`）；临时 harness 未入库，按约束已删除。
