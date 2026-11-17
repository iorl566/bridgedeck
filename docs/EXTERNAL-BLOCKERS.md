# 0.1.8 外部阻塞

以下项目需要用户/组织提供材料或权限，Agent 不能自行完成：

## 1. 发布签名

- **已解决**：release.json 由 GitHub Actions Secret `RELEASE_SIGNING_PRIVATE_KEY` 签名，keyId `c7b5e21301f91a2d`，preflight PASS；私钥未落到本机。
- 私钥口令（如使用加密 PEM）；
- 允许写入 `dist/release-public.pem` 并同步 `lib/release-public-key.mjs`。

没有私钥时：

```text
node tools/release-preflight.mjs
blocker: release.json 缺少签名
```

## 2. 商店/仓库上架

- **已执行**：GitHub v0.1.8 已公开；Edge 0.1.8 已提交审核（7 个工作日）。
- 后续版本仍需 Partner Center / GitHub 权限。

## 3. 交互式远程 viewer（非阻塞）

只读远程 viewer 已完成：`/preview`、`/preview/shot`、`/preview/focus`；
输入/点击双向控制需要独立 Web 前端与更细的授权，不在当前扩展页面内继续。

## 已完成（不依赖上述材料）

- 远程设备续期/scope/撤销、反代文档；
- cooperation target 标记、mode/revision；
- 本地 preview/focus + 远程只读 viewer；
- 0.1.8 九制品统一；
- release-preflight；
- 10 语言框架，8 个附加语言各 225 条人工翻译；
- 全量测试/构建/真机证据。
