# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T05:55:07.512Z
- 夹具页：http://127.0.0.1:59655/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| Y1 | DemoQA：点击下载文件 | ❌ 3956ms / 3 步 | ✅ 32401ms / 3 步 |
| Y2 | DemoQA：网络抓包（debug start → requests） | ✅ 4516ms / 5 步 | ✅ 66897ms / 5 步 |
| Y3 | 多标签页：新开 + 列出 + 关闭 | ✅ 602ms / 4 步 | ✅ 2310ms / 4 步 |
| Y4 | DemoQA：视频录制 3s | ❌ 167ms / 2 步 | ✅ 53102ms / 2 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 2/4 | 4/4 |
| 任务耗时合计 | 9241ms | 154710ms |
| CLI 步数合计 | 14 | 14 |

## 逐任务的实测细节

### Y1 DemoQA：点击下载文件

- **BSK 0.5.0**：失败：{
  "code": "protocol_error",
  "message": "拒绝访问。 (os error 5)",
  "hint": "ensure CLI and daemon protocol versions match — check `protocol version` i size=0

  ```text
  {
    "code": "protocol_error",
    "message": "拒绝访问。 (os error 5)",
    "hint": "ensure CLI and daemon protocol versions match — check `protocol version` in `bsk status`",
    "exit_code": 2
  }
  ```

- **BridgeDeck 0.3.1**：下载落盘 4096 字节

  ```text
  {"ok":true,"result":{"downloadId":5,"filename":"C:\\Users\\CFT\\Downloads\\sampleFile (4).jpeg","bytes":4096,"state":"complete","url":"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEBUSEhAVFRUVFQ8VFRUVEA
  ```

### Y2 DemoQA：网络抓包（debug start → requests）

- **BSK 0.5.0**：抓到 ≥3 条请求

  ```text
  {
    "session_id": "btng",
    "run": {
      "id": "daf2bf84c1c32",
      "session_id": "btng",
      "tab_id": 1769051065,
      "name": "web3",
      "url": "https://demoqa.com/text-box",
      "started_at": 1795758879727.0,
      "state": "capturing",
      "requests": 0,
      "operations": 0,
      "errors": 0,
      "dropped_requests": 0,
  ```

- **BridgeDeck 0.3.1**：抓到 ≥3 条请求

  ```text
  {"ok":true,"result":{"ok":true,"tabId":1779785469,"startedAt":1795758767967,"receipt":{"method":"debug.start","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"sch
  {"ok":true,"result":{"entries":[{"id":1,"requestId":"456E409919413E9755072E3E266EB957","method":"GET","url":"https://demoqa.com/text-box","status":200,"type":"Document","resourceType":"Document","mime":"text/html","proto
  ```

### Y3 多标签页：新开 + 列出 + 关闭

- **BSK 0.5.0**：新标签已创建并关闭（tabId=1769051067）

  ```text
  {
    "tab_id": 1769051067,
    "window_id": 1769051064,
    "url": ""
  }
  {
    "tabs": [
      {
        "tab_id": 1769051003,
        "title": "about:blank",
        "url": "about:blank",
        "window_id": 1769051001,
        "active": true,
        "scope": "user"
  ```

- **BridgeDeck 0.3.1**：新标签已创建并关闭（tabId=1779785472）

  ```text
  {"ok":true,"result":{"tabId":1779785472,"windowId":1779785470,"receipt":{"method":"tab.new","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","c
  {"ok":true,"result":{"tabs":[{"tabId":1779785464,"windowId":1779785463,"url":"https://demoqa.com/upload-download","title":"demosite","active":true,"owned":"agent","controlled":false,"keepOpen":false,"groupId":863370663,"
  ```

### Y4 DemoQA：视频录制 3s

- **BSK 0.5.0**：失败：{
  "code": "not_found",
  "message": "No tab with id: 1769051067.",
  "hint": "the session, tab, or browser may have stopped; run `bsk session list`  | {
  "code": null,
  "message": "Choose one recording with --recording (0 matches); use bsk video list",
  "hint": "is the daemon running? try `bsk dae | 

  ```text
  {
    "code": "not_found",
    "message": "No tab with id: 1769051067.",
    "hint": "the session, tab, or browser may have stopped; run `bsk session list` / `bsk browsers` to see current state",
    "exit_code": 1
  }
  {
    "code": null,
    "message": "Choose one recording with --recording (0 matches); use bsk video list",
    "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
    "exit_code": 2
  }
  
  ```

- **BridgeDeck 0.3.1**：录制就绪，落盘 516644 字节

  ```text
  {"ok":true,"result":{"ok":true,"recordingId":"b177ecef-f62c-4300-86d8-ad66dc4196ec","tabId":1779785475,"mime":"video/mp4","startedAt":1795758844973,"mode":"debugger","durationMs":3000,"recording_state":"recording","budge
  ```

## 差异摘要（自动）

- Y1：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y2：耗时差 +62381ms（BSK 4516ms / BridgeDeck 66897ms）
- Y3：耗时差 +1708ms（BSK 602ms / BridgeDeck 2310ms）
- Y4：通过状态不同（BSK 失败 / BridgeDeck 通过）

