# 当前状态

最后更新：逐文件等价推进中（E2E 本轮重跑 131/131）

## 目标

逐文件源码等价，不设范围外豁免。必要的 UI/媒体依赖只用于镜像模块与测试，不进入运行时安装包。

## 已验证

| 项 | 结果 |
| --- | --- |
| 真实 Edge E2E | 131/131 |
| 纯函数单测 | 554/554 |
| CLI selftest | 139/139 |
| 宿主插件 | 21/21 |
| MCP selftest | 9/9 |
| 发布清单 | 2 artifacts |

## 源码镜像覆盖

`node tools/audit-source-parity.mjs`

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

## 依赖边界

- 运行时仍不依赖 React / mediabunny / vitest
- 镜像 UI 与 fixture 模块使用开发依赖；`tools/package-portable.mjs` 不打包 `node_modules`
- 安装器体积未因依赖增加

## 剩余

- content：record-capture 仍是核心子集，复杂 hover ownership 未完全移植
- 其余目录文件边界已齐，但部分模块行数仍低于对照实现
