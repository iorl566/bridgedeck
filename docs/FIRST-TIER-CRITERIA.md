# 第一梯队验收清单（BridgeDeck 0.3.0）

目标：用可验证的工程指标判断 BridgeDeck 是否进入浏览器自动化“第一梯队”，而不是靠功能数量或体量。
版本保持 **0.3.0**，不升号、不重新打包、不发版。

## 1. 深度能力

| # | 能力 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 1 | VOM 分层/视觉对象/稳定身份 | `observe.layers`、`visualObjects`、`refDetails`；stableRef 驱动 click/fill/select/read/hover/actionable | ✅ |
| 2 | OOPIF / iframe 几何 | owner 链投影；scale/scroll/rotate/skew/matrix3d；E2E 23p2–23p9 | ✅ |
| 3 | 3D perspective 深投影 | 祖先 perspective + homography；E2E 23p9 | ✅ |
| 4 | 协作 authority / stale | 内容脚本 stale 拒绝、后台 generation 对齐、`E_COOPERATION_STALE`、E2E 23j2 | ✅ |
| 5 | 长截图恢复 | IndexedDB 分片 + manifest + 恢复 UI；E2E 31b | ✅ |
| 6 | 超长/超宽 capture | >12000px 自动 CDP 2D 分块；31c/31d/31e（35000px） | ✅ |
| 7 | 视频完帧恢复 | 分片扫描 → 重建 → save magic；E2E 35r | ✅ |
| 8 | capture suppression | ref-counted + 真实 2 rAF ack（无固定 sleep） | ✅ |
| 9 | 12 语言 + 完整 RTL | ar/he 全量 UI/浮层，方向自动；E2E 29d | ✅ |

## 2. 质量门禁

| 门禁 | 目标 | 状态 |
| --- | --- | --- |
| 单测 + reference | 全绿，0 skip | ✅ |
| 真实 Edge E2E | 全绿，0 skip | ✅ 190 |
| eval corpus | ≥103 条真实浏览器 case | ✅ 103 |
| 架构/性能/故障注入/契约 | 全绿 | ✅ |
| source guard / vendor leak | clean | ✅ |
| release preflight | PASS（制品哈希/签名/版本） | ✅ |
| 复杂度 | 非生成文件 ≤1100 行；循环依赖 0 | ✅ |

## 3. 可运维性

| # | 能力 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 1 | CI 单测/守卫 | `quality.yml` 在 push/PR 跑单测、source guard、vendor | ✅ |
| 2 | CI 真实浏览器 E2E | `real-browser-e2e.yml` 在 push/PR 跑 `eval-from-e2e` | ✅ |
| 3 | 发布链路 | 九制品、签名 manifest、preflight | ✅ |
| 4 | 文档契约 | HANDOFF/QUALITY/REFACTOR/TEST-STATUS/FIRST-TIER 同步 | ✅ |

## 4. 判定

- 1–9 项全部满足，质量/运维门禁全绿；
- 投影覆盖无 perspective 与单层祖先 perspective；更深的 3D 嵌套/超 40000px 作为后续边界；
- 结论：**达到第一梯队**。

下一次加深的候选：多层 3D 嵌套、超大高度/宽度 >40000px、复杂 VOM/cooperation 状态机。
