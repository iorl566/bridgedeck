# Edge 商店文案与素材（0.3.1）

> 状态（2026-11-27）：0.3.1 扩展包已通过 API 上传为 **draft**；商店 listing（文案 / 多语言 / 截图）还需在
> Partner Center 页面填写并保存，然后才能提交审核。提交流程见 [STORE-PUBLISH-RUNBOOK.md](STORE-PUBLISH-RUNBOOK.md)，
> 审核页填写答案见 [STORE-REVIEW.md](STORE-REVIEW.md)。

## 文件

| 内容 | 位置 |
| --- | --- |
| 各语言商店文案 | `docs/store-listing/<locale>.md`（13 个） |
| 文案校验脚本 | `docs/store-listing/validate.mjs` |
| 商店图片 | `docs/assets/store/`（logo、两种宣传图、5 张截图） |
| 版本更新说明（API 提交用） | `docs/assets/store/release-notes-0.3.1.md` |
| 隐私页填写答案 / 审核备注 | [STORE-REVIEW.md](STORE-REVIEW.md) |
| 提交流程 | [STORE-PUBLISH-RUNBOOK.md](STORE-PUBLISH-RUNBOOK.md) |

## 校验

```powershell
& 'D:\tools\node\node.exe' docs\store-listing\validate.mjs
```

脚本检查：13 个文件齐全、Description 250–10,000 字符、搜索词 ≤7 条 / 单条 ≤30 字符 / 总词数 ≤21，
并对包内短描述长度（Chromium 参考上限 132 字符）给出提示。

## 语言对照

Partner Center 的语言行来自包内 `_locales/`（manifest 用 `__MSG_extName__` / `__MSG_extDescription__`，
所以 13 个 locale 都会被识别）。每个语言行都要有 Description 和 Logo；名称与短描述是只读的，来自 manifest。

| Partner Center locale | 包内 locale | 文案文件 | 短描述（只读，来自 manifest） |
| --- | --- | --- | --- |
| en-US | `en` | [en-US.md](store-listing/en-US.md) | BridgeDeck turns the browser you already use into a workspace for your AI agent. Local daemon + MV3 extension; no telemetry. |
| zh-CN | `zh_CN` | [zh-CN.md](store-listing/zh-CN.md) | BridgeDeck 把已登录的浏览器变成 AI Agent 的工作区：本地 daemon + MV3 扩展，数据只在本机流转。 |
| zh-TW | `zh_TW` | [zh-TW.md](store-listing/zh-TW.md) | BridgeDeck 把已登入的瀏覽器變成 AI Agent 的工作區：本機 daemon + MV3 擴充功能，資料只在本機流動。 |
| ja-JP | `ja` | [ja-JP.md](store-listing/ja-JP.md) | BridgeDeck は、ログイン済みのブラウザを AI エージェントのワークスペースに変えます。ローカル daemon + MV3 拡張機能、テレメトリなし。 |
| ko-KR | `ko` | [ko-KR.md](store-listing/ko-KR.md) | BridgeDeck은 이미 로그인된 브라우저를 AI 에이전트의 작업 공간으로 바꿉니다. 로컬 daemon + MV3 확장 프로그램, 텔레메트리 없음. |
| de-DE | `de` | [de-DE.md](store-listing/de-DE.md) | BridgeDeck macht aus deinem bereits angemeldeten Browser einen Arbeitsbereich für deinen KI-Agenten. Lokaler Daemon + MV3-Erweiterung, keine Telemetrie. |
| fr-FR | `fr` | [fr-FR.md](store-listing/fr-FR.md) | BridgeDeck transforme votre navigateur déjà connecté en espace de travail pour votre agent IA. Daemon local + extension MV3, sans télémétrie. |
| es-ES | `es` | [es-ES.md](store-listing/es-ES.md) | BridgeDeck convierte tu navegador ya iniciado en un espacio de trabajo para tu agente de IA. Daemon local + extensión MV3, sin telemetría. |
| it-IT | `it` | [it-IT.md](store-listing/it-IT.md) | BridgeDeck trasforma il browser già connesso in uno spazio di lavoro per il tuo agente IA. Daemon locale + estensione MV3, senza telemetria. |
| pt-BR | `pt_BR` | [pt-BR.md](store-listing/pt-BR.md) | BridgeDeck transforma o navegador já conectado em um espaço de trabalho para o seu agente de IA. Daemon local + extensão MV3, sem telemetria. |
| pt-PT | `pt_PT` | [pt-PT.md](store-listing/pt-PT.md) | BridgeDeck transforma o navegador já ligado num espaço de trabalho para o seu agente de IA. Daemon local + extensão MV3, sem telemetria. |
| ar-SA | `ar` | [ar-SA.md](store-listing/ar-SA.md) | BridgeDeck يحوّل المتصفح المسجّل لديك إلى مساحة عمل لوكيل الذكاء الاصطناعي. خدمة محلية + إضافة MV3، دون قياس عن بُعد. |
| he-IL | `he` | [he-IL.md](store-listing/he-IL.md) | BridgeDeck הופך את הדפדפן המחובר שלך לסביבת עבודה עבור סוכן ה-AI. daemon מקומי + תוסף MV3، ללא טלמטריה. |

如果某个语言在 Partner Center 的下拉里没有（不同账号可用语言可能略有差异），跳过那一行即可；不影响其余语言。

## 字段与限制（Partner Center → Store listings → Details for <language>）

| 字段 | 要求 | 我们的内容 |
| --- | --- | --- |
| Extension name | 只读，来自 manifest | `BridgeDeck` |
| Short description | 只读，来自 manifest | 见上表 |
| Description | 必填，每个语言；250–10,000 字符 | 各语言 `.md` 的 `## Description` 段 |
| Extension logo | 必填，每个语言；1:1，推荐 300×300，最小 128×128 | `docs/assets/store/icon-300.png`（300×300），上传后点 Duplicate 复制到所有语言 |
| Small promotional tile | 可选；440×280 | `docs/assets/store/promo-small-440x280.png`，Duplicate 到所有语言 |
| Large promotional tile | 可选；1400×560 | `docs/assets/store/promo-large-1400x560.png`，Duplicate 到所有语言 |
| Screenshots | 可选，最多 6 张；640×480 或 1280×800 | 5 张，见下表，按顺序上传后 Duplicate 到所有语言 |
| Search terms | 可选；≤7 条，单条 ≤30 字符，总词数 ≤21 | 各语言 `.md` 的 `## Search terms` 段 |
| YouTube video URL | 可选 | 暂不填 |

## 截图（按此顺序上传，1280×800）

| 顺序 | 文件 | 画面 |
| --- | --- | --- |
| 1 | `docs/assets/store/store-01.png` | 数据工作台：导入、导出、对比与清洗，从页面直接取数 |
| 2 | `docs/assets/store/store-02.png` | 扩展弹窗：连接状态、复制给 Agent 的指令、自动化开关、CLI / Ext / 协议版本 |
| 3 | `docs/assets/store/store-03.png` | 快捷功能五入口：视频录制、网站调试、长截图、操作录制、操作审计 |
| 4 | `docs/assets/store/store-04.png` | 操作录制：一键生成给 Agent 的录制指令，也可直接开始录制 |
| 5 | `docs/assets/store/store-05.png` | 网站调试：请求、控制台、操作时间线与证据导出 |

> 截图画面是中文界面。Edge 的图片是“每个语言一份、可一键 Duplicate 到其它语言”，
> 所以英文用户也会看到中文界面截图。若要更贴合英文受众，可只在 en-US 行放英文界面截图、
> 其它语言用 Duplicate；这一步不是提交阻塞项。

## Points to Properties / Availability

| 页面 | 填什么 |
| --- | --- |
| Availability | Public；Markets 保持默认（全部市场） |
| Properties → Category | Productivity |
| Properties → Website | `https://github.com/iorl566/bridgedeck` |
| Properties → Support contact | `https://github.com/iorl566/bridgedeck/issues` |
| Properties → Mature content | 不勾选 |
| Privacy | 见 [STORE-REVIEW.md](STORE-REVIEW.md) |

## 维护

- 改文案：改 `docs/store-listing/<locale>.md` → 跑 `validate.mjs` → 在 Partner Center 对应语言行更新。
- 短描述 / 名称要改：只能改 `extension/_locales/*/messages.json` 并重新打包上传（会改变包哈希，需重跑
  `tools/build-extension.mjs`、`tools/release.mjs`、`tools/release-preflight.mjs`）。
- 工具数量（MCP 92、DSH 插件 37）由 `tests/unit/mcp-tool-methods.test.mjs`、`tests/unit/dsh-tools.test.mjs`
  断言；数量变化时同步更新各语言文案与 README。
