// src/ws-client.js —— daemon 端口候选锚点（部署/E2E 可替换的配置面）。
//
// 这是 WXT public/ 目录里的静态资源，会被原样复制到产物根目录（.output/chrome-mv3/src/
// ws-client.js）。TS 运行时的 background 启动时 fetch 本文件、解析下面这一行 PORTS，
// 作为多端口发现的候选表（见 apps/extension/src/daemon/discovery.ts）。
//
// 为什么放在产物里的独立文件而不是打包进 background：
// - 运维/部署可以在不改代码的情况下调整 daemon 端口；
// - tools/e2e.mjs --ext-dir 会把 `const PORTS = [...]` 这一行改写成它本次 daemon 的
//   端口，从而让同一套 212 条验收直接指向 TS 产物（E2E 脚本本身不需要改）；
// - 读不到/解析失败时回退到与 0.3.0 JS 扩展一致的 52900-52909。
const PORTS = [52900, 52901, 52902, 52903, 52904, 52905, 52906, 52907, 52908, 52909];

// 本文件不在扩展页面里执行（不会被 <script> 引入），只是可读配置；
// 显式导出便于人工核对，不依赖任何运行时 API。
export { PORTS };
