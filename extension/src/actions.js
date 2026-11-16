// src/actions.js —— 页面工具统一出口；实现按域拆分在 tools/。
export { goBack, goForward, navigate, reload } from './tools/navigation.js';
export { clearFrameAliases, resolveFrameAlias } from './tools/frames.js';
export { cancelWait, waitForElement, waitForNavigationCmd, waitMs } from './tools/waits.js';
export { getHtml, observe, observeFrames, observeSmart, snapshot, visualScan } from './tools/observation.js';
export { consoleEntries, evaluate, extract, extractDiscover, extractList, extractTable, read } from './tools/read.js';
export { shadowClick, shadowRead } from './tools/shadow.js';
export { upload } from './tools/file-transfer.js';
export {
  actionable, blur, click, clickBackend, drag, fill, focus, hover, press, scrollTo, select, wheel,
} from './tools/interaction.js';
