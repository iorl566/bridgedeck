# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比

- 生成时间：2026-11-27T04:03:20.533Z
- 夹具页：http://127.0.0.1:54794/test.html
- 浏览器：Microsoft（两个工具各自独立 profile + 扩展 + daemon，顺序执行）
- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案

| 任务 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| R1 | 真实站点：example.com | ✅ 1064ms / 1 步 | ✅ 746ms / 1 步 |
| R2 | 真实站点：GitHub 仓库页 | ❌ 31301ms / 1 步 | ❌ 60900ms / 1 步 |
| R3 | 真实站点：Microsoft Learn 文档 | ❌ 784ms / 1 步 | ✅ 5057ms / 1 步 |

| 汇总 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- |
| 通过 | 1/3 | 2/3 |
| 任务耗时合计 | 33149ms | 66703ms |
| CLI 步数合计 | 3 | 3 |

## 逐任务的实测细节

### R1 真实站点：example.com

- **BSK 0.5.0**：VOM 中读到 Example Domain

  ```text
  {
    "context_id": "2303f8ca-c3b8-4cfa-ac63-4e39a269d45b",
    "ctx": "c1",
    "history_complete": false,
    "obs": "o1",
    "observation_id": "5a4d48d2-80ad-4732-a362-48a25231977a",
    "session_id": "sylg",
    "tab_id": 1769050108,
    "title": "",
    "url": "https://example.com/",
    "vom": "@vom 1\n@view 1256x801\n@layers 1 focus=L1\nL1 page\n  RootWebArea \"Example Domain\"\n    paragraph \"该域名仅用于文档示例，无需获得许可。这并非一项服务，请勿将其用于测试和监控目的。\"\n    paragraph \"This domain is for use in documentation example
  }
  ```

- **BridgeDeck 0.3.1**：VOM 中读到 Example Domain

  ```text
  {"ok":true,"result":{"sessionId":"mprs","url":"https://example.com/","title":"Example Domain","observation":{"url":"","title":"","observation":"- document \"Example Domain\"\n  - paragraph: 该域名仅用于文档示例，无需获得许可。这并非一项服务，请勿将其
  ```

### R2 真实站点：GitHub 仓库页

- **BSK 0.5.0**：失败：{
  "code": "not_found",
  "message": "Document changed during observation; observe again",
  "hint": "rerun `bsk observe` for the current tab and use one of the returned refs",
  "exit_code": 1,
  "data": {
    "reason": "ref_not_found"
  

  ```text
  {
    "code": "not_found",
    "message": "Document changed during observation; observe again",
    "hint": "rerun `bsk observe` for the current tab and use one of the returned refs",
    "exit_code": 1,
    "data": {
      "reason": "ref_not_found"
    }
  }
  ```

- **BridgeDeck 0.3.1**：失败：{"ok":false,"error":{"code":"E_TIMEOUT","message":"命令 navigate 超时（60500ms）","data":{"effect_state":"unknown"},"hint":"加 --timeout，或先确认页面是否卡住","retry":"after-action","usage":"bridge open [url] [--observe] [--wait-for <文本>] [--wait-not <文本>] 

  ```text
  {"ok":false,"error":{"code":"E_TIMEOUT","message":"命令 navigate 超时（60500ms）","data":{"effect_state":"unknown"},"hint":"加 --timeout，或先确认页面是否卡住","retry":"after-action","usage":"bridge open [url] [--observe] [--wait-for <文本>
  ```

### R3 真实站点：Microsoft Learn 文档

- **BSK 0.5.0**：失败：{
  "code": "permission_denied",
  "message": "The strict observation changed before this action",
  "hint": "For data, use read/extract (fixed passive DOM queries) without another sync. For a visual action, synchronize and reconsider; use 

  ```text
  {
    "code": "permission_denied",
    "message": "The strict observation changed before this action",
    "hint": "For data, use read/extract (fixed passive DOM queries) without another sync. For a visual action, synchronize and reconsider; use a DOM target with explicit expect facts when possible.",
    "exit_code": 1,
    "data": {
      "effect_state": "none",
      "observation_id": "01a5896e-420f-426b-8f85-fb54444d3d58",
      "observed_change": {
        "after": "Open more actions menu Latest commit BridgeDeck Dev failure 2 hours ago · 2 hou…",
        "before": "Open more actions menu Latest commit BridgeDeck Dev failure 2 hours ago · 2 hou…",
        "change": "changed",
        "field": "name",
        "name": "Open more actions menu Latest commit BridgeDeck Dev failure 2 hours ago · 2 hou…",
  ```

- **BridgeDeck 0.3.1**：文档页可读

  ```text
  {"ok":true,"result":{"sessionId":"fikb","url":"https://learn.microsoft.com/en-us/microsoft-edge/extensions/","title":"Overview of Microsoft Edge extensions - Microsoft Edge Developer documentation | Microsoft Learn","obs
  ```

## 差异摘要（自动）

- R1：耗时差 -318ms（BSK 1064ms / BridgeDeck 746ms）
- R2：结果与步数一致
- R3：通过状态不同（BSK 失败 / BridgeDeck 通过）

