# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T03:20:07.564Z
- 夹具页：http://127.0.0.1:64631/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| T1 | 打开页面并读取结构 | ✅ 1149ms / 1 步 | ✅ 1645ms / 1 步 |
| T2 | 填表 + 提交 + 回读结果 | ✅ 1818ms / 5 步 | ✅ 1909ms / 5 步 |
| T3 | 表格提取（人员表 3×3） | ✅ 118ms / 1 步 | ✅ 289ms / 1 步 |
| T4 | 视口截图落盘 | ❌ 234ms / 1 步 | ✅ 583ms / 1 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 3/4 | 4/4 |
| 任务耗时合计 | 3319ms | 4426ms |
| CLI 步数合计 | 8 | 8 |

## 逐任务的实测细节

### T1 打开页面并读取结构

- **BSK 0.5.0**：页面结构与人员表可见

  ```text
  {
    "context_id": "cb2fabc3-04b0-4dfe-84b3-28c8075b1008",
    "ctx": "c1",
    "history_complete": false,
    "obs": "o1",
    "observation_id": "daceda6e-a0c8-4793-bd58-5ad2964e823b",
    "session_id": "brzc",
    "tab_id": 1769049783,
    "title": "",
    "url": "http://127.0.0.1:64631/test.html",
    "vom": "@vom 1\n@view 1241x760\n@layers 1 focus=L1\nL1 page\n  RootWebArea \"BridgeDeck E2E 夹具页\"\n    main \"E2E 夹具页 这个页面供BridgeDeck 的端到端测试使用：填表、点按钮、读回结果、导出表格、拖拽、上传、对话框、网络。 关键词 类型 同意条款 密码 结果： 未提交 详情 详情段落内容。 人员表 姓名 城市 
  ```

- **BridgeDeck 0.3.1**：页面结构与人员表可见

  ```text
  {"ok":true,"result":{"sessionId":"zuol","url":"http://127.0.0.1:58349/test.html","title":"BridgeDeck E2E 夹具页","observation":{"url":"","title":"","observation":"frame 0 http://127.0.0.1:58349/test.html\n- document \"Bridg
  ```

### T2 填表 + 提交 + 回读结果

- **BSK 0.5.0**：结果文本 clicked:hello:b:yes 与预期一致

  ```text
  fill #kw --value hello --json -> 0 (170ms)
  select #kind --value b --json -> 0 (294ms)
  click #agree --json -> 0 (850ms)
  click #submit-btn --json -> 0 (420ms)
  read --selector #out --json -> 0 (84ms)
  {
    "tab_id": 1769049783,
    "page_url": "http://127.0.0.1:64631/test.html",
    "frame_url": "http://127.0.0.1:64631/test.html",
    "frame_id": "57AC294A4FD5FA464C08B39C707B02CD",
    "title": "E2E 夹具页 · 已提交",
    "captured_at": "2026-11-27T03:19:47.308Z",
    "items": [
      {
  ```

- **BridgeDeck 0.3.1**：结果文本 clicked:hello:b:yes 与预期一致

  ```text
  fill #kw --value hello --json -> 0 (415ms)
  select #kind --value b --json -> 0 (319ms)
  click #agree --json -> 0 (370ms)
  click #submit-btn --json -> 0 (527ms)
  read --selector #out --json -> 0 (278ms)
  {"ok":true,"result":{"fields":[{"contentEditable":false,"disabled":false,"name":"","readonly":false,"required":false,"tag":"strong","type":"strong","value":"clicked:hello:b:yes"}],"revision":19},"schema":"bb.cli/1","comm
  ```

### T3 表格提取（人员表 3×3）

- **BSK 0.5.0**：6 个单元格值齐全

  ```text
  {
    "schema_version": 1,
    "kind": "table",
    "tab_id": 1769049783,
    "source": {
      "page_url": "http://127.0.0.1:64631/test.html",
      "frame_url": "http://127.0.0.1:64631/test.html",
      "frame_id": "57AC294A4FD5FA464C08B39C707B02CD",
      "title": "E2E 夹具页 · 已提交",
      "captured_at": "2026-11-27T03:19:47.423Z",
      "selector": "#people"
    },
    "columns": [
      {
  ```

- **BridgeDeck 0.3.1**：6 个单元格值齐全

  ```text
  {"ok":true,"result":{"budget":{"bytes":550,"cells":9,"maxBytes":262144,"maxCells":20000,"maxRows":500,"offset":0,"rows":3,"stopReason":"end"},"cells":9,"columnCount":3,"columns":[{"key":"c1","label":"姓名"},{"key":"c2","la
  ```

### T4 视口截图落盘

- **BSK 0.5.0**：截图失败：{
  "code": null,
  "message": "write screenshot to C:\\Users\\CFT\\AppData\\Local\\Temp\\cmp-bsk-1795749587441.png: 拒绝访问。 (os error 5)",
  "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
  "exit_code": 2
}

  ```text
  {
    "code": null,
    "message": "write screenshot to C:\\Users\\CFT\\AppData\\Local\\Temp\\cmp-bsk-1795749587441.png: 拒绝访问。 (os error 5)",
    "hint": "is the daemon running? try `bsk daemon start` or `bsk status`",
    "exit_code": 2
  }
  ```

- **BridgeDeck 0.3.1**：PNG 36994 字节

  ```text
  {"ok":true,"result":{"path":"C:\\Users\\CFT\\AppData\\Local\\Temp\\cmp-bridge-1795749601674.png","width":1256,"height":760,"bytes":36994},"schema":"bb.cli/1","command":"screenshot"}
  ```

## 差异摘要（自动）

- T1：耗时差 +496ms（BSK 1149ms / BridgeDeck 1645ms）
- T2：耗时差 +91ms（BSK 1818ms / BridgeDeck 1909ms）
- T3：耗时差 +171ms（BSK 118ms / BridgeDeck 289ms）
- T4：通过状态不同（BSK 失败 / BridgeDeck 通过）

