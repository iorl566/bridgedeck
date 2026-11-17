# 0.1.8 外部阻塞

以下项目需要用户/组织提供材料或权限，Agent 不能自行完成：

## 1. 发布签名

- Ed25519 私钥（或签名服务）；本机未找到与公钥 `c7b5e21301f91a2d` 对应的私钥；
- 私钥口令（如使用加密 PEM）；
- 允许写入 `dist/release-public.pem` 并同步 `lib/release-public-key.mjs`。

没有私钥时：

```text
node tools/release-preflight.mjs
blocker: release.json 缺少签名
```

## 2. 商店/仓库上架

- GitHub release 写权限；
- Edge Partner Center 账号与产品权限。

没有权限时只能生成制品、清单和预检结果，不能上传。

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
