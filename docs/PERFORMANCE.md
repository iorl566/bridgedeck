# 性能基线（本地微基准）

`npm run bench` / `node tools/bench.mjs [--json]`：只跑**纯函数与账本写入**，不启动浏览器，
用于同机前后对比与回归排查。数值与机器强相关，不对外承诺绝对速度。

## 基线（2026-11-19，Windows，Node v24.21.0）

两次运行的范围（机器负载不同）：账本 **2.2–3.0 ms/op**、vom-graph 600n/1200e **0.76–1.03 ms/op**、
frame-vom 8f×60n **0.88–0.93 ms/op**。下表取较空载的一次：

| 基准 | 规模 | 结果 |
| --- | --- | --- |
| intent-ledger begin+finish | 200 次动作 | **2.21 ms/op**（45.2 ops/s） |
| vom-graph 归一化 | 600 节点 / 1200 边 | **0.76 ms/op**（131.5 ops/s） |
| frame-vom 跨帧子图 | 8 帧 × 60 节点 | **0.88 ms/op**（114.2 ops/s） |

> 对比时用同一次运行区间；负载高时账本项可升到 ~3ms/op，属正常波动。

## CLI 冷启动（2026-11-20，Windows，Node v24.21.0）

CLI 拆分（`cli/lib/*`、`cli/commands/*`）后确认按需加载没有拖慢启动；用 5 次 `bridge help` 取中位数：

| 阶段 | 中位数 |
| --- | --- |
| 进程 wall | **100.7 ms** |
| `module-body`（模块顶层求值） | **61 ms** |
| `main`（分发开始） | **62 ms** |
| `args-parsed`（参数解析完成） | **62 ms** |

复测：

```powershell
npm run startup                 # 人类可读
node tools/startup.mjs --json   # 机器可读（--runs N 可调采样数）
```

> `BB_STARTUP_TRACE=1` 时阶段行打在 stderr，不影响 `--json` 的 stdout 单行契约。

## 本轮相关优化

- 账本：`begin` 仍同步 WAL；`finish`/`resolve`/`reconcile` 合并 25ms 落盘，daemon 停止前 `flush()`。
  同机 300 次 begin+finish 从 **4.96 → 2.24 ms/action**（优化前用临时脚本测得）。
- 会话持久化：compact JSON + 80ms 合并；session start/stop 与 daemon 停止立即写。
- 大截图：`screenshot --stream` + `screenshot.read/release` 分块，单次 RPC 不再带数 MB dataUrl。
- 内存：tab 关闭清理按 tabId 记账的输入窗口/指针位置/截图基线；daemon 人工事件限流表定期清理。

## 怎么用

```powershell
npm run bench                 # 人类可读
node tools/bench.mjs --json   # 机器可读
```

改动热路径（vom-graph / frame-vom / 账本 / 提取）后跑一次，与上表同机对比；差异 >30% 时排查回归。

## 未引用模块扫描

```powershell
npm run audit:unused          # 人类可读（advisory，不阻断）
node tools/unused-extension-modules.mjs --json --fail
```

从 manifest 声明的入口（service worker / content scripts / popup / options）与 HTML `<script>` 出发，
跟踪相对 `import`/`export ... from`/动态 `import()`；同时把 `cli/bridge.mjs`、`daemon/server.mjs`、
`mcp/server.mjs`、`sdk/index.mjs` 作为共享入口（扩展 `src` 里的模块会被它们直接 import）。
2026-11-19 扫描 150 个模块、0 未引用。
