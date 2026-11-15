# 9 站实测：BridgeDeck 协议 1.9

> 复测时间：2026-11-15。浏览器：Edge 157（未登录、逐站独立会话、先建立会话再逐站导航）。
> 原始数据：`.tmp-bench/out-bridge050g/`；聚合脚本：`.tmp-bench/bench-bridge.mjs`、`compare050.mjs`。

## 1. 测试配置

- 实例：`6a7751ff`，扩展 0.1.2，daemon 本机。
- 每个站点单独 `session start` → `navigate` → `observe` → `evaluate` → `screenshot` → `session stop`。
- 异常页（超时/网络错误）保留在结果中，不计入中位数统计。

## 2. 逐站结果

| 站点 | 导航（ms） | 观察 refs / 字符 | 脚本验证型（ms） | 截图（ms / 大小） |
| --- | --- | --- | --- | --- |
| baidu | 783 | 33 / 3547 | 124 | 283 / 95 KB |
| bing | 516 | 29 / 2519 | 152 | 670 / 1140 KB |
| github | 超时 | — | — | — |
| zhihu | 1949 | 39 / 2491 | 258 | 320 / 450 KB |
| bilibili | 1287 | 84 / 8049 | 138 | 388 / 690 KB |
| taobao | 1938 | 200 / 9721 | 191 | 391 / 445 KB |
| jd | 880 | 74 / 7606 | 441 | 566 / 180 KB |
| douban | 1044 | 429 / 10013 | 160 | 328 / 360 KB |
| wikipedia | 错误页 | 0 / 1077 | 107 | 246 / 28 KB |

## 3. 中位数

| 指标 | 数值 |
| --- | --- |
| 导航 | 1166 ms |
| 观察 | 186 ms |
| 脚本验证型 | 156 ms |
| 截图 | 358 ms |
| 会话启动 | 367 ms |

## 4. 观察管线双跑校验（`--compare-ax`）

同一批站点上开启双跑校验（视口内、排除自家浮层）：

| 站点 | 视口内交互节点 | VOM 命中 | 覆盖率 |
| --- | --- | --- | --- |
| baidu | 33 | 32 | 0.970 |
| bing | 34 | 27 | 0.794 |
| github | 8 | 4 | 0.500 |
| zhihu | 38 | 38 | 1.000 |
| bilibili | 54 | 54 | 1.000 |
| taobao | 106 | 105 | 0.991 |
| jd | 46 | 39 | 0.848 |
| douban | 12 | 12 | 1.000 |
| wikipedia | 2 | 0 | 0（错误页） |

- 覆盖率中位 **0.970**；AX 管线中位 139ms vs page-lib 76ms。
- 结论：page-lib 继续作为默认采集器；AX 管线用于降级与校验。

## 5. 任务级

Bing 搜索全流程（建会话 → 导航 → 观察 → 填写 → 提交 → 读结果）：**2271/2382ms**（两次），与常驻路径的差距主要来自 CLI 启动。

## 6. 复现

```powershell
$env:BB_BENCH_BROWSER='<instanceId>'
node .tmp-bench/bench-bridge.mjs .tmp-bench/out-bridge050g
node .tmp-bench/bench-compare050.mjs .tmp-bench/out-compare050b <instanceId>
```
