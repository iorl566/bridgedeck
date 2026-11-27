# Parity Status — BridgeDeck 0.3.1 vs 兼容目标 0.5.0

> 复核时间：2026-11-27

## 结论

- 矩阵：641 格，**missing 0 / P0 0**；equal 36、partial 333、extra 252、unknown 20。
- P0 工程项（页面 UI 重排、协议/CLI/错误码、浮层 a11y、录制交接、P2 构建/边界字段）均已落地并加门禁。
- 剩余 partial/extra/unknown 为**契约形状/命名/超集**差异，不是缺失能力；逐项说明见 `docs/BSK-REMAINING-GAPS.md`。
- 发布物与商店材料已准备：9 个 artifact（本地验证签名）、5 张 1280×800 截图 + 300×300 图标、listing/审核/隐私文档、CI 工作流与一键发布步骤。

## 发布状态

- ✅ GitHub Release `v0.3.1` 已发布（生产密钥 `c7b5e21301f91a2d` 签名，12 个资产）。
- ⏳ Edge 商店：API Key 已有；仍缺 `EDGE_CLIENT_ID` 与 `EDGE_PRODUCT_ID`（Partner Center Extension Identity 的小写 GUID）。
- 本地凭证：`D:\BridgeDeck-secrets`（ACL 仅当前用户）；Edge 补齐两个文件后运行 `tools/publish-edge.ps1`。

详见 `docs/RELEASE-READINESS-0.3.1.md`、`docs/STORE-PUBLISH-RUNBOOK.md`。
