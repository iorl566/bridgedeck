# 商店更新流程

最后更新：2026-11-16。版本：0.1.3。

## 结论

Edge 商店**不支持覆盖已提交/已上架的同一版本号**。更新分两种情况：

| 当前状态 | 操作 |
| --- | --- |
| 0.1.3 仍在审核中 | 取消审核后重新提交 0.1.3，或等审核结束后发布 0.1.4 |
| 0.1.3 已上架 | 新版本号必须大于 0.1.3（例如 0.1.4） |

同版本包的 GitHub Release 可以替换；商店包不能。

## 工具

```sh
# 只上传到 draft，不提交发布（适合先检查包）
EDGE_API_KEY=... EDGE_CLIENT_ID=... EDGE_PRODUCT_ID=... \
  node tools/edge-publish.mjs \
  --package dist/BridgeDeck-extension-0.1.3.zip \
  --notes-file docs/releases/0.1.3.md \
  --draft-only

# 上传并提交发布
EDGE_API_KEY=... EDGE_CLIENT_ID=... EDGE_PRODUCT_ID=... \
  node tools/edge-publish.mjs \
  --package dist/BridgeDeck-extension-0.1.3.zip \
  --notes-file docs/releases/0.1.3.md
```

参数：

- `--package`：扩展 zip，默认 `dist/BridgeDeck-extension-<version>.zip`；
- `--notes` / `--notes-file`：提交说明；
- `--draft-only`：只上传到 draft，不调用发布。

## 0.1.3 当前情况

- GitHub Release 已刷新：扩展、Windows Setup、Windows CLI、release.json、SHA256SUMS；
- Edge 商店的 0.1.3 之前已提交，仍在审核；**没有用同版本覆盖**；
- 本机没有 `EDGE_API_KEY` / `EDGE_CLIENT_ID` / `EDGE_PRODUCT_ID` 环境变量，因此没有执行线上商店提交。

## 推荐

1. 若商店 0.1.3 审核未完成：在 Partner Center 取消审核，重新提交本次 0.1.3 包；
2. 若希望更稳：等 0.1.3 审核结束后，发 0.1.4，使用同一套 `edge-publish.mjs`；
3. GitHub 源与 Release 已更新到 0.1.3 刷新版本。
