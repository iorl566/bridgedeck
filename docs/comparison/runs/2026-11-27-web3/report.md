# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T06:08:19.213Z
- 夹具页：http://127.0.0.1:64447/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| Y1 | DemoQA：点击下载文件 | ❌ 3754ms / 3 步 | ✅ 33104ms / 3 步 |
| Y2 | DemoQA：网络抓包（debug start → requests） | ✅ 3141ms / 5 步 | ✅ 70872ms / 5 步 |
| Y3 | 多标签页：新开 + 列出 + 关闭 | ❌ 659ms / 4 步 | ✅ 1710ms / 4 步 |
| Y4 | DemoQA：视频录制 3s | ❌ 155ms / 2 步 | ✅ 26004ms / 2 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 1/4 | 4/4 |
| 任务耗时合计 | 7709ms | 131690ms |
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
  {"ok":true,"result":{"downloadId":6,"filename":"C:\\Users\\CFT\\Downloads\\sampleFile (5).jpeg","bytes":4096,"state":"complete","url":"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEBUSEhAVFRUVFQ8VFRUVEA
  ```

### Y2 DemoQA：网络抓包（debug start → requests）

- **BSK 0.5.0**：抓到 30 条请求 {"Image":12,"Fetch":1,"Document":7,"Script":7,"Stylesheet":1,"Other":1,"XHR":1}

  ```text
  {
    "session_id": "sbey",
    "run": {
      "id": "d17ca0ee91eee",
      "session_id": "sbey",
      "tab_id": 1769051543,
      "name": "web3",
      "url": "https://demoqa.com/text-box",
      "started_at": 1795759670972.0,
      "state": "capturing",
      "requests": 0,
      "operations": 0,
      "errors": 0,
      "dropped_requests": 0,
  ```

- **BridgeDeck 0.3.1**：抓到 23 条请求 {"Document":5,"Script":7,"Stylesheet":1,"Image":3,"Other":2,"XHR":2,"Fetch":3}

  ```text
  {"ok":true,"result":{"ok":true,"tabId":1779786033,"startedAt":1795759550482,"receipt":{"method":"debug.start","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"sch
  {"ok":true,"result":{"entries":[{"id":1,"requestId":"445385F0CE5187C47BC4FE7A25E72E4C","method":"GET","url":"https://demoqa.com/text-box","status":200,"type":"Document","resourceType":"Document","mime":"text/html","proto
  ```

### Y3 多标签页：新开 + 列出 + 关闭

- **BSK 0.5.0**：失败：{
  "tab_id": 1769051549,
  "window_id": 1769051542,
  "url": ""
} | {
  "tabs": [
    {
      "tab_id": 1769051481,
      "title": "about:blank",
      "url": "about:blank",
      "window_id": 1769051479,
      "active | {
  "tab_id": 1769051549
}

  ```text
  {
    "tab_id": 1769051549,
    "window_id": 1769051542,
    "url": ""
  }
  {
    "tabs": [
      {
        "tab_id": 1769051481,
        "title": "about:blank",
        "url": "about:blank",
        "window_id": 1769051479,
        "active": true,
        "scope": "user"
  ```

- **BridgeDeck 0.3.1**：新标签已创建并关闭（tabId=1779786036）

  ```text
  {"ok":true,"result":{"tabId":1779786036,"windowId":1779786034,"receipt":{"method":"tab.new","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","c
  {"ok":true,"result":{"tabs":[{"tabId":1779786028,"windowId":1779786027,"url":"https://demoqa.com/upload-download","title":"demosite","active":true,"owned":"agent","controlled":false,"keepOpen":false,"groupId":1658191622,
  ```

### Y4 DemoQA：视频录制 3s

- **BSK 0.5.0**：失败：{
  "code": "not_found",
  "message": "No tab with id: 1769051549.",
  "hint": "the session, tab, or browser may have stopped; run `bsk session list`  | {
  "code": null,
  "message": "Choose one recording with --recording (0 matches); use bsk video list",
  "hint": "is the daemon running? try `bsk dae | 

  ```text
  {
    "code": "not_found",
    "message": "No tab with id: 1769051549.",
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

- **BridgeDeck 0.3.1**：录制就绪，落盘 1197633 字节

  ```text
  {"ok":true,"result":{"ok":true,"recordingId":"f64b2dc4-5c65-4157-83fc-e6ecfdfb16b8","tabId":1779786039,"mime":"video/mp4","startedAt":1795759619990,"mode":"debugger","durationMs":3000,"recording_state":"recording","budge
  ```

## 差异摘要（自动）

- Y1：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y2：耗时差 +67731ms（BSK 3141ms / BridgeDeck 70872ms）
- Y3：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y4：通过状态不同（BSK 失败 / BridgeDeck 通过）

