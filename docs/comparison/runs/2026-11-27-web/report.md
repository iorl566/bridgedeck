# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T04:37:41.485Z
- 夹具页：http://127.0.0.1:50367/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| W1 | 真实站点：example.com 读取标题 | ✅ 943ms / 2 步 | ✅ 1443ms / 2 步 |
| W2 | 真实站点：点击链接并跳转（example → iana） | ✅ 741ms / 3 步 | ✅ 1586ms / 3 步 |
| W3 | 真实站点：httpbin 表单填写并提交 | ✅ 1604ms / 4 步 | ✅ 2489ms / 4 步 |
| W4 | 真实站点：Microsoft Learn 整页截图 | ❌ 15591ms / 2 步 | ✅ 3330ms / 2 步 |
| W5 | 真实站点：MDN 滚动 + 键盘 | ❌ 8500ms / 3 步 | ✅ 3504ms / 3 步 |
| W6 | 真实站点：Edge 商店页读取 | ❌ 579ms / 2 步 | ✅ 3500ms / 2 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 3/6 | 6/6 |
| 任务耗时合计 | 27958ms | 15852ms |
| CLI 步数合计 | 16 | 16 |

## 逐任务的实测细节

### W1 真实站点：example.com 读取标题

- **BSK 0.5.0**：页面包含 Example Domain

  ```text
  {
    "context_id": "f764e79e-8705-4fa3-ac4c-00eb7c8fae1d",
    "ctx": "c1",
    "history_complete": false,
    "obs": "o1",
    "observation_id": "f558e009-4e17-48c3-a1d8-0b9c8e1850ca",
    "session_id": "gjdb",
    "tab_id": 1769050269,
    "title": "",
    "url": "https://example.com/",
    "vom": "@vom 1\n@view 1241x760\n@layers 1 focus=L1\nL1 page\n  RootWebArea \"Example Domain\"\n    paragraph \"该域名仅用于文档示例，无需获得许可。这并非一项服务，请勿将其用于测试和监控目的。\"\n    paragraph \"This domain is for use in documentation example
  }
  {
    "ok": true,
  ```

- **BridgeDeck 0.3.1**：页面包含 Example Domain

  ```text
  {"ok":true,"result":{"sessionId":"wfae","url":"https://example.com/","title":"Example Domain","observation":null},"schema":"bb.cli/1","command":"open"}
  {"ok":true,"result":{"value":false,"receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","command":"evaluate"}
  ```

### W2 真实站点：点击链接并跳转（example → iana）

- **BSK 0.5.0**：跳转到 iana.org

  ```text
  {
    "tab_id": 1769050269,
    "used_ref": "e3",
    "used_selector": "a",
    "x": 620.5,
    "y": 735.828125
  }
  {
    "ok": true,
    "tab_id": 1769050269,
    "value": "https://www.iana.org/help/example-domains"
  }
  ```

- **BridgeDeck 0.3.1**：跳转到 iana.org

  ```text
  {"ok":true,"result":{"ok":true,"trusted":true,"x":620.5,"y":714.828125,"effectState":"committed","cleanupState":"ok","phase":"pointer","pointer_moves":{"planned":3,"kept":3,"dropped":0,"min_distance_px":1,"max_events":3,
  {"ok":true,"result":{"value":"https://www.iana.org/help/example-domains","receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"
  ```

### W3 真实站点：httpbin 表单填写并提交

- **BSK 0.5.0**：提交后页面包含 BridgeDeck

  ```text
  {
    "tab_id": 1769050269,
    "used_ref": "e51",
    "used_selector": "input[name=\"custname\"]",
    "value_length": 10,
    "actual_value": "BridgeDeck"
  }
  {
    "tab_id": 1769050269,
    "used_ref": "e52",
    "used_selector": "form button",
    "x": 54.15625,
    "y": 664.1875
  }
  ```

- **BridgeDeck 0.3.1**：提交后页面包含 BridgeDeck

  ```text
  {"ok":true,"result":{"ok":true,"trusted":true,"fast":true,"effectState":"committed","cleanupState":"ok","phase":"pointer","fill_strategy":"fast","fill_steps":["insert"],"fill_step_count":1,"fill_needs_clear":false,"fill_
  {"ok":true,"result":{"ok":true,"trusted":true,"x":54.15625,"y":664.1875,"effectState":"committed","cleanupState":"ok","phase":"pointer","pointer_moves":{"planned":3,"kept":3,"dropped":0,"min_distance_px":1,"max_events":3
  {"ok":true,"result":{"value":true,"receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","command":"evaluate"}
  ```

### W4 真实站点：Microsoft Learn 整页截图

- **BSK 0.5.0**：失败：{
  "code": null,
  "message": "create screenshot temporary file C:\\Users\\CFT\\AppData\\Local\\Temp\\.bsk-screenshot-79e026ff84e54567a325a178cee67893.part: 拒绝访问。 (os error 5)",
  "hint": "is the dae (size=0)

  ```text
  {
    "code": null,
    "message": "create screenshot temporary file C:\\Users\\CFT\\AppData\\Local\\Temp\\.bsk-screenshot-79e026ff84e54567a325a178cee67893.part: 拒绝访问。 (os error 5)",
    "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
    "exit_code": 2
  }
  ```

- **BridgeDeck 0.3.1**：整页 PNG 1195327 字节

  ```text
  {"ok":true,"result":{"path":"C:\\Users\\CFT\\AppData\\Local\\Temp\\web-bridge-1795754202690.png","width":1246,"height":11000,"bytes":1195327,"streamed":true},"schema":"bb.cli/1","command":"screenshot"}
  ```

### W5 真实站点：MDN 滚动 + 键盘

- **BSK 0.5.0**：失败：{
  "ok": true,
  "tab_id": 1769050269,
  "value": 0
} | {
  "code": "permission_denied",
  "message": "The strict observation changed before this action",
  "hint": "For data, use read/extract (fixed passive DOM quer

  ```text
  {
    "ok": true,
    "tab_id": 1769050269,
    "value": 0
  }
  {
    "code": "permission_denied",
    "message": "The strict observation changed before this action",
    "hint": "For data, use read/extract (fixed passive DOM queries) without another sync. For a visual action, synchronize and reconsider; use a DOM target with explicit expect facts when possible.",
    "exit_code": 1,
    "data": {
      "effect_state": "none",
      "observation_id": "5a5f67f4-b3c9-4df8-90a4-71ed0863f446",
      "observed_change": {
  ```

- **BridgeDeck 0.3.1**：滚动与按键均成功

  ```text
  {"ok":true,"result":{"value":0,"receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"committed","recovery":null},"effectState":"committed"},"schema":"bb.cli/1","command":"evaluate"}
  {"ok":true,"result":{"ok":true,"trusted":true,"effectState":"committed","cleanupState":"ok","phase":"key","tx_id":"atx_004","journal_id":"aj_mwyhoua2_m3qj_004","replayable":false,"receipt":{"method":"press","ref":null,"f
  ```

### W6 真实站点：Edge 商店页读取

- **BSK 0.5.0**：失败：{
  "code": "cdp_failed",
  "message": "{\"code\":-32000,\"message\":\"Not allowed\"}",
  "hint": "Inspect the application result and synchronize before choosin | {
  "ok": true,
  "tab_id": 1769050269,
  "value": false
}

  ```text
  {
    "code": "cdp_failed",
    "message": "{\"code\":-32000,\"message\":\"Not allowed\"}",
    "hint": "Inspect the application result and synchronize before choosing another action. Never replay an uncertain submission.",
    "exit_code": 3,
    "data": {
      "effect_state": "unknown",
      "phase": "execution",
      "recovery": "Inspect the application result and synchronize before choosing another action. Never replay an uncertain submission."
    }
  }
  {
    "ok": true,
    "tab_id": 1769050269,
  ```

- **BridgeDeck 0.3.1**：商店页包含 BridgeDeck

  ```text
  {"ok":true,"result":{"sessionId":"grnf","url":"https://microsoftedge.microsoft.com/addons/detail/ieflpefpmlmmlfgmpfakaglhgmcbcnig","title":"BridgeDeck - Microsoft Edge Addons","observation":null},"schema":"bb.cli/1","com
  {"ok":false,"error":{"code":"E_INTERNAL","message":"无法在该页面执行脚本（受限页面）: The extensions gallery cannot be scripted.","data":{"receipt":{"method":"evaluate","ref":null,"frameId":0,"revision":0,"effectState":"unknown","recove
  ```

## 差异摘要（自动）

- W1：耗时差 +500ms（BSK 943ms / BridgeDeck 1443ms）
- W2：耗时差 +845ms（BSK 741ms / BridgeDeck 1586ms）
- W3：耗时差 +885ms（BSK 1604ms / BridgeDeck 2489ms）
- W4：通过状态不同（BSK 失败 / BridgeDeck 通过）
- W5：通过状态不同（BSK 失败 / BridgeDeck 通过）
- W6：通过状态不同（BSK 失败 / BridgeDeck 通过）

