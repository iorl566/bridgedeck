# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T05:03:12.602Z
- 夹具页：http://127.0.0.1:61103/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| X1 | DemoQA：原生 confirm（对话框） | ❌ 3272ms / 3 步 | ✅ 32343ms / 3 步 |
| X2 | DemoQA：文件上传 | ❌ 2463ms / 3 步 | ✅ 31557ms / 3 步 |
| X3 | DemoQA：练习表单填写并提交 | ❌ 6075ms / 5 步 | ✅ 24894ms / 5 步 |
| X4 | DemoQA：动态元素等待（5s 后可用） | ✅ 1446ms / 2 步 | ✅ 30884ms / 2 步 |
| X5 | DemoQA：移动端仿真 + 截图 | ❌ 524ms / 3 步 | ✅ 25586ms / 3 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 1/5 | 5/5 |
| 任务耗时合计 | 13780ms | 145264ms |
| CLI 步数合计 | 16 | 16 |

## 逐任务的实测细节

### X1 DemoQA：原生 confirm（对话框）

- **BSK 0.5.0**：失败：{
  "code": "dialog_pending",
  "message": "Original operation is suspended for a dialog decision; do not repeat it",
  "hint": "inspect `bsk dialog status --se | {
  "tab_id": 1769050732,
  "page_url": "https://demoqa.com/alerts",
  "frame_url": "https://demoqa.com/alerts",
  "frame_id": "6DC21B773D231C4F6742A066587B400E

  ```text
  {
    "code": "dialog_pending",
    "message": "Original operation is suspended for a dialog decision; do not repeat it",
    "hint": "inspect `bsk dialog status --session <id> --json`; decide with dialog accept/dismiss, then retrieve the ORIGINAL result with `bsk operation await <operation-id> --session <id> --json`. Do not repeat the origin
    "exit_code": 6,
    "data": {
      "dialog": {
        "decision_deadline": 1795755829937,
        "default_prompt": "",
        "id": "1b499fcc-1990-4dfc-b917-a8732fea79f0",
        "message": "Do you confirm action?",
        "sequence": 1,
        "tab_id": 1769050732,
        "type": "confirm",
  ```

- **BridgeDeck 0.3.1**：confirm 已接受，页面显示 Ok

  ```text
  {"ok":true,"result":{"ok":true,"trusted":true,"x":627.1796875,"y":376,"effectState":"committed","cleanupState":"ok","phase":"pointer","pointer_moves":{"planned":3,"kept":3,"dropped":0,"min_distance_px":1,"max_events":3,"
  {"ok":true,"result":{"fields":[{"contentEditable":false,"disabled":false,"name":"","readonly":false,"required":false,"tag":"span","type":"span","value":"You selected Ok"}],"revision":25},"schema":"bb.cli/1","command":"re
  ```

### X2 DemoQA：文件上传

- **BSK 0.5.0**：失败：{
  "tab_id": 1769050732,
  "used_ref": "e35",
  "used_selector": "#uploadFile",
  "file_names": [
    "demoqa-upload.txt"
  ]
} | {
  "code": "permission_denied",
  "message": "A page frame changed; synchronize before choosing this action",
  "hint": "Wait for control if needed, synchroniz

  ```text
  {
    "tab_id": 1769050732,
    "used_ref": "e35",
    "used_selector": "#uploadFile",
    "file_names": [
      "demoqa-upload.txt"
    ]
  }
  {
    "code": "permission_denied",
    "message": "A page frame changed; synchronize before choosing this action",
    "hint": "Wait for control if needed, synchronize and inspect the live result before deciding again. Never replay an uncertain action.",
    "exit_code": 1,
    "data": {
  ```

- **BridgeDeck 0.3.1**：文件已进入页面（uploadedFilePath 显示文件名）

  ```text
  {"ok":true,"result":{"names":["demoqa-upload.txt"],"ok":true,"receipt":{"method":"upload","ref":null,"frameId":0,"revision":0,"effectState":"committed","target":{"selector":"#uploadFile"},"recovery":null},"effectState":"
  {"ok":true,"result":{"value":"C:\\fakepath\\demoqa-upload.txt","receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1",
  ```

### X3 DemoQA：练习表单填写并提交

- **BSK 0.5.0**：失败：{
  "tab_id": 1769050732,
  "used_ref": "e63",
  "used_selector": "#firstName",
  "value_length": 6,
  "actual_value": "Bridge"
} | {
  "tab_id": 1769050732,
  "used_ref": "e65",
  "used_selector": "#submit",
  "x": 858.546875,
  "y": 539.0
} | {
  "tab_id": 1769050732,
  "page_url": "https://demoqa.com/automation-practice-form",
  "frame_url": "https://demoqa.com/automation-practice-form",
  "frame_id

  ```text
  {
    "tab_id": 1769050732,
    "used_ref": "e63",
    "used_selector": "#firstName",
    "value_length": 6,
    "actual_value": "Bridge"
  }
  {
    "tab_id": 1769050732,
    "used_ref": "e65",
    "used_selector": "#submit",
    "x": 858.546875,
    "y": 539.0
  }
  ```

- **BridgeDeck 0.3.1**：提交成功（出现 Thanks for submitting the form）

  ```text
  {"ok":true,"result":{"ok":true,"trusted":true,"fast":true,"effectState":"committed","cleanupState":"ok","phase":"pointer","fill_strategy":"fast","fill_steps":["insert"],"fill_step_count":1,"fill_needs_clear":false,"fill_
  {"ok":true,"result":{"ok":true,"trusted":true,"x":858.546875,"y":539,"effectState":"committed","cleanupState":"ok","phase":"pointer","pointer_moves":{"planned":3,"kept":3,"dropped":0,"min_distance_px":1,"max_events":3,"d
  {"ok":true,"result":{"value":false,"receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","command":"evaluate"}
  ```

### X4 DemoQA：动态元素等待（5s 后可用）

- **BSK 0.5.0**：等到按钮 5s 后变为可用

  ```text
  {
    "tab_id": 1769050732,
    "used_selector": "#enableAfter",
    "satisfied": true,
    "attached": true,
    "visible": true,
    "elapsed_ms": 4
  }
  ```

- **BridgeDeck 0.3.1**：等到按钮 5s 后变为可用

  ```text
  {"ok":true,"result":{"satisfied":true,"operationId":"wait-ffb61ece-c3e2-442b-9345-e221c953bb3d","state":"visible","selector":"#enableAfter","ref":null,"attached":true,"visible":true,"elapsedMs":2},"schema":"bb.cli/1","co
  ```

### X5 DemoQA：移动端仿真 + 截图

- **BSK 0.5.0**：失败：{
  "tab_id": 1769050732,
  "cleared": false,
  "applied": {
    "width": 390,
    "height": 844,
    "device_scale_factor": 3.0,
    "mobile": true,
    "user_ | {
  "code": null,
  "message": "write screenshot to C:\\Users\\CFT\\AppData\\Local\\Temp\\emu-bsk-1795755789893.png: 拒绝访问。 (os error 5)",
  "hint": "is the daem

  ```text
  {
    "tab_id": 1769050732,
    "cleared": false,
    "applied": {
      "width": 390,
      "height": 844,
      "device_scale_factor": 3.0,
      "mobile": true,
      "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "touch": true,
      "max_touch_points": 5
    },
    "note": "emulation overrides are per-tab (CDP target): new tabs do not inherit them — re-run `bsk emulate` on each new tab"
  }
  ```

- **BridgeDeck 0.3.1**：仿真宽度进入手机区间且截图成功

  ```text
  {"ok":true,"result":{"ok":true,"applied":{"viewport":{"width":390,"height":844},"userAgent":"Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safa
  {"ok":true,"result":{"path":"C:\\Users\\CFT\\AppData\\Local\\Temp\\emu-bridge-1795755759890.png","width":1170,"height":2532,"bytes":181650},"schema":"bb.cli/1","command":"screenshot"}
  ```

## 差异摘要（自动）

- X1：通过状态不同（BSK 失败 / BridgeDeck 通过）
- X2：通过状态不同（BSK 失败 / BridgeDeck 通过）
- X3：通过状态不同（BSK 失败 / BridgeDeck 通过）
- X4：耗时差 +29438ms（BSK 1446ms / BridgeDeck 30884ms）
- X5：通过状态不同（BSK 失败 / BridgeDeck 通过）

