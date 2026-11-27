// lib/network-waterfall.mjs —— 网络瀑布（Node/CLI 侧入口）。
//
// 实现单源在 extension/src/lib/network-waterfall.js（浏览器扩展的 network.waterfall RPC 直接消费），
// 这里只做 Node 侧复用导出：MV3 打包不能 import 扩展目录之外的文件，而 Node 可以 import 扩展内的
// 纯函数模块，因此把"扩展实现"作为唯一实现，避免两份 waterfall 逻辑漂移。
// 消费点：tests/unit/network-analysis.test.mjs、离线 HAR/archive 分析脚本。
export {
  buildWaterfall,
  deriveCdpTimings,
  timingsForEntry,
} from '../extension/src/lib/network-waterfall.js';
