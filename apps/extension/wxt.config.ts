import { defineConfig } from 'wxt';
import { createUiHtmlCompatPlugin } from './src/ui/html-compat.ts';

// 架构路线：BridgeDeck 扩展的 TypeScript + React + WXT 工程。
// 与 0.3.0 的原生 JS 扩展（repo 根 extension/）并存：本工程产出到 .output/，
// 在达到能力对等前不改 dist/、不改根 extension/。
//
// 构建期兼容（29/29d 的根因修复）见 src/ui/html-compat.ts：
// - 去掉 Vite 留在 <!DOCTYPE html> 之后的游离 UTF-8 BOM（否则 head 内容被解析进
//   body，页面清空 body 时 title 一起被清掉，tab.title 退化成 URL）；
// - popup 额外产出 ui/popup.html 别名页（0.3.0 JS 产物布局 / CLI 断言使用该路径）。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: '.output',
  vite: () => ({
    plugins: [createUiHtmlCompatPlugin()],
  }),
  manifest: {
    name: 'BridgeDeck',
    short_name: 'BridgeDeck',
    description: 'BridgeDeck 本地浏览器扩展：让命令行 AI agent 驱动当前浏览器（仅连接 127.0.0.1 上的本地 daemon）。',
    version: '0.3.1',
    minimum_chrome_version: '111',
    permissions: [
      'tabs',
      'scripting',
      'storage',
      'alarms',
      'idle',
      'notifications',
      'windows',
      'downloads',
      'webNavigation',
      'debugger',
      'tabCapture',
      'offscreen',
      'tabGroups',
      'declarativeNetRequest',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'BridgeDeck',
      default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    },
    icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  },
});
