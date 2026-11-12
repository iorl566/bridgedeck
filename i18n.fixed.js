// ui/i18n.js —— 运行时中英切换（默认跟随浏览器语言）
const LANG_KEY = 'bb.uiLang';
const DICT = {
  '未连接': 'Disconnected',
  '已连接': 'Connected',
  '连接中': 'Connecting',
  '协议偏差': 'Protocol mismatch',
  '已关闭': 'Off',
  '连接中…': 'Connecting…',
  '未命名浏览器': 'Unnamed browser',
  '当前浏览器': 'Current browser',
  '复制指令': 'Copy command',
  '连接设置': 'Connection settings',
  '· 本机': '· Local',
  '本机 · 未连接': 'Local · Disconnected',
  '本机': 'Local',
  '远程配对': 'Remote pairing',
  '本机端口': 'Local port',
  '留空恢复默认端口。': 'Leave empty to restore the default port.',
  '保存端口': 'Save port',
  '保存并连接': 'Save and connect',
  '恢复本机': 'Back to local',
  '控制提示': 'Control hint',
  'Agent 控制页面时显示提示条和蓝色高亮。': 'Show a hint bar and blue highlight while the agent controls the page.',
  '自动化设置': 'Automation',
  '借用标签页前确认': 'Confirm before borrowing tabs',
  '开启时，借用你已打开的标签页前会请求允许；关闭时，直接借用。自动保存到当前浏览器配置，对到达插件的所有会话请求生效；命令行参数不能覆盖。': 'When on, the agent asks before taking over one of your tabs. Saved in this browser profile and applies to every session; command-line flags cannot override it.',
  '允许请求人工协助': 'Allow human help requests',
  '开启时，Agent 可以请求你协助。关闭时，Agent 会尽力自主完成操作，遇到无法处理的步骤再报告受阻。自动保存到当前浏览器配置，对到达插件的所有会话请求生效；命令行参数不能覆盖。': 'When on, the agent may ask you for help. When off, it tries to finish alone and reports a blocker instead. Saved in this browser profile for all sessions; command-line flags cannot override it.',
  '当前任务': 'Current tasks',
  '实例 ID': 'Instance ID',
  '快捷功能': 'Quick actions',
  '视频录制': 'Video recording',
  '将任务标签页录制为 MP4 视频': 'Record a task tab as MP4 video',
  '网站调试': 'Website debugging',
  '记录请求、异常与页面上下文，随时回看': 'Capture requests, errors and page context for later review',
  '长截图': 'Full-page screenshot',
  '从网页顶部截到底部，预览并保存长图': 'Capture the page from top to bottom, preview and save',
  '操作录制': 'Action recording',
  '录制你的操作，供 Agent 参考': 'Record your actions as a reference for the agent',
  '操作审计': 'Task audit',
  '操作审计介绍': 'Task audit',
  '在完整页面打开': 'Open full page',
  '面板': 'Panel',
  'BridgeDeck · 设置': 'BridgeDeck · Settings',
  '这些设置立刻对已打开和新建的任务生效，保存在当前浏览器配置里。': 'These settings apply immediately to open and new tasks and are saved in this browser profile.',
  '浏览器实例': 'Browser instance',
  '名称': 'Name',
  '给这个浏览器起个名字，Agent 可用': 'Name this browser so the agent can select it with',
  '精确选中它。': 'to target it precisely.',
  '复制该实例的启动命令': 'Copy this instance\'s start command',
  '自动化': 'Automation',
  'Agent 接管你已有的标签页前，先在页面顶部弹出确认条。': 'Show a confirmation before the agent takes over one of your tabs.',
  '允许 Agent 请你处理登录、验证码等必须本人参与的步骤。': 'Allow the agent to ask you for login, CAPTCHA or other steps only you can complete.',
  '页面守卫': 'Page guard',
  '外部链接或手动新建的标签页落进 Agent 窗口时，自动移回普通窗口。': 'Move external or manually opened tabs back to a normal window when they land in the agent window.',
  '默认长截图模式': 'Default full-page mode',
  '自动滚动': 'Auto scroll',
  '手动拼接': 'Manual stitch',
  '保存设置': 'Save settings',
  '恢复默认': 'Restore defaults',
  '数据默认只在本机流转；详见': 'Data stays on this machine by default. See',
  '隐私说明': 'Privacy notice',
  '快捷功能 · BridgeDeck': 'Quick actions · BridgeDeck',
  '操作审计 · BridgeDeck': 'Task audit · BridgeDeck',
  '浏览器本地记录': 'Stored locally in this browser',
  '记录仅保存在本机，已结束的任务保留 30 天。只保存方法名、耗时、结果码、会话、标签页与 URL； 输入值、页面正文与截图不会保存。可用': 'Records stay on this machine for 30 days. Only method, duration, result code, session, tab and URL are saved; input values, page text and screenshots are not. Read with',
  '读取，': 'and disable anytime.',
  '可关闭。': '',
  '全部任务': 'All tasks',
  '最近 1 小时': 'Last hour',
  '最近 24 小时': 'Last 24 hours',
  '最近 7 天': 'Last 7 days',
  '清空记录': 'Clear records',
  '刷新': 'Refresh',
  '还没有任务记录。后续通过 BridgeDeck 执行的操作会显示在这里。': 'No task records yet. Operations run through BridgeDeck will appear here.',
  '视频录制 · BridgeDeck': 'Video recording · BridgeDeck',
  '录制': 'Record',
  '开始录制': 'Start recording',
  '停止录制': 'Stop recording',
  '未开始': 'Not started',
  '录制的是标签页画面（无声）。浏览器会在标签页上显示「正在共享」提示。 优先用 MP4（H.264），浏览器不支持时自动退回 WebM。': 'Records the tab (silent). The browser shows a sharing indicator. MP4 (H.264) is preferred and falls back to WebM.',
  '录制文件': 'Recordings',
  '还没有录制文件': 'No recordings yet',
  '关闭预览': 'Close preview',
  '操作录制历史': 'Action recording history',
  '录制文件在当前浏览器保留 24 小时，请及时保存重要视频。': 'Recordings are kept for 24 hours in this browser. Save important videos promptly.',
  '最近录制': 'Recent recordings',
  '还没有录制视频。': 'No videos yet.',
  '完整录制页': 'Open recording page',
  '长截图 · BridgeDeck': 'Full-page screenshot · BridgeDeck',
  '自动滚动整页，或手动滚动采集，将内容拼成清晰长图。': 'Auto-scroll the page or capture it manually, then stitch a long image.',
  '预览': 'Preview',
  '打开预览': 'Open preview',
  '截图暂不可用': 'Screenshot unavailable',
  '预览可能已过期或被清理。请回到网页，通过快捷功能重新截图。': 'The preview may have expired or been cleared. Go back to the page and capture again.',
  '重新截图（高级）': 'Capture again (advanced)',
  '目标与模式': 'Target and mode',
  '截取整页': 'Capture full page',
  '自动滚动并拼接，最多 8 屏': 'Auto-scroll and stitch, up to 8 screens',
  '开始拼接': 'Start stitching',
  '拍一帧': 'Capture frame',
  '拼接': 'Stitch',
  '0 帧': '0 frames',
  '保存到下载目录': 'Save to Downloads',
  '丢弃': 'Discard',
  '网站调试 · BridgeDeck': 'Website debugging · BridgeDeck',
  '每一次调查，都有迹可循。': 'Every investigation leaves a trail.',
  '查看网页上下文、请求和异常，或导出记录交给 Agent 分析。': 'Inspect page context, requests and errors, or export records for the agent.',
  '手动采集（高级）': 'Manual capture (advanced)',
  '开始采集': 'Start capture',
  '停止采集': 'Stop capture',
  '采集当前标签页的请求元数据（方法/状态/耗时）与控制台输出/未捕获异常；停止后保存为历史，最多保留 10 条。': 'Capture request metadata (method/status/duration), console output and uncaught errors from this tab; keep up to 10 runs.',
  '请求': 'Requests',
  '导出 JSON': 'Export JSON',
  '还没有请求': 'No requests yet',
  '控制台 / 异常': 'Console / errors',
  '没有控制台输出': 'No console output',
  '页面上下文': 'Page context',
  '历史记录': 'History',
  '还没有调试记录': 'No debug records yet',
  '把网站地址和遇到的问题告诉 Agent，它会建立任务并开启采集。': 'Tell the agent the URL and the problem; it will start a capture.',
  '历史详情': 'History details',
  '关闭': 'Close',
  '调试记录保存在当前浏览器本地，任务结束后仍可查看和导出。保留最近 30 天、最多 50 份、总计 50 MiB；常见凭据脱敏，正文有上限。': 'Debug records stay in this browser after the task ends. Kept for 30 days, up to 50 runs and 50 MiB; credentials are redacted and bodies are capped.',
  '采集范围与限制': 'Scope and limits',
  '记录请求元数据（方法/状态/耗时）、控制台输出与未捕获异常、页面基础上下文；不记录请求正文与截图。单次采集在本地保留 10 条历史。': 'Records request metadata, console output, uncaught errors and basic page context; request bodies and screenshots are not recorded. Each capture keeps 10 local runs.',
  '操作录制 · BridgeDeck': 'Action recording · BridgeDeck',
  '录制你的点击/输入/选择/导航，导出 JSON 给 Agent 参考': 'Record clicks, input, selections and navigation as JSON for the agent',
  '录制只发生在你选中的这个标签页；密码框的值会被记成': 'Recording stays in the selected tab; password values are stored as',
  '。 停止后可导出 JSON，配合': '. Stop, then export JSON and use it with',
  '或': 'or',
  '复制': 'Copy',
  '未配对': 'Unpaired',
  '已验证': 'Verified',
  '已连接 · 未配对': 'Connected · Unpaired',
  '已连接 · 已验证': 'Connected · Verified',
  '远程': 'Remote',
  "界面语言 / Language": "Language",
  "保存图片": "Save image",
  "停止并保存": "Stop and save",
  "复制录制指令": "Copy recording command",
  "复制给 Agent 的指令": "Copy agent command",
  "复制给 Agent 的提示词": "Copy agent prompt",
  "已打开手动长截图页": "Opened manual full-page page",
  "开关读写异常": "Failed to read or write switch",
  "开启操作审计": "Enable task audit",
  "开始录制": "Start recording",
  "开始截图": "Start capture",
  "当前可视区域": "Visible area",
  "当前页面": "Current page",
  "录制完成": "Recording complete",
  "手动录制正在运行的任务": "Record a running task manually",
  "打开录制页": "Open recording page",
  "操作主题（可选）": "Action theme (optional)",
  "操作审计": "Task audit",
  "操作录制": "Action recording",
  "整页 · 自动滚动": "Full page · Auto scroll",
  "时长上限（1–600 秒）": "Max duration (1–600 s)",
  "标准 1280/15": "Standard 1280/15",
  "标准 · 1280 / 15 帧": "Standard · 1280/15 fps",
  "正在停止…": "Stopping…",
  "正在开始录制…": "Starting recording…",
  "正在截取…": "Capturing…",
  "清晰 1920/30": "Clear 1920/30",
  "清晰 · 1920 / 30 帧": "Clear · 1920/30 fps",
  "长图 · 我来滚动": "Full page · I will scroll",
  "需要 ws:// 或 wss:// 地址": "A ws:// or wss:// address is required",
  "非本机连接必须使用 wss://": "Non-local connections must use wss://",
  "配对保存失败": "Pairing save failed",
  "配对恢复失败": "Pairing restore failed",
  "配对链接解析失败": "Pairing link parse failed",
  "本机 · ws://127.0.0.1:": "Local · ws://127.0.0.1:",
  "最近录制（": "Recent recordings (",
  "录制中…": "Recording…",
  "录制中 ·": "Recording ·",
  "开始失败：": "Failed to start: ",
  "停止失败：": "Failed to stop: ",
  "保存失败：": "Save failed: ",
  "截图失败：": "Screenshot failed: ",
  "已保存：": "Saved: ",
  "例如：工作账号": "e.g. Work account",
  "名字": "name",
  "读取，可在弹窗关闭。": "to read it; turn it off in the popup.",
  "记录仅保存在本机，已结束的任务保留 30 天。只保存方法名、耗时、结果码、会话、标签页与 URL； 输入值、页面正文与截图不会保存。可用": "Records stay on this machine for 30 days. Only method, duration, result code, session, tab and URL are saved; input values, page text and screenshots are not. Use",
  "读取，": "to read;",
  "可在弹窗关闭。": "it can be turned off in the popup.",
  "录制的是标签页画面（无声）。浏览器会在标签页上显示「正在共享」提示。 优先用 MP4（H.264），浏览器不支持时自动退回 WebM。": "Records the tab (silent). The browser shows a sharing indicator. MP4 (H.264) is preferred and falls back to WebM.",
  "录制只发生在你选中的这个标签页；密码框的值会被记成": "Recording stays in the selected tab; password values are stored as",
  "。 停止后可导出 JSON，配合": ". Stop, then export JSON and use it with",
};
const PATTERNS = [
  [/^(\d+) 秒$/,'$1 s'],
  [/^最近录制（(\d+)）$/,'Recent recordings ($1)'],
  [/^时长上限（(\d+).*?）$/,'Max duration ($1 s)'],
  [/^协议偏差：daemon (.+)，扩展 (.+)$/, 'Protocol mismatch: daemon $1, extension $2'],
  [/^已连接 · 未配对$/, 'Connected · Unpaired'],
  [/^已连接 · 已验证$/, 'Connected · Verified'],
  [/^(\d+) 帧$/, '$1 frames'],
  [/^(\d+) 个文件$/, '$1 files'],
  [/^(\d+) 条$/, '$1 items'],
  [/^(\d+) 条记录$/, '$1 records'],
  [/^(\d+) 秒后自动拒绝$/, 'Auto-deny in $1 s'],
  [/^已保存：(.+)$/, 'Saved: $1'],
  [/^已复制：?(.*)$/, 'Copied$1'],
  [/^录制中… ?(.*)$/, 'Recording… $1'],
  [/^正在(.+)$/, 'Working: $1'],
  [/^开始失败：?(.*)$/, 'Failed to start$1'],
  [/^保存失败：?(.*)$/, 'Failed to save$1'],
  [/^截图失败：?(.*)$/, 'Screenshot failed$1'],
  [/^拼接失败：?(.*)$/, 'Stitch failed$1'],
  [/^复制失败：?(.*)$/, 'Copy failed$1'],
  [/^读取失败：?(.*)$/, 'Read failed$1'],
  [/^未知错误$/, 'Unknown error'],
];
let current = 'zh';
let observer = null;

export function getLang() {
  return current;
}

function normalizeLang(value) {
  if (value === 'en' || value === 'zh') return value;
  return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export async function loadLang() {
  try {
    const stored = await chrome.storage.local.get(LANG_KEY);
    current = normalizeLang(stored && stored[LANG_KEY]);
  } catch {
    current = normalizeLang(null);
  }
  return current;
}

export function translate(text) {
  if (current !== 'en') return text;
  const raw = String(text);
  const trimmed = raw.trim();
  if (!trimmed || !/[\u4e00-\u9fa5]/.test(trimmed)) return raw;
  const normalized = trimmed.replace(/\s+/g, ' ');
  const exact = DICT[trimmed] !== undefined ? DICT[trimmed] : DICT[normalized];
  if (exact !== undefined) return raw.replace(trimmed, exact);
  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(trimmed)) return raw.replace(trimmed, trimmed.replace(pattern, replacement));
  }
  return raw;
}

function translateNode(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.nodeValue && /[\u4e00-\u9fa5]/.test(root.nodeValue)) {
      const next = translate(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const tag = root.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return;
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const value = root.getAttribute(attr);
    if (value && /[\u4e00-\u9fa5]/.test(value)) {
      const next = translate(value);
      if (next !== value) root.setAttribute(attr, next);
    }
  }
  for (const child of root.childNodes) translateNode(child);
}

function observe() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) translateNode(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

let readyPromise = null;

export function whenReady() {
  return readyPromise || (readyPromise = initI18n());
}

export async function initI18n() {
  const lang = await loadLang();
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (lang !== 'en') return lang;
  const apply = () => {
    if (document.title) {
      const translated = translate(document.title);
      if (translated) document.title = translated;
    }
    translateNode(document.body);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
  observe();
  return lang;
}

export async function setLang(lang) {
  const next = lang === 'en' ? 'en' : 'zh';
  await chrome.storage.local.set({ [LANG_KEY]: next });
  current = next;
  location.reload();
}

whenReady();
