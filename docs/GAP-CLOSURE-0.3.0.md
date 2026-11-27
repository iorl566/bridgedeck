# BridgeDeck 0.3.0 对标差距清单（Round 217）

> 结论：**可执行行为项已闭环到本地全绿；剩余非外部差距集中在“4x 规模”和
> `page-lib` 单文件注入架构；外部环境项为 Linux/macOS/原生 fsync。**
> 因此目标保持 active，不声明完成。

## 1. 已闭环（有门禁证据）

| 域 | 证据 |
| --- | --- |
| VOM 语义/默认计费 | o200k 默认 BPE；semantic v2；ARIA snapshot；5b/5b2 通过 |
| 录制恢复边界 | 分片扫描/OPFS 恢复/manifest seal/stop 重试；35/35r/35d 通过 |
| 长截图 | 固定页脚/顶栏、分数 DPR、分段；31f/31f2 通过 |
| 协作 | 共享 tab、控制权/租约/handoff、冻结；20q10/20q11/23h 系列 |
| 动作事务 | committed/cleanupState、unknown 语义、fill 校验、浮层 180s TTL；23i/23s/35d |
| 协议/MCP | 165 方法、67 工具、MCP 四分组；selftest 21/21、schema/protocol PASS |
| CI/文档 | preflight、source/encoding/path guard、unit 1025 |
| 全量 | Edge/Chrome 212/212；eval 127/127 attempts=1 |

## 2. 非外部剩余差距

### 2.1 规模（主差距）

- 当前 `node tools/scale-report.mjs`：**760 文件 / 91,016 行**；
- 对 329k 目标 **27.5%**；
- 已把最大产品文件压到：
  - `extension/injected/page-lib.js` 4,158
  - `extension/ui/locales.js` 3,269（生成数据）
  - `extension/src/generated/protocol.js` 2,817（生成代码）
  - `daemon/server.mjs` 1,913
  - `cli/bridge.mjs` 1,947
  - `extension/src/screenshot.js` 814
- 结论：架构拆分显著，但**未达到 4x 规模**。

### 2.2 `page-lib` 单文件注入

- 页面内脚本仍以单文件 `page-lib.js` 注入；
- 受 MV3 `executeScript`/CSP 与跨帧投影约束，未拆成多文件；
- 这是结构性限制，不是行为缺口。

## 3. 外部环境项（本机不可执行）

| 项 | 原因 |
| --- | --- |
| Linux/macOS 真实启动 | 当前仅 Windows Edge/Chrome |
| 原生 fsync 语义 | 浏览器录制使用 readback，`fsync_supported:false` |
| 跨平台安装/签名 | 只验证 Windows 0.3.0，不重新打包 |

## 4. 下一步优先级

1. 继续拆 `page-lib` 的**源模块**（保持构建后单文件注入）；
2. 继续拆 `daemon/server.mjs` 的 route 方法段；
3. 继续拆 `cli/bridge.mjs` 的未迁移命令；
4. 每批定向测试 + 阶段全量；
5. 外部环境具备后再补 Linux/macOS/fsync 门禁。

## 5. 度量入口

```bash
node tools/scale-report.mjs
node --test "tests/unit/*.test.mjs"
node tests/mcp/selftest.mjs
node tools/eval-from-e2e.mjs
node tools/e2e.mjs --browser chrome
```
