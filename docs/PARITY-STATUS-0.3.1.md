# Parity Status — BridgeDeck 0.3.1 vs 兼容目标 0.5.0

> 复核时间：2026-11-27

## 结论

- 矩阵：641 格，**missing 0 / P0 0**；equal 36、partial 333、extra 252、unknown 20。
- P0 工程项（页面 UI 重排、协议/CLI/错误码、浮层 a11y、录制交接、P2 构建/边界字段）均已落地并加门禁。
- 剩余 partial/extra/unknown 为**契约形状/命名/超集**差异，不是缺失能力；逐项说明见 `docs/BSK-REMAINING-GAPS.md`。
- 发布物与商店材料已准备：9 个 artifact（本地验证签名）、5 张 1280×800 截图 + 300×300 图标、listing/审核/隐私文档、CI 工作流与一键发布步骤。

## 发布阻塞（仅凭证）

1. 生产 Ed25519 私钥（当前 keyId `4ee9753d5d93f35d` 仅为本地验证）；
2. GitHub 仓库写权限/token 或本机 gh 登录；
3. Edge Partner Center 的 `EDGE_API_KEY` + `EDGE_PRODUCT_ID`；
4. 此前对话中泄露的 PAT/Edge Key 已作废，需重建后只放 Secrets。

详见 `docs/RELEASE-READINESS-0.3.1.md`、`docs/STORE-PUBLISH-RUNBOOK.md`。
