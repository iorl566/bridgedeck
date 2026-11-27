# BridgeDeck 架构与规模重写进展

更新：2026-11-27，版本 0.3.1。

## 1. 动作子系统（已拆）

```
tools/interaction.js             ~30 行编排层（re-export + select/focus/滚动/actionable）
├─ tools/pointer-actions.js      click/hover/drag/clickBackend/trusted 路径
├─ tools/pointer-primitives.js   指针位置缓存 + trustedClickPoint
├─ tools/fill-actions.js         fill/press 事务与读回
├─ tools/fill-verify.js          读回字段/目标构造
├─ tools/keyboard.js             按键映射/键盘事务/beginInput/pipeCdp
├─ tools/visual-drag.js          视觉坐标拖拽
├─ tools/action-common.js        目标重试/输入焦点/焦点坐标
└─ lib/transaction-ledger.js     effectState/cleanupState 状态机
```

原则：动作成功统一 `effectState:'committed'`、`cleanupState:'ok'`；
按下后失败统一 `effect_state:'unknown'`，禁止回退二次点击。

## 2. VOM / 计费（已模块化）

```
lib/vom-weights.js     权重、CJK/emoji 估算、分数
lib/vom-profile.js      balanced/compact/all
lib/vom-compact.js      按组裁剪/组 token 预算
lib/vom-section.js      landmark/row/form 锚点
lib/vom-groups.js       语义组 + 组 tokens
lib/vom-semantic.js     组节点 + member 边 + 语义过滤
lib/vom-billing.js      可插拔 billing、o200k 模型、tokenizer 注册
lib/o200k.js            o200k_base BPE（vendor 词表 3.6MB）
lib/vom-funnel.js       漏斗摘要
lib/vom-payload.js      payload 组装
```

**默认 billing model = o200k**；`cjk-heuristic-v2` / `chars-per-4` 保留作对照。

## 3. CLI（部分拆）

```
cli/bridge.mjs                    1,946 行（原 3,199）
├─ commands/files.mjs             upload/download
├─ commands/ui-settings.mjs       ui/settings
├─ commands/page.mjs              页面动作
└─ commands/*.mjs                 network/debug/video/record/pair/...
```

## 4. 规模重写路线（未完成）

1. 继续拆 `cli/bridge.mjs` 的 plan/step/view/cooperate/operation/help 等；
2. 拆 `extension/offscreen.js`（录制编码）与 `video.js`；
3. 把 page-lib 的 4,168 行单文件注入改为可维护构建（受 MV3 单文件注入限制）；
4. 追赶 BSK 的 semantic graph/o200k 之外的内部状态机；
5. Linux/macOS 真机、原生 fsync 属外部项。

当前源码约 760 文件 / 91,016 行；BSK 约 953 / 329,630 行（约 1/4）。
“4x”不是本会话能完成的，需按上述路线分阶段重写。
