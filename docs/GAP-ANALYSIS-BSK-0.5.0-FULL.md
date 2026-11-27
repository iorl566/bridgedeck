# BSK 0.5.0 能力差距全量清单（BridgeDeck 0.1.9 对照）

日期：2026-11-18（BridgeDeck 0.1.11）。对照源：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`。
说明：这是**能力差距**清单，不是“必须全部补齐”的待办。哪些补、哪些不补，取决于 BridgeDeck 的产品定位。

## 0.1 0.1.10/0.1.11 之后的变化

已补：

- `observe.layers` + L1/L2 文本 + `tokenEstimate`；
- `observe.refDetails`（@eN + backendNodeId + frameId + documentId + revision）；
- frame alias 携带 URL/documentId；
- 单层 iframe owner-quad 投影（trusted click），失败回退 frame 内 page-lib；
- 控制呼吸框恢复 0.1.7 级清晰度；
- 发布包 vendor-clean 与 preflight 门禁。

仍然只是“部分”：

- refDetails 是**元数据**，动作仍按页面内 @eN 解析，不是 backendNodeId/CDP 路由；
- 投影只支持当前文档直接 iframe，没有嵌套 frame、滚动容器、transform/zoom 链；
- layers 只覆盖 dialog/overlay，不是完整 VOM 分层；
- 没有 stable refs 协商、opaque revision cursor、视觉对象模型。

## 0. 结论

BridgeDeck 0.1.9 已经有：

- 148/148 真实 Edge E2E；
- 10 语言 UI 与内容浮层；
- 本机/远程 daemon、配对、scope、renew、revoke、只读+点击/按键 viewer；
- 九制品、签名 release、Edge/GitHub 发布链路。

但和 BSK 0.5.0 相比，**深度能力**仍有明显差距，集中在四块：

1. **VOM/视觉对象模型**：BSK 有独立 `packages/vom`（11 文件、5,370 行），我们只有页面侧 DOM 观察 + 截图；
2. **协作 capture/state**：BSK `cooperation` 22 文件、14,441 行；我们只有输入锁/read/mode/target marker；
3. **frame 几何/身份**：我们刚补 canonical frame identity 和 frame-local 点击，但仍没有 OOPIF owner-quad 投影；
4. **评测体系**：BSK 有 25 个 browser eval case 文件和 tri-state oracle；我们主要靠单测 + 单条 E2E。

量化：

| 指标 | BSK 0.5.0 | BridgeDeck 0.1.9 |
| --- | ---: | ---: |
| 扩展源码 | 556 JS/TS 文件、188,711 行 | 121 运行时 JS、29,158 行 |
| 工具层 | 184 文件、84,007 行 | `extension/src/tools` 约 1.2 万行 |
| cooperation | 22 文件、14,441 行 | 约 2.5k 行 |
| VOM | 11 文件、5,370 行 | 无独立 VOM |
| DSH 插件 | 81 文件、25,407 行 | 26 项 selftest |
| eval case | 25 文件、7,038 行 | 无 case corpus |
| 扩展包 | 未同机对照 | 432,005 B / 142 entries |

> 行数不是能力本身，但能解释为什么 BSK 在复杂页面、跨帧、协作边界上更稳。

## 1. 观察与引用（最大差距）

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| DOM/VOM 6 阶段漏斗 | `tools/observation.ts` + `packages/vom` | page-lib DOM 树 + AX/VOM 混合 | 部分 |
| 分层文档（页面/遮挡层） | `@layers`、`L1/L2`、遮挡原因 | `blockingLayers` 侧数组，无分层文本 | 缺 |
| 视觉对象模型 | visual nodes / visual region / 截图区域 | 截图 + 按图坐标点击 | 部分 |
| Ref 身份 | backendNodeId + frameId + cdpSessionId + revision | `@eN` + frame alias + documentId（部分） | 部分 |
| Stable refs 协商 | 有 | 无 | 缺 |
| 文档 revision 失效 | 有 | 有 revision，但 ref 未统一绑定 | 部分 |
| Observation cursor | opaque、revision-bound、可重试 | `{t,o,at}` 字符 offset | 部分 |
| Token 预算估算 | 预分词器 + 每行成本 + header/footer | 字符 run 启发式 | 部分 |
| 遮挡/覆盖率 | coverage/occluded 明确 | blockers 侧数组 | 部分 |
| Canvas/视觉区域 | visual screenshot/region | 截图 + image click | 部分 |

**影响**：复杂后台、表格、Canvas、遮挡弹窗、跨帧页面，BSK 的观察更“可决策”，我们的 ref 更容易 stale。

## 2. 输入与动作

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| Ref/selector 二选一 | 有 | 有 | 对齐 |
| Target hit/reachability | `target-hit.ts`、OOPIF 投影 | hit-test + frame-local 回退 | 部分 |
| Input readiness | 可见性→override→双 rAF→revision | 两帧 + 复采样 + focus 守卫 | 部分 |
| Focus lease | attachment 维度 | tab 级 focus cache | 部分 |
| Pointer transaction | pointer-transaction.ts | input lease + trusted click + 按下后 unknown/禁止双点击 | 部分（已补 unknown） |
| File input/drop transaction | file-input/file-drop transaction | upload/download | 部分 |
| 拖拽 move-click-move | 有 | drag | 部分 |
| Replaced target | fail closed，不重放 | 0.1.9 fail closed（synthetic/selector） | 部分（trusted 仍待） |
| Scroll-to/wait-for-element | 有 | 有 | 对齐 |
| Frame 几何 | owner-quad 投影 | owner-quad + affine/matrix3d/perspective homography，E2E 23p2–23p9 | 对齐 |
| 软 detach/重连 | document/child signature | attachment version + read gate | 部分 |

**影响**：跨源 iframe、复杂布局、缩放/滚动容器、文件拖放，BSK 更稳。

## 3. 协作 / 共享控制

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| 人类/Agent 状态机 | 完整 controller | mode/read/revision + 输入锁 | 部分 |
| FrameState 计数器 | 文档/结构/文本/人类/忙碌 | 只读快照 | 缺 |
| Authority revision | 有 | 有 generation/revision（简化） | 部分 |
| Capture suppression | ref-counted，2 rAF ack | executeScript + 80ms sleep | 部分 |
| Passthrough | 每 click token + input outcome | 输入锁 + passthrough TTL | 部分 |
| Borrow | reserve/确认/回滚 | reservation + 确认 | 部分 |
| Target marker/toolbar | 完整 target/toolbar | marker + mode 简化 | 部分 |
| 人类输入归因 | 时钟校准 | command window + isolated marker | 部分 |

**影响**：共享控制、录制期间的 Agent/人类归因、复杂协作恢复，BSK 更完整。

## 4. Frame / OOPIF

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| Frame graph | target/session/owner 完整 | canonical frameId + URL | 部分 |
| OOPIF target | CDP target/session | chrome frameId | 部分 |
| 跨帧坐标投影 | frame-geometry | 无 | 缺 |
| 不可达 frame 证据 | unavailableFrames | 有 frame error 字段 | 部分 |
| 导航后 frame 重建 | 有 | 0.1.9 record/observe 部分处理 | 部分 |
| Cross-frame hover/menu | 有 | 20d7 已作为已知边界 | 缺 |

## 5. 捕获 / 视频 / 调试

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| 长截图 | 磁盘分片 + index.json | 内存 canvas 拼接 | 缺 |
| 视频 | fragmented MP4 + 完帧重封装 | video encoder/Blob | 部分 |
| 视频恢复 | 有 | 无 | 缺 |
| Debug journal | IndexedDB 归档 + coverage | debug 内存/存储 | 部分 |
| 请求/响应正文 | 有 | network/debug 部分 | 部分 |
| 脱敏 | 源保留式 JSON 脱敏 | redact 规则 | 部分 |
| Replay | 有 | 有 replay/rule | 部分 |
| 证据包 | 有 | debug evidence | 部分 |

## 6. 协议 / 错误 / 版本

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| Method catalog | 78 variants 单一 catalog | 141 方法，手写集合 | 部分 |
| Feature floors | 每方法/组件 | 5 个特性 | 部分 |
| Schema | 生成 + 校验 | schema + 校验 | 部分 |
| Error taxonomy | code/reason/effect/recovery/exit | 140 codes + effect_state | 部分 |
| Compatibility status | 有 | 0.1.9 status.compatibility | 对齐 |
| 旧端行为 | 明确 | featureShortfall | 部分 |

## 7. Daemon / CLI / 安装

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| 单实例 lock | 有 | 端口/daemon.json | 部分 |
| probe/verify | pid+协议 | health/port | 部分 |
| IPC/RPC | 完整 | WS/HTTP | 对齐 |
| session 恢复 | 有 | start journal | 部分 |
| Skill install | 事务/回滚 | install-skill | 部分 |
| 多 agent 集成 | 8 harness | CLI/MCP/DSH | 部分 |
| 远程 | remote extension | pairing/scope/renew/view | 对齐/部分领先 |

## 8. UI / i18n / 可访问性

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| 10 语言 | 有 key-based | 有 251+54 条 | 对齐/部分 |
| Token/主题 | 有 | 有 | 对齐 |
| 组件化 | React | 原生 DOM | 不同 |
| A11y | 较完整 | 浮层有基础 | 部分 |
| RTL | 有 | 无 | 缺 |
| 设计系统 | packages/ui | ui.css/tokens | 部分 |

## 9. 测试 / 评测 / 发布

| 能力 | BSK | BridgeDeck | 状态 |
| --- | --- | --- | --- |
| 单测 | 255 test 文件 | 474 项 | 对齐 |
| Browser E2E | eval case + browser tests | 148 项 E2E | 对齐/部分 |
| Case/oracle | 25 case 文件、tri-state | 无 case corpus | 缺 |
| 真实浏览器 CI | 有 | 本机 E2E，无 CI lane | 缺 |
| Seeded generator | 有 | 无 | 缺 |
| DSH plugin | 81 文件 | 26 项 selftest | 部分 |
| 九制品 | 有 | 有 | 对齐 |
| 签名/上架 | 有 | 0.1.9 签名 + Edge/GitHub | 对齐 |

## 10. 明确不建议照搬

1. **不复制 React/WXT**：我们的零构建 UI 是产品优势；组件化概念可以借，框架不搬。
2. **不复制 2,614 行 ChromiumCdp 单类**：拆成 attachment/frames/signatures 小模块。
3. **不复制所有 VOM 启发式**：只保留通用 compaction，不要站点/地域特判。
4. **不为了“能力”引入无界队列/无界字符串**。
5. **不把 skip 当 pass**：0.1.9 已强制 skip 失败。

## 11. 建议优先级

### P0（如果目标是“Agent 控制质量”）

1. VOM 分层文档 + 视觉 facts/region；
2. Ref 复合身份（backendNodeId + frame/session + revision）；
3. OOPIF owner-quad 投影；
4. Cooperation capture/state（counter、authority revision、capture suppression）。

### P1（如果目标是“可恢复/可审计”）

5. 长截图磁盘分片、视频 fragmented + 恢复；
6. Debug journal/IndexedDB/coverage；
7. Eval case corpus + 浏览器 CI lane。

### P2（体验/维护）

8. RTL、a11y、组件化；
9. soft-detach signature、pointer/file transaction；
10. 完整 method catalog/feature floors。

## 12. 最终判断

**“变轻”没有让 0.1.9 降级到不可用**：它已经能完成本机/远程自动化、录制、协作、发布，并全绿。

**但 BSK 0.5.0 仍是更深的浏览器自动化引擎**，尤其在 VOM/视觉、cooperation capture、跨帧几何、评测语料上。  
下一阶段不应再“补测试”，而应选择是否投入这四块深度能力；如果只做本地 CLI + 远程控制，现有架构已经足够，不必为了“像 BSK”而变大。
