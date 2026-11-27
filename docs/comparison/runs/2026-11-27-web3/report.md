# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T05:43:56.903Z
- 夹具页：http://127.0.0.1:60115/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| Y1 | DemoQA：点击下载文件 | ❌ 32797ms / 3 步 | ✅ 32820ms / 3 步 |
| Y2 | DemoQA：网络抓包（debug start → requests） | ❌ 4432ms / 5 步 | ✅ 66789ms / 5 步 |
| Y3 | 多标签页：新开 + 列出 + 关闭 | ❌ 3954ms / 4 步 | ✅ 2796ms / 4 步 |
| Y4 | DemoQA：视频录制 3s | ❌ 164ms / 3 步 | ❌ 66211ms / 3 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 0/4 | 3/4 |
| 任务耗时合计 | 41347ms | 168616ms |
| CLI 步数合计 | 15 | 15 |

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
  {"ok":true,"result":{"downloadId":3,"filename":"C:\\Users\\CFT\\Downloads\\sampleFile (2).jpeg","bytes":4096,"state":"complete","url":"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEBUSEhAVFRUVFQ8VFRUVEA
  ```

### Y2 DemoQA：网络抓包（debug start → requests）

- **BSK 0.5.0**：失败：{
  "code": null,
  "message": "--session is required except for offline capabilities",
  "hint": "is the daemon running? try `bsk daemon start` or `b | {
  "code": "permission_denied",
  "message": "The strict observation changed before this action",
  "hint": "For data, use read/extract (fixed passiv | {
  "code": null,
  "message": "--session is required except for offline capabilities",
  "hint": "is the daemon running? try `bsk daemon start` or `b

  ```text
  {
    "code": null,
    "message": "--session is required except for offline capabilities",
    "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
    "exit_code": 2
  }
  {
    "code": null,
    "message": "--session is required except for offline capabilities",
    "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
    "exit_code": 2
  }
  ```

- **BridgeDeck 0.3.1**：抓到 ≥3 条请求

  ```text
  {"ok":true,"result":{"ok":true,"tabId":1779785133,"startedAt":1795758045900,"receipt":{"method":"debug.start","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"sch
  {"ok":true,"result":{"entries":[{"id":1,"requestId":"2C0F6A98CF2B5858D3D512A72344AD8A","method":"GET","url":"https://demoqa.com/text-box","status":200,"type":"Document","resourceType":"Document","mime":"text/html","proto
  ```

### Y3 多标签页：新开 + 列出 + 关闭

- **BSK 0.5.0**：失败：{
  "tab_id": 1769050838,
  "window_id": 1769050835,
  "url": ""
} | {
  "tabs": [
    {
      "tab_id": 1769050786,
      "title": "about:blank",
      "url": "about:blank",
      "window_id": 1769050784,
      "active | {
  "tab_id": 1769050838
}

  ```text
  {
    "tab_id": 1769050838,
    "window_id": 1769050835,
    "url": ""
  }
  {
    "tabs": [
      {
        "tab_id": 1769050786,
        "title": "about:blank",
        "url": "about:blank",
        "window_id": 1769050784,
        "active": true,
        "scope": "user"
  ```

- **BridgeDeck 0.3.1**：新标签已创建并关闭（tabId=1779785136）

  ```text
  {"ok":true,"result":{"tabId":1779785136,"windowId":1779785134,"receipt":{"method":"tab.new","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","c
  {"ok":true,"result":{"tabs":[{"tabId":1779785128,"windowId":1779785127,"url":"https://demoqa.com/upload-download","title":"demosite","active":true,"owned":"agent","controlled":false,"keepOpen":false,"groupId":1516850502,
  ```

### Y4 DemoQA：视频录制 3s

- **BSK 0.5.0**：失败：{
  "code": "not_found",
  "message": "No tab with id: 1769050838.",
  "hint": "the session, tab, or browser may have stopped; run `bsk session list`  |  | {
  "browser": "418146c0",
  "recordings": []
}

  ```text
  {
    "code": "not_found",
    "message": "No tab with id: 1769050838.",
    "hint": "the session, tab, or browser may have stopped; run `bsk session list` / `bsk browsers` to see current state",
    "exit_code": 1
  }
  
  {
    "browser": "418146c0",
    "recordings": []
  }
  ```

- **BridgeDeck 0.3.1**：失败：{"ok":true,"result":{"ok":true,"recordingId":"9a432018-91c3-4b8b-b91e-0d0bd0f112e7","tabId":1779785139,"mime":"video/mp4","startedAt":1795758120349,"m | {"ok":false,"error":{"code":"E_NOT_FOUND","message":"找不到录制 9a432018-91c3-4b8b-b91e-0d0bd0f112e7 trace=[]","hint":"重新 observe 确认目标是否还在","retry":"after- | {"ok":true,"result":{"ok":true,"recordings":[]},"schema":"bb.cli/1","command":"video","subcommand":"list","page":{"returned":0,"total":0,"totalExact":

  ```text
  {"ok":true,"result":{"ok":true,"recordingId":"9a432018-91c3-4b8b-b91e-0d0bd0f112e7","tabId":1779785139,"mime":"video/mp4","startedAt":1795758120349,"mode":"debugger","durationMs":3000,"recording_state":"recording","budge
  ```

## 差异摘要（自动）

- Y1：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y2：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y3：通过状态不同（BSK 失败 / BridgeDeck 通过）
- Y4：结果与步数一致

