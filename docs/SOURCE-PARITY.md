# 源码级镜像审计

最后审计：`node tools/audit-source-parity.mjs`

只统计对照实现 `apps/extension/src` 与镜像目录，不含测试文件。

逐文件行数差异见 [PARITY-MANIFEST.md](PARITY-MANIFEST.md)（由 `node tools/parity-manifest.mjs` 生成）。

| 目录 | 对照文件 | 对照行 | 镜像文件 | 镜像行 |
| --- | ---: | ---: | ---: | ---: |
| debug | 20 | 6478 | 20 | 6478 |
| transport | 15 | 3077 | 15 | 3077 |
| session-manager | 11 | 1839 | 11 | 1839 |
| browser-driver | 5 | 2496 | 7 | 2628 |
| content | 15 | 4428 | 15 | 4451 |
| long-screenshot | 15 | 2194 | 15 | 2194 |
| video | 19 | 2516 | 20 | 2516 |
| lib | 48 | 5775 | 48 | 5775 |
| shared | 1 | 23 | 1 | 23 |
| **合计** | **149** | **28826** | **152** | **28958** |

## 结论

- 文件边界覆盖约 **102%**（152/149，含 3 个辅助镜像文件），行数约 **100.5%**（28958/28826，差额为 console-parsers/dialog-parser 两个辅助模块）。
- 已覆盖主要纯逻辑与协议模块。- 未覆盖的主要是浏览器胶水、UI、完整 CDP 类、完整 WebCodecs 编码器、page/capture 全管线。

## 已接入运行路径

- `session-manager/tab-moves` → `tabs.js` 的 `tab.move`
- `browser-driver/command-deadline` → `debugger.js` 的 `send`

两项通过全量 E2E。

## 未接入

其余镜像模块均为旁路实现；现有运行路径仍是原 `debug.js` / `network.js` / `video.js` / `actions.js`。

## 下一步优先级

1. `browser-driver/chromium-cdp` 主体
2. `long-screenshot/page` + `capture`
3. `video/encoder` 完整管线
4. `content` 录制捕获
5. 逐模块替换运行路径，每次全量 E2E
