# Edge 商店：两边实测（BSK 已上架 vs BridgeDeck 0.3.1 draft）

> 2026-11-27。目的：用已经上架的 BSK 当参照，确认“商店这一侧”的差异到底在哪，以及 BridgeDeck 0.3.1 为什么上传成功却发不出去。
> 数据来自 Edge 加载项公开接口 + 商店 CRX 下载，不是推测。

## 1. 商店实际分发的包（CRX 下载解出来的 manifest）

| | BSK | BridgeDeck |
| --- | --- | --- |
| 商店版本 | **0.5.0**（与 GitHub 一致） | **0.3.0**（0.3.1 还在 draft） |
| 包体 | 1,304,908 字节 | 458,037 字节 |
| 最低浏览器 | 125 | 111 |
| 权限数 | 13 | 14（多 `declarativeNetRequest`） |
| 商店页地址 | `.../detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg` | `.../detail/ieflpefpmlmmlfgmpfakaglhgmcbcnig` |

结论：商店这一侧对两家都是“能上传、能分发”的；BridgeDeck 缺的只是把 0.3.1 推到已上架状态。

## 2. 商店 listing 现状

| 项 | BSK | BridgeDeck |
| --- | --- | --- |
| 语言行 | 仅 en-US | 仅 en-US（0.3.1 包里有 13 个 locale，会要求 13 行） |
| 截图 | **0 张** | 5 张（1280×800） |
| 描述 | 811 字符，仍写着旧名 **Browser-hand / bh CLI**，完全没出现 `bsk` | 2046 字符，品牌一致 |
| Website | 空 | `https://example.com`（占位，必须改） |
| 隐私 URL | GitHub 仓库文件 | `bridgedeck-privacy` 的 Pages 页面 |
| 安装量 / 评分 | 83,507 / 4.3（7 个评分） | 3 / 无评分 |
| 最近更新 | 2026-11-16 | 2026-11-18 |

**关键发现**：BSK 的包只有 en-US 一个 locale，所以商店只要求 1 个语言行，单语言 listing 就能发布；
BridgeDeck 0.3.1 包里有 13 个 locale → Partner Center 要求 13 个语言行都填 Description + Logo，
缺任何一行，`POST /submissions` 就返回：

```
status: Failed
errorCode: ModuleStateUnPublishable
errors: [{ "message": "Invalid module : LISTING" }]
```

这不是包的问题（包上传 `Succeeded`，operation `acfc5b64…`），纯粹是 listing 没填完。

## 3. 三条可选路径

| 方案 | 做法 | 代价 | 何时可用 |
| --- | --- | --- | --- |
| **A（推荐）** | 在 Partner Center 把 13 行填完（文案/图片已备好，见 `docs/STORE-LISTING.md` + `paste-sheet.html`），再跑 `tools/publish-edge.ps1` | 一次登录内手工粘贴约 15–20 分钟 | 保留了 13 语言 |
| **B** | 重打一个只含 `en` locale 的 0.3.1 包，上传后立即发布 | 非英文用户界面回退到英文，直到 0.3.2 修回来；与 GitHub 上的 0.3.1 包不同源 | 5 分钟内可上架 |
| **C** | 只保留 `en` + `zh_CN` 两个 locale，填 2 行后发布 | 其余 11 语言界面回退英文 | 约 5 分钟 + 2 行粘贴 |

## 4. 自动化的边界（已实测）

- 上传接口可用：`POST /submissions/draft/package` → `Succeeded`。
- 发布接口存在但会挡 listing：`ModuleStateUnPublishable / Invalid module : LISTING`。
- 列表里的 **listing 内容（描述/截图/logo）没有任何 API**，只能在 Partner Center 页面填。
  这也是 BSK 那边的描述至今还停在 Browser-hand/bh CLI 的原因——它只能靠人工改。
